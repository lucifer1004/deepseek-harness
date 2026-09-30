/** Ruling records, appeals, acceptances, and the dashboard snapshot are durable files under the local directory. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ArchitectureService, { adjudicationText, indexRevision } from '../src/index.ts'
import type { AppealId, AppealRecord, Config, RulingId } from '../src/index.ts'
import { RecordStore } from '../src/records.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-architecture-records-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A repository on `main` with one committed and one untracked source, and a local entry. */
async function fixture(): Promise<string> {
  const repo = await scratch()
  await mkdir(join(repo, 'design'))
  await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - design/*.md\n')
  await writeFile(join(repo, 'design', 'arch.md'), '# Arch\n\n## Storage\n\nUse the store.\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  await writeFile(join(repo, 'design', 'draft.md'), '# Draft\n\nNew idea.\n')
  await mkdir(join(repo, '.architecture', 'notes'), { recursive: true })
  await writeFile(join(repo, '.architecture', 'notes', 'idea.md'), 'idea\n')
  return repo
}

async function boot(config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ArchitectureService, { mainBranch: 'main', ...config } as Config)
  return ctx
}

const WORKER = brandString<SessionId>('worker')
const RULING = brandString<RulingId>('ruling-1')

function record(revision = 'r1') {
  return {
    ruling: {
      id: RULING,
      question: 'Where does persistence go?',
      scope: ['src/store'],
      summary: 'Use the store.',
      constraints: [{
        statement: 'Persist through the store.',
        citations: [{ path: brandString<never>('design/arch.md'), anchor: 'storage', hash: brandString<never>('0'.repeat(64)) }],
      }],
      unresolved: [{ statement: 'Caching?' }],
    },
    workerSession: WORKER,
    architectSession: brandString<SessionId>('architect'),
    revision,
  }
}

/** A live worker that records steered messages. */
function liveWorker(ctx: Context, cwd: string): { steer: ReturnType<typeof vi.fn> } {
  const steer = vi.fn()
  const worker = { id: WORKER, session: { header: { cwd } } as Session, steer } as never as Agent
  ctx.provide('agents', { get: (id: SessionId) => id === WORKER ? worker : undefined })
  return { steer }
}

describe('architecture records', () => {
  it('reports the dashboard snapshot with source status, local entries, and staleness', async () => {
    const repo = await fixture()
    const ctx = await boot()
    const changes: string[] = []
    ctx.on('architecture/changed', (root) => { changes.push(root) })
    const empty = await ctx.architecture.snapshot(repo)
    expect(empty).toMatchObject({
      root: repo,
      mainBranch: 'main',
      manifestPath: 'architecture.yml',
      localDirectory: '.architecture',
      hasManifest: true,
      sourceStatus: { 'design/arch.md': 'committed', 'design/draft.md': 'untracked' },
      localEntries: [{ path: '.architecture/notes/idea.md', status: 'untracked' }],
      rulings: [],
      appeals: [],
      acceptances: [],
      problems: [],
    })
    expect(empty.revision).toBe(indexRevision(empty.index))
    expect(changes).toEqual([repo])

    // Rebuilding an unchanged index does not notify again.
    await ctx.architecture.rebuild(repo)
    expect(changes).toEqual([repo])

    await ctx.architecture.recordRuling(repo, record())
    const storage = empty.index.sections.find(section => section.anchor === 'storage')
    await ctx.architecture.recordRuling(repo, { ...record(), ruling: { ...record().ruling, id: brandString<RulingId>('ruling-0') } })
    await writeFile(join(repo, '.architecture', 'rulings', 'bad.json'), '{')
    const withRuling = await ctx.architecture.snapshot(repo)
    expect(withRuling.problems.map(problem => problem.file)).toEqual(['.architecture/rulings/bad.json'])
    await rm(join(repo, '.architecture', 'rulings', 'bad.json'))
    await rm(join(repo, '.architecture', 'rulings', 'ruling-0.json'))
    expect(withRuling.rulings.map(entry => entry.ruling.id).sort()).toEqual(['ruling-0', 'ruling-1'])
    expect(withRuling.rulings.find(entry => entry.ruling.id === RULING)).toMatchObject({ status: 'issued', stale: true, revision: 'r1' })
    // Records are files, and the local-entry view omits them.
    expect(await readdir(join(repo, '.architecture', 'rulings'))).toEqual(['ruling-1.json'])
    expect(changes).toHaveLength(3)
    expect(withRuling.localEntries.map(entry => entry.path)).toEqual(['.architecture/notes/idea.md'])

    const current = { ...record(), ruling: { ...record().ruling, constraints: [{ statement: 's', citations: [{ path: brandString<never>('design/arch.md'), anchor: 'storage', hash: storage?.hash ?? brandString<never>('') }] }] } }
    await ctx.architecture.recordRuling(repo, current)
    expect((await ctx.architecture.snapshot(repo)).rulings[0]?.stale).toBe(false)
  })

  it('reports an empty snapshot for a repository without a manifest or local directory', async () => {
    const repo = await scratch()
    git(repo, 'init', '-q', '-b', 'main')
    const ctx = await boot()
    const changes: string[] = []
    ctx.on('architecture/changed', (root) => { changes.push(root) })
    await ctx.architecture.snapshot(repo)
    const snapshot = await ctx.architecture.snapshot(repo)
    expect(changes).toEqual([repo])
    expect(snapshot).toMatchObject({ hasManifest: false, revision: 'empty', index: { sources: [], sections: [] }, localEntries: [] })
    const outside = await scratch()
    expect(await ctx.architecture.snapshot(outside)).toMatchObject({ root: outside, unsupported: { kind: 'no-repository' }, hasManifest: false, rulings: [] })
    expect(await ctx.architecture.snapshot(outside)).not.toHaveProperty('vcs')
  })

  it('reports a repository whose version-control executable is not installed', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const resolve = ctx.subprocess.resolveExecutable.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async (command, env, signal) => {
      if (command === 'jj' || command === 'git') throw new Error(`${command}: not found`)
      return await resolve(command, env, signal)
    })
    await ctx.plugin(ArchitectureService, { mainBranch: 'main' } as Config)
    const repo = await scratch()
    await mkdir(join(repo, '.jj', 'repo'), { recursive: true })
    expect(await ctx.architecture.snapshot(repo)).toMatchObject({ unsupported: { kind: 'vcs-missing', vcs: 'jj' }, hasManifest: false })
    expect(ctx.architecture.checkout(repo)).toBeUndefined()
    expect(ctx.architecture.isProtected(join(repo, 'architecture.yml'))).toBe(false)
    await expect(ctx.architecture.rebuild(repo)).rejects.toThrow(/is a jj checkout, but jj is not installed/)
    const gitRepo = await scratch()
    git(gitRepo, 'init', '-q', '-b', 'main')
    expect(await ctx.architecture.snapshot(gitRepo)).toMatchObject({ unsupported: { kind: 'vcs-missing', vcs: 'git' } })
  })

  it('accepts an uncommitted section at its reviewed hash only', async () => {
    const repo = await fixture()
    const ctx = await boot()
    const draft = (await ctx.architecture.rebuild(repo))?.sections.find(section => section.anchor === 'draft')
    if (draft === undefined) throw new Error('draft section missing')
    await expect(ctx.architecture.accept(repo, 'design/draft.md', 'nope', draft.hash)).rejects.toThrow(/not an indexed section/)
    await expect(ctx.architecture.accept(repo, 'design/draft.md', 'draft', '1'.repeat(64))).rejects.toThrow(/changed since it was reviewed/)
    await ctx.architecture.accept(repo, 'design/draft.md', 'draft', draft.hash)
    await ctx.architecture.accept(repo, 'design/draft.md', 'draft', draft.hash)
    const snapshot = await ctx.architecture.snapshot(repo)
    expect(snapshot.acceptances).toMatchObject([{ path: 'design/draft.md', anchor: 'draft', hash: draft.hash }])
  })

  it('files an appeal, decides it, and delivers the decision to a live worker', async () => {
    const repo = await fixture()
    const ctx = await boot()
    const { steer } = liveWorker(ctx, repo)
    await ctx.architecture.recordRuling(repo, record())
    const request = { cwd: repo, rulingId: RULING, workerSession: WORKER, reason: 'The store cannot stream.', evidence: ['src/stream.ts'] }
    await expect(ctx.architecture.appeal({ ...request, rulingId: brandString<RulingId>('ruling-x') })).rejects.toThrow(/no recorded Ruling/)
    await expect(ctx.architecture.appeal({ ...request, workerSession: brandString<SessionId>('other') })).rejects.toThrow(/another Session/)
    const appeal = await ctx.architecture.appeal(request)
    expect((await ctx.architecture.snapshot(repo)).rulings[0]?.status).toBe('appealed')

    const decided = await ctx.architecture.adjudicate(repo, appeal.id, { kind: 'overturn', note: 'redesign' })
    expect(decided.adjudication).toEqual({ kind: 'overturn', note: 'redesign' })
    expect(steer).toHaveBeenCalledOnce()
    expect(steer.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'architecture', appealId: appeal.id } })
    const snapshot = await ctx.architecture.snapshot(repo)
    expect(snapshot.rulings[0]?.status).toBe('overturned')
    expect(snapshot.appeals[0]).toMatchObject({ delivered: true })
    await expect(ctx.architecture.adjudicate(repo, brandString<AppealId>('appeal-x'), { kind: 'uphold' })).rejects.toThrow(/no appeal appeal-x/)

    // Delivery on agent creation skips delivered and undecided appeals.
    const second = await ctx.architecture.appeal(request)
    await ctx.architecture.deliverPending({ id: WORKER, session: { header: { cwd: repo } } } as never as Agent)
    expect(steer).toHaveBeenCalledOnce()
    expect((await ctx.architecture.snapshot(repo)).appeals.map(entry => entry.id)).toEqual([second.id, appeal.id])
  })

  it('keeps a decision whose Ruling record is gone, and ignores Sessions outside a checkout', async () => {
    const repo = await fixture()
    const ctx = await boot()
    await ctx.architecture.recordRuling(repo, record())
    const appeal = await ctx.architecture.appeal({ cwd: repo, rulingId: RULING, workerSession: WORKER, reason: 'r', evidence: [] })
    await rm(join(repo, '.architecture', 'rulings', 'ruling-1.json'))
    // No agent registry: the decision stays undelivered.
    await ctx.architecture.adjudicate(repo, appeal.id, { kind: 'uphold' })
    expect((await ctx.architecture.snapshot(repo)).appeals[0]).toMatchObject({ adjudication: { kind: 'uphold' }, delivered: false })
    await ctx.architecture.deliverPending({ id: WORKER, session: { header: {} } } as never as Agent)
    await ctx.architecture.deliverPending({ id: WORKER, session: { header: { cwd: await scratch() } } } as never as Agent)
  })

  it('delivers pending decisions when the worker agent is created, and logs a delivery failure', async () => {
    const repo = await fixture()
    const ctx = await boot()
    await ctx.architecture.recordRuling(repo, record())
    const appeal = await ctx.architecture.appeal({ cwd: repo, rulingId: RULING, workerSession: WORKER, reason: 'r', evidence: [] })
    await ctx.architecture.adjudicate(repo, appeal.id, { kind: 'exception', scope: 'src/a.ts' })
    const { steer } = liveWorker(ctx, repo)
    const agent = { id: WORKER, session: { header: { cwd: repo } }, steer } as never as Agent
    await ctx.serial('agent/created', { agent, source: 'startup' })
    await vi.waitFor(async () => { expect((await ctx.architecture.snapshot(repo)).appeals[0]?.delivered).toBe(true) })
    expect(steer).toHaveBeenCalledOnce()

    const warn = vi.spyOn(ctx.logger, 'warn')
    vi.spyOn(ctx.architecture, 'deliverPending').mockRejectedValueOnce(new Error('disk full'))
    await ctx.serial('agent/created', { agent, source: 'resume' })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledOnce() })
    expect(String(warn.mock.calls[0]?.[0])).toBe('architecture: delivering appeal decisions to worker failed: Error: disk full')
  })

  it('serializes concurrent writes and keeps later writes after a failed one', async () => {
    const repo = await fixture()
    const ctx = await boot()
    await ctx.architecture.recordRuling(repo, record())
    const request = { cwd: repo, rulingId: RULING, workerSession: WORKER, reason: 'r', evidence: [] }
    const [first, missing, second] = await Promise.allSettled([
      ctx.architecture.appeal(request),
      ctx.architecture.appeal({ ...request, rulingId: brandString<RulingId>('ruling-x') }),
      ctx.architecture.appeal(request),
    ])
    expect([first.status, missing.status, second.status]).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect((await ctx.architecture.snapshot(repo)).appeals).toHaveLength(2)
  })

  it('describes every adjudication to the worker', () => {
    const appeal = { id: 'appeal-1', rulingId: 'ruling-1' } as AppealRecord
    expect(adjudicationText(appeal, { kind: 'uphold' })).toBe('The user upheld Ruling ruling-1 on your appeal appeal-1. Keep following its constraints.')
    expect(adjudicationText(appeal, { kind: 'overturn', note: 'redesign' })).toBe(
      'The user overturned Ruling ruling-1 on your appeal appeal-1. Its constraints no longer bind you; the user will revise the architecture record. '
      + 'Consult the architect again before relying on the revised design. The user notes: redesign')
    expect(adjudicationText(appeal, { kind: 'exception', scope: 'src/a.ts' })).toBe(
      'The user granted an exception to Ruling ruling-1 on your appeal appeal-1, limited to: src/a.ts. Outside that scope its constraints still bind you.')
  })
})

