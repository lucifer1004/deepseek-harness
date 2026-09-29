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
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { GitFiles } from './git-files.ts'
import { canonicalizeForWrite, isProtected, writeCall, writeTarget, type ProtectedPaths } from './guard.ts'
import { buildIndex } from './index-builder.ts'
import { parseManifest } from './manifest.ts'
import { locateCheckout } from './repository.ts'
import type {
  ArchitectureEditRequest,
  ArchitectureEditResult,
  ArchitectureIndex,
  ArchitectureManifest,
  Config,
  EditRefusal,
} from './types.ts'

export type * from './types.ts'
export { ManifestError } from './manifest.ts'
export { githubSlug, hashSection, indexSections } from './sections.ts'

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
    this.architectTools = new Set(config.architectTools)
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
      listFiles: (listRoot, listSignal) => files.list(listRoot, listSignal),
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
   * Write one architecture file under the main-branch edit rule. The target
   * must be the manifest, an indexed source, or a path under the local
   * directory, and the checkout must be the primary worktree on `mainBranch`.
   * The write replaces the file atomically and rebuilds the index.
   * @param request - Session directory, target, and content.
   * @returns the written path, or the refusal.
   */
  async edit(request: ArchitectureEditRequest): Promise<ArchitectureEditResult> {
    const refusal = this.checkEdit(request.cwd, request.path)
    if (refusal !== undefined) return { kind: 'refused', refusal }
    const checkout = locateCheckout(request.cwd)
    /* v8 ignore next -- checkEdit refuses a missing checkout. */
    if (checkout === undefined) return { kind: 'refused', refusal: { kind: 'not-repository', cwd: request.cwd } }
    const target = canonicalizeForWrite(resolve(checkout.root, request.path))
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, request.content, { signal: request.signal })
    await rename(temporary, target)
    await this.rebuild(checkout.root, request.signal)
    return { kind: 'written', path: relative(checkout.root, target).split(sep).join(posix.sep) }
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
