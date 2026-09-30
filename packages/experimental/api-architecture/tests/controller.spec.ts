/** The architecture Remote namespace resolves Workspaces, reads snapshots, follows changes, and forwards decisions. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import ArchitectureService from '@deepseek-ai/dsh-experimental-architecture'
import type { AppealId, RulingId } from '@deepseek-ai/dsh-experimental-architecture'
import type { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import ArchitectureController from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

const WORKSPACE = brandString<WorkspaceId>('ws-1')

/** A registry holding one Workspace at `path`; the controller reads only `get`. */
class Workspaces extends Service {
  constructor(ctx: Context, private readonly path: string) {
    super(ctx, 'workspaceRegistry')
  }

  get(id: WorkspaceId): Pick<Workspace, 'path'> | undefined {
    return id === WORKSPACE ? { path: this.path } : undefined
  }
}

async function boot(): Promise<{ ctx: Context; api: ArchitectureController; repo: string }> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'dsh-api-architecture-')))
  cleanups.push(() => rm(repo, { recursive: true, force: true }))
  await mkdir(join(repo, 'design'))
  await writeFile(join(repo, 'architecture.yml'), 'sources:\n  - design/*.md\n')
  await writeFile(join(repo, 'design', 'arch.md'), '# Arch\n\n## Storage\n\nUse the store.\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ArchitectureService, { mainBranch: 'main' })
  // The controller only needs the service to exist; the Gateway is not under test.
  ctx.provide('typert', {})
  await ctx.plugin((inner: Context) => { new Workspaces(inner, repo) })
  await ctx.plugin((inner: Context) => { new ArchitectureController(inner) })
  return { ctx, api: ctx.architectureController, repo }
}

async function remoteError(promise: Promise<unknown>): Promise<RemoteError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RemoteError) return error
    throw error
  }
  throw new Error('expected a RemoteError')
}

