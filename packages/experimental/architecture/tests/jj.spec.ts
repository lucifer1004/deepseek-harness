/** The architecture service in Jujutsu repositories: non-colocated, colocated, and secondary workspaces, against real jj. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ArchitectureService, { describeRefusal } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { JjFiles, jjString } from '../src/jj-files.ts'
import { locateCheckout } from '../src/repository.ts'
import { hasJj, jj } from './jj-support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-jj-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A jj repository whose `main` bookmark holds a manifest and one source; the working copy, a child of `main`, adds a
 * draft section and a new source file.
 */
async function repository(colocate: boolean): Promise<string> {
  const root = join(await scratch(), 'repo')
  jj(await realpath(join(root, '..')), 'git', 'init', colocate ? '--colocate' : '--no-colocate', 'repo')
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'architecture.yml'), 'mainBranch: main\nsources:\n  - docs/*.md\n')
  await writeFile(join(root, 'docs', 'arch.md'), '# Arch\n\n## Storage\n\nThrough the store.\n')
  await writeFile(join(root, '.gitignore'), 'docs/ignored.md\n')
  jj(root, 'describe', '-m', 'init')
  jj(root, 'bookmark', 'create', 'main', '-r', '@')
  jj(root, 'new')
  await writeFile(join(root, 'docs', 'arch.md'), '# Arch\n\n## Storage\n\nThrough the store.\n\n## Draft\n\nNot on main.\n')
  await writeFile(join(root, 'docs', 'new.md'), '# New\n')
  await writeFile(join(root, 'docs', 'ignored.md'), '# Ignored\n')
  return root
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ArchitectureService, {} as Config)
  return ctx
}

