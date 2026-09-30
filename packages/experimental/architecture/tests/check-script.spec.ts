/** The commit and CI check refuses architecture-source changes made outside the main branch's primary worktree. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/check-architecture.sh', import.meta.url))
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV })
}

function check(cwd: string, ...args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync('sh', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: ENV })
  return { status: result.status, stderr: result.stderr }
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
  it('allows source changes on the main branch in the primary worktree', async () => {
    const { repo } = await fixture()
    await writeFile(join(repo, 'design', 'sub', 'arch.md'), '# Arch\n\nMore.\n')
    git(repo, 'add', '-A')
    expect(check(repo, '--main-branch', 'main', 'staged')).toEqual({ status: 0, stderr: '' })
  })

  it('refuses source and manifest changes in a linked worktree or on another branch', async () => {
    const { repo, linked } = await fixture()
    await writeFile(join(linked, 'design', 'sub', 'arch.md'), '# Changed\n')
    await writeFile(join(linked, 'notes.md'), 'not a source\n')
    git(linked, 'add', '-A')
    const worktree = check(linked, '--main-branch', 'main', 'staged')
    expect(worktree.status).toBe(1)
    expect(worktree.stderr).toBe('check-architecture: architecture sources change only on main in the primary worktree; '
      + 'this commit is on a linked worktree and changes:\n  design/sub/arch.md\n')

    git(repo, 'checkout', '-q', '-b', 'feature')
    await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - design/**/*.md\n')
    git(repo, 'add', '-A')
    expect(check(repo, '--main-branch', 'main', 'staged').stderr).toMatch(/this commit is on branch feature and changes:\n {2}architecture\.yml\n$/)
    git(repo, 'checkout', '-q', '--detach')
    expect(check(repo, '--main-branch', 'main', 'staged').stderr).toMatch(/on branch \(detached HEAD\)/)
  })

  it('ignores code, excluded sources, and repositories without a manifest', async () => {
    const { repo, linked } = await fixture()
    await writeFile(join(linked, 'src', 'code.ts'), 'y\n')
    await writeFile(join(linked, 'design', 'sub', 'arch.zh.md'), '# 架构\n')
    git(linked, 'add', '-A')
    expect(check(linked, '--main-branch', 'main', 'staged').status).toBe(0)
    await rm(join(repo, 'architecture.yml'))
    expect(check(repo, '--main-branch', 'main', 'staged').status).toBe(0)
  })

  it('takes the main branch from the manifest before --main-branch, and refuses changes when neither names one', async () => {
    const { repo } = await fixture('mainBranch: "trunk"  # declared\nsources:\n  - design/**/*.md\n')
    await writeFile(join(repo, 'design', 'sub', 'arch.md'), '# Changed\n')
    git(repo, 'add', '-A')
    expect(check(repo, '--main-branch', 'main', 'staged').stderr).toMatch(/change only on trunk in the primary worktree; this commit is on branch main/)
    git(repo, 'checkout', '-q', '-b', 'trunk')
    expect(check(repo, 'staged')).toEqual({ status: 0, stderr: '' })

    await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - design/**/*.md\n')
    git(repo, 'add', '-A')
    expect(check(repo, 'staged')).toEqual({
      status: 1,
      stderr: 'check-architecture: architecture.yml declares no mainBranch and --main-branch is not given, so no branch may change '
        + 'architecture sources; this commit changes:\n  architecture.yml\n  design/sub/arch.md\n',
    })
  })

  it('reads a custom manifest path', async () => {
    const { repo, linked } = await fixture()
    git(repo, 'mv', 'architecture.yml', 'arch.yml')
    git(repo, 'commit', '-q', '-m', 'rename')
    git(linked, 'merge', '-q', 'main')
    await writeFile(join(linked, 'design', 'sub', 'arch.md'), '# Changed\n')
    git(linked, 'add', '-A')
    expect(check(linked, '--main-branch', 'main', 'staged').status).toBe(0)
    expect(check(linked, '--main-branch', 'main', '--manifest', 'arch.yml', 'staged').status).toBe(1)
  })
})

describe('check-architecture.sh range', () => {
  it('refuses a range that changes sources and allows one that does not', async () => {
    const { repo, linked } = await fixture()
    await writeFile(join(linked, 'src', 'code.ts'), 'y\n')
    git(linked, 'commit', '-q', '-am', 'code')
    expect(check(linked, '--main-branch', 'main', 'range', 'main', 'HEAD').status).toBe(0)
    await writeFile(join(linked, 'design', 'sub', 'arch.md'), '# Changed\n')
    git(linked, 'commit', '-q', '-am', 'doc')
    const refused = check(linked, '--main-branch', 'main', 'range', 'main', 'HEAD')
    expect(refused).toEqual({ status: 1, stderr: 'check-architecture: architecture sources change only on main; main...HEAD changes:\n  design/sub/arch.md\n' })
    expect(check(linked, 'range', 'main', 'HEAD').stderr).toMatch(/^check-architecture: architecture sources change only on the main branch the manifest declares; /)
    // A head without a manifest has nothing to check.
    git(repo, 'rm', '-q', 'architecture.yml')
    git(repo, 'commit', '-q', '-m', 'drop')
    expect(check(repo, '--main-branch', 'main', 'range', 'topic', 'main').status).toBe(0)
  })
})

describe('check-architecture.sh errors', () => {
  it('rejects bad usage', async () => {
    const { repo } = await fixture()
    for (const args of [[], ['--main-branch'], ['--main-branch', 'main'], ['--main-branch', 'main', 'staged', 'extra'],
      ['--main-branch', 'main', 'range', 'a'], ['--main-branch', 'main', 'other'], ['--bogus'], ['--manifest']]) {
      const result = check(repo, ...args)
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/^usage: /)
    }
    expect(check(repo, '--main-branch', 'main', '--', 'staged').status).toBe(0)
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-check-outside-')))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    expect(check(outside, '--main-branch', 'main', 'staged')).toEqual({ status: 2, stderr: 'check-architecture: not inside a git checkout\n' })
  })

  it.each([
    ['flow style', 'sources: [design/*.md]\n', /architecture\.yml:1: unsupported manifest syntax/],
    ['orphan item', '  - design/*.md\n', /architecture\.yml:1: list item outside sources or exclude/],
    ['empty glob', 'sources:\n  - ""\n', /architecture\.yml:2: empty glob/],
    ['no sources', '# nothing\nexclude:\n  - x\n', /no sources/],
    ['a spaced main branch', 'mainBranch: a b\nsources:\n  - x\n', /architecture\.yml:1: mainBranch must be one branch name/],
  ])('refuses a manifest it cannot read: %s', async (_name, manifest, message) => {
    const { repo } = await fixture(manifest)
    const result = check(repo, '--main-branch', 'main', 'staged')
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(message)
  })
})
