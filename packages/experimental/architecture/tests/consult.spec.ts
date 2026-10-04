/** A consultation runs an architect agent on its own preset and returns a validated Ruling. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ArchitectureService, { SUBMIT_RULING_TOOL } from '../src/index.ts'
import type { Config } from '../src/index.ts'

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

/** A repository on `main` whose `storage` section is committed and whose `draft` section is not. */
async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-consult-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'design'))
  await writeFile(join(root, 'architecture.yml'), 'sources:\n  - design/*.md\n')
  await writeFile(join(root, 'design', 'arch.md'), '# Arch\n\n## Storage\n\nAll persistence goes through the store.\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  await writeFile(join(root, 'design', 'arch.md'), '# Arch\n\n## Storage\n\nAll persistence goes through the store.\n\n## Draft\n\nNot committed yet.\n')
  await writeFile(join(root, 'design', 'new.md'), '# New\n')
  return root
}

type Script = ConstructorParameters<typeof MockAdapter>[0]

interface Booted { ctx: Context; adapter: MockAdapter; worker: Agent; repo: string }

type BootConfig = Partial<Omit<Config, 'mainBranch' | 'architectProvider' | 'architectModel' | 'architectReasoningEffort'>> & {
  mainBranch?: string | null
  /** Raw architect model fields, which the schema turns into live references. */
  architect?: { architectProvider: string; architectModel: string; architectReasoningEffort?: string }
}

async function boot(script: Script, config: BootConfig = {}): Promise<Booted> {
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
  await ctx.agentPresets.register({ id: 'architect', plugins: [{ name: tools, config: { tools: ['read', 'write', 'web_search'] } }] })
  const { mainBranch = 'main', architect = {}, ...rest } = config
  // A null mainBranch boots the service without a default branch.
  await ctx.plugin(ArchitectureService, {
    ...(mainBranch === null ? {} : { mainBranch }),
    architectTools: ['read', 'web_search', 'not_installed'],
    ...architect,
    ...rest,
  })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('worker'),
    meta: { cwd: repo },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'coding'),
  })
  return { ctx, adapter, worker: handle.agent, repo }
}

const submission = {
  summary: 'Use the store.',
  constraints: [
    { statement: 'Persist through the store.', cites: ['design/arch.md#storage', 'design/arch.md#arch'] },
    { statement: 'Follow the new doc.', cites: ['design/new.md#new'] },
    { statement: 'Follow the draft.', cites: ['design/arch.md#draft'] },
    { statement: 'Obey a missing section.', cites: ['design/arch.md#missing'] },
    { statement: 'Obey a malformed cite.', cites: ['design/arch.md'] },
    { statement: 'Obey nothing.', cites: [] },
  ],
  unresolved: ['Should caching be allowed?'],
}

