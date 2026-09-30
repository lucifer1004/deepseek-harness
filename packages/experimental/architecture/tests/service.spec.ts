/** `ctx.architecture` indexes manifest sources and enforces the edit rule through the tool executor. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ArchitectureService, { describeRefusal, ManifestError } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

/** A repository on `main` with a manifest, two sources, and code; plus a linked worktree on `topic`. */
async function fixture(): Promise<{ repo: string; linked: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'docs'), { recursive: true })
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - docs/**/*.md\n')
  await writeFile(join(repo, 'docs', 'architecture.md'), '# Architecture\n\nOverview.\n\n## Storage\n\nFiles.\n')
  await writeFile(join(repo, 'docs', 'notes.txt'), 'not a source\n')
  await writeFile(join(repo, 'src', 'code.ts'), 'export const x = 1\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const linked = join(root, 'linked')
  git(repo, 'worktree', 'add', '-q', '-b', 'topic', linked)
  return { repo, linked }
}

async function boot(config: Partial<Omit<Config, 'mainBranch' | 'architectProvider' | 'architectModel' | 'architectReasoningEffort'>> & { mainBranch?: string | null } = {}): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const { mainBranch = 'main', ...rest } = config
  // A null mainBranch boots the service without a default branch.
  await ctx.plugin(ArchitectureService, { ...(mainBranch === null ? {} : { mainBranch }), ...rest })
  await ctx.plugin(Object.assign((inner: Context) => {
    for (const name of ['write', 'edit', 'str_replace_editor', 'read']) {
      inner.tools.register({
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        execute: () => Promise.resolve(`ran:${name}`),
      })
    }
  }, { inject: ['tools'] }))
  return ctx
}

/** A minimal Agent whose Session has a working directory, optionally joined to a preset. */
async function agent(ctx: Context, cwd: string, preset?: string): Promise<Agent> {
  const key = { id: `a-${cwd}` as SessionId, session: { header: { cwd } } as Session } as Agent
  await ctx.plugin(Object.assign((inner: Context) => {
    const scope = createScope(inner, key)
    Object.assign(key, { ctx: scope.ctx })
  }, { inject: ['tools', 'systemPrompt'] }))
  if (preset !== undefined) ctx.provide('agentPresets', { composedPreset: (scoped: Context) => scoped === key.ctx ? preset : undefined })
  return key
}

async function run(ctx: Context, caller: Agent, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('c1'), name, arguments: args, agent: caller })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

