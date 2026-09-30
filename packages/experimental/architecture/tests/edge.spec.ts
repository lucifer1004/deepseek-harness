/** Failure and edge paths of the git file listing, checkout locator, index builder, and section text. */
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitFiles } from '../src/git-files.ts'
import { buildIndex } from '../src/index-builder.ts'
import { parseManifest } from '../src/manifest.ts'
import { locateCheckout } from '../src/repository.ts'
import { indexSections } from '../src/sections.ts'
import type { SourcePath } from '../src/types.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-edge-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

async function gitFiles(limits: { timeoutMs?: number; outputMaxBytes?: number } = {}): Promise<GitFiles> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const executable = await ctx.subprocess.resolveExecutable('git')
  return new GitFiles(ctx.subprocess, executable, {
    timeoutMs: limits.timeoutMs ?? 10_000,
    outputMaxBytes: limits.outputMaxBytes ?? 1_000_000,
  })
}

describe('GitFiles', () => {
  it('lists tracked and untracked unignored files', async () => {
    const repo = await scratch()
    git(repo, 'init', '-q', '-b', 'main')
    await writeFile(join(repo, '.gitignore'), 'ignored.md\n')
    await writeFile(join(repo, 'a.md'), 'a')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    await writeFile(join(repo, 'new.md'), 'n')
    await writeFile(join(repo, 'ignored.md'), 'i')
    const files = await gitFiles()
    expect([...await files.list(repo, ['*'], new AbortController().signal)].sort()).toEqual(['.gitignore', 'a.md', 'new.md'])
  })

  it('fails outside a repository, above the output cap, and when aborted', async () => {
    const outside = await scratch()
    await expect((await gitFiles()).list(outside, ['*'], undefined)).rejects.toThrow(/ls-files failed/)

    const repo = await scratch()
    git(repo, 'init', '-q', '-b', 'main')
    await writeFile(join(repo, 'a-long-file-name.md'), 'a')
    await expect((await gitFiles({ outputMaxBytes: 4 })).list(repo, ['*'], undefined)).rejects.toThrow(/exceeded 4 bytes/)

    const aborted = new AbortController()
    aborted.abort()
    await expect((await gitFiles()).list(repo, ['*'], aborted.signal)).rejects.toThrow(/aborted before spawn/)

    const midway = new AbortController()
    const listing = (await gitFiles()).list(repo, ['*'], midway.signal)
    midway.abort()
    await expect(listing).rejects.toThrow(/^git ls-files was aborted$/)
  })

  it('reads a committed file, and reports a missing branch or path as absent', async () => {
    const repo = await scratch()
    git(repo, 'init', '-q', '-b', 'main')
    await writeFile(join(repo, 'a.md'), '# A\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    const files = await gitFiles()
    expect(await files.committed(repo, 'main', 'a.md', undefined)).toBe('# A\n')
    expect(await files.committed(repo, 'main', 'missing.md', undefined)).toBeUndefined()
    expect(await files.committed(repo, 'nope', 'a.md', undefined)).toBeUndefined()
    await expect(files.committed(await scratch(), 'main', 'a.md', undefined)).rejects.toThrow(/git cat-file failed/)
  })

  it('limits the listing to the given globs, including dot directories', async () => {
    const repo = await scratch()
    git(repo, 'init', '-q', '-b', 'main')
    await mkdir(join(repo, 'design', 'sub'), { recursive: true })
    await mkdir(join(repo, '.notes'))
    for (const file of ['design/a.md', 'design/sub/b.md', '.notes/c.md', 'src.ts']) await writeFile(join(repo, file), 'x')
    const files = await gitFiles()
    expect([...await files.list(repo, ['design/*.md', '.notes/**/*.md'], undefined)].sort()).toEqual(['.notes/c.md', 'design/a.md'])
  })

  it('rejects a listing that ends mid-entry', async () => {
    const root = await scratch()
    const fake = join(root, 'fake-git')
    await writeFile(fake, '#!/bin/sh\nprintf \'a.md\\0partial\'\n', { mode: 0o755 })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const files = new GitFiles(ctx.subprocess, fake, { timeoutMs: 10_000, outputMaxBytes: 1_000 })
    await expect(files.list(root, ['*'], undefined)).rejects.toThrow(/ended mid-entry/)
  })

  it('reports the status of modified, untracked, and ignored paths, and rejects a failed or truncated status', async () => {
    const repo = await scratch()
    git(repo, 'init', '-q', '-b', 'main')
    await writeFile(join(repo, '.gitignore'), 'ign.md\n')
    await writeFile(join(repo, 'a.md'), 'a')
    await writeFile(join(repo, 'b.md'), 'b')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    await writeFile(join(repo, 'a.md'), 'changed')
    await writeFile(join(repo, 'new.md'), 'n')
    await writeFile(join(repo, 'ign.md'), 'i')
    const files = await gitFiles()
    expect(Object.fromEntries(await files.status(repo, undefined, ['a.md', 'b.md', 'new.md', 'ign.md'], undefined)))
      .toEqual({ 'a.md': 'modified', 'new.md': 'untracked', 'ign.md': 'ignored' })
    expect((await files.status(repo, undefined, [], undefined)).size).toBe(0)
    await expect(files.status(await scratch(), undefined, ['a.md'], undefined)).rejects.toThrow(/git status failed/)

    const fake = join(repo, 'fake-git')
    await writeFile(fake, '#!/bin/sh\nprintf \' M a.md\\0partial\'\n', { mode: 0o755 })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const truncated = new GitFiles(ctx.subprocess, fake, { timeoutMs: 10_000, outputMaxBytes: 1_000 })
    await expect(truncated.status(repo, undefined, ['a.md'], undefined)).rejects.toThrow(/status output ended mid-entry/)
  })

  it('reports a timeout', async () => {
    const repo = await scratch()
    git(repo, 'init', '-q', '-b', 'main')
    await expect((await gitFiles({ timeoutMs: 1 })).list(repo, ['*'], undefined)).rejects.toThrow(/timed out after 1ms/)
  })
})

describe('locateCheckout', () => {
  it('follows a relative gitdir pointer and treats every checkout of a bare repository as linked', async () => {
    const root = await scratch()
    const bare = join(root, 'bare.git')
    git(root, 'init', '-q', '--bare', '-b', 'main', bare)
    const seed = join(root, 'seed')
    git(root, 'init', '-q', '-b', 'main', seed)
    await writeFile(join(seed, 'a.md'), 'a')
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'init')
    git(seed, 'push', '-q', bare, 'main')
    const work = join(root, 'work')
    git(bare, 'worktree', 'add', '-q', work, 'main')
    expect(locateCheckout(work)).toEqual({ vcs: 'git', root: work, primaryRoot: bare, isPrimary: false, branch: 'main' })

    const absolute = join(root, 'absolute')
    await mkdir(join(absolute, 'gitdir'), { recursive: true })
    await writeFile(join(absolute, '.git'), `gitdir: ${join(absolute, 'gitdir')}\n`)
    await writeFile(join(absolute, 'gitdir', 'commondir'), `${join(root, 'seed', '.git')}\n`)
    await writeFile(join(absolute, 'gitdir', 'HEAD'), 'ref: refs/heads/topic\n')
    expect(locateCheckout(absolute)).toEqual({ vcs: 'git', root: absolute, primaryRoot: join(root, 'seed'), isPrimary: false, branch: 'topic' })

    const relative = join(root, 'relative')
    await mkdir(relative)
    const gitDir = join(root, 'seed', '.git')
    await writeFile(join(relative, '.git'), 'gitdir: ../seed/.git\n')
    expect(locateCheckout(relative)).toMatchObject({ root: relative, primaryRoot: relative, isPrimary: true, branch: 'main' })
    expect(gitDir).toContain('seed')
  })

  it('rejects a malformed .git file and a filesystem root without .git', async () => {
    const root = await scratch()
    await writeFile(join(root, '.git'), 'not a pointer\n')
    expect(locateCheckout(root)).toBeUndefined()
    await writeFile(join(root, '.git'), 'gitdir:   \n')
    expect(locateCheckout(root)).toBeUndefined()
    expect(locateCheckout('/')).toBeUndefined()
  })

  it('treats a special file named .git as absent', async () => {
    const root = await scratch()
    git(root, 'init', '-q', '-b', 'main')
    const child = join(root, 'child')
    await mkdir(child)
    execFileSync('mkfifo', [join(child, '.git')])
    expect(locateCheckout(child)?.root).toBe(root)
  })
})


