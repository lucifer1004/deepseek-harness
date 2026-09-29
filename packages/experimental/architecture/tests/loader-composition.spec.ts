/**
 * Real Loader composition: the package's cordis.yml row boots beside the tool
 * registry and local subprocess runtime, rebuilds a repository index, and its
 * guard denies a built-in write to an architecture source.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ArchitectureService from '../src/index.ts'

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

function moduleLoader(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: (specifier: string) => {
      if (!modules.has(specifier)) return Promise.reject(new Error(`unexpected Loader import: ${specifier}`))
      return Promise.resolve(modules.get(specifier))
    },
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

describe('real Loader composition', () => {
  it('loads the configured row, indexes the repository, and guards its sources', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-loader-')))
    const repo = join(root, 'repo')
    await mkdir(join(repo, 'docs'), { recursive: true })
    await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - docs/*.md\n')
    await writeFile(join(repo, 'docs', 'architecture.md'), '# Architecture\n')
    git(repo, 'init', '-q', '-b', 'trunk')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')

    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      '- id: architecture',
      "  name: '@deepseek-ai/dsh-experimental-architecture'",
      '  config:',
      '    mainBranch: trunk',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = moduleLoader(new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-experimental-architecture', ArchitectureService],
    ]))
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
    await context.loader.await()
    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const ctx = context
    const index = await ctx.architecture.rebuild(repo)
    expect(index?.sections.map(s => `${s.path}#${s.anchor}`)).toEqual(['docs/architecture.md#architecture'])

    ctx.tools.register({
      name: 'write',
      description: 'write',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: () => Promise.resolve('ran:write'),
    })
    const agent = { id: 'loader' as SessionId, session: { header: { cwd: repo } } as Session } as Agent
    await ctx.plugin(Object.assign((inner: Context) => {
      Object.assign(agent, { ctx: createScope(inner, agent).ctx })
    }, { inject: ['tools', 'systemPrompt'] }))
    const denied = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('c1'), name: 'write', arguments: { file_path: 'docs/architecture.md' }, agent,
    })
    expect(denied.isError).toBe(true)
    const first = denied.content[0]
    expect(first?.type === 'text' ? first.text : '').toMatch(/is an architecture source/)
    expect(await ctx.architecture.edit({ cwd: repo, path: 'docs/architecture.md', content: '# Architecture\n\nv2\n' }))
      .toEqual({ kind: 'written', path: 'docs/architecture.md' })
  })
})
