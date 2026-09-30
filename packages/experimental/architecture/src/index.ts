/**
 * `ctx.architecture`: the workspace architecture manifest, a rebuildable
 * section index of its sources, the main-branch edit rule, and the global tool
 * guard that keeps every other writer away from architecture sources.
 * @module @deepseek-ai/dsh-experimental-architecture
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { runConsultation, SUBMIT_RULING_TOOL } from './consultation.ts'
import { GitFiles } from './git-files.ts'
import { canonicalizeForWrite, isProtected, writeCall, writeTarget, type ProtectedPaths } from './guard.ts'
import { buildIndex } from './index-builder.ts'
import { parseManifest } from './manifest.ts'
import { locateCheckout } from './repository.ts'
import { ACCEPTANCES_FILE, APPEALS_DIRECTORY, isMissing, RecordStore, RULINGS_DIRECTORY } from './records.ts'
import { validateRuling } from './ruling.ts'
import { indexSections, sectionText } from './sections.ts'
import type {
  ArchitectureEditRequest,
  ArchitectureEditResult,
  ArchitectureIndex,
  ArchitectureManifest,
  Config,
  Acceptance,
  Adjudication,
  AppealId,
  AppealRecord,
  ArchitectureSnapshot,
  ConsultResult,
  EditRefusal,
  GitFileStatus,
  IndexedSection,
  LocalEntry,
  RulingId,
  RulingRecord,
  RulingStatus,
  SourcePath,
} from './types.ts'

export type * from './types.ts'
export { ManifestError } from './manifest.ts'
export { githubSlug, hashSection, indexSections, sectionText } from './sections.ts'
export { describeCitationFailure, parseCite } from './citations.ts'
export { CONSULTATION_INSTRUCTION, CONSULTATION_WITHHELD_TOOLS, restrictToArchitectTools, SUBMIT_RULING_TOOL } from './consultation.ts'
export { ACCEPTANCES_FILE, APPEALS_DIRECTORY, RULINGS_DIRECTORY } from './records.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    architecture: ArchitectureService
  }
}

/** Byte cap on `git ls-files` output for one checkout. */
const LIST_OUTPUT_MAX_BYTES = 32 * 1024 * 1024

/** A loaded manifest and the index built from it for one repository root. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The architecture state of a repository changed: its index, a Ruling,
     * an appeal, or an acceptance. Emitted after the change is written.
     * @param root - canonical primary-worktree root of the repository.
     * @mode emit
     */
    'architecture/changed'(root: string): void
  }
}

/** An adjudication message delivered to a worker Session. */
export interface ArchitectureMessageSource {
  readonly kind: 'architecture'
  /** Appeal whose decision the message carries. */
  readonly appealId: AppealId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    architecture: ArchitectureMessageSource
  }
}

interface RootState {
  readonly manifest: ArchitectureManifest | undefined
  readonly index: ArchitectureIndex | undefined
  readonly protectedPaths: ProtectedPaths
}

/** One worker consultation. */
export interface ConsultRequest {
  /** The consulting worker; its Session owns the architect child and supplies the working directory. */
  readonly worker: Agent
  /** The question, in the worker's words. */
  readonly question: string
  /** Paths or components the question concerns. */
  readonly scope: readonly string[]
  /** Cancels the consultation, such as the consulting tool call's signal. */
  readonly signal: AbortSignal
}

/** Revision of a repository without a manifest. */
const EMPTY_REVISION = 'empty'
const RULINGS_DIRECTORY_PREFIX = `${RULINGS_DIRECTORY}/`
const APPEALS_DIRECTORY_PREFIX = `${APPEALS_DIRECTORY}/`
const ACCEPTANCES_FILE_NAME = ACCEPTANCES_FILE

/** Ruling status after each kind of adjudication. */
const STATUS_AFTER: Readonly<Record<Adjudication['kind'], RulingStatus>> = {
  uphold: 'upheld',
  overturn: 'overturned',
  exception: 'excepted',
}

/**
 * Hash the indexed content of a repository: sources, anchors, and section hashes.
 * @param index - an index.
 * @returns a 16-hex-digit revision that changes whenever any indexed section changes.
 */