// Each jj command takes about 0.2 s, so these tests run for seconds.
describe('jjString', () => {
  it('quotes backslashes and double quotes', () => {
    expect(jjString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})

describe('locateCheckout for jj metadata', () => {
  it('ignores a .jj directory without a readable repository pointer and falls back to git', async () => {
    const root = await scratch()
    await mkdir(join(root, '.jj'))
    expect(locateCheckout(root)).toBeUndefined()
    await writeFile(join(root, '.jj', 'repo'), '')
    expect(locateCheckout(root)).toBeUndefined()
    await writeFile(join(root, '.jj', 'repo'), '../missing/.jj/repo')
    expect(locateCheckout(root)).toBeUndefined()
    // An absolute pointer names the primary workspace's repository directory.
    const primary = await scratch()
    await mkdir(join(primary, '.jj', 'repo'), { recursive: true })
    await writeFile(join(root, '.jj', 'repo'), join(primary, '.jj', 'repo'))
    expect(locateCheckout(root)).toEqual({ vcs: 'jj', root, primaryRoot: primary, isPrimary: false, branch: undefined })
  })
})

describe.skipIf(!hasJj())('ArchitectureService in a jj repository', { timeout: 30_000 }, () => {
  it.each([['non-colocated', false], ['colocated', true]])('indexes, verifies, and guards a %s repository', async (_label, colocate) => {
    const repo = await repository(colocate)
    expect(locateCheckout(join(repo, 'docs'))).toEqual({ vcs: 'jj', root: repo, primaryRoot: repo, isPrimary: true, branch: undefined })
    const ctx = await boot()

    const index = await ctx.architecture.rebuild(repo)
    expect(index?.sources).toEqual(['docs/arch.md', 'docs/new.md'])
    const snapshot = await ctx.architecture.snapshot(repo)
    expect(snapshot).toMatchObject({ vcs: 'jj', mainBranch: 'main', sourceStatus: { 'docs/arch.md': 'modified', 'docs/new.md': 'untracked' } })
    const draft = index?.sections.find(section => section.anchor === 'draft')
    const storage = index?.sections.find(section => section.anchor === 'storage')
    if (draft === undefined || storage === undefined) throw new Error('sections missing')

    // `@` is a child of `main`, so the primary workspace may change the record.
    expect(await ctx.architecture.checkEdit(repo, 'docs/arch.md')).toBeUndefined()
    expect(await ctx.architecture.edit({ cwd: repo, path: 'docs/third.md', content: '# Third\n' })).toEqual({ kind: 'written', path: 'docs/third.md' })
    expect(ctx.architecture.isProtected(join(repo, 'docs', 'fourth.md'))).toBe(true)
    // A working copy two commits past `main` is off the branch.
    jj(repo, 'new')
    const refusal = await ctx.architecture.checkEdit(repo, 'docs/arch.md')
    expect(refusal).toMatchObject({ kind: 'wrong-branch', vcs: 'jj', mainBranch: 'main' })
    if (refusal !== undefined) expect(describeRefusal(refusal)).toBe('architecture sources change only on bookmark main; the working-copy commit is neither main nor its child')
    expect(await readFile(join(repo, 'docs', 'third.md'), 'utf8')).toBe('# Third\n')

    // Accepting the draft lets a Ruling cite it; the storage section is committed on `main`.
    await ctx.architecture.accept(repo, draft.path, draft.anchor, draft.hash)
    expect((await ctx.architecture.snapshot(repo)).acceptances).toHaveLength(1)
  })

  it('reads a source as committed on the main bookmark', async () => {
    const repo = await repository(false)
    const ctx = await boot()
    const files = new JjFiles(ctx.subprocess, await ctx.subprocess.resolveExecutable('jj'), { timeoutMs: 10_000, outputMaxBytes: 1_000_000 })
    expect(await files.committed(repo, 'main', 'docs/arch.md', undefined)).toBe('# Arch\n\n## Storage\n\nThrough the store.\n')
    expect(await files.committed(repo, 'main', 'docs/new.md', undefined)).toBeUndefined()
    expect(await files.committed(repo, 'nope', 'docs/arch.md', undefined)).toBeUndefined()
    expect(await files.status(repo, 'main', [], undefined)).toEqual(new Map())
    expect(await ctx.architecture.currentBranches(repo)).toEqual({ vcs: 'jj', isPrimary: true, branches: ['main'] })
    expect(await files.status(repo, 'main', ['docs/ignored.md'], undefined)).toEqual(new Map([['docs/ignored.md', 'ignored']]))
    expect(await files.status(repo, undefined, ['docs/ignored.md', 'docs/new.md'], undefined))
      .toEqual(new Map([['docs/ignored.md', 'ignored'], ['docs/new.md', 'untracked']]))
    // Two concurrent operations that move one bookmark leave it conflicted.
    jj(repo, 'bookmark', 'create', 'side', '-r', '@-')
    const operation = jj(repo, 'op', 'log', '--no-graph', '-T', 'id ++ "\\n"', '--limit', '1').trim()
    jj(repo, 'bookmark', 'set', 'side', '-r', '@')
    jj(repo, '--at-op', operation, 'bookmark', 'set', 'side', '-r', 'root()', '--allow-backwards')
    await expect(files.committed(repo, 'side', 'docs/arch.md', undefined)).rejects.toThrow(/jj file show failed/)
    await expect(files.list(await scratch(), [], undefined)).rejects.toThrow(/jj file list failed/)
  })

  it('treats a secondary workspace as linked and protects its copy of the sources', async () => {
    const repo = await repository(false)
    const second = join(repo, '..', 'second')
    jj(repo, 'workspace', 'add', second)
    const secondRoot = await realpath(second)
    expect(locateCheckout(secondRoot)).toEqual({ vcs: 'jj', root: secondRoot, primaryRoot: repo, isPrimary: false, branch: undefined })
    const ctx = await boot()
    await ctx.architecture.rebuild(secondRoot)
    expect(ctx.architecture.isProtected(join(secondRoot, 'docs', 'arch.md'))).toBe(true)
    expect(await ctx.architecture.edit({ cwd: secondRoot, path: 'docs/arch.md', content: 'x' }))
      .toEqual({ kind: 'refused', refusal: { kind: 'linked-worktree', root: secondRoot, primaryRoot: repo } })
  })

  it('reads a missing bookmark or path as uncommitted', async () => {
    const repo = await repository(false)
    await writeFile(join(repo, 'architecture.yml'), 'mainBranch: trunk\nsources:\n  - docs/*.md\n')
    const ctx = await boot()
    expect(await ctx.architecture.snapshot(repo)).toMatchObject({ mainBranch: 'trunk' })
    expect(await ctx.architecture.checkEdit(repo, 'docs/arch.md')).toMatchObject({ kind: 'wrong-branch', vcs: 'jj', mainBranch: 'trunk' })
  })
})
