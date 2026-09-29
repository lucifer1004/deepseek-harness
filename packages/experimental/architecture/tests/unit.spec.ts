/** Unit behavior of the manifest parser, section index, source matching, and checkout locator. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { canonicalizeForWrite, isProtected, writeTarget, type WriteCall } from '../src/guard.ts'
import { matchSources } from '../src/index-builder.ts'
import { ManifestError, parseManifest } from '../src/manifest.ts'
import { locateCheckout } from '../src/repository.ts'
import { githubSlug, hashSection, indexSections } from '../src/sections.ts'
import type { SourcePath } from '../src/types.ts'

const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-unit-')))
  cleanups.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

const path = (value: string): SourcePath => brandString<SourcePath>(value)

describe('parseManifest', () => {
  it('accepts workspace-relative source globs', () => {
    expect(parseManifest('sources:\n  - docs/**/*.md\n  - ARCHITECTURE.md\n', 'architecture.yml'))
      .toEqual({ sources: ['docs/**/*.md', 'ARCHITECTURE.md'] })
  })

  it.each([
    ['not YAML', 'sources: [', /invalid YAML/],
    ['an empty list', 'sources: []\n', /sources/],
    ['an absolute glob', 'sources:\n  - /etc/passwd\n', /workspace-relative/],
    ['a parent segment', 'sources:\n  - ../other/*.md\n', /workspace-relative/],
    ['a backslash', 'sources:\n  - docs\\a.md\n', /workspace-relative/],
    ['an unknown key', 'sources:\n  - a.md\nextra: 1\n', /extra|Unrecognized/i],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseManifest(text, 'architecture.yml')).toThrow(ManifestError)
    expect(() => parseManifest(text, 'architecture.yml')).toThrow(message)
  })
})

describe('indexSections', () => {
  it('splits at every heading level with GitHub anchors and per-section hashes', () => {
    const text = 'Intro line\n\n# Title\n\nbody\n\n## Sub `code`\n\nmore\n\n## Sub `code`\n\n### Deep!\n'
    const sections = indexSections(path('a.md'), text)
    expect(sections.map(s => [s.anchor, s.level, s.line, s.title])).toEqual([
      ['', 0, 1, ''],
      ['title', 1, 3, 'Title'],
      ['sub-code', 2, 7, 'Sub code'],
      ['sub-code-1', 2, 11, 'Sub code'],
      ['deep', 3, 13, 'Deep!'],
    ])
    expect(new Set(sections.map(s => s.hash)).size).toBe(sections.length)
  })

  it('changes only the edited section hash', () => {
    const before = indexSections(path('a.md'), '# A\n\nx\n\n## B\n\ny\n')
    const after = indexSections(path('a.md'), '# A\n\nx\n\n## B\n\nchanged\n')
    expect(after[0]?.hash).toBe(before[0]?.hash)
    expect(after[1]?.hash).not.toBe(before[1]?.hash)
  })

  it('ignores headings inside fenced code and omits an empty preamble', () => {
    expect(indexSections(path('a.md'), '\n\n# A\n\n```\n# not a heading\n```\n').map(s => s.anchor)).toEqual(['a'])
  })

  it('hashes independently of line endings and trailing whitespace', () => {
    expect(hashSection('# A  \r\n\r\nx\r\n\n')).toBe(hashSection('# A\n\nx'))
  })

  it('slugs like GitHub', () => {
    expect(githubSlug('Showcase: web_fetch')).toBe('showcase-web_fetch')
    expect(githubSlug('中文 标题')).toBe('中文-标题')
  })
})

describe('matchSources', () => {
  it('matches globs, including dotfiles, sorted and deduplicated', () => {
    expect(matchSources(['b.md', 'design/x.md', 'design/y.txt', '.hidden/notes/a.md', 'b.md'], ['design/*.md', 'b.md', '.hidden/**/*.md']))
      .toEqual(['.hidden/notes/a.md', 'b.md', 'design/x.md'])
  })
})

describe('locateCheckout', () => {
  it('reports the primary worktree, a linked worktree, and a detached HEAD', async () => {
    const root = await scratch()
    const repo = join(root, 'repo')
    await mkdir(repo)
    git(repo, 'init', '-q', '-b', 'main')
    await writeFile(join(repo, 'a.md'), '# A\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    git(repo, 'worktree', 'add', '-q', '-b', 'topic', join(root, 'linked'))

    expect(locateCheckout(join(repo, 'missing', 'file.md'))).toEqual({ root: repo, primaryRoot: repo, isPrimary: true, branch: 'main' })
    expect(locateCheckout(join(root, 'linked'))).toEqual({ root: join(root, 'linked'), primaryRoot: repo, isPrimary: false, branch: 'topic' })
    git(repo, 'checkout', '-q', '--detach')
    expect(locateCheckout(repo)?.branch).toBeUndefined()
    expect(locateCheckout(root)).toBeUndefined()
  })
})

describe('guard helpers', () => {
  const exec = (name: string, args: unknown, cwd?: string): WriteCall => ({ name, arguments: args, cwd })

  it('resolves the written file of each built-in mutating tool', () => {
    expect(writeTarget(exec('write', { file_path: 'design/a.md', content: '' }, '/w'))).toBe('/w/design/a.md')
    expect(writeTarget(exec('edit', { file_path: '/abs/a.md' }))).toBe('/abs/a.md')
    expect(writeTarget(exec('str_replace_editor', { command: 'create', path: '/abs/a.md' }))).toBe('/abs/a.md')
    expect(writeTarget(exec('str_replace_editor', { command: 'view', path: '/abs/a.md' }))).toBeUndefined()
    expect(writeTarget(exec('write', { file_path: 'rel.md' }))).toBeUndefined()
    expect(writeTarget(exec('read', { file_path: '/abs/a.md' }))).toBeUndefined()
    expect(writeTarget(exec('write', null))).toBeUndefined()
    expect(writeTarget(exec('write', { file_path: '  ' }, '/w'))).toBeUndefined()
  })

  it('canonicalizes through symlinked ancestors of a missing file', async () => {
    const root = await scratch()
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'link'))
    expect(canonicalizeForWrite(join(root, 'link', 'new', 'file.md'))).toBe(join(root, 'real', 'new', 'file.md'))
  })

  it('protects listed files and everything under the local directory', () => {
    const paths = { root: '/r', files: new Set(['/r/a.md']), localDirectory: '/r/.architecture' }
    expect(isProtected('/r/a.md', paths)).toBe(true)
    expect(isProtected('/r/.architecture', paths)).toBe(true)
    expect(isProtected('/r/.architecture/rulings/x.json', paths)).toBe(true)
    expect(isProtected('/r/.architecture-other/x', paths)).toBe(false)
    expect(isProtected('/r/b.md', paths)).toBe(false)
  })
})