describe('RecordStore', () => {
  it('reports malformed, mismatched, and invalid record files instead of reading them', async () => {
    const directory = await scratch()
    const store = new RecordStore(directory)
    expect(await store.read()).toMatchObject({ rulings: new Map(), appeals: new Map(), acceptances: [], problems: [] })
    await mkdir(join(directory, 'rulings'))
    await mkdir(join(directory, 'appeals'))
    await writeFile(join(directory, 'rulings', 'broken.json'), '{')
    await writeFile(join(directory, 'rulings', 'notes.txt'), 'ignored')
    await writeFile(join(directory, 'rulings', 'invalid.json'), JSON.stringify({ version: 2 }))
    await writeFile(join(directory, 'rulings', 'empty.json'), '[]')
    const valid = { version: 1, ...record(), issuedAt: 1, status: 'issued' }
    await writeFile(join(directory, 'rulings', 'renamed.json'), JSON.stringify(valid))
    const appeal = { version: 1, id: 'appeal-1', rulingId: 'ruling-1', workerSession: 'w', reason: 'r', evidence: [], filedAt: 1, delivered: false }
    await writeFile(join(directory, 'appeals', 'other.json'), JSON.stringify(appeal))
    await writeFile(join(directory, 'appeals', 'appeal-1.json'), JSON.stringify(appeal))
    await writeFile(join(directory, 'acceptances.json'), JSON.stringify({ version: 1, acceptances: [{ path: 'a.md', anchor: 'a', hash: 'x', acceptedAt: 0 }] }))
    const { rulings, appeals, acceptances, problems } = await store.read()
    expect(rulings.size).toBe(0)
    expect([...appeals.keys()]).toEqual(['appeal-1'])
    expect(acceptances).toEqual([])
    expect(problems.map(problem => problem.file)).toEqual([
      'rulings/broken.json', 'rulings/empty.json', 'rulings/invalid.json', 'rulings/renamed.json', 'appeals/other.json', 'acceptances.json',
    ])
    expect(problems[0]?.message).toMatch(/^is not JSON: /)
    expect(problems[1]?.message).toMatch(/^\(root\): /)
    expect(problems[2]?.message).toMatch(/^version: /)
    expect(problems[3]?.message).toBe('names Ruling ruling-1')
    expect(problems[4]?.message).toBe('names appeal appeal-1')
    expect(problems[5]?.message).toMatch(/^acceptances\.0\.hash: /)
  })

  it('rethrows a read failure other than a missing file', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'rulings'), 'not a directory')
    await expect(new RecordStore(directory).read()).rejects.toThrow(/ENOTDIR/)
    const other = await scratch()
    await mkdir(join(other, 'acceptances.json'))
    await expect(new RecordStore(other).read()).rejects.toThrow(/EISDIR/)
  })

  it('writes each record atomically as formatted JSON', async () => {
    const directory = await scratch()
    const store = new RecordStore(join(directory, 'nested'))
    await store.writeAcceptances([])
    expect(await readFile(join(directory, 'nested', 'acceptances.json'), 'utf8')).toBe('{\n  "version": 1,\n  "acceptances": []\n}\n')
    expect(await readdir(join(directory, 'nested'))).toEqual(['acceptances.json'])
  })

  it('rethrows a local-directory listing failure other than a missing directory', async () => {
    const repo = await fixture()
    const ctx = await boot()
    await rm(join(repo, '.architecture'), { recursive: true })
    await writeFile(join(repo, '.architecture'), 'file')
    await expect(ctx.architecture.snapshot(repo)).rejects.toThrow(/ENOTDIR/)
  })
})