export function indexRevision(index: ArchitectureIndex): string {
  const hash = createHash('sha256')
  for (const section of index.sections) hash.update(`${section.path}\0${section.anchor}\0${section.hash}\n`)
  return hash.digest('hex').slice(0, 16)
}

function acceptanceKey(section: { readonly path: string; readonly anchor: string; readonly hash: string }): string {
  return `${section.path}#${section.anchor}@${section.hash}`
}

/**
 * The message a worker receives when the user decides its appeal.
 * @param appeal - the appeal.
 * @param adjudication - the decision.
 * @returns model-facing text.
 */
export function adjudicationText(appeal: AppealRecord, adjudication: Adjudication): string {
  const note = adjudication.note === undefined ? '' : ` The user notes: ${adjudication.note}`
  switch (adjudication.kind) {
    case 'uphold':
      return `The user upheld Ruling ${appeal.rulingId} on your appeal ${appeal.id}. Keep following its constraints.${note}`
    case 'overturn':
      return `The user overturned Ruling ${appeal.rulingId} on your appeal ${appeal.id}. Its constraints no longer bind you; the user will revise the architecture record. Consult the architect again before relying on the revised design.${note}`
    case 'exception':
      return `The user granted an exception to Ruling ${appeal.rulingId} on your appeal ${appeal.id}, limited to: ${adjudication.scope}. Outside that scope its constraints still bind you.${note}`
  }
}

function relativeInside(root: string, target: string): string | undefined {
  const path = relative(root, target)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined
  return path.split(sep).join(posix.sep)
}

/**
 * Explain an edit refusal to a model or user.
 * @param refusal - the refusal.
 * @returns one sentence naming the violated condition.
 */
export function describeRefusal(refusal: EditRefusal): string {
  switch (refusal.kind) {
    case 'not-repository':
      return `${refusal.cwd} is not inside a git checkout, so the main-branch edit rule cannot be satisfied`
    case 'linked-worktree':
      return `architecture sources change only in the primary worktree ${refusal.primaryRoot}, not in the linked worktree ${refusal.root}`
    case 'wrong-branch':
      return `architecture sources change only on branch ${refusal.mainBranch}; the checkout is on ${refusal.branch ?? 'a detached HEAD'}`
    case 'not-protected':
      return `${refusal.path} is neither an architecture source, the manifest, nor a path under the local architecture directory`
    case 'unknown-section':
      return `${refusal.path} has no indexed section #${refusal.anchor}`
    case 'stale-section':
      return `${refusal.path}#${refusal.anchor} changed since it was read; its current hash is ${refusal.hash}`
  }
}

/**
 * Tools an Architect agent may run in the `architect` preset: repository read and search, web references,
 * Session query, the architecture tools, and the user-dialogue tools. It holds no generic write or execution tool.
 */
export const DEFAULT_ARCHITECT_TOOLS: readonly string[] = [
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
  'architecture_index',
  'architecture_read',
  'architecture_edit',
  'ask_user_question',
  'todo_write',
]

/** Workspace architecture sources, index, and edit rule. */
export class ArchitectureService extends Service {
  static inject = ['subprocess', 'tools']

  static Config: z<Config> = z.object({
    mainBranch: z.string().required().description('Branch whose primary-worktree checkout is the only place architecture sources change.'),
    manifestPath: z.string().default('architecture.yml').description('Workspace-relative path of the architecture manifest.'),
    localDirectory: z.string().default('.architecture').description('Workspace-relative directory holding local architecture entries.'),
    architectPreset: z.string().default('architect').description('Agent preset whose agents may run only `architectTools`.'),
    architectTools: z.array(z.string()).default([...DEFAULT_ARCHITECT_TOOLS])
      .description('Tool names an agent composed with `architectPreset` may run; every other call is denied.'),
    gitTimeoutMs: z.natural().min(1).default(10_000).description('Milliseconds a git command may run before it is terminated.'),
    maxSourceBytes: z.natural().min(1).default(1_048_576).description('Byte cap on one manifest source read while indexing.'),
    consultTimeoutMs: z.natural().min(1).default(300_000).description('Milliseconds a consultation waits for the architect to submit a Ruling.'),
  })

