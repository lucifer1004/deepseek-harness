/** Worker and architect tools run through the tool executor against a real repository and a real agent loop. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import ArchitectureService from '@deepseek-ai/dsh-experimental-architecture'
import type { Config as ArchitectureConfig } from '@deepseek-ai/dsh-experimental-architecture'
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
  await ctx.plugin(ArchitectureService, { mainBranch: 'main', architectTools: ARCHITECT_TOOLS } as ArchitectureConfig)
  await ctx.plugin(WorkerTools)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, repo }
}

/** An agent on `preset`; the architect preset also mounts the architect tools, as the profile's preset row does. */
async function agent(ctx: Context, repo: string, id: string, preset: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: repo, agentPreset: preset },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, preset)
      if (preset === 'architect') await agentCtx.plugin(ArchitectTools)
    },
  })
  return handle.agent
}

async function call(ctx: Context, caller: Agent, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`c-${name}`), name, arguments: args, agent: caller })
  const first = result.content[0]
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError ?? false }
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
    expect(await call(ctx, architect, 'architecture_index', {})).toEqual({ text: 'This workspace has no architecture manifest yet.', isError: false })
  })

  it('keeps generic write tools unavailable to an architect-preset Session', async () => {
    const { ctx, repo } = await boot([])
    const architect = await agent(ctx, repo, 'architect-session', 'architect')
    expectResult(await call(ctx, architect, 'write', { file_path: 'src/x.ts' }), true, /unavailable to the architect/)
    expect(await call(ctx, architect, 'read', { file_path: 'src/x.ts' })).toEqual({ text: 'ran:read', isError: false })
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
    expect(text).toMatch(/Ruling ruling-[0-9a-f-]+: Use the store\./)
    expect(text).toContain('Binding constraints:\\n1. Persist through the store. (design/arch.md#storage)')
    expect(text).toContain('Unresolved, not binding:\\n- Is caching allowed?\\n- Use YAML. (no citation to an architecture section)')
    expect(adapter.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['consult_architect', 'read', 'write'])
    expect(JSON.stringify(adapter.requests[0]?.messages[0])).toContain('call `consult_architect`')
  })

  it('renders a consultation without a Ruling', () => {
    expect(WorkerTools.renderConsultation({ status: 'timeout', rulingId: 'r1', constraints: [], unresolved: [] })).toMatch(/did not answer in time \(r1\)/)
    expect(WorkerTools.renderConsultation({ status: 'no-submission', rulingId: 'r2', constraints: [], unresolved: [] })).toMatch(/ended without a Ruling \(r2\)/)
    expect(WorkerTools.renderConsultation({ status: 'ruling', rulingId: 'r3', constraints: [], unresolved: [] })).toBe('Ruling r3: \n\nNo binding constraints.')
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
  })
})
