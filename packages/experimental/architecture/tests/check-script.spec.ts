/** The commit check refuses architecture-source changes made outside the primary checkout; the range check lists them. */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hasJj, jj, JJ_ENV } from './jj-support.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/check-architecture.sh', import.meta.url))
const ENV = { ...JJ_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV })
}

function expectFailure(result: { status: number | null; stderr: string }, status: number, stderr: RegExp): void {
  expect(result.status).toBe(status)
  expect(result.stderr).toMatch(stderr)
}

function check(cwd: string, ...args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync('sh', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: ENV })
  return { status: result.status, stderr: result.stderr }
}

/** Run the range mode, which reports on stdout. */
function range(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: ENV })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A repository on `main` with a manifest, one source, and code; plus a linked worktree on `topic`. */
async function fixture(manifest = 'sources:\n  - design/**/*.md  # all design docs\n  - "notes/*.md"\nexclude:\n  - \'**/*.zh.md\'\n') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-check-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'design', 'sub'), { recursive: true })
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'architecture.yml'), manifest)
  await writeFile(join(repo, 'design', 'sub', 'arch.md'), '# Arch\n')
  await writeFile(join(repo, 'src', 'code.ts'), 'x\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const linked = join(root, 'linked')
  git(repo, 'worktree', 'add', '-q', '-b', 'topic', linked)
  return { root, repo, linked }
}

describe('check-architecture.sh staged', () => {
  it('allows source changes in the primary worktree on any branch, including a detached HEAD', async () => {
    const { repo } = await fixture()
    await writeFile(join(repo, 'design', 'sub', 'arch.md'), '# Arch\n\nMore.\n')
    git(repo, 'add', '-A')
    expect(check(repo, 'staged')).toEqual({ status: 0, stderr: '' })
    git(repo, 'checkout', '-q', '-b', 'feature')
    await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - design/**/*.md\n')
    git(repo, 'add', '-A')
    expect(check(repo, 'staged')).toEqual({ status: 0, stderr: '' })
    git(repo, 'checkout', '-q', '--detach')
    expect(check(repo, 'staged')).toEqual({ status: 0, stderr: '' })
  })

  it('refuses source and manifest changes in a linked worktree', async () => {
    const { linked } = await fixture()
    await writeFile(join(linked, 'design', 'sub', 'arch.md'), '# Changed\n')
    await writeFile(join(linked, 'architecture.yml'), 'mainBranch: topic\nsources:\n  - design/**/*.md\n')
    await writeFile(join(linked, 'notes.md'), 'not a source\n')
    git(linked, 'add', '-A')
    expect(check(linked, 'staged')).toEqual({
      status: 1,
      stderr: 'check-architecture: architecture sources change only in the primary worktree; this commit from a linked worktree changes:\n'
        + '  architecture.yml\n  design/sub/arch.md\n',
    })
  })

  it('ignores code, excluded sources, and repositories without a manifest', async () => {
    const { repo, linked } = await fixture()
    await writeFile(join(linked, 'src', 'code.ts'), 'y\n')
    await writeFile(join(linked, 'design', 'sub', 'arch.zh.md'), '# 架构\n')
    git(linked, 'add', '-A')
    expect(check(linked, 'staged').status).toBe(0)
    await rm(join(repo, 'architecture.yml'))
    expect(check(repo, 'staged').status).toBe(0)
  })

  it('reads a custom manifest path', async () => {
    const { repo, linked } = await fixture()
    git(repo, 'mv', 'architecture.yml', 'arch.yml')
    git(repo, 'commit', '-q', '-m', 'rename')
    git(linked, 'merge', '-q', 'main')
    await writeFile(join(linked, 'design', 'sub', 'arch.md'), '# Changed\n')
    git(linked, 'add', '-A')
    expect(check(linked, 'staged').status).toBe(0)
    expect(check(linked, '--manifest', 'arch.yml', 'staged').status).toBe(1)
  })
})

