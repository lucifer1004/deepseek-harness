/** Worker and architect tools run through the tool executor against a real repository and a real agent loop. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import ArchitectureService from '@deepseek-ai/dsh-experimental-architecture'
import type { RulingId, SectionHash, SourcePath } from '@deepseek-ai/dsh-experimental-architecture/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as WorkerTools from '../src/index.ts'
import * as ArchitectTools from '../src/architect.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

const ARCH = '# Arch\n\n## Storage\n\nAll persistence goes through the store.\n\n## Wire\n\nJSON only.\n'

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-architecture-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'design'))
  await writeFile(join(root, 'architecture.yml'), 'sources:\n  - design/*.md\n')
  await writeFile(join(root, 'design', 'arch.md'), ARCH)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

type Script = ConstructorParameters<typeof MockAdapter>[0]

const ARCHITECT_TOOLS = ['read', 'architecture_index', 'architecture_read', 'architecture_edit']

async function boot(script: Script): Promise<{ ctx: Context; adapter: MockAdapter; repo: string }> {
  const repo = await repository()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(FIXTURES).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'coding' })
  await ctx.plugin(LocalSubprocessRuntime)
  const tools = pathToFileURL(join(FIXTURES, 'plugins/preset-tools.js')).href
  await ctx.agentPresets.register({ id: 'coding', plugins: [{ name: tools, config: { tools: ['read', 'write'] } }] })
  await ctx.agentPresets.register({ id: 'architect', plugins: [{ name: tools, config: { tools: ['read', 'write'] } }] })
  await ctx.plugin(ArchitectureService, { mainBranch: 'main', architectTools: ARCHITECT_TOOLS })
  await ctx.plugin(WorkerTools)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, repo }
}

/** An agent on `preset`; the architect preset also mounts the architect tools, as the profile's preset row does. */
async function agent(ctx: Context, repo: string, id: string, preset: string): Promise<Agent> {
  return (await createAgent(ctx, repo, id, preset)).agent
}

async function createAgent(ctx: Context, repo: string, id: string, preset: string): Promise<AgentHandle> {
  return await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: repo, agentPreset: preset },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, preset)
      if (preset === 'architect') await agentCtx.plugin(ArchitectTools)
    },
  })
}

async function call(ctx: Context, caller: Agent, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`c-${name}`), name, arguments: args, agent: caller })
  const first = result.content[0]
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError ?? false }
}

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached')
}

function expectResult(result: { text: string; isError: boolean }, isError: boolean, text: RegExp): void {
  expect(result.isError).toBe(isError)
  expect(result.text).toMatch(text)
}