describe('buildIndex', () => {
  it('indexes Markdown sections, keeps non-Markdown sources as sources, and records unreadable sources', async () => {
    const root = await scratch()
    await writeFile(join(root, 'a.md'), '# A\n')
    await writeFile(join(root, 'b.yml'), 'x: 1\n')
    await writeFile(join(root, 'bad.md'), Uint8Array.of(0xff, 0xfe))
    await writeFile(join(root, 'locked.md'), '# L\n')
    await chmod(join(root, 'locked.md'), 0o000)
    cleanups.push(() => chmod(join(root, 'locked.md'), 0o600))
    const index = await buildIndex({
      root,
      manifest: parseManifest('sources: ["*.md", "*.yml", "gone.md"]\n', 'm'),
      maxSourceBytes: 1024,
      listFiles: () => Promise.resolve(['a.md', 'b.yml', 'bad.md', 'locked.md', 'gone.md']),
      signal: new AbortController().signal,
    })
    expect(index.sources).toEqual(['a.md', 'b.yml', 'bad.md', 'gone.md', 'locked.md'])
    expect(index.sections.map(s => s.path)).toEqual(['a.md'])
    expect(index.diagnostics.map(d => d.path).sort()).toEqual(process.getuid?.() === 0 ? ['bad.md', 'gone.md'] : ['bad.md', 'gone.md', 'locked.md'])
  })

  it('propagates cancellation instead of recording it as a diagnostic', async () => {
    const root = await scratch()
    await writeFile(join(root, 'a.md'), '# A\n')
    const controller = new AbortController()
    const building = buildIndex({
      root,
      manifest: parseManifest('sources: ["*.md"]\n', 'm'),
      maxSourceBytes: 1024,
      listFiles: () => {
        controller.abort()
        return Promise.resolve(['a.md'])
      },
      signal: controller.signal,
    })
    await expect(building).rejects.toThrow()
  })
})

describe('indexSections heading text', () => {
  it('renders images, hard breaks, and HTML inside headings as GitHub heading text', () => {
    const titles = indexSections(brandString<SourcePath>('a.md'), '# ![Logo](x.png) and <b>html</b>\n\nSetext\\\nline\n======\n\n# ![][ref]\n\n[ref]: y.png\n')
      .map(section => section.title)
    expect(titles).toEqual(['Logo and html', 'Setextline', ''])
  })

  it('indexes a document without headings as one preamble section', () => {
    expect(indexSections(brandString<SourcePath>('a.md'), 'just text\n').map(s => [s.anchor, s.level])).toEqual([['', 0]])
  })

  it('names the source in YAML errors', () => {
    expect(() => parseManifest('sources: [a\n', 'arch.yml')).toThrow(/^arch\.yml: invalid YAML/)
  })
})
