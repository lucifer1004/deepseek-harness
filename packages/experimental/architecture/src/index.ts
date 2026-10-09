/**
 * `ctx.architecture`: the workspace architecture manifest, a rebuildable
 * section index of its sources, the main-branch edit rule, and the global tool
 * guard that keeps every other writer away from architecture sources.
 * @module @deepseek-ai/dsh-experimental-architecture
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the optional ctx.sessionQuery Context merge, which continuing a consultation reads.
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-settings'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { runConsultation, SUBMIT_RULING_TOOL, type ConsultationRun } from './consultation.ts'
import { foldConsultation, type ConsultationRoute } from './thread.ts'
import { GitFiles } from './git-files.ts'
import { canonicalizeForWrite, isProtected, writeCall, writeTarget, type ProtectedPaths } from './guard.ts'
import { JjFiles } from './jj-files.ts'
import { buildIndex, type SectionCache } from './index-builder.ts'
import { declaredMainBranch, ManifestError, parseManifest, withMainBranch } from './manifest.ts'
import { locateCheckout } from './repository.ts'
import { ACCEPTANCES_FILE, APPEALS_DIRECTORY, isMissing, RecordStore, RULINGS_DIRECTORY } from './records.ts'
import { validateRuling } from './ruling.ts'
import { hashSection, indexSections, sectionText } from './sections.ts'
import type {
  ArchitectureEditRequest,
  ArchitectureEditResult,
  ApplyProposedEditRequest,
  ApplyProposedEditResult,
  DismissProposedEditRequest,
  ProposedEdit,
  ArchitectureIndex,
  ArchitectureManifest,
  CheckoutBranches,
  CheckoutState,
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
  VcsKind,
} from './types.ts'
import type { VcsFiles } from './vcs.ts'

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

/** Byte cap on `git ls-files` or `jj file list` output for one checkout. */
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

/**
 * A message the architecture service writes into a Session: an adjudication delivered to a worker, a consultation
 * turn's question or its submit-now notice sent to the architect.
 */