describe('architecture Remote namespace', () => {
  it('reads a section before any snapshot builds the index', async () => {
    const { api } = await boot()
    const section = await api.section({ workspaceId: WORKSPACE, path: 'design/arch.md', anchor: 'storage' }, new AbortController().signal)
    expect(section.text).toBe('## Storage\n\nUse the store.\n')
  })

  it('reads a snapshot and a section, and accepts a reviewed section', async () => {
    const { api, ctx } = await boot()
    const signal = new AbortController().signal
    const snapshot = await api.snapshot(WORKSPACE, signal)
    expect(snapshot.hasManifest).toBe(true)
    expect(snapshot.index.sections.map(section => section.anchor)).toEqual(['arch', 'storage'])

    // A section read uses the index the snapshot built instead of rebuilding it.
    const rebuild = vi.spyOn(ctx.architecture, 'rebuild')
    const section = await api.section({ workspaceId: WORKSPACE, path: 'design/arch.md', anchor: 'storage' }, signal)
    expect(section.text).toBe('## Storage\n\nUse the store.\n')
    expect(rebuild).not.toHaveBeenCalled()
    rebuild.mockRestore()
    const accepted = await api.accept({ workspaceId: WORKSPACE, path: 'design/arch.md', anchor: 'storage', hash: section.hash })
    expect(accepted.hash).toBe(section.hash)

    expect((await remoteError(api.section({ workspaceId: WORKSPACE, path: 'design/arch.md', anchor: 'nope' }, signal))).code).toBe('architecture/failed')
    expect((await remoteError(api.accept({ workspaceId: WORKSPACE, path: 'design/arch.md', anchor: 'storage', hash: 'f'.repeat(64) }))).message)
      .toMatch(/changed since it was reviewed/)
  })

  it('rejects an unknown Workspace and wraps service failures', async () => {
    const { ctx, api, repo } = await boot()
    const signal = new AbortController().signal
    const missing = brandString<WorkspaceId>('ws-missing')
    expect((await remoteError(api.snapshot(missing, signal))).code).toBe('architecture/workspace-not-found')
    await writeFile(join(repo, 'architecture.yml'), 'sources: 3\n')
    expect((await remoteError(api.snapshot(WORKSPACE, signal))).code).toBe('architecture/failed')
    expect((await remoteError(api.section({ workspaceId: WORKSPACE, path: 'a', anchor: 'b' }, signal))).code).toBe('architecture/failed')
    const thrower = vi.spyOn(ctx.architecture, 'accept').mockRejectedValueOnce('plain failure')
    expect((await remoteError(api.accept({ workspaceId: WORKSPACE, path: 'a', anchor: 'b', hash: 'c' }))).message).toBe('plain failure')
    thrower.mockRestore()
    const adjudication = await remoteError(api.adjudicate({ workspaceId: WORKSPACE, appealId: brandString<AppealId>('appeal-x'), adjudication: { kind: 'uphold' } }))
    expect(adjudication.message).toMatch(/no appeal appeal-x/)
  })

  it('declares the main branch in the manifest and reports a refusal', async () => {
    const { api, repo } = await boot()
    const signal = new AbortController().signal
    expect((await api.snapshot(WORKSPACE, signal)).currentBranches).toEqual(['main'])
    expect(await api.setMainBranch({ workspaceId: WORKSPACE, branch: 'main' }, signal)).toEqual({ path: 'architecture.yml' })
    expect(await readFile(join(repo, 'architecture.yml'), 'utf8')).toBe('mainBranch: "main"\nsources:\n  - design/*.md\n')
    // From main, the branch may move on; afterwards the checkout is no longer on the declared branch.
    await api.setMainBranch({ workspaceId: WORKSPACE, branch: 'trunk' }, signal)
    const refused = await remoteError(api.setMainBranch({ workspaceId: WORKSPACE, branch: 'main' }, signal))
    expect(refused.code).toBe('architecture/failed')
    expect(refused.message).toBe('architecture sources change only on branch trunk; the checkout is on main')
    expect((await remoteError(api.setMainBranch({ workspaceId: WORKSPACE, branch: 'a b' }, signal))).message).toMatch(/is not a branch name/)
    const controller = new AbortController()
    controller.abort(new Error('client left'))
    await expect(api.setMainBranch({ workspaceId: WORKSPACE, branch: 'main' }, controller.signal)).rejects.toThrow('client left')
  })

  it('propagates cancellation instead of wrapping it', async () => {
    const { api } = await boot()
    const controller = new AbortController()
    controller.abort(new Error('client left'))
    await expect(api.snapshot(WORKSPACE, controller.signal)).rejects.toThrow('client left')
    await expect(api.section({ workspaceId: WORKSPACE, path: 'design/arch.md', anchor: 'storage' }, controller.signal)).rejects.toThrow('client left')
  })

  it('follows changes of its repository, coalesces bursts, and ignores other repositories', async () => {
    const { ctx, api, repo } = await boot()
    const controller = new AbortController()
    const stream = api.follow(WORKSPACE, controller.signal)[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.done).toBe(false)

    const record = {
      ruling: { id: brandString<RulingId>('ruling-1'), question: 'q', scope: [], summary: 's', constraints: [], unresolved: [] },
      workerSession: brandString<SessionId>('w'),
      architectSession: brandString<SessionId>('a'),
      revision: 'r',
    }
    ctx.emit('architecture/changed', '/elsewhere')
    await ctx.architecture.recordRuling(repo, record)
    const second = await stream.next()
    expect(second.done === false ? second.value.rulings.map(entry => entry.ruling.id) : []).toEqual(['ruling-1'])

    const pending = stream.next()
    controller.abort()
    expect((await pending).done).toBe(true)
  })

  it('ends a follow stream whose read fails after the client left, and reports a failure otherwise', async () => {
    const { ctx, api, repo } = await boot()
    const leaving = new AbortController()
    vi.spyOn(ctx.architecture, 'snapshot').mockImplementationOnce(async () => {
      leaving.abort()
      throw new Error('aborted read')
    })
    expect((await api.follow(WORKSPACE, leaving.signal)[Symbol.asyncIterator]().next()).done).toBe(true)
    await writeFile(join(repo, 'architecture.yml'), 'sources: 3\n')
    const stream = api.follow(WORKSPACE, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await remoteError(stream.next())).code).toBe('architecture/failed')

    const controller = new AbortController()
    controller.abort()
    const ended = api.follow(WORKSPACE, controller.signal)[Symbol.asyncIterator]()
    expect((await ended.next()).done).toBe(true)
  })
})