  private readonly config: Config
  private readonly roots = new Map<string, RootState>()
  private readonly architectTools: ReadonlySet<string>
  private readonly revisions = new Map<string, string>()
  /** Serializes read-modify-write of each repository's records. */
  private readonly writes = new Map<string, Promise<unknown>>()
  /** Lifts the tool mask of each agent currently composed with the architect preset. */
  private readonly masks = new WeakMap<Agent, () => void>()
  private files: GitFiles | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'architecture')
    for (const [field, value] of [['manifestPath', config.manifestPath], ['localDirectory', config.localDirectory]] as const) {
      if (value.length === 0 || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        throw new Error(`architecture: ${field} must be a workspace-relative path without ".." segments`)
      }
    }
    if (config.mainBranch.trim().length === 0) throw new Error('architecture: mainBranch must be a non-empty branch name')
    this.config = config
    // The service registers `submit_ruling` on its own consultation agents.
    this.architectTools = new Set([...config.architectTools, SUBMIT_RULING_TOOL])
    ctx.effect(() => ctx.tools.guard(exec => this.guardReason(exec)), 'architecture: edit-rule tool guard')
    // A decision made while the worker's agent was not live reaches it when the agent is next created.
    ctx.on('agent/created', ({ agent }) => {
      this.maskArchitect(agent)
      void this.deliverPending(agent).catch((error: unknown) => {
        ctx.logger.warn(`architecture: delivering appeal decisions to ${agent.id} failed: ${String(error)}`)
      })
      return undefined
    })
    // A blank Session may switch presets before its first turn.
    // The event fires from the selecting agent's own Session log, so that agent is live.
    ctx.on('agent-preset/selected', (sessionId) => {
      const agent = ctx.get('agents')?.get(sessionId)
      /* v8 ignore next -- the selecting agent is live while its Session appends the selection. */
      if (agent !== undefined) this.maskArchitect(agent)
    })
  }

  /** Resolve git once; the service cannot list sources without it. */
  async [Service.init](): Promise<void> {
    const executable = await this.ctx.subprocess.resolveExecutable('git')
    this.files = new GitFiles(this.ctx.subprocess, executable, {
      timeoutMs: this.config.gitTimeoutMs,
      outputMaxBytes: LIST_OUTPUT_MAX_BYTES,
    })
  }

  /**
   * Load the manifest and rebuild the index of the checkout containing `cwd`.
   * Rulings and the tool guard read the primary worktree, so the index is
   * always built from the primary worktree of that repository.
   * @param cwd - absolute directory inside the checkout.
   * @param signal - cancels the rebuild.
   * @returns the rebuilt index, or undefined when the repository has no manifest.
   * @throws {ManifestError} for a manifest that violates the manifest schema.
   * @throws when `cwd` is not inside a git checkout, or git fails.
   */
  async rebuild(cwd: string, signal?: AbortSignal): Promise<ArchitectureIndex | undefined> {
    const checkout = locateCheckout(cwd)
    if (checkout === undefined) throw new Error(`architecture: ${cwd} is not inside a git checkout`)
    const root = checkout.primaryRoot
    const manifestFile = join(root, this.config.manifestPath)
    const protectedBase: ProtectedPaths = {
      root,
      files: new Set([canonicalizeForWrite(manifestFile)]),
      localDirectory: canonicalizeForWrite(join(root, this.config.localDirectory)),
    }
    if (!existsSync(manifestFile)) {
      this.roots.set(root, { manifest: undefined, index: undefined, protectedPaths: protectedBase })
      if (this.revisions.get(root) !== EMPTY_REVISION) {
        this.revisions.set(root, EMPTY_REVISION)
        this.changed(root)
      }
      return undefined
    }
    const manifest = parseManifest(await readFile(manifestFile, 'utf8'), this.config.manifestPath)
    const files = this.requireFiles()
    const index = await buildIndex({
      root,
      manifest,
      maxSourceBytes: this.config.maxSourceBytes,
      listFiles: (listRoot, globs, listSignal) => files.list(listRoot, globs, listSignal),
      signal,
    })
    const protectedFiles = new Set(protectedBase.files)
    for (const source of index.sources) protectedFiles.add(canonicalizeForWrite(join(root, source)))
    this.roots.set(root, { manifest, index, protectedPaths: { ...protectedBase, files: protectedFiles } })
    const revision = indexRevision(index)
    if (this.revisions.get(root) !== revision) {
      this.revisions.set(root, revision)
      this.changed(root)
    }
    return index
  }

  /**
   * The last index built for the repository containing `cwd`.
   * @param cwd - absolute directory inside the checkout.
   * @returns the index, or undefined before the first rebuild or without a manifest.
   */
  index(cwd: string): ArchitectureIndex | undefined {
    const checkout = locateCheckout(cwd)
    return checkout === undefined ? undefined : this.roots.get(checkout.primaryRoot)?.index
  }

  /**
   * Whether an absolute path is protected in the repository containing it,
   * by the last rebuild of that repository. The manifest and the local
   * directory are protected even before a rebuild.
   * @param path - absolute path; need not exist.
   * @returns true when only {@link edit} may write the path.
   */
  isProtected(path: string): boolean {
    const target = canonicalizeForWrite(path)
    const checkout = locateCheckout(target)
    if (checkout === undefined) return false
    for (const root of new Set([checkout.root, checkout.primaryRoot])) {
      const state = this.roots.get(root)
      const paths = state?.protectedPaths ?? this.defaultProtected(root)
      if (isProtected(target, this.retarget(paths, root, checkout.root))) return true
    }
    return false
  }

  /**
   * Write one architecture file, or replace one of its indexed sections, under
   * the main-branch edit rule. The target must be the manifest, an indexed
   * source, or a path under the local directory, and the checkout must be the
   * primary worktree on `mainBranch`. A section edit reads the current file,
   * refuses when the section is missing or its hash differs from
   * `expectedHash`, and replaces the section's lines. The write replaces the
   * file atomically and rebuilds the index.
   * @param request - Session directory, target, optional section, and content.
   * @returns the written path, or the refusal.
   */
  async edit(request: ArchitectureEditRequest): Promise<ArchitectureEditResult> {
    const refusal = this.checkEdit(request.cwd, request.path)
    if (refusal !== undefined) return { kind: 'refused', refusal }
    const checkout = locateCheckout(request.cwd)
    /* v8 ignore next -- checkEdit refuses a missing checkout. */
    if (checkout === undefined) return { kind: 'refused', refusal: { kind: 'not-repository', cwd: request.cwd } }
    const target = canonicalizeForWrite(resolve(checkout.root, request.path))
    const path = relative(checkout.root, target).split(sep).join(posix.sep)
    let content = request.content
    if (request.anchor !== undefined) {
      // `checkEdit` admitted the target, so it is the manifest, an indexed source, or under the local directory.
      const current = await readFile(target, { encoding: 'utf8', signal: request.signal })
      const section = indexSections(brandString<SourcePath>(path), current).find(entry => entry.anchor === request.anchor)
      if (section === undefined) return { kind: 'refused', refusal: { kind: 'unknown-section', path, anchor: request.anchor } }
      if (request.expectedHash !== undefined && request.expectedHash !== section.hash) {
        return { kind: 'refused', refusal: { kind: 'stale-section', path, anchor: request.anchor, hash: section.hash } }
      }
      // The section's trailing blank lines separate it from the next heading; the replacement keeps them.
      const lines = current.split('\n')
      const body = lines.slice(section.line - 1, section.endLine)
      let blank = 0
      while (blank < body.length - 1 && body[body.length - 1 - blank]?.trim() === '') blank += 1
      const replacement = request.content.replace(/\s+$/, '').split('\n')
      content = [...lines.slice(0, section.line - 1), ...replacement, ...body.slice(body.length - blank), ...lines.slice(section.endLine)].join('\n')
    }
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, content, { signal: request.signal })
    await rename(temporary, target)
    await this.rebuild(checkout.root, request.signal)
    return { kind: 'written', path }
  }

  /**
   * Read one indexed section as it is in the primary worktree.
   * @param cwd - absolute directory inside the checkout.
   * @param path - source path from the index.
   * @param anchor - section anchor within that source.
   * @param signal - cancels the read.
   * @returns the section and its text, or undefined when the index has no such section.
   */
  async readSection(
    cwd: string,
    path: string,
    anchor: string,
    signal?: AbortSignal,
  ): Promise<{ section: IndexedSection; text: string } | undefined> {
    const index = this.index(cwd)
    const section = index?.sections.find(entry => entry.path === path && entry.anchor === anchor)
    if (index === undefined || section === undefined) return undefined
    const source = await readFile(join(index.root, section.path), { encoding: 'utf8', signal })
    return { section, text: sectionText(source, section) }
  }

  /**
   * Ask the architect one question on behalf of a worker. The service rebuilds
   * the index of the worker's repository, runs an architect agent as a hidden
   * child of the worker's Session, and validates its submission into a Ruling
   * whose every constraint cites a section committed on `mainBranch`.
   * @param request - worker, question, scope, and cancellation.
   * @returns the Ruling, or an unresolved result naming why there is none.
   * @throws when the worker has no working directory, the repository has no manifest, or the agent services are not mounted.
   */
  async consult(request: ConsultRequest): Promise<ConsultResult> {
    const cwd = request.worker.session.header.cwd
    if (cwd === undefined) throw new Error('architecture: the consulting Session has no working directory')
    const index = await this.rebuild(cwd, request.signal)
    if (index === undefined) throw new Error(`architecture: the repository has no ${this.config.manifestPath}; establish the architecture in an Architecture Session first`)
    const agents = this.ctx.get('agents')
    const presets = this.ctx.get('agentPresets')
    if (agents === undefined || presets === undefined) {
      throw new Error('architecture: consultation requires the agent registry and the agent preset registry')
    }
    const scopeLine = request.scope.length === 0 ? '' : `\n\nScope: ${request.scope.join(', ')}`
    const outcome = await runConsultation({
      agents,
      presets,
      worker: request.worker,
      cwd,
      prompt: `${request.question}${scopeLine}`,
      preset: this.config.architectPreset,
      tools: this.config.architectTools,
      timeoutMs: this.config.consultTimeoutMs,
      signal: request.signal,
    })
    if (outcome.kind !== 'submitted') return { kind: outcome.kind, id: outcome.id, session: outcome.session }
    const files = this.requireFiles()
    const accepted = await this.acceptedKeys(index.root)
    const ruling = await validateRuling(
      { id: outcome.id, question: request.question, scope: request.scope },
      outcome.submission,
      index,
      this.config.mainBranch,
      path => files.committed(index.root, this.config.mainBranch, path, request.signal),
      section => accepted.has(acceptanceKey(section)),
    )
    return { kind: 'ruling', ruling, session: outcome.session, revision: indexRevision(index) }
  }

  /**
   * Record a Ruling for the dashboard. Call after the worker's log committed
   * the consulting tool result, so the record never names a Ruling the worker
   * did not receive.
   * @param cwd - the worker Session's directory.
   * @param record - Ruling, Sessions, and index revision; status starts at `issued`.
   */
  async recordRuling(cwd: string, record: Omit<RulingRecord, 'version' | 'issuedAt' | 'status'>): Promise<void> {
    const root = this.primaryRoot(cwd)
    await this.serialize(root, () => this.store(root).writeRuling({ version: 1, ...record, issuedAt: Date.now(), status: 'issued' }))
    this.changed(root)
  }

  /**
   * File a worker's appeal against a recorded Ruling. The Ruling stays binding
   * while the appeal is pending.
   * @param request - Session directory, Ruling, appellant Session, reason, and evidence.
   * @returns the appeal record.
   * @throws when the repository has no record of the Ruling, or the Ruling is not the appellant's.
   */
  async appeal(request: {
    readonly cwd: string
    readonly rulingId: RulingId
    readonly workerSession: SessionId
    readonly reason: string
    readonly evidence: readonly string[]
  }): Promise<AppealRecord> {
    const root = this.primaryRoot(request.cwd)
    const record = await this.serialize(root, async () => {
      const store = this.store(root)
      const ruling = (await store.read()).rulings.get(request.rulingId)
      if (ruling === undefined) throw new Error(`architecture: no recorded Ruling ${request.rulingId}`)
      if (ruling.workerSession !== request.workerSession) {
        throw new Error(`architecture: Ruling ${request.rulingId} was issued to another Session`)
      }
      const appeal: AppealRecord = {
        version: 1,
        id: brandString<AppealId>(`appeal-${randomUUID()}`),
        rulingId: request.rulingId,
        workerSession: request.workerSession,
        reason: request.reason,
        evidence: request.evidence,
        filedAt: Date.now(),
        delivered: false,
      }
      await store.writeAppeal(appeal)
      await store.writeRuling({ ...ruling, status: 'appealed' })
      return appeal
    })
    this.changed(root)
    return record
  }

  /**
   * Record the user's decision on a pending appeal and deliver it to the
   * worker's Session when that Session's agent is live. An undelivered
   * decision is delivered when the Session's agent is next created.
   * @param cwd - any directory inside the repository.
   * @param appealId - the pending appeal.
   * @param adjudication - uphold, overturn, or a scoped exception.
   * @returns the decided appeal record.
   * @throws when the appeal does not exist or is already decided.
   */
  async adjudicate(cwd: string, appealId: AppealId, adjudication: Adjudication): Promise<AppealRecord> {
    const root = this.primaryRoot(cwd)
    const decided = await this.serialize(root, async () => {
      const store = this.store(root)
      const records = await store.read()
      const appeal = records.appeals.get(appealId)
      if (appeal === undefined) throw new Error(`architecture: no appeal ${appealId}`)
      if (appeal.adjudication !== undefined) throw new Error(`architecture: appeal ${appealId} is already decided`)
      const next: AppealRecord = { ...appeal, adjudication, decidedAt: Date.now() }
      await store.writeAppeal(next)
      const ruling = records.rulings.get(appeal.rulingId)
      if (ruling !== undefined) await store.writeRuling({ ...ruling, status: STATUS_AFTER[adjudication.kind] })
      return next
    })
    this.changed(root)
    await this.deliver(root, decided)
    return decided
  }

  /**
   * Deliver every decided, undelivered appeal of a Session whose agent is now live.
   * @param agent - the live agent.
   */
  async deliverPending(agent: Agent): Promise<void> {
    const cwd = agent.session.header.cwd
    const checkout = cwd === undefined ? undefined : locateCheckout(cwd)
    if (checkout === undefined) return
    const records = await this.store(checkout.primaryRoot).read()
    for (const appeal of records.appeals.values()) {
      if (appeal.workerSession === agent.id && appeal.adjudication !== undefined && !appeal.delivered) {
        await this.deliver(checkout.primaryRoot, appeal)
      }
    }
  }

  /**
   * Accept a section's current content so Rulings may cite it before it is
   * committed on `mainBranch`. Accepting again replaces the earlier hash.
   * @param cwd - any directory inside the repository.
   * @param path - source path of the section.
   * @param anchor - section anchor.
   * @param hash - the content hash the user reviewed; refused when the section has changed since.
   * @returns the recorded acceptance.
   * @throws when the section is not indexed or its hash differs from `hash`.
   */
  async accept(cwd: string, path: string, anchor: string, hash: string): Promise<Acceptance> {
    const root = this.primaryRoot(cwd)
    const index = await this.rebuild(root)
    const section = index?.sections.find(entry => entry.path === path && entry.anchor === anchor)
    if (section === undefined) throw new Error(`architecture: ${path}#${anchor} is not an indexed section`)
    if (section.hash !== hash) throw new Error(`architecture: ${path}#${anchor} changed since it was reviewed; its hash is ${section.hash}`)
    const acceptance: Acceptance = { path: section.path, anchor: section.anchor, hash: section.hash, acceptedAt: Date.now() }
    await this.serialize(root, async () => {
      const store = this.store(root)
      const kept = (await store.read()).acceptances.filter(entry => entry.path !== path || entry.anchor !== anchor)
      await store.writeAcceptances([...kept, acceptance])
    })
    this.changed(root)
    return acceptance
  }

  /**
   * Read the whole dashboard state of a repository. Rebuilds the index first.
   * @param cwd - any directory inside the repository.
   * @param signal - cancels the rebuild and git reads.
   * @returns the snapshot.
   * @throws for an invalid manifest, a directory outside git, or a git failure.
   */
  async snapshot(cwd: string, signal?: AbortSignal): Promise<ArchitectureSnapshot> {
    const root = this.primaryRoot(cwd)
    const built = await this.rebuild(root, signal)
    const index = built ?? { root, sources: [], sections: [], diagnostics: [] }
    const revision = built === undefined ? EMPTY_REVISION : indexRevision(built)
    const localEntries = await this.localEntries(root)
    const records = await this.store(root).read()
    const status = await this.requireFiles().status(root, [...index.sources, ...localEntries], signal)
    const gitStatus = (path: string): GitFileStatus => status.get(path) ?? 'committed'
    const current = new Map(index.sections.map(section => [`${section.path}#${section.anchor}`, section.hash]))
    const rulings = [...records.rulings.values()]
      .map(record => ({
        ...record,
        stale: record.ruling.constraints.some(constraint =>
          constraint.citations.some(citation => current.get(`${citation.path}#${citation.anchor}`) !== citation.hash)),
      }))
      .sort((a, b) => b.issuedAt - a.issuedAt)
    const appeals = [...records.appeals.values()].sort((a, b) =>
      Number(a.adjudication !== undefined) - Number(b.adjudication !== undefined) || b.filedAt - a.filedAt)
    return {
      root,
      mainBranch: this.config.mainBranch,
      manifestPath: this.config.manifestPath,
      localDirectory: this.config.localDirectory,
      hasManifest: this.roots.get(root)?.manifest !== undefined,
      revision,
      index,
      sourceStatus: Object.fromEntries(index.sources.map(source => [source, gitStatus(source)])),
      rulings,
      appeals,
      acceptances: records.acceptances,
      localEntries: localEntries.map((path): LocalEntry => ({ path, status: gitStatus(path) })),
      problems: records.problems.map(problem => ({ file: posix.join(this.config.localDirectory, problem.file), message: problem.message })),
    }
  }

  /**
   * Evaluate the edit rule without writing.
   * @param cwd - Session directory.
   * @param path - target, relative to the repository root or absolute.
   * @returns the refusal, or undefined when {@link edit} would write.
   */
  checkEdit(cwd: string, path: string): EditRefusal | undefined {
    const checkout = locateCheckout(cwd)
    if (checkout === undefined) return { kind: 'not-repository', cwd }
    if (!checkout.isPrimary) return { kind: 'linked-worktree', root: checkout.root, primaryRoot: checkout.primaryRoot }
    if (checkout.branch !== this.config.mainBranch) {
      return { kind: 'wrong-branch', branch: checkout.branch, mainBranch: this.config.mainBranch }
    }
    const target = canonicalizeForWrite(resolve(checkout.root, path))
    if (relativeInside(checkout.root, target) === undefined || !this.isProtected(target)) {
      return { kind: 'not-protected', path }
    }
    return undefined
  }

  private primaryRoot(cwd: string): string {
    const checkout = locateCheckout(cwd)
    if (checkout === undefined) throw new Error(`architecture: ${cwd} is not inside a git checkout`)
    return checkout.primaryRoot
  }

  private store(root: string): RecordStore {
    return new RecordStore(join(root, this.config.localDirectory))
  }

  private async serialize<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(root) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.writes.set(root, next.catch(() => undefined))
    return await next
  }

  private changed(root: string): void {
    this.ctx.emit('architecture/changed', root)
  }

  private async acceptedKeys(root: string): Promise<ReadonlySet<string>> {
    return new Set((await this.store(root).read()).acceptances.map(acceptanceKey))
  }

  /** Files under the local directory other than the records this service owns, as repository-relative paths. */
  private async localEntries(root: string): Promise<string[]> {
    const base = join(root, this.config.localDirectory)
    let names: string[]
    try {
      names = await readdir(base, { recursive: true })
    } catch (error: unknown) {
      if (isMissing(error)) return []
      throw error
    }
    const owned = [RULINGS_DIRECTORY_PREFIX, APPEALS_DIRECTORY_PREFIX]
    const entries: string[] = []
    for (const name of names.map(entry => entry.split(sep).join(posix.sep)).sort()) {
      if (name === ACCEPTANCES_FILE_NAME || owned.some(prefix => name.startsWith(prefix))) continue
      if (!(await stat(join(base, name))).isFile()) continue
      entries.push(posix.join(this.config.localDirectory, name))
    }
    return entries
  }

  private async deliver(root: string, appeal: AppealRecord): Promise<void> {
    const agent = this.ctx.get('agents')?.get(appeal.workerSession)
    if (agent === undefined || appeal.adjudication === undefined || appeal.delivered) return
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: adjudicationText(appeal, appeal.adjudication) }],
      source: { kind: 'architecture', appealId: appeal.id },
    }))
    await this.serialize(root, () => this.store(root).writeAppeal({ ...appeal, delivered: true }))
    this.changed(root)
  }

  private requireFiles(): GitFiles {
    /* v8 ignore next -- Service.init resolves git before the service is usable. */
    if (this.files === undefined) throw new Error('architecture: git is not resolved yet')
    return this.files
  }

  private defaultProtected(root: string): ProtectedPaths {
    return {
      root,
      files: new Set([canonicalizeForWrite(join(root, this.config.manifestPath))]),
      localDirectory: canonicalizeForWrite(join(root, this.config.localDirectory)),
    }
  }

  /** Map protected paths of a primary root onto the same relative paths in a linked checkout. */
  private retarget(paths: ProtectedPaths, from: string, to: string): ProtectedPaths {
    if (from === to) return paths
    // Every protected path lies inside `from`, so its relative spelling never escapes.
    const move = (path: string): string => join(to, relative(from, path))
    return { root: to, files: new Set([...paths.files].map(move)), localDirectory: move(paths.localDirectory) }
  }

  /**
   * Show an architect only the tools the guard lets it run, so its tool list and its permissions agree. The mask is
   * an agent-scope allow list: it also hides tools registered after it, and lifts when the agent leaves the preset.
   * @param agent - an agent just created or just recomposed.
   */
  private maskArchitect(agent: Agent): void {
    this.masks.get(agent)?.()
    this.masks.delete(agent)
    if (this.ctx.get('agentPresets')?.composedPreset(agent.ctx) !== this.config.architectPreset) return
    // A restriction names only tools the agent inherits from its preset scope; the agent's own registrations, such
    // as a consultation's `submit_ruling`, stay visible without it. A bound preset is always the agent's scope parent.
    const inherited = new Set(agent.ctx.tools.schemas(scopeParentOf(agent)).map(schema => schema.name))
    const allow = [...this.architectTools].filter(name => inherited.has(name))
    const lift = agent.ctx.effect(() => agent.ctx.tools.restrict({ allow }), 'architecture: architect tool mask')
    this.masks.set(agent, () => { void lift() })
  }

  private guardReason(exec: Readonly<ToolExecution>): string | undefined {
    const preset = exec.agent === undefined ? undefined : this.ctx.get('agentPresets')?.composedPreset(exec.agent.ctx)
    if (preset === this.config.architectPreset && !this.architectTools.has(exec.name)) {
      return `The ${exec.name} tool is unavailable to the architect: it discusses and records architecture and does not change code. Use the architecture tools instead.`
    }
    const target = writeTarget(writeCall(exec))
    if (target === undefined || !this.isProtected(target)) return undefined
    return `${target} is an architecture source. Architecture sources change only through the architecture agent on the main branch; do not edit them directly.`
  }
}

export default ArchitectureService