export type ArchitectureMessageSource =
  | {
    readonly kind: 'architecture'
    /** Appeal whose decision the message carries. */
    readonly appealId: AppealId
  }
  | {
    readonly kind: 'architecture'
    /** The consultation turn's question, carrying the Ruling id the turn's submission issues under. */
    readonly rulingId: RulingId
  }
  | {
    readonly kind: 'architecture'
    /** The consultation turn's submit-now notice. */
    readonly deadline: true
  }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Messages the architecture service writes: adjudications in worker Sessions, and consultation questions and
     * deadline notices in architect Sessions. Readers preserve these messages without the producer; only the
     * architecture service reads the kind, to derive a consultation's pending Ruling id.
     * @persistenceAttribution
     */
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
  /** Consultation id (its architect Session) to continue; omitted to start a consultation. */
  readonly continue?: SessionId
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
      return `${refusal.cwd} is not inside a git or jj checkout, so it has no primary checkout where architecture sources change`
    case 'linked-worktree':
      return `architecture sources change only in the primary checkout ${refusal.primaryRoot}, not in ${refusal.root}`
    case 'unknown-branch':
      return `${refusal.branch} is not a local ${refusal.vcs === 'jj' ? 'bookmark' : 'branch'} of this repository`
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

  static Config = z.object({
    mainBranch: z.string().description('Main branch of a repository whose manifest declares no `mainBranch`.'),
    manifestPath: z.string().default('architecture.yml').description('Workspace-relative path of the architecture manifest.'),
    localDirectory: z.string().default('.architecture').description('Workspace-relative directory holding local architecture entries.'),
    architectPreset: z.string().default('architect').description('Agent preset whose agents may run only `architectTools`.'),
    architectTools: z.array(z.string()).default([...DEFAULT_ARCHITECT_TOOLS])
      .description('Tool names an agent composed with `architectPreset` may run; every other call is denied.'),
    gitTimeoutMs: z.natural().min(1).default(10_000).description('Milliseconds a git command may run before it is terminated.'),
    maxSourceBytes: z.natural().min(1).default(1_048_576).description('Byte cap on one manifest source read while indexing.'),
    consultTimeoutMs: z.natural().min(1).default(300_000).description('Milliseconds a consultation waits for the architect to submit a Ruling.'),
    consultNudgeMs: z.natural().min(1).default(240_000)
      .description('Milliseconds into a consultation at which the architect is told to submit now; less than `consultTimeoutMs`.'),
    architectProvider: z.string().volatile().description('Provider route of the consulted architect; unset runs it on the consulting worker\'s model.'),
    architectModel: z.string().volatile().description('Model of the consulted architect, used together with `architectProvider`.'),
    architectReasoningEffort: z.string().volatile().description('Reasoning effort of the consulted architect; unset keeps the model\'s default.'),
  })

  private readonly config: Config
  private readonly roots = new Map<string, RootState>()
  private readonly architectTools: ReadonlySet<string>
  private readonly revisions = new Map<string, string>()
  /** Sections of each root's last index build, holding one text per source, reused while a source is unchanged. */
  private readonly sectionCaches = new Map<string, SectionCache>()
  /** The last complete snapshot of each primary root, already marked not fresh. */
  private readonly lastSnapshots = new Map<string, ArchitectureSnapshot>()
  /** Serializes read-modify-write of each repository's records. */
  private readonly writes = new Map<string, Promise<unknown>>()
  /** Lifts the tool mask of each agent currently composed with the architect preset. */
  private readonly masks = new WeakMap<Agent, () => void>()
  private readonly files: Partial<Record<VcsKind, VcsFiles>> = {}

  constructor(ctx: Context, config: Config) {
    super(ctx, 'architecture')
    // The dashboard and the Plugins page render this plugin's settings, so no page is generated from its schema.
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    for (const [field, value] of [['manifestPath', config.manifestPath], ['localDirectory', config.localDirectory]] as const) {
      if (value.length === 0 || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        throw new Error(`architecture: ${field} must be a workspace-relative path without ".." segments`)
      }
    }
    if (config.mainBranch?.trim().length === 0) throw new Error('architecture: mainBranch must be a non-empty branch name')
    if (config.consultNudgeMs >= config.consultTimeoutMs) {
      throw new Error(`architecture: consultNudgeMs (${config.consultNudgeMs}) must be less than consultTimeoutMs (${config.consultTimeoutMs})`)
    }
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

  /** Resolve git and jj once. A repository whose version-control executable is missing is unsupported. */
  async [Service.init](): Promise<void> {
    const limits = { timeoutMs: this.config.gitTimeoutMs, outputMaxBytes: LIST_OUTPUT_MAX_BYTES }
    const resolve = async (command: string): Promise<string | undefined> => {
      try {
        return await this.ctx.subprocess.resolveExecutable(command)
      } catch {
        // resolveExecutable failed: the executable is not installed, so repositories of that kind are unsupported.
        return undefined
      }
    }
    const [git, jj] = await Promise.all([resolve('git'), resolve('jj')])
    if (git !== undefined) this.files.git = new GitFiles(this.ctx.subprocess, git, limits)
    if (jj !== undefined) this.files.jj = new JjFiles(this.ctx.subprocess, jj, limits)
  }

  /**
   * The version control of the checkout containing a directory and the repository's local branches.
   * @param cwd - absolute directory inside the checkout.
   * @param signal - cancels git and jj queries.
   * @returns the system, whether the checkout is the primary one, the branch or bookmark names it is on now, and every
   * local branch or bookmark.
   * @throws when `cwd` is not inside a usable git or jj checkout, or version control fails.
   */
  async branches(cwd: string, signal?: AbortSignal): Promise<CheckoutBranches> {
    const checkout = this.requireCheckout(cwd)
    const { all, current } = await this.filesOf(checkout).branches(checkout, signal)
    return { vcs: checkout.vcs, isPrimary: checkout.isPrimary, current, all }
  }

  /**
   * The checkout containing a directory, when the service can read its version control.
   * @param cwd - absolute directory.
   * @returns the checkout, or undefined outside git and jj or when that system's executable is not installed.
   */
  checkout(cwd: string): CheckoutState | undefined {
    const checkout = locateCheckout(cwd)
    return checkout !== undefined && this.files[checkout.vcs] !== undefined ? checkout : undefined
  }

  /**
   * Load the manifest and rebuild the index of the checkout containing `cwd`.
   * Rulings and the tool guard read the primary worktree, so the index is
   * always built from the primary worktree of that repository.
   * @param cwd - absolute directory inside the checkout.
   * @param signal - cancels the rebuild.
   * @returns the rebuilt index, or undefined when the repository has no manifest.
   * @throws {ManifestError} for a manifest that violates the manifest schema.
   * @throws when `cwd` is not inside a git or jj checkout, or version control fails.
   */
  async rebuild(cwd: string, signal?: AbortSignal): Promise<ArchitectureIndex | undefined> {
    const checkout = this.requireCheckout(cwd)
    const root = checkout.primaryRoot
    const manifestFile = join(root, this.config.manifestPath)
    const protectedBase: ProtectedPaths = {
      root,
      files: new Set([canonicalizeForWrite(manifestFile)]),
      localDirectory: canonicalizeForWrite(join(root, this.config.localDirectory)),
    }
    if (!existsSync(manifestFile)) {
      this.roots.set(root, { manifest: undefined, index: undefined, protectedPaths: protectedBase })
      const previous = this.revisions.get(root)
      this.revisions.set(root, EMPTY_REVISION)
      if (previous !== undefined && previous !== EMPTY_REVISION) this.changed(root)
      return undefined
    }
    const manifest = parseManifest(await readFile(manifestFile, 'utf8'), this.config.manifestPath)
    const files = this.filesOf(checkout)
    const { cache, ...index } = await buildIndex({
      root,
      manifest,
      maxSourceBytes: this.config.maxSourceBytes,
      listFiles: (listRoot, globs, listSignal) => files.list(listRoot, globs, listSignal),
      signal,
      previous: this.sectionCaches.get(root),
    })
    this.sectionCaches.set(root, cache)
    const protectedFiles = new Set(protectedBase.files)
    for (const source of index.sources) protectedFiles.add(canonicalizeForWrite(join(root, source)))
    this.roots.set(root, { manifest, index, protectedPaths: { ...protectedBase, files: protectedFiles, sources: manifest } })
    const revision = indexRevision(index)
    const previous = this.revisions.get(root)
    this.revisions.set(root, revision)
    // The first build of a root establishes its revision: no reader could hold an earlier one, and the reader that
    // asked receives this build.
    if (previous !== undefined && previous !== revision) this.changed(root)
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
    const checkout = this.checkout(target)
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
   * the edit rule. The target must be the manifest, an indexed source, or a
   * path under the local directory, and the checkout must be the primary
   * worktree or jj workspace, on any branch. A section edit reads the current file,
   * refuses when the section is missing or its hash differs from
   * `expectedHash`, and replaces the section's lines. The write replaces the
   * file atomically and rebuilds the index.
   * @param request - Session directory, target, optional section, and content.
   * @returns the written path, or the refusal.
   */
  async edit(request: ArchitectureEditRequest): Promise<ArchitectureEditResult> {
    const refusal = this.checkEdit(request.cwd, request.path)
    if (refusal !== undefined) return { kind: 'refused', refusal }
    const checkout = this.checkout(request.cwd)
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
    const before = this.revisions.get(checkout.primaryRoot)
    await this.rebuild(checkout.root, request.signal)
    // A write that leaves every section alone, such as a changed mainBranch or a record file, still changes the
    // snapshot, so it is announced when the rebuild did not.
    if (this.revisions.get(checkout.primaryRoot) === before) this.changed(checkout.primaryRoot)
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
   * whose every constraint cites a section committed on `mainBranch`. With
   * `continue`, it resumes that consultation's architect Session for another
   * turn on the route the consultation started with; a timeout or a turn
   * without a submission leaves its Ruling id pending for the next turn.
   * @param request - worker, question, scope, cancellation, and the consultation to continue.
   * @returns the Ruling, or an unresolved result naming why there is none; each names the consultation.
   * @throws when the worker has no working directory, the repository has no manifest, or the agent services are not
   *   mounted, or when `continue` names no consultation the worker started, names one still running, or the session
   *   query service is not mounted.
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
    const thread = request.continue === undefined ? undefined : await this.openThread(request.worker, request.continue, request.signal)
    const outcome = await runConsultation({
      agents,
      presets,
      worker: request.worker,
      cwd,
      prompt: `${request.question}${scopeLine}`,
      preset: this.config.architectPreset,
      tools: this.config.architectTools,
      // A continuation runs on the route its consultation started with.
      model: thread === undefined ? this.architectModel() : thread.route,
      timeoutMs: this.config.consultTimeoutMs,
      nudgeMs: this.config.consultNudgeMs,
      signal: request.signal,
      ...thread === undefined ? {} : { continuation: { session: thread.session, rulingId: thread.rulingId } },
    })
    if (outcome.kind !== 'submitted') return { kind: outcome.kind, id: outcome.id, session: outcome.session }
    const files = this.filesOf(this.requireCheckout(index.root))
    const accepted = await this.acceptedKeys(index.root)
    const mainBranch = this.mainBranchOf(index.root)
    const ruling = await validateRuling(
      { id: outcome.id, question: request.question, scope: request.scope },
      outcome.submission,
      index,
      mainBranch,
      // Without a main branch the citations never read a committed version.
      path => files.committed(index.root, mainBranch as string, path, request.signal),
      section => accepted.has(acceptanceKey(section)),
    )
    return { kind: 'ruling', ruling, session: outcome.session, revision: indexRevision(index) }
  }

  /**
   * Check that `worker` may continue the consultation `session`, and derive the Ruling id its next turn issues under.
   * @param worker - the calling worker.
   * @param session - the consultation id.
   * @param signal - cancels the log read.
   * @returns the route the consultation started with, and the pending or a new Ruling id.
   * @throws when the id names no consultation the worker started, or the consultation is running.
   */
  private async openThread(
    worker: Agent,
    session: SessionId,
    signal: AbortSignal,
  ): Promise<{ readonly session: SessionId; readonly route: ConsultationRoute; readonly rulingId: RulingId }> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) throw new Error('architecture: continuing a consultation requires the session query service')
    // An unknown id, another worker's consultation, and a Session that is no consultation get one answer.
    const unknown = new Error(`architecture: ${session} is not a consultation this Session started`)
    if (this.ctx.get('agents')?.get(session) !== undefined) throw new Error(`architecture: consultation ${session} is still running`)
    let observation: Awaited<ReturnType<typeof query.observeSession>>
    try {
      observation = await query.observeSession(session, { signal })
    } catch (_error: unknown) {
      // The query reports an id it cannot open; the worker learns only that it names no consultation of its own.
      signal.throwIfAborted()
      throw unknown
    }
    using source = observation
    if (source.header.parentSession !== worker.id || source.header.agentPreset !== this.config.architectPreset) throw unknown
    const thread = foldConsultation(source.events.slice(source.inheritedEventCount), SUBMIT_RULING_TOOL)
    if (thread === undefined) throw unknown
    return { session, route: thread.route, rulingId: thread.pendingRulingId ?? brandString<RulingId>(`ruling-${randomUUID()}`) }
  }

  /**
   * Record a Ruling for the dashboard. Call after the worker's log committed
   * the consulting tool result, so the record never names a Ruling the worker
   * did not receive.
   * @param cwd - the worker Session's directory.
   * @param record - Ruling, Sessions, and index revision; status starts at `issued`.
   */
  async recordRuling(cwd: string, record: Omit<RulingRecord, 'version' | 'issuedAt' | 'status' | 'appliedEdits' | 'dismissedEdits'>): Promise<void> {
    const root = this.primaryRoot(cwd)
    const initial = { issuedAt: Date.now(), status: 'issued', appliedEdits: [], dismissedEdits: [] } as const
    await this.serialize(root, () => this.store(root).writeRuling({ version: 1, ...record, ...initial }))
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
    const checkout = cwd === undefined ? undefined : this.checkout(cwd)
    if (checkout === undefined) return
    const records = await this.store(checkout.primaryRoot).read()
    for (const appeal of records.appeals.values()) {
      if (appeal.workerSession === agent.id && appeal.adjudication !== undefined && !appeal.delivered) {
        await this.deliver(checkout.primaryRoot, appeal)
      }
    }
  }

  /**
   * Apply one proposed edit of a recorded Ruling from the primary checkout, under the edit rule. The write is refused
   * when the section changed since the architect read it. With `accept`, the section the write produced is accepted.
   * @param request - repository directory, Ruling, the edit's index in `ruling.proposedEdits`, and whether to accept.
   * @returns the written path, or the refusal; an accepted section is returned with the written result.
   * @throws when the Ruling is not recorded, the index names no proposed edit, or the edit was already applied or dismissed.
   */
  async applyProposedEdit(request: ApplyProposedEditRequest): Promise<ApplyProposedEditResult> {
    const root = this.primaryRoot(request.cwd)
    // The marker check, the write, and the marker update run in one serialized section, so a concurrent dismissal or
    // second apply of the same edit sees this one's result.
    const outcome = await this.serialize(root, async () => {
      const store = this.store(root)
      const { record, edit } = await this.openEdit(store, request.rulingId, request.index)
      const { path, anchor, hash, content } = edit
      const result = await this.edit({ cwd: request.cwd, path, anchor, expectedHash: hash, content, signal: request.signal })
      if (result.kind === 'written') await store.writeRuling({ ...record, appliedEdits: [...record.appliedEdits, request.index] })
      return { result, edit }
    })
    const { result, edit } = outcome
    if (result.kind === 'refused') return result
    if (!request.accept) {
      this.changed(root)
      return result
    }
    // A changed heading changes the anchor, so the written section is found by the hash of the reviewed content. Content
    // that splits into several sections matches none, and then nothing is accepted.
    const written = this.index(root)?.sections.find(section => section.path === edit.path && section.hash === hashSection(edit.content))
    if (written === undefined) {
      this.changed(root)
      return { ...result, acceptance: undefined }
    }
    const acceptance = await this.accept(root, written.path, written.anchor, written.hash)
    return { ...result, acceptance }
  }

  /**
   * Dismiss one proposed edit of a recorded Ruling, so the dashboard stops offering it. Writes only the Ruling record;
   * the worker never sees the marker, and the edit stays a non-binding proposal.
   * @param request - repository directory, Ruling, and the edit's index in `ruling.proposedEdits`.
   * @throws when the Ruling is not recorded, the index names no proposed edit, or the edit was already applied or dismissed.
   */
  async dismissProposedEdit(request: DismissProposedEditRequest): Promise<void> {
    const root = this.primaryRoot(request.cwd)
    await this.serialize(root, async () => {
      const store = this.store(root)
      const { record } = await this.openEdit(store, request.rulingId, request.index)
      await store.writeRuling({ ...record, dismissedEdits: [...record.dismissedEdits, request.index] })
    })
    this.changed(root)
  }

  /** The recorded Ruling and its proposed edit at `index`, when the edit is neither applied nor dismissed; call while serialized. */
  private async openEdit(store: RecordStore, rulingId: RulingId, index: number): Promise<{ record: RulingRecord; edit: ProposedEdit }> {
    const record = (await store.read()).rulings.get(rulingId)
    if (record === undefined) throw new Error(`architecture: no Ruling ${rulingId}`)
    const edit = record.ruling.proposedEdits[index]
    if (edit === undefined) throw new Error(`architecture: Ruling ${rulingId} has no proposed edit ${index}`)
    if (record.appliedEdits.includes(index)) throw new Error(`architecture: proposed edit ${index} of Ruling ${rulingId} is already applied`)
    if (record.dismissedEdits.includes(index)) throw new Error(`architecture: proposed edit ${index} of Ruling ${rulingId} is dismissed`)
    return { record, edit }
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
   * Read the whole dashboard state of a repository. Rebuilds the index first, and keeps the result for
   * {@link lastSnapshot}.
   * @param cwd - any directory inside the repository.
   * @param signal - cancels the rebuild and git reads.
   * @returns the snapshot; outside a usable git or jj checkout, an empty snapshot with `unsupported` set.
   * @throws for an invalid manifest or a version-control failure.
   */
  async snapshot(cwd: string, signal?: AbortSignal): Promise<ArchitectureSnapshot> {
    const found = locateCheckout(cwd)
    if (found === undefined || this.files[found.vcs] === undefined) {
      const unsupported = found === undefined ? { kind: 'no-repository' as const } : { kind: 'vcs-missing' as const, vcs: found.vcs }
      return {
        root: canonicalizeForWrite(cwd),
        unsupported,
        manifestPath: this.config.manifestPath,
        localDirectory: this.config.localDirectory,
        hasManifest: false,
        revision: EMPTY_REVISION,
        index: { root: canonicalizeForWrite(cwd), sources: [], sections: [], diagnostics: [] },
        sourceStatus: {},
        rulings: [],
        appeals: [],
        acceptances: [],
        localEntries: [],
        problems: [],
        fresh: true,
      }
    }
    const checkout = found
    const root = checkout.primaryRoot
    const files = this.filesOf(checkout)
    // setMainBranch writes in the primary checkout, so its branch list is the one the dashboard offers.
    const primary = locateCheckout(root)
    /* v8 ignore next -- root is the primary root of a located checkout, so it locates. */
    if (primary === undefined) throw new Error(`${root} is not a checkout`)
    const mainBranch = this.mainBranchOf(root)
    // Every VCS query that needs no listing runs beside the index build, so a snapshot waits for one round of them.
    const globs = this.manifestGlobs(root)
    const localEntries = await this.localEntries(root)
    const pending = [
      files.branches(primary, signal),
      files.status(root, mainBranch, localEntries, signal),
      globs === undefined ? Promise.resolve(undefined) : files.globStatus(root, mainBranch, globs, signal),
    ] as const
    // A query that rejects while the index builds is awaited below; observing it here keeps it from going unhandled.
    for (const query of pending) query.catch(() => undefined)
    const built = await this.rebuild(root, signal)
    const index = built ?? { root, sources: [], sections: [], diagnostics: [] }
    const revision = built === undefined ? EMPTY_REVISION : indexRevision(built)
    const records = await this.store(root).read()
    const [branches, localStatus, sourceGlobStatus] = await Promise.all(pending)
    // A glob query covers more than the sources, so only the indexed sources keep its states.
    const sourceStatus = sourceGlobStatus ?? await files.status(root, mainBranch, index.sources, signal)
    const status = new Map([...index.sources.flatMap((source) => {
      const state = sourceStatus.get(source)
      return state === undefined ? [] : [[source, state] as const]
    }), ...localStatus])
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
    const snapshot: ArchitectureSnapshot = {
      root,
      vcs: checkout.vcs,
      ...(mainBranch === undefined ? {} : { mainBranch }),
      branches,
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
      fresh: true,
    }
    // Only a complete read replaces the copy a later reader may see first.
    this.lastSnapshots.set(root, { ...snapshot, fresh: false })
    return snapshot
  }

  /**
   * The last complete snapshot {@link snapshot} read for the repository containing `cwd`, without reading anything.
   * @param cwd - any directory inside the repository.
   * @returns that snapshot with `fresh` false, or undefined before the first complete read, outside a usable checkout,
   *   and after the service restarts.
   */
  lastSnapshot(cwd: string): ArchitectureSnapshot | undefined {
    const checkout = locateCheckout(cwd)
    return checkout === undefined ? undefined : this.lastSnapshots.get(checkout.primaryRoot)
  }

  /**
   * Declare the repository's main branch in its manifest, from the primary checkout. The branch must be one of the
   * repository's local branches or bookmarks.
   * @param cwd - any directory inside the repository.
   * @param branch - the branch or jj bookmark to declare.
   * @param signal - cancels git and jj queries.
   * @returns the written manifest path, or the refusal.
   * @throws {ManifestError} when the repository has no valid manifest or `branch` is not a branch name.
   */
  async setMainBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<ArchitectureEditResult> {
    const checkout = this.requireCheckout(cwd)
    if (!checkout.isPrimary) return { kind: 'refused', refusal: { kind: 'linked-worktree', root: checkout.root, primaryRoot: checkout.primaryRoot } }
    let text: string
    try {
      text = await readFile(join(checkout.primaryRoot, this.config.manifestPath), 'utf8')
    } catch (error) {
      throw new ManifestError(`${this.config.manifestPath}: cannot read the manifest: ${String(error)}`)
    }
    const content = withMainBranch(text, branch, this.config.manifestPath)
    const { all } = await this.filesOf(checkout).branches(checkout, signal)
    if (!all.includes(branch)) return { kind: 'refused', refusal: { kind: 'unknown-branch', vcs: checkout.vcs, branch } }
    return await this.edit({ cwd: checkout.primaryRoot, path: this.config.manifestPath, content, signal })
  }

  /**
   * Evaluate the edit rule without writing: architecture files change only in the primary checkout, on any branch.
   * @param cwd - Session directory.
   * @param path - target, relative to the repository root or absolute.
   * @returns the refusal, or undefined when {@link edit} would write.
   */
  checkEdit(cwd: string, path: string): EditRefusal | undefined {
    const checkout = this.checkout(cwd)
    if (checkout === undefined) return { kind: 'not-repository', cwd }
    if (!checkout.isPrimary) return { kind: 'linked-worktree', root: checkout.root, primaryRoot: checkout.primaryRoot }
    const target = canonicalizeForWrite(resolve(checkout.root, path))
    if (relativeInside(checkout.root, target) === undefined || !this.isProtected(target)) {
      return { kind: 'not-protected', path }
    }
    return undefined
  }

  /**
   * The main branch of the repository at `root`: the manifest's `mainBranch`, else the service default. The manifest
   * is read on each call, so a branch change applies at once and a manifest under repair still names its branch.
   */
  /** The source globs of the manifest the root's last build read, or of the manifest on disk before any build. */
  private manifestGlobs(root: string): readonly string[] | undefined {
    const built = this.roots.get(root)
    if (built !== undefined) return built.manifest?.sources
    try {
      return parseManifest(readFileSync(join(root, this.config.manifestPath), 'utf8'), this.config.manifestPath).sources
    } catch {
      // An absent or invalid manifest leaves the sources to the listing; the index build reports it.
      return undefined
    }
  }

  private mainBranchOf(root: string): string | undefined {
    let text: string
    try {
      text = readFileSync(join(root, this.config.manifestPath), 'utf8')
    } catch {
      // readFileSync failed: the repository has no readable manifest, so only the default can apply.
      return this.config.mainBranch
    }
    return declaredMainBranch(text) ?? this.config.mainBranch
  }

  /** The configured architect model, read now so a settings change applies to the next consultation. */
  private architectModel(): ConsultationRun['model'] {
    const provider = this.config.architectProvider.get()
    const model = this.config.architectModel.get()
    if (provider === undefined || model === undefined) return undefined
    const effort = this.config.architectReasoningEffort.get()
    return { provider, model, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) } }
  }

  private primaryRoot(cwd: string): string {
    return this.requireCheckout(cwd).primaryRoot
  }

  private requireCheckout(cwd: string): CheckoutState {
    const checkout = locateCheckout(cwd)
    if (checkout === undefined) throw new Error(`architecture: ${cwd} is not inside a git or jj checkout`)
    if (this.files[checkout.vcs] === undefined) throw new Error(`architecture: ${checkout.root} is a ${checkout.vcs} checkout, but ${checkout.vcs} is not installed`)
    return checkout
  }

  private filesOf(checkout: CheckoutState): VcsFiles {
    const files = this.files[checkout.vcs]
    /* v8 ignore next -- every checkout reaching here came from checkout() or requireCheckout(), which require the adapter. */
    if (files === undefined) throw new Error(`architecture: ${checkout.vcs} is not installed`)
    return files
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
    return { root: to, files: new Set([...paths.files].map(move)), localDirectory: move(paths.localDirectory), sources: paths.sources }
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
    return `${target} is an architecture source. Architecture sources change only through the architecture agent; do not edit them directly.`
  }
}

export default ArchitectureService