describe('ArchitectureService.consult', () => {
  it('runs the architect on its own preset and keeps only constraints committed on mainBranch', async () => {
    const { ctx, adapter, worker } = await boot([toolCallResponse('s1', SUBMIT_RULING_TOOL, submission), textResponse('done')])

    const result = await ctx.architecture.consult({ worker, question: 'Where does persistence go?', scope: ['src/store'], signal: new AbortController().signal })

    expect(result.kind).toBe('ruling')
    if (result.kind !== 'ruling') return
    expect(result.ruling.summary).toBe('Use the store.')
    expect(result.ruling.constraints.map(constraint => constraint.statement)).toEqual(['Persist through the store.'])
    const citations = result.ruling.constraints[0]?.citations ?? []
    expect(citations.map(citation => `${citation.path}#${citation.anchor}`)).toEqual(['design/arch.md#storage', 'design/arch.md#arch'])
    for (const citation of citations) expect(citation.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.ruling.unresolved.map(point => [point.statement, point.reason])).toEqual([
      ['Should caching be allowed?', undefined],
      ['Follow the new doc.', '"design/new.md#new" differs from the section committed on main, or is not committed there, and the user has not accepted it'],
      ['Follow the draft.', '"design/arch.md#draft" differs from the section committed on main, or is not committed there, and the user has not accepted it'],
      ['Obey a missing section.', '"design/arch.md#missing" names no indexed architecture section'],
      ['Obey a malformed cite.', '"design/arch.md" is not a path#anchor reference'],
      ['Obey nothing.', 'no citation to an architecture section'],
    ])

    const request = adapter.requests[0] as GenerateOptions
    expect(request.tools?.map(tool => tool.name).sort()).toEqual(['read', SUBMIT_RULING_TOOL, 'web_search'])
    expect(JSON.stringify(request.messages)).toContain('Where does persistence go?\\n\\nScope: src/store')
    expect(ctx.agents.get(result.session)).toBeUndefined()
    expect(adapter.requests).toHaveLength(1)
  })

  it('keeps proposed edits of indexed sections at their current hash, and demotes the rest', async () => {
    const probe = await boot([])
    const storage = (await probe.ctx.architecture.rebuild(probe.repo))?.sections.find(section => section.anchor === 'storage')
    if (storage === undefined) throw new Error('storage missing')
    const edits = [
      { cite: 'design/arch.md#storage', hash: storage.hash, content: '## Storage\n\nThrough the port.', rationale: 'name the port' },
      { cite: 'design/arch.md#storage', hash: '0'.repeat(64), content: '## Storage\n\nX.', rationale: 'stale' },
      { cite: 'design/arch.md#missing', hash: storage.hash, content: '## Missing', rationale: 'missing' },
      { cite: 'design/arch.md', hash: storage.hash, content: '## X', rationale: 'malformed' },
      { cite: 'design/arch.md#storage', hash: storage.hash, content: '  ', rationale: 'empty' },
    ]
    const { ctx, worker } = await boot([toolCallResponse('s1', SUBMIT_RULING_TOOL, { ...submission, constraints: [], proposedEdits: edits }), textResponse('done')])
    const result = await ctx.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })
    if (result.kind !== 'ruling') throw new Error(result.kind)
    expect(result.ruling.proposedEdits).toEqual([{ path: 'design/arch.md', anchor: 'storage', hash: storage.hash, content: '## Storage\n\nThrough the port.', rationale: 'name the port' }])
    expect(result.ruling.unresolved.slice(1).map(point => [point.statement, point.reason])).toEqual([
      ['Proposed edit of design/arch.md#storage: stale', `design/arch.md#storage changed since it was read; its current hash is ${storage.hash}`],
      ['Proposed edit of design/arch.md#missing: missing', 'design/arch.md#missing is not an indexed section'],
      ['Proposed edit of design/arch.md: malformed', '"design/arch.md" is not a path#anchor reference'],
      ['Proposed edit of design/arch.md#storage: empty', 'the proposed content is empty'],
    ])
  })

  it('runs the architect on the configured model instead of the worker model', async () => {
    const { ctx, adapter, worker } = await boot([], { architect: { architectProvider: 'arch', architectModel: 'big', architectReasoningEffort: 'high' } })
    const architect = new MockAdapter([toolCallResponse('s1', SUBMIT_RULING_TOOL, submission)], {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
    })
    ctx.llm.registerAdapter(['arch'], architect)
    const result = await ctx.architecture.consult({ worker, question: 'Q', scope: [], signal: new AbortController().signal })
    expect(result.kind).toBe('ruling')
    // submit_ruling concludes the architect's turn, so it makes one request.
    expect(architect.requests.map(request => [request.provider, request.model, request.reasoningEffort])).toEqual([['arch', 'big', 'high']])
    expect(adapter.requests).toEqual([])
  })

  it('keeps the architect model\'s default reasoning effort when none is configured', async () => {
    const { ctx, worker } = await boot([], { architect: { architectProvider: 'arch', architectModel: 'big' } })
    const architect = new MockAdapter([toolCallResponse('s1', SUBMIT_RULING_TOOL, submission)])
    ctx.llm.registerAdapter(['arch'], architect)
    await ctx.architecture.consult({ worker, question: 'Q', scope: [], signal: new AbortController().signal })
    expect(architect.requests.map(request => [request.provider, request.model, request.reasoningEffort])).toEqual([['arch', 'big', undefined]])
  })

  it('binds only accepted sections when the repository declares no main branch', async () => {
    const { ctx, worker, repo } = await boot([toolCallResponse('s1', SUBMIT_RULING_TOOL, submission), textResponse('done')], { mainBranch: null })
    const index = await ctx.architecture.rebuild(repo)
    const storage = index?.sections.find(section => section.anchor === 'storage')
    if (storage === undefined) throw new Error('storage section missing')
    await ctx.architecture.accept(repo, storage.path, storage.anchor, storage.hash)
    const result = await ctx.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })
    if (result.kind !== 'ruling') throw new Error(`expected a ruling, got ${result.kind}`)
    // The accepted section binds; the committed but unaccepted #arch has no main branch to be checked against.
    expect(result.ruling.constraints).toEqual([])
    expect(result.ruling.unresolved.find(point => point.statement === 'Persist through the store.')?.reason)
      .toBe('"design/arch.md#arch" cannot be checked against a committed version because the repository declares no main branch, and the user has not accepted it')
  })

  it('executes only the first of two submissions in one response', async () => {
    const first = toolCallResponse('s1', SUBMIT_RULING_TOOL, { summary: 'first', constraints: [], unresolved: [] })
    const second = toolCallResponse('s2', SUBMIT_RULING_TOOL, { summary: 'second', constraints: [], unresolved: [] })
      .map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk)
    const combined = [...first.filter(chunk => chunk.type !== 'usage' && chunk.type !== 'finish'), ...second]
    const { ctx, worker } = await boot([combined, textResponse('done')])
    const result = await ctx.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })
    expect(result.kind === 'ruling' ? result.ruling.summary : result.kind).toBe('first')
  })

  it('reports no submission when the architect ends its turn without submitting', async () => {
    const { ctx, worker } = await boot([textResponse('I think you should use the store.')])
    const result = await ctx.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })
    expect(result.kind).toBe('no-submission')
  })

  it('cancels the architect at the consultation deadline', async () => {
    const { ctx, worker } = await boot(['hang'], { consultTimeoutMs: 50, consultNudgeMs: 40 })
    const result = await ctx.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })
    expect(result.kind).toBe('timeout')
  })

  it('states the time budget, and tells a still-working architect to submit before the deadline', async () => {
    // The architect is still reading when the notice is due; it sees the notice at its next step and submits.
    const { ctx, adapter, worker } = await boot([
      toolCallResponse('r1', 'slow_read', {}),
      toolCallResponse('s1', SUBMIT_RULING_TOOL, submission),
      textResponse('done'),
    ], { consultTimeoutMs: 60_000, consultNudgeMs: 30, architectTools: ['read', 'web_search', 'slow_read'] })
    // A slow tool keeps the architect working past the notice, so the step after it claims the notice.
    ctx.effect(() => ctx.tools.register({
      name: 'slow_read',
      description: 'fixture tool that takes longer than the notice delay',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'read' }] },
      execute: () => new Promise<string>(resolve => setTimeout(() => { resolve('read') }, 80)),
    }))
    const result = await ctx.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })
    expect(result.kind).toBe('ruling')
    const [first, second] = adapter.requests
    // A loop-built request carries the system prompt as its leading system-role message.
    expect(first?.messages[0]?.role).toBe('system')
    expect(JSON.stringify(first?.messages[0])).toContain('You have 60 seconds for this consultation')
    expect(JSON.stringify(first?.messages)).not.toContain('seconds remain')
    expect(JSON.stringify(second?.messages)).toContain('About 60 seconds remain. Stop reading and call `submit_ruling` now')
  })

  it('sends no deadline notice once the architect has submitted, even with a slow call in the same response', async () => {
    // The submission and a slow sibling call share one response, so the turn runs on past the notice delay.
    const both: Script[number] = [
      ...toolCallResponse('s1', SUBMIT_RULING_TOOL, submission).filter(chunk => chunk.type !== 'finish'),
      ...toolCallResponse('r1', 'slow_read', {}).map(chunk => 'index' in chunk ? { ...chunk, index: chunk.index + 1 } : chunk),
    ] as never
    const { ctx, adapter, worker } = await boot([both, textResponse('done')], {
      consultTimeoutMs: 60_000, consultNudgeMs: 20, architectTools: ['read', 'web_search', 'slow_read'],
    })
    ctx.effect(() => ctx.tools.register({
      name: 'slow_read',
      description: 'fixture tool that takes longer than the notice delay',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'read' }] },
      execute: () => new Promise<string>(resolve => setTimeout(() => { resolve('read') }, 80)),
    }))
    const result = await ctx.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })
    expect(result.kind).toBe('ruling')
    // Submitting concludes the turn, so the slow sibling call finishes without another request.
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests)).not.toContain('seconds remain')
  })

  it('refuses a deadline notice that is not before the hard stop', async () => {
    await expect(boot([], { consultTimeoutMs: 100, consultNudgeMs: 100 })).rejects.toThrow('consultNudgeMs (100) must be less than consultTimeoutMs (100)')
  })

  it('cancels the architect and rejects when the worker cancels during the architect turn', async () => {
    const controller = new AbortController()
    const { ctx, worker } = await boot([() => {
      controller.abort(new Error('worker cancelled'))
      return textResponse('interrupted')
    }])
    const consulting = ctx.architecture.consult({ worker, question: 'q', scope: [], signal: controller.signal })
    await expect(consulting).rejects.toThrow('worker cancelled')
    expect([...ctx.agents.list()].map(agent => agent.id)).toEqual(['worker'])
  })

  it('rejects before creating an architect when the worker already cancelled', async () => {
    const { ctx, worker } = await boot([])
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(ctx.architecture.consult({ worker, question: 'q', scope: [], signal: controller.signal })).rejects.toThrow()
  })

  it('fails loud for a worker without a working directory or without agent services', async () => {
    const { ctx, worker } = await boot([])
    const noCwd = await ctx.agents.create({ sessionId: SessionId('no-cwd'), agentOptions: { provider: 'mock', model: 'mock' } })
    await expect(ctx.architecture.consult({ worker: noCwd.agent, question: 'q', scope: [], signal: new AbortController().signal })).rejects.toThrow(/no working directory/)

    const bare = new Context()
    cleanups.push(() => bare.fiber.dispose())
    await bare.plugin((await import('@deepseek-ai/dsh-system-prompt')).default, {})
    await bare.plugin((await import('@deepseek-ai/dsh-tools')).default)
    await bare.plugin(LocalSubprocessRuntime)
    await bare.plugin(ArchitectureService, { mainBranch: 'main' })
    await expect(bare.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })).rejects.toThrow(/requires the agent registry/)
  })

  it('fails loud without a manifest', async () => {
    const { ctx, worker, repo } = await boot([])
    await rm(join(repo, 'architecture.yml'))
    await expect(ctx.architecture.consult({ worker, question: 'q', scope: [], signal: new AbortController().signal })).rejects.toThrow(/no architecture.yml/)
  })
})
