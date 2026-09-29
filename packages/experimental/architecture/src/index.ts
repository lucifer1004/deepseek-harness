/**
 * `ctx.architecture`: the workspace architecture manifest, a rebuildable
 * section index of its sources, the main-branch edit rule, and the global tool
 * guard that keeps every other writer away from architecture sources.
 * @module @deepseek-ai/dsh-experimental-architecture
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { runConsultation, SUBMIT_RULING_TOOL } from './consultation.ts'
import { GitFiles } from './git-files.ts'
import { canonicalizeForWrite, isProtected, writeCall, writeTarget, type ProtectedPaths } from './guard.ts'
import { buildIndex } from './index-builder.ts'
import { parseManifest } from './manifest.ts'
import { locateCheckout } from './repository.ts'
import { validateRuling } from './ruling.ts'
import { indexSections, sectionText } from './sections.ts'
import type {
  ArchitectureEditRequest,
  ArchitectureEditResult,
  ArchitectureIndex,
  ArchitectureManifest,
  Config,
  ConsultRequest,
  ConsultResult,
  EditRefusal,
  IndexedSection,
  SourcePath,
} from './types.ts'

export type * from './types.ts'
export { ManifestError } from './manifest.ts'
export { githubSlug, hashSection, indexSections, sectionText } from './sections.ts'
export { describeCitationFailure, parseCite } from './citations.ts'
export { CONSULTATION_INSTRUCTION, restrictToArchitectTools, SUBMIT_RULING_TOOL } from './consultation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    architecture: ArchitectureService
  }
}

/** Byte cap on `git ls-files` output for one checkout. */
const LIST_OUTPUT_MAX_BYTES = 32 * 1024 * 1024

/** A loaded manifest and the index built from it for one repository root. */
interface RootState {
  readonly manifest: ArchitectureManifest | undefined
  readonly index: ArchitectureIndex | undefined
  readonly protectedPaths: ProtectedPaths
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

/** Workspace architecture sources, index, and edit rule. */
export class ArchitectureService extends Service {
  static inject = ['subprocess', 'tools']

  static Config: z<Config> = z.object({
    mainBranch: z.string().required().description('Branch whose primary-worktree checkout is the only place architecture sources change.'),
    manifestPath: z.string().default('architecture.yml').description('Workspace-relative path of the architecture manifest.'),
    localDirectory: z.string().default('.architecture').description('Workspace-relative directory holding local architecture entries.'),
    architectPreset: z.string().default('architect').description('Agent preset whose agents may run only `architectTools`.'),
    architectTools: z.array(z.string()).default([]).description('Tool names an agent composed with `architectPreset` may run; every other call is denied.'),
    gitTimeoutMs: z.natural().min(1).default(10_000).description('Milliseconds a git command may run before it is terminated.'),
    maxSourceBytes: z.natural().min(1).default(1_048_576).description('Byte cap on one manifest source read while indexing.'),
    consultTimeoutMs: z.natural().min(1).default(300_000).description('Milliseconds a consultation waits for the architect to submit a Ruling.'),
  })

  private readonly config: Config
  private readonly roots = new Map<string, RootState>()
  private readonly architectTools: ReadonlySet<string>
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
    const ruling = await validateRuling(
      { id: outcome.id, question: request.question, scope: request.scope },
      outcome.submission,
      index,
      this.config.mainBranch,
      path => files.committed(index.root, this.config.mainBranch, path, request.signal),
    )
    return { kind: 'ruling', ruling, session: outcome.session }
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