describe('check-architecture.sh range', () => {
  it('lists the sources a range changes without failing', async () => {
    const { repo, linked } = await fixture('mainBranch: main\nsources:\n  - design/**/*.md\n')
    await writeFile(join(linked, 'src', 'code.ts'), 'y\n')
    git(linked, 'commit', '-q', '-am', 'code')
    expect(range(linked, 'range', 'main', 'HEAD')).toEqual({ status: 0, stdout: '', stderr: '' })
    await writeFile(join(linked, 'design', 'sub', 'arch.md'), '# Changed\n')
    git(linked, 'commit', '-q', '-am', 'doc')
    expect(range(linked, 'range', 'main', 'HEAD')).toEqual({
      status: 0,
      stdout: 'check-architecture: main...HEAD changes architecture sources; review them before merging:\n  design/sub/arch.md\n',
      stderr: '',
    })
    // A head without a manifest has nothing to list.
    git(repo, 'rm', '-q', 'architecture.yml')
    git(repo, 'commit', '-q', '-m', 'drop')
    expect(range(repo, 'range', 'topic', 'main')).toEqual({ status: 0, stdout: '', stderr: '' })
  })
})

describe('check-architecture.sh errors', () => {
  it('rejects bad usage', async () => {
    const { repo } = await fixture()
    for (const args of [[], ['staged', 'extra'], ['range', 'a'], ['other'], ['--bogus'], ['--main-branch', 'main', 'staged'], ['--manifest']]) {
      const result = check(repo, ...args)
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/^usage: /)
    }
    expect(check(repo, '--', 'staged').status).toBe(0)
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-check-outside-')))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    expect(check(outside, 'staged')).toEqual({ status: 2, stderr: 'check-architecture: not inside a git or jj checkout\n' })
    expectFailure(check(repo, 'working'), 2, /working mode checks jj repositories/)
  })

  it.each([
    ['flow style', 'sources: [design/*.md]\n', /architecture\.yml:1: unsupported manifest syntax/],
    ['orphan item', '  - design/*.md\n', /architecture\.yml:1: list item outside sources or exclude/],
    ['empty glob', 'sources:\n  - ""\n', /architecture\.yml:2: empty glob/],
    ['no sources', '# nothing\nexclude:\n  - x\n', /no sources/],
    ['a spaced main branch', 'mainBranch: a b\nsources:\n  - x\n', /architecture\.yml:1: mainBranch must be one branch name/],
  ])('refuses a manifest it cannot read: %s', async (_name, manifest, message) => {
    const { repo } = await fixture(manifest)
    const result = check(repo, 'staged')
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(message)
  })
})