describe('architect tools', () => {
  it('lists, reads, and edits sections under the edit rule', async () => {
    const { ctx, repo } = await boot([])
    const architect = await agent(ctx, repo, 'architect-session', 'architect')

    const listed = await call(ctx, architect, 'architecture_index', {})
    expect(listed.text).toMatch(/^1 source\(s\), 3 section\(s\)\./)
    expect(listed.text).toContain('  design/arch.md#storage — Storage [line 3, ')

    const read = await call(ctx, architect, 'architecture_read', { cite: 'design/arch.md#storage' })
    expect(read.text).toMatch(/^design\/arch\.md#storage \[[0-9a-f]{64}\]\n\n## Storage\n\nAll persistence goes through the store\.\n$/)
    const hash = /\[([0-9a-f]{64})\]/.exec(read.text)?.[1]

    const edited = await call(ctx, architect, 'architecture_edit', { path: 'design/arch.md', anchor: 'storage', expectedHash: hash, content: '## Storage\n\nPersistence goes through the store and its journal.\n' })
    expect(edited).toEqual({ text: 'Wrote design/arch.md. The user reviews and commits the change.', isError: false })
    expect(await readFile(join(repo, 'design', 'arch.md'), 'utf8')).toBe('# Arch\n\n## Storage\n\nPersistence goes through the store and its journal.\n\n## Wire\n\nJSON only.\n')

    const stale = await call(ctx, architect, 'architecture_edit', { path: 'design/arch.md', anchor: 'storage', expectedHash: hash, content: '## Storage\n\nx\n' })
    expect(stale.isError).toBe(true)
    expect(stale.text).toMatch(/design\/arch\.md#storage changed since it was read/)

    const whole = await call(ctx, architect, 'architecture_edit', { path: '.architecture/open/q1.md', content: '# Q1\n' })
    expect(whole.isError).toBe(false)
    expectResult(await call(ctx, architect, 'architecture_edit', { path: 'src/x.ts', content: 'x' }), true, /refused: src\/x\.ts is neither/)
    expectResult(await call(ctx, architect, 'architecture_edit', { path: 'design/arch.md', expectedHash: 'x', content: 'x' }), true, /expectedHash requires anchor/)
    expectResult(await call(ctx, architect, 'architecture_read', { cite: 'design/arch.md' }), true, /not a path#anchor citation/)
    expectResult(await call(ctx, architect, 'architecture_read', { cite: 'design/arch.md#nope' }), true, /names no indexed section/)
    expect(await call(ctx, architect, 'architecture_index', { path: 'design/arch.md' })).toMatchObject({ isError: false })
    expectResult(await call(ctx, architect, 'architecture_edit', { path: 'design/arch.md', anchor: 'nope', content: '## Nope\n' }), true, /design\/arch\.md has no indexed section #nope/)

    await writeFile(join(repo, 'design', 'bad.md'), Uint8Array.of(0xff, 0xfe))
    await writeFile(join(repo, 'design', 'intro.md'), 'Text before any heading.\n')
    const diagnosed = await call(ctx, architect, 'architecture_index', {})
    expect(diagnosed.text).toContain('design/intro.md# — (preamble) [line 1, ')
    expect(diagnosed.text).toMatch(/\n! design\/bad\.md: /)
  })

  it('reports a workspace without a manifest', async () => {
    const { ctx, repo } = await boot([])
    await rm(join(repo, 'architecture.yml'))
    const architect = await agent(ctx, repo, 'architect-session', 'architect')
    expect(await call(ctx, architect, 'architecture_index', {}))
      .toEqual({ text: `${ArchitectTools.COLD_START_GUIDANCE}\n\nThis is the primary git checkout; it is on \`main\`. Local branches: \`main\`.`, isError: false })
    const empty = { hasManifest: false, sources: [], sections: [], diagnostics: [] }
    expect(ArchitectTools.renderIndex(empty)).toBe(ArchitectTools.COLD_START_GUIDANCE)
    const cold = (checkout: { vcs: string; isPrimary: boolean; current: string[]; all: string[] }): string =>
      ArchitectTools.renderIndex({ ...empty, checkout }).slice(ArchitectTools.COLD_START_GUIDANCE.length + 2)
    expect(cold({ vcs: 'jj', isPrimary: true, current: ['main', 'wip'], all: ['main', 'wip'] }))
      .toBe('This is the primary jj workspace; it is on `main`, `wip`. Local bookmarks: `main`, `wip`.')
    expect(cold({ vcs: 'jj', isPrimary: false, current: [], all: ['main'] })).toBe('This is not the primary jj workspace, so nothing can be written from here; '
      + 'it is on no bookmark (none points to @ or @-). Local bookmarks: `main`.')
    expect(cold({ vcs: 'git', isPrimary: true, current: [], all: [] }))
      .toBe('This is the primary git checkout; it is on no branch (detached HEAD). The repository has no local branch yet; ask the user which name to use.')
  })

  it('keeps generic write tools unavailable to an architect-preset Session', async () => {
    const { ctx, repo } = await boot([])
    const architect = await agent(ctx, repo, 'architect-session', 'architect')
    expectResult(await call(ctx, architect, 'write', { file_path: 'src/x.ts' }), true, /unavailable to the architect/)
    expect(await call(ctx, architect, 'read', { file_path: 'src/x.ts' })).toEqual({ text: 'ran:read', isError: false })
  })

  it('shows an architect only the tools it may run, following a preset switch before the first turn', async () => {
    const { ctx, repo } = await boot([])
    const names = (target: Agent): string[] => ctx.tools.schemas(target).map(schema => schema.name)
    const architect = await agent(ctx, repo, 'architect-session', 'architect')
    expect(names(architect)).toContain('read')
    for (const tool of ['write', 'consult_architect', 'appeal_ruling']) expect(names(architect)).not.toContain(tool)
    const switched = await agent(ctx, repo, 'switched-session', 'coding')
    expect(names(switched)).toContain('write')
    await ctx.agentPresets.select(switched, 'architect')
    expect(names(switched)).not.toContain('write')
    await ctx.agentPresets.select(switched, 'coding')
    expect(names(switched)).toContain('write')
  })

  it('rejects calls from a Session without a working directory', async () => {
    const { ctx } = await boot([])
    const handle = await ctx.agents.create({
      sessionId: SessionId('no-cwd'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx: Context) => {
        await ctx.agentPresets.mount(agentCtx, 'architect')
        await agentCtx.plugin(ArchitectTools)
      },
    })
    expectResult(await call(ctx, handle.agent, 'architecture_index', {}), true, /no working directory/)
  })
})

describe('consult_architect', () => {
  it('passes a continued consultation to the service and tells the worker how to continue after a timeout', async () => {
    const { ctx, repo } = await boot([
      toolCallResponse('w1', 'consult_architect', { question: 'Narrower?', continue: 'architect-7' }),
      textResponse('worker done'),
    ])
    const consult = vi.spyOn(ctx.architecture, 'consult').mockResolvedValue({
      kind: 'timeout', id: brandString<RulingId>('ruling-7'), session: brandString<SessionId>('architect-7'),
    })
    const worker = await agent(ctx, repo, 'worker', 'coding')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    worker.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await worker.whenIdle()
    expect(consult).toHaveBeenCalledWith(expect.objectContaining({ question: 'Narrower?', continue: 'architect-7' }))
    const result = worker.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(JSON.stringify(result?.data)).toContain('To continue, call consult_architect with continue: \\"architect-7\\"; its next Ruling is ruling-7.')
  })

  it('returns the validated Ruling to the worker model', async () => {
    const submission = {
      summary: 'Use the store.',
      constraints: [{ statement: 'Persist through the store.', cites: ['design/arch.md#storage'] }, { statement: 'Use YAML.', cites: [] }],
      unresolved: ['Is caching allowed?'],
    }
    const { ctx, adapter, repo } = await boot([
      toolCallResponse('w1', 'consult_architect', { question: 'Where does persistence go?', scope: ['src/store'] }),
      toolCallResponse('a1', 'submit_ruling', submission),
      textResponse('architect done'),
      textResponse('worker done'),
    ])
    const worker = await agent(ctx, repo, 'worker', 'coding')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    worker.followup(createUserMessage({ content: [{ type: 'text', text: 'add persistence' }], source: { kind: 'user' } }))
    await worker.whenIdle()

    const result = worker.session.snapshotEvents().find(event => event.type === 'tool/result')
    const text = JSON.stringify(result?.data)
    expect(text).toMatch(/Ruling ruling-[0-9a-f-]+ \(consultation architect-[0-9a-f-]+\): Use the store\./)
    expect(text).toContain('Binding constraints:\\n1. Persist through the store. (design/arch.md#storage)')
    expect(text).toContain('Unresolved, not binding:\\n- Is caching allowed?\\n- Use YAML. (no citation to an architecture section)')
    expect(adapter.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['appeal_ruling', 'consult_architect', 'read', 'write'])
    expect(JSON.stringify(adapter.requests[0]?.messages[0])).toContain('call `consult_architect`')

    const snapshot = await waitFor(async () => {
      const current = await ctx.architecture.snapshot(repo)
      return current.rulings.length === 1 ? current : undefined
    })
    const [record] = snapshot.rulings
    expect(record?.workerSession).toBe('worker')
    expect(record?.status).toBe('issued')
    expect(record?.stale).toBe(false)
    expect(record?.revision).toBe(snapshot.revision)
    expect(text).toContain(`Ruling ${record?.ruling.id} (consultation ${record?.architectSession}):`)
  })

  it('files an appeal, delivers the user decision to the worker, and records the outcome', async () => {
    const submission = { summary: 'Use the store.', constraints: [{ statement: 'Persist through the store.', cites: ['design/arch.md#storage'] }], unresolved: [] }
    const { ctx, adapter, repo } = await boot([
      toolCallResponse('w1', 'consult_architect', { question: 'Where does persistence go?' }),
      toolCallResponse('a1', 'submit_ruling', submission),
      textResponse('architect done'),
      textResponse('worker done'),
      textResponse('noted the exception'),
    ])
    const worker = await agent(ctx, repo, 'worker', 'coding')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    worker.followup(createUserMessage({ content: [{ type: 'text', text: 'add persistence' }], source: { kind: 'user' } }))
    await worker.whenIdle()
    const rulingId = (await waitFor(async () => (await ctx.architecture.snapshot(repo)).rulings[0]))?.ruling.id ?? ''

    expectResult(await call(ctx, worker, 'appeal_ruling', { rulingId, reason: ' ' }), true, /reason must be a non-empty string/)
    expectResult(await call(ctx, worker, 'appeal_ruling', { rulingId: 'ruling-unknown', reason: 'x' }), true, /no recorded Ruling ruling-unknown/)
    const other = await agent(ctx, repo, 'other', 'coding')
    expectResult(await call(ctx, other, 'appeal_ruling', { rulingId, reason: 'x' }), true, /issued to another Session/)
    const filed = await call(ctx, worker, 'appeal_ruling', { rulingId, reason: 'The store cannot stream.', evidence: ['src/stream.ts'] })
    expectResult(filed, false, new RegExp(`^Appeal appeal-[0-9a-f-]+ filed against Ruling ${rulingId}\\.`))

    let snapshot = await ctx.architecture.snapshot(repo)
    const [appeal] = snapshot.appeals
    expect(snapshot.rulings[0]?.status).toBe('appealed')
    expect(appeal).toMatchObject({ reason: 'The store cannot stream.', evidence: ['src/stream.ts'], delivered: false })
    if (appeal === undefined) return

    await ctx.architecture.adjudicate(repo, appeal.id, { kind: 'exception', scope: 'src/stream.ts', note: 'streaming only' })
    await worker.whenIdle()
    snapshot = await ctx.architecture.snapshot(repo)
    expect(snapshot.rulings[0]?.status).toBe('excepted')
    expect(snapshot.appeals[0]).toMatchObject({ adjudication: { kind: 'exception', scope: 'src/stream.ts' }, delivered: true })
    const steered = JSON.stringify(adapter.requests.at(-1)?.messages)
    expect(steered).toContain(`The user granted an exception to Ruling ${rulingId} on your appeal ${appeal.id}, limited to: src/stream.ts.`)
    expect(steered).toContain('The user notes: streaming only')
    await expect(ctx.architecture.adjudicate(repo, appeal.id, { kind: 'uphold' })).rejects.toThrow(/already decided/)
  })

  it('delivers a decision made while the worker was not live when its agent is next created', async () => {
    const submission = { summary: 'Use the store.', constraints: [], unresolved: [] }
    const { ctx, adapter, repo } = await boot([
      toolCallResponse('w1', 'consult_architect', { question: 'q' }),
      toolCallResponse('a1', 'submit_ruling', submission),
      textResponse('architect done'),
      textResponse('worker done'),
      textResponse('ok, keeping it'),
    ])
    const handle = await createAgent(ctx, repo, 'worker', 'coding')
    const worker = handle.agent
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    worker.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await worker.whenIdle()
    const rulingId = (await waitFor(async () => (await ctx.architecture.snapshot(repo)).rulings[0]))?.ruling.id ?? ''
    await call(ctx, worker, 'appeal_ruling', { rulingId, reason: 'wrong' })
    const appealId = (await ctx.architecture.snapshot(repo)).appeals[0]?.id
    if (appealId === undefined) throw new Error('appeal missing')
    await handle.dispose()
    await ctx.architecture.adjudicate(repo, appealId, { kind: 'uphold' })
    expect((await ctx.architecture.snapshot(repo)).appeals[0]?.delivered).toBe(false)

    const revived = await agent(ctx, repo, 'worker', 'coding')
    await waitFor(async () => (await ctx.architecture.snapshot(repo)).appeals[0]?.delivered === true ? true : undefined)
    await revived.whenIdle()
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain(`The user upheld Ruling ${rulingId} on your appeal ${appealId}. Keep following its constraints.`)
  })

  it('hides the worker tools and guidance from a Session outside version control', async () => {
    const { ctx, repo } = await boot([])
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-architecture-outside-')))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const inside = await agent(ctx, repo, 'inside', 'coding')
    const plain = await agent(ctx, outside, 'plain', 'coding')
    const names = (target: Agent): string[] => ctx.tools.schemas(target).map(schema => schema.name)
    expect(names(inside)).toEqual(expect.arrayContaining(['consult_architect', 'appeal_ruling']))
    expect(names(plain)).not.toContain('consult_architect')
    expect(names(plain)).not.toContain('appeal_ruling')
    expect(names(plain)).toContain('read')
    const prompt = async (target: Agent): Promise<string> => (await ctx.systemPrompt.assemble({ scope: target })).sections.map(section => section.text).join('\n')
    expect(await prompt(inside)).toContain('call `consult_architect`')
    expect(await prompt(plain)).not.toContain('call `consult_architect`')
  })

  it('renders a consultation without a Ruling', () => {
    const empty = { constraints: [], unresolved: [], proposedEdits: [] }
    expect(WorkerTools.renderConsultation({ status: 'timeout', rulingId: 'r1', consultation: 'architect-1', ...empty })).toBe(
      'The architect did not answer in time (consultation architect-1). No constraints apply yet. '
      + 'To continue, call consult_architect with continue: "architect-1"; its next Ruling is r1. Or proceed with your own judgment.',
    )
    expect(WorkerTools.renderConsultation({ status: 'no-submission', rulingId: 'r2', consultation: 'architect-2', ...empty })).toBe(
      'The architect ended without a Ruling (consultation architect-2). No constraints apply yet. '
      + 'To continue, call consult_architect with continue: "architect-2"; its next Ruling is r2. Or proceed with your own judgment.',
    )
    expect(WorkerTools.renderConsultation({ status: 'ruling', rulingId: 'r3', consultation: 'architect-3', ...empty })).toBe('Ruling r3 (consultation architect-3): \n\nNo binding constraints.')
  })

  it('tells the worker which sections a Ruling proposes to change, and that the current text governs', () => {
    const value = WorkerTools.consultValue({
      kind: 'ruling',
      session: SessionId('a'),
      revision: 'r',
      ruling: {
        id: brandString<RulingId>('r4'), question: 'q', scope: [], summary: 's', constraints: [], unresolved: [],
        proposedEdits: [{ path: brandString<SourcePath>('design/arch.md'), anchor: 'storage', hash: brandString<SectionHash>('h'), content: 'secret text', rationale: 'name the port' }],
      },
    })
    expect(value.proposedEdits).toEqual([{ section: 'design/arch.md#storage', rationale: 'name the port' }])
    expect(WorkerTools.renderConsultation(value)).toBe('Ruling r4 (consultation a): s\n\nNo binding constraints.\n\n'
      + 'Proposed record changes, waiting for the user to review and apply:\n- design/arch.md#storage: name the port\n'
      + 'Until the user applies one and it is committed on the main branch or accepted, the current text governs.')
  })

  it('logs a Ruling record that could not be written without failing the consultation', async () => {
    const { ctx, repo } = await boot([
      toolCallResponse('a1', 'submit_ruling', { summary: 's', constraints: [], unresolved: [] }),
      textResponse('architect done'),
    ])
    const worker = await agent(ctx, repo, 'worker', 'coding')
    const record = vi.spyOn(ctx.architecture, 'recordRuling').mockRejectedValueOnce(new Error('disk full'))
    const warn = vi.spyOn(ctx.logger, 'warn')
    expectResult(await call(ctx, worker, 'consult_architect', { question: 'q' }), false, /^Ruling ruling-/)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledOnce() })
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/recording Ruling ruling-[0-9a-f-]+ failed: Error: disk full/)
    expect(record).toHaveBeenCalledOnce()
  })

  it('reports a consultation that ends without a Ruling', async () => {
    const { ctx, repo } = await boot([textResponse('no ruling from me')])
    const worker = await agent(ctx, repo, 'worker', 'coding')
    const result = await call(ctx, worker, 'consult_architect', { question: 'q' })
    expectResult(result, false, /^The architect ended without a Ruling/)
  })

  it('rejects an empty question and an agentless call', async () => {
    const { ctx, repo } = await boot([])
    const worker = await agent(ctx, repo, 'worker', 'coding')
    expectResult(await call(ctx, worker, 'consult_architect', { question: '  ' }), true, /non-empty/)
    const agentless = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('x'), name: 'consult_architect', arguments: { question: 'q' } })
    expect(agentless.isError).toBe(true)
    const appealless = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('y'), name: 'appeal_ruling', arguments: { rulingId: 'r', reason: 'x' } })
    expect(appealless.isError).toBe(true)
  })
})
