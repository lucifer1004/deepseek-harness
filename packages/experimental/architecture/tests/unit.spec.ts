/** Unit behavior of the manifest parser, section index, source matching, and checkout locator. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { canonicalizeForWrite, isProtected, writeTarget, type WriteCall } from '../src/guard.ts'
import { matchSources } from '../src/index-builder.ts'
import { declaredMainBranch, ManifestError, parseManifest, withMainBranch } from '../src/manifest.ts'
import { locateCheckout } from '../src/repository.ts'
import { githubSlug, hashSection, indexSections } from '../src/sections.ts'
import { foldConsultation, routeOf } from '../src/thread.ts'
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

describe('withMainBranch', () => {
  it('replaces a declared branch in place, keeping every other byte', () => {
    expect(withMainBranch('# record\nmainBranch: main  # the branch\nsources:\n  - a.md    # doc\n', 'trunk', 'architecture.yml'))
      .toBe('# record\nmainBranch: "trunk"  # the branch\nsources:\n  - a.md    # doc\n')
    expect(withMainBranch('sources: [a.md]\nmainBranch: "main"\n', 'release/2', 'architecture.yml')).toBe('sources: [a.md]\nmainBranch: "release/2"\n')
  })

  it('adds the key before the first key of a block or flow mapping', () => {
    expect(withMainBranch('# record\n\n# sources\nsources:\n  - a.md\nexclude: [b.md]\n', 'main', 'architecture.yml'))
      .toBe('# record\n\n# sources\nmainBranch: "main"\nsources:\n  - a.md\nexclude: [b.md]\n')
    expect(withMainBranch('---\n{sources: [a.md]}\n', 'main', 'architecture.yml')).toBe('---\n{mainBranch: "main", sources: [a.md]}\n')
  })

  it('quotes a branch YAML would read as another type', () => {
    for (const branch of ['yes', '1.0', 'null']) expect(declaredMainBranch(withMainBranch('sources: [a.md]\n', branch, 'architecture.yml'))).toBe(branch)
  })

  it('refuses a name that is not a branch and a manifest that is not valid', () => {
    expect(() => withMainBranch('sources: [a.md]\n', 'a b', 'architecture.yml')).toThrow('architecture.yml: mainBranch "a b" is not a branch name')
    expect(() => withMainBranch('sources: []\n', 'main', 'architecture.yml')).toThrow(ManifestError)
  })
})

describe('parseManifest', () => {
  it('accepts workspace-relative source globs', () => {
    expect(parseManifest('sources:\n  - design/**/*.md\n  - ARCHITECTURE.md\n', 'architecture.yml'))
      .toEqual({ sources: ['design/**/*.md', 'ARCHITECTURE.md'], exclude: [], mainBranch: undefined })
    expect(parseManifest('sources: [design/*.md]\nexclude: [design/*.zh.md]\nmainBranch: release/2\n', 'architecture.yml'))
      .toEqual({ sources: ['design/*.md'], exclude: ['design/*.zh.md'], mainBranch: 'release/2' })
  })

  it('reads the declared main branch alone, from a manifest that fails validation too', () => {
    expect(declaredMainBranch('mainBranch: trunk\nsources: []\n')).toBe('trunk')
    for (const text of ['sources: [a.md]\n', 'mainBranch: two words\n', 'mainBranch: [\n', '- a\n', 'plain']) {
      expect(declaredMainBranch(text)).toBeUndefined()
    }
  })

  it.each([
    ['not YAML', 'sources: [', /invalid YAML/],
    ['an empty list', 'sources: []\n', /sources/],
    ['an absolute glob', 'sources:\n  - /etc/passwd\n', /workspace-relative/],
    ['a parent segment', 'sources:\n  - ../other/*.md\n', /workspace-relative/],
    ['a backslash', 'sources:\n  - docs\\a.md\n', /workspace-relative/],
    ['an unknown key', 'sources:\n  - a.md\nextra: 1\n', /extra|Unrecognized/i],
    ['a negated source', 'sources:\n  - design/*.md\n  - "!design/a.md"\n', /must not be negated/],
    ['an invalid main branch', 'sources:\n  - a.md\nmainBranch: "a b"\n', /mainBranch: must be a git branch name/],
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
    expect(matchSources(['b.md', 'design/x.md', 'design/y.txt', '.hidden/notes/a.md', 'b.md'], { sources: ['design/*.md', 'b.md', '.hidden/**/*.md'], exclude: [] }))
      .toEqual(['.hidden/notes/a.md', 'b.md', 'design/x.md'])
    expect(matchSources(['design/x.md', 'design/x.zh.md', 'src/a.ts'], { sources: ['design/*.md'], exclude: ['design/*.zh.md'] }))
      .toEqual(['design/x.md'])
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

    expect(locateCheckout(join(repo, 'missing', 'file.md'))).toEqual({ vcs: 'git', root: repo, primaryRoot: repo, isPrimary: true, branch: 'main' })
    expect(locateCheckout(join(root, 'linked'))).toEqual({ vcs: 'git', root: join(root, 'linked'), primaryRoot: repo, isPrimary: false, branch: 'topic' })
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

describe('foldConsultation', () => {
  const question = (rulingId: string) => ({
    type: 'user/message', data: { role: 'user', content: [], source: { kind: 'architecture', rulingId } },
  })
  const submit = { type: 'tool/call', data: { name: 'submit_ruling' } }

  it('keeps the pending id until a submission follows it, and reads the route once', () => {
    const route = { type: 'architecture/consultation', data: { version: 1, route: { reasoningEffort: 'high' } } }
    const events = [route, question('r1'), { type: 'tool/call', data: { name: 'read' } }] as never
    expect(foldConsultation(events, 'submit_ruling')).toEqual({ route: { reasoningEffort: 'high' }, pendingRulingId: 'r1' })
    expect(foldConsultation([route, question('r1'), submit] as never, 'submit_ruling')).toEqual({ route: { reasoningEffort: 'high' }, pendingRulingId: undefined })
    // Other messages, such as an appeal decision or a user reminder, open no turn.
    const other = [
      route, question('r1'), submit,
      { type: 'user/message', data: { role: 'user', content: [], source: { kind: 'architecture', appealId: 'a1' } } },
      { type: 'user/message', data: { role: 'user', content: [], source: { kind: 'user' } } },
    ] as never
    expect(foldConsultation(other, 'submit_ruling')?.pendingRulingId).toBeUndefined()
  })

  it('reports no consultation for a log without its route', () => {
    expect(foldConsultation([question('r1')] as never, 'submit_ruling')).toBeUndefined()
  })

  it('records only the route fields that are set', () => {
    expect(routeOf({})).toEqual({})
    expect(routeOf({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('low') })).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'low' })
  })
})