// Each jj command takes about 0.2 s, so these tests run for seconds.
describe.skipIf(!hasJj())('check-architecture.sh in a jj repository', { timeout: 30_000 }, () => {
  /** A non-colocated jj repository whose `main` bookmark holds a manifest, one source, and code; `@` is its child. */
  async function jjFixture(manifest = 'mainBranch: main\nsources:\n  - design/**/*.md\nexclude:\n  - "**/*.zh.md"\n') {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-check-jj-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    jj(root, 'git', 'init', '--no-colocate', 'repo')
    const repo = join(root, 'repo')
    await mkdir(join(repo, 'design', 'sub'), { recursive: true })
    await mkdir(join(repo, 'src'))
    await writeFile(join(repo, 'architecture.yml'), manifest)
    await writeFile(join(repo, 'design', 'sub', 'arch.md'), '# Arch\n')
    await writeFile(join(repo, 'src', 'code.ts'), 'x\n')
    jj(repo, 'describe', '-m', 'init')
    jj(repo, 'bookmark', 'create', 'main', '-r', '@')
    jj(repo, 'new')
    return { root, repo }
  }

  it('allows source changes in the primary workspace wherever the working copy is, from any directory', async () => {
    const { repo } = await jjFixture()
    await writeFile(join(repo, 'design', 'sub', 'arch.md'), '# Arch\n\nMore.\n')
    expect(check(repo, 'working')).toEqual({ status: 0, stderr: '' })
    expect(check(join(repo, 'design'), 'working')).toEqual({ status: 0, stderr: '' })
    // Two commits past main, far from any bookmark.
    jj(repo, 'new')
    await writeFile(join(repo, 'architecture.yml'), 'mainBranch: main\nsources:\n  - design/**/*.md\n')
    expect(check(repo, 'working')).toEqual({ status: 0, stderr: '' })
  })

  it('refuses source and manifest changes in a secondary workspace, and ignores code and excludes', async () => {
    const { root, repo } = await jjFixture()
    const second = join(root, 'second')
    jj(repo, 'workspace', 'add', '-r', 'main', second)
    await writeFile(join(second, 'src', 'code.ts'), 'y\n')
    await writeFile(join(second, 'design', 'sub', 'arch.zh.md'), '# 中文\n')
    expect(check(second, 'working')).toEqual({ status: 0, stderr: '' })
    await writeFile(join(second, 'design', 'sub', 'new.md'), '# New\n')
    await writeFile(join(second, 'architecture.yml'), 'mainBranch: main\nsources:\n  - design/**/*.md\n')
    expect(check(second, 'working')).toEqual({
      status: 1,
      stderr: 'check-architecture: architecture sources change only in the primary workspace; this secondary workspace changes:\n'
        + '  architecture.yml\n  design/sub/arch.zh.md\n  design/sub/new.md\n',
    })
  })

  it('diffs a secondary workspace from its parent when the manifest declares no main branch', async () => {
    const { root, repo } = await jjFixture('sources:\n  - design/*.md\n')
    const second = join(root, 'second')
    jj(repo, 'workspace', 'add', '-r', 'main', second)
    await writeFile(join(second, 'design', 'a.md'), '# A\n')
    expectFailure(check(second, 'working'), 1, /this secondary workspace changes:\n {2}design\/a\.md\n$/)
  })

  it('lists the sources a revset range changes against the manifest at its head, without failing', async () => {
    const { repo } = await jjFixture()
    jj(repo, 'describe', '-m', 'code')
    await writeFile(join(repo, 'src', 'code.ts'), 'y\n')
    jj(repo, 'new')
    expect(range(repo, 'range', 'main', '@-')).toEqual({ status: 0, stdout: '', stderr: '' })
    await writeFile(join(repo, 'design', 'sub', 'arch.md'), '# Changed\n')
    jj(repo, 'describe', '-m', 'source')
    jj(repo, 'new')
    expect(range(repo, 'range', 'main', '@-')).toEqual({
      status: 0, stdout: 'check-architecture: main...@- changes architecture sources; review them before merging:\n  design/sub/arch.md\n', stderr: '',
    })
    // A head without a manifest has nothing to list; a revset that names no commit is an error.
    expect(range(repo, 'range', 'root()', 'root()')).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(check(repo, 'range', 'main', 'nope').status).toBe(2)
    expect(check(repo, 'range', 'nope', '@-').status).toBe(2)
  })

  it('fails loud in a jj repository when jj is not installed', async () => {
    const { repo } = await jjFixture()
    // A PATH without jj: the directories of the tools the script itself runs.
    const tools = ['sh', 'sed', 'awk', 'dirname', 'cat', 'git'].map(tool => execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim())
    const path = [...new Set(tools.map(tool => tool.slice(0, tool.lastIndexOf('/'))))].filter(dir => !existsSync(join(dir, 'jj'))).join(':')
    const result = spawnSync('sh', [SCRIPT, 'working'], { cwd: repo, encoding: 'utf8', env: { ...ENV, PATH: path } })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 2, stderr: `check-architecture: ${repo} is a jj repository, but jj is not installed\n` })
  })

  it('refuses the staged mode, and reads a colocated repository through jj', async () => {
    const { repo } = await jjFixture()
    expectFailure(check(repo, 'staged'), 2, /jj has no staging area/)
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-check-colocated-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    jj(root, 'git', 'init', '--colocate', 'repo')
    const colocated = join(root, 'repo')
    await writeFile(join(colocated, 'architecture.yml'), 'mainBranch: main\nsources:\n  - "*.md"\n')
    jj(colocated, 'bookmark', 'create', 'main', '-r', '@')
    jj(colocated, 'new')
    const second = join(root, 'second')
    jj(colocated, 'workspace', 'add', '-r', 'main', second)
    await writeFile(join(second, 'a "quoted" \\ name.md'), '# A\n')
    expectFailure(check(second, 'working'), 1, /\n {2}a "quoted" \\ name\.md\n$/)
  })
})
