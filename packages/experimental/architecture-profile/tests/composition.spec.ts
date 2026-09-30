/**
 * Real Loader composition of the bundle patch: its rows boot beside host
 * services through `cordis:include`, and an agent on the `architect` preset
 * reaches the model with read, search, web, and architecture tools, while a
 * worker agent reaches it with `consult_architect`.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Service } from '@deepseek-ai/cordis'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresetRow from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import ArchitectureService from '@deepseek-ai/dsh-experimental-architecture'
import ArchitectureController from '@deepseek-ai/dsh-experimental-api-architecture'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import * as WorkerTools from '@deepseek-ai/dsh-experimental-tool-architecture'
import * as ArchitectTools from '@deepseek-ai/dsh-experimental-tool-architecture/architect'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WebRuntime from '@deepseek-ai/dsh-web'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

const MODULES = new Map<string, unknown>([
  ['@deepseek-ai/dsh-agent-preset', AgentPresetRow],
  ['@deepseek-ai/dsh-persona', Persona],
  ['@deepseek-ai/dsh-agent-instructions', AgentInstructions],
  ['@deepseek-ai/dsh-tool-fs', ToolFs],
  ['@deepseek-ai/dsh-tool-fs-search', ToolFsSearch],
  ['@deepseek-ai/dsh-tool-web', ToolWeb],
  ['@deepseek-ai/dsh-tool-session-query', ToolSessionQuery],
  ['@deepseek-ai/dsh-tool-ask-user', ToolAskUser],
  ['@deepseek-ai/dsh-tool-todo', ToolTodo],
  ['@deepseek-ai/dsh-experimental-architecture', ArchitectureService],
  ['@deepseek-ai/dsh-experimental-tool-architecture', WorkerTools],
  ['@deepseek-ai/dsh-experimental-tool-architecture/architect', ArchitectTools],
  ['@deepseek-ai/dsh-experimental-api-architecture', ArchitectureController],
  // The UI package's Host half is an empty marker; its browser half is a Client program this Host test cannot import.
  ['@deepseek-ai/dsh-experimental-client-ui-architecture', { apply: () => {} }],
])

const WORKSPACE = 'ws-1' as WorkspaceId

/** The Web host's Workspace registry, reduced to the lookup the dashboard Remote reads. */
class Workspaces extends Service {
  constructor(ctx: Context, private readonly path: string) {
    super(ctx, 'workspaceRegistry')
  }

  get(id: WorkspaceId): { readonly path: string } | undefined {
    return id === WORKSPACE ? { path: this.path } : undefined
  }
}

function moduleLoader(): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: (specifier: string) => {
      if (!MODULES.has(specifier)) return Promise.reject(new Error(`unexpected Loader import: ${specifier}`))
      return Promise.resolve(MODULES.get(specifier))
    },
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

describe('architecture profile bundle composition', () => {
  it('boots its rows and composes the architect and worker tool sets', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-profile-')))
    const repo = join(root, 'repo')
    await mkdir(join(repo, 'design'), { recursive: true })
    await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - design/*.md\n')
    await writeFile(join(repo, 'design', 'architecture.md'), '# Architecture\n')
    git(repo, 'init', '-q', '-b', 'trunk')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')

    // The profile names the main branch, as the README tells users to.
    const patch = [...yaml.load(await readFile(PATCH, 'utf8')) as object[], { id: 'architecture', config: { mainBranch: 'trunk' } }]
    await writeFile(join(root, 'cordis.yml'), '[]\n')
    const ctx = new Context()
    context = ctx
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = moduleLoader()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, { default: 'architect' })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: repo })
    await ctx.plugin(WebRuntime, { searchProvider: 'none', fetchProvider: 'none' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'query.db') })
    // The Gateway is not under test; the dashboard Remote only needs its service key.
    ctx.provide('typert', {})
    await ctx.plugin((inner: Context) => { new Workspaces(inner, repo) })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href, patches: patch } })
    await ctx.loader.await()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    // The architect's first step reads a file; the guard must let an allowed tool run.
    const adapter = new MockAdapter([
      toolCallResponse('read-1', 'read', { file_path: join(repo, 'design', 'architecture.md') }),
      textResponse('architect idle'),
      textResponse('worker idle'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const architect = await ctx.agents.create({
      sessionId: SessionId('architect-session'),
      meta: { cwd: repo, agentPreset: 'architect' },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'architect'),
    })
    architect.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await architect.agent.whenIdle()
    const architectTools = adapter.requests[0]?.tools?.map(tool => tool.name) ?? []
    for (const tool of ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'session_search', 'ask_user_question', 'todo_write', 'architecture_index', 'architecture_read', 'architecture_edit']) {
      expect(architectTools).toContain(tool)
    }
    // The architect sees only tools the guard lets it run: no worker tools, no generic writes.
    for (const tool of ['consult_architect', 'appeal_ruling', 'write', 'edit', 'bash']) expect(architectTools).not.toContain(tool)
    expect(JSON.stringify(adapter.requests[0]?.messages[0])).toContain('You are the architecture agent for this workspace, powered by the mock model.')
    // Worker guidance follows consult_architect's visibility: the architect sees neither.
    expect(JSON.stringify(adapter.requests[0]?.messages[0])).not.toContain('call `consult_architect`')
    const readResult = JSON.stringify(adapter.requests[1]?.messages.at(-1))
    expect(readResult).toContain('# Architecture')
    expect(readResult).not.toContain('unavailable to the architect')

    const worker = await ctx.agents.create({ sessionId: SessionId('worker'), meta: { cwd: repo }, agentOptions: { provider: 'mock', model: 'mock' } })
    worker.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await worker.agent.whenIdle()
    expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toContain('consult_architect')
    expect(adapter.requests[2]?.tools?.map(tool => tool.name)).not.toContain('architecture_edit')
    expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toContain('appeal_ruling')
    expect(JSON.stringify(adapter.requests[2]?.messages[0])).toContain('call `consult_architect`')

    // A consultation's architect child reaches the model with the architect's read tools, not only submit_ruling.
    const consultation = new MockAdapter([textResponse('no ruling')])
    ctx.llm.registerAdapter(['consult'], consultation)
    const consulting = await ctx.agents.create({ sessionId: SessionId('consulting'), meta: { cwd: repo }, agentOptions: { provider: 'consult', model: 'consult' } })
    await ctx.architecture.consult({ worker: consulting.agent, question: 'Where does storage go?', scope: [], signal: new AbortController().signal })
    const consultTools = consultation.requests[0]?.tools?.map(tool => tool.name) ?? []
    for (const tool of ['read', 'glob', 'grep', 'architecture_index', 'architecture_read', 'submit_ruling']) expect(consultTools).toContain(tool)
    for (const tool of ['architecture_edit', 'ask_user_question', 'write', 'bash']) expect(consultTools).not.toContain(tool)

    // The dashboard Remote reads the Workspace's repository through the composed service.
    const snapshot = await ctx.architectureController.snapshot(WORKSPACE, new AbortController().signal)
    expect(snapshot).toMatchObject({ mainBranch: 'trunk', hasManifest: true, rulings: [] })
    expect(snapshot.index.sources).toEqual(['design/architecture.md'])
  })
})