describe('ArchitectureService', () => {
  it('fails loud on an empty mainBranch or an escaping path', async () => {
    await expect(boot({ mainBranch: ' ' })).rejects.toThrow(/mainBranch/)
    await expect(boot({ localDirectory: '../x' })).rejects.toThrow(/localDirectory/)
    await expect(boot({ manifestPath: '/abs.yml' })).rejects.toThrow(/manifestPath/)
  })

  it('indexes manifest sources from the primary worktree, even when asked from a linked worktree', async () => {
    const { repo, linked } = await fixture()
    const ctx = await boot()
    const index = await ctx.architecture.rebuild(linked)
    expect(index?.root).toBe(repo)
    expect(index?.sources).toEqual(['docs/architecture.md'])
    expect(index?.sections.map(s => `${s.path}#${s.anchor}`)).toEqual(['docs/architecture.md#architecture', 'docs/architecture.md#storage'])
    expect(ctx.architecture.index(repo)).toBe(index)
  })

  it('reports no index without a manifest and rejects an invalid manifest', async () => {
    const { repo } = await fixture()
    const ctx = await boot()
    await rm(join(repo, 'architecture.yml'))
    expect(await ctx.architecture.rebuild(repo)).toBeUndefined()
    await writeFile(join(repo, 'architecture.yml'), 'sources: nope\n')
    await expect(ctx.architecture.rebuild(repo)).rejects.toThrow(ManifestError)
  })

  it('records oversized sources as diagnostics', async () => {
    const { repo } = await fixture()
    const ctx = await boot({ maxSourceBytes: 8 })
    const index = await ctx.architecture.rebuild(repo)
    expect(index?.sections).toEqual([])
    expect(index?.diagnostics[0]?.message).toMatch(/limit/)
  })

  it('denies built-in writes to sources, the manifest, and the local directory in every worktree', async () => {
    const { repo, linked } = await fixture()
    const ctx = await boot()
    await ctx.architecture.rebuild(repo)
    const main = await agent(ctx, repo)
    const topic = await agent(ctx, linked)
    await mkdir(join(repo, 'alias'))
    await symlink(join(repo, 'docs'), join(repo, 'alias', 'docs'))

    for (const [caller, args, name] of [
      [main, { file_path: 'docs/architecture.md' }, 'write'],
      [main, { file_path: join(repo, 'src', '..', 'docs', 'architecture.md') }, 'edit'],
      [main, { file_path: join(repo, 'alias', 'docs', 'architecture.md') }, 'edit'],
      [main, { command: 'create', path: join(repo, '.architecture', 'rulings', 'r.json') }, 'str_replace_editor'],
      [main, { file_path: 'architecture.yml' }, 'write'],
      [topic, { file_path: 'docs/architecture.md' }, 'write'],
    ] as const) {
      expect(await run(ctx, caller, name, args)).toMatch(/is an architecture source/)
    }
    expect(await run(ctx, main, 'write', { file_path: 'src/code.ts' })).toBe('ran:write')
    expect(await run(ctx, main, 'write', { file_path: 'docs/notes.txt' })).toBe('ran:write')
    expect(await run(ctx, main, 'str_replace_editor', { command: 'view', path: join(repo, 'docs', 'architecture.md') })).toBe('ran:str_replace_editor')
    expect(await run(ctx, main, 'read', { file_path: 'docs/architecture.md' })).toBe('ran:read')
  })

  it('protects the manifest and local directory before the first rebuild', async () => {
    const { repo } = await fixture()
    const ctx = await boot()
    const main = await agent(ctx, repo)
    expect(await run(ctx, main, 'write', { file_path: 'architecture.yml' })).toMatch(/architecture source/)
    expect(await run(ctx, main, 'write', { file_path: '.architecture/x.md' })).toMatch(/architecture source/)
    expect(await run(ctx, main, 'write', { file_path: 'docs/architecture.md' })).toBe('ran:write')
  })

  it('answers index and protection queries outside any checkout, and for agentless calls', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-outside-')))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const ctx = await boot()
    expect(ctx.architecture.index(outside)).toBeUndefined()
    expect(ctx.architecture.isProtected(join(outside, 'architecture.yml'))).toBe(false)
    await expect(ctx.architecture.rebuild(outside)).rejects.toThrow(/not inside a git or jj checkout/)
    expect(ctx.architecture.checkout(outside)).toBeUndefined()
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('c2'), name: 'write', arguments: { file_path: join(outside, 'x') } })
    expect(result.content[0]).toEqual({ type: 'text', text: 'ran:write' })
  })

  it('establishes a first manifest on the branch it declares, then protects every path its globs match', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-cold-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'code.ts'), 'x\n')
    git(root, 'init', '-q', '-b', 'trunk')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    const ctx = await boot({ mainBranch: null })
    const manifest = (branch: string): string => `mainBranch: ${branch}\nsources:\n  - docs/**/*.md\nexclude:\n  - docs/drafts/**\n`

    // Without a main branch, only a manifest declaring the checkout's own branch may be written.
    expect(await ctx.architecture.edit({ cwd: root, path: 'docs/architecture.md', content: '# A\n' }))
      .toMatchObject({ refusal: { kind: 'no-main-branch' } })
    expect(await ctx.architecture.edit({ cwd: root, path: 'architecture.yml', content: 'sources: [docs/*.md]\n' }))
      .toMatchObject({ refusal: { kind: 'no-main-branch' } })
    expect(await ctx.architecture.edit({ cwd: root, path: 'architecture.yml', content: manifest('main') }))
      .toMatchObject({ refusal: { kind: 'wrong-branch', branch: 'trunk', mainBranch: 'main' } })
    expect(await ctx.architecture.edit({ cwd: root, path: 'architecture.yml', content: manifest('trunk') }))
      .toEqual({ kind: 'written', path: 'architecture.yml' })
    expect(await ctx.architecture.rebuild(root)).toMatchObject({ sources: [] })

    // A source that does not exist yet is protected from file tools, and the architect may create it.
    const worker = await agent(ctx, root)
    expect(await run(ctx, worker, 'write', { file_path: 'docs/sub/new.md' })).toMatch(/is an architecture source/)
    expect(await run(ctx, worker, 'write', { file_path: 'docs/drafts/x.md' })).toBe('ran:write')
    expect(await run(ctx, worker, 'write', { file_path: 'code.ts' })).toBe('ran:write')
    expect(await ctx.architecture.edit({ cwd: root, path: 'docs/sub/new.md', content: '# New\n' })).toEqual({ kind: 'written', path: 'docs/sub/new.md' })
    expect(ctx.architecture.index(root)?.sources).toEqual(['docs/sub/new.md'])
    expect(await ctx.architecture.edit({ cwd: root, path: 'docs/drafts/x.md', content: 'x' })).toMatchObject({ refusal: { kind: 'not-protected' } })
    expect(await ctx.architecture.checkEdit(root, 'architecture.yml')).toBeUndefined()
  })

  it('declares the main branch under the edit rule and lists the branches the checkout is on', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-branch-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'architecture.yml'), '# Record\n\nsources:\n  - docs/*.md\n')
    await writeFile(join(root, 'docs', 'a.md'), '# A\n')
    git(root, 'init', '-q', '-b', 'trunk')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
    const ctx = await boot({ mainBranch: null })
    expect(await ctx.architecture.snapshot(root)).toMatchObject({ currentBranches: ['trunk'] })
    // The branch changes no section, yet the dashboard must learn of the new snapshot.
    const changes: string[] = []
    ctx.on('architecture/changed', (changed) => { changes.push(changed) })

    // An undeclared branch may be one the checkout is on.
    expect(await ctx.architecture.setMainBranch(root, 'main'))
      .toMatchObject({ kind: 'refused', refusal: { kind: 'wrong-branch', branch: 'trunk', mainBranch: 'main' } })
    expect(await ctx.architecture.setMainBranch(root, 'trunk')).toEqual({ kind: 'written', path: 'architecture.yml' })
    expect(await readFile(join(root, 'architecture.yml'), 'utf8')).toBe('# Record\n\nmainBranch: "trunk"\nsources:\n  - docs/*.md\n')
    expect((await ctx.architecture.snapshot(root)).mainBranch).toBe('trunk')
    expect(changes).toEqual([root])

    // A declared branch changes only from that branch.
    expect(await ctx.architecture.setMainBranch(root, 'main')).toEqual({ kind: 'written', path: 'architecture.yml' })
    expect(await ctx.architecture.setMainBranch(root, 'trunk'))
      .toMatchObject({ kind: 'refused', refusal: { kind: 'wrong-branch', branch: 'trunk', mainBranch: 'main' } })
    await expect(ctx.architecture.setMainBranch(root, 'a b')).rejects.toThrow(ManifestError)
    await rm(join(root, 'architecture.yml'))
    await expect(ctx.architecture.setMainBranch(root, 'trunk')).rejects.toThrow(/cannot read the manifest/)
  })

  it('protects a linked worktree copy of a source outside the primary index directory', async () => {
    const { repo, linked } = await fixture()
    const ctx = await boot({ localDirectory: '.architecture' })
    await ctx.architecture.rebuild(repo)
    expect(ctx.architecture.isProtected(join(linked, 'docs', 'architecture.md'))).toBe(true)
    expect(ctx.architecture.isProtected(join(linked, 'src', 'code.ts'))).toBe(false)
  })

  it('restricts architect-preset agents to the configured architect tools', async () => {
    const { repo } = await fixture()
    const ctx = await boot({ architectTools: ['read'] })
    const architect = await agent(ctx, repo, 'architect')
    expect(await run(ctx, architect, 'read', { file_path: 'src/code.ts' })).toBe('ran:read')
    expect(await run(ctx, architect, 'write', { file_path: 'src/code.ts' })).toMatch(/unavailable to the architect/)
  })

  it('writes architecture files only in the primary worktree on mainBranch', async () => {
    const { repo, linked } = await fixture()
    const ctx = await boot()
    await ctx.architecture.rebuild(repo)

    const written = await ctx.architecture.edit({ cwd: repo, path: 'docs/architecture.md', content: '# Architecture\n\nRevised.\n' })
    expect(written).toEqual({ kind: 'written', path: 'docs/architecture.md' })
    expect(await readFile(join(repo, 'docs', 'architecture.md'), 'utf8')).toBe('# Architecture\n\nRevised.\n')
    expect(ctx.architecture.index(repo)?.sections.map(s => s.anchor)).toEqual(['architecture'])

    expect(await ctx.architecture.edit({ cwd: repo, path: '.architecture/open/q1.md', content: '# Q1\n' })).toEqual({ kind: 'written', path: '.architecture/open/q1.md' })

    const refusals = [
      await ctx.architecture.edit({ cwd: linked, path: 'docs/architecture.md', content: 'x' }),
      await ctx.architecture.edit({ cwd: repo, path: 'src/code.ts', content: 'x' }),
      await ctx.architecture.edit({ cwd: repo, path: '../outside.md', content: 'x' }),
      await ctx.architecture.edit({ cwd: tmpdir(), path: 'a.md', content: 'x' }),
    ]
    expect(refusals.map(r => r.kind === 'refused' ? r.refusal.kind : r.kind)).toEqual(['linked-worktree', 'not-protected', 'not-protected', 'not-repository'])
    for (const r of refusals) if (r.kind === 'refused') expect(describeRefusal(r.refusal)).toMatch(/\S/)

    git(repo, 'checkout', '-q', '-b', 'side')
    const wrong = await ctx.architecture.edit({ cwd: repo, path: 'docs/architecture.md', content: 'x' })
    expect(wrong).toEqual({ kind: 'refused', refusal: { kind: 'wrong-branch', vcs: 'git', branch: 'side', mainBranch: 'main' } })
    if (wrong.kind === 'refused') expect(describeRefusal(wrong.refusal)).toMatch(/branch main/)
    git(repo, 'checkout', '-q', '--detach')
    const detached = await ctx.architecture.edit({ cwd: repo, path: 'docs/architecture.md', content: 'x' })
    if (detached.kind === 'refused') expect(describeRefusal(detached.refusal)).toMatch(/detached HEAD/)
    expect(await ctx.architecture.currentBranches(repo)).toEqual({ vcs: 'git', isPrimary: true, branches: [] })
  })

  it('takes the main branch from the manifest before the service default, and refuses edits without one', async () => {
    const { repo } = await fixture()
    git(repo, 'checkout', '-q', '-b', 'trunk')
    const ctx = await boot()
    await ctx.architecture.rebuild(repo)
    expect(await ctx.architecture.edit({ cwd: repo, path: 'docs/architecture.md', content: 'x' }))
      .toMatchObject({ refusal: { kind: 'wrong-branch', branch: 'trunk', mainBranch: 'main' } })
    // The manifest's branch wins over the default, from the next check on.
    await writeFile(join(repo, 'architecture.yml'), 'mainBranch: trunk\nsources:\n  - docs/**/*.md\n')
    expect(await ctx.architecture.edit({ cwd: repo, path: 'docs/architecture.md', content: '# Architecture\n' }))
      .toEqual({ kind: 'written', path: 'docs/architecture.md' })
    expect(await ctx.architecture.snapshot(repo)).toMatchObject({ mainBranch: 'trunk' })

    // Without a default, a manifest that names no branch leaves the sources unchangeable.
    const bare = await boot({ mainBranch: null })
    await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - docs/**/*.md\n')
    const refused = await bare.architecture.edit({ cwd: repo, path: 'docs/architecture.md', content: 'x' })
    expect(refused).toEqual({ kind: 'refused', refusal: { kind: 'no-main-branch', manifestPath: 'architecture.yml' } })
    if (refused.kind === 'refused') expect(describeRefusal(refused.refusal)).toMatch(/architecture\.yml declares mainBranch/)
    expect(await bare.architecture.snapshot(repo)).not.toHaveProperty('mainBranch')
  })

  it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(async (ctx) => {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    return ctx.plugin(ArchitectureService, { mainBranch: 'main' })
  }))

  it('withdraws the guard when the plugin unloads', async () => {
    const { repo } = await fixture()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(ArchitectureService, { mainBranch: 'main' })
    await ctx.plugin(Object.assign((inner: Context) => {
      inner.tools.register({
        name: 'write', description: 'write', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        execute: () => Promise.resolve('ran:write'),
      })
    }, { inject: ['tools'] }))
    const main = await agent(ctx, repo)
    expect(await run(ctx, main, 'write', { file_path: 'architecture.yml' })).toMatch(/architecture source/)
    await fiber.dispose()
    expect(await run(ctx, main, 'write', { file_path: 'architecture.yml' })).toBe('ran:write')
  })
})
