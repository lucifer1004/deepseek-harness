/**
 * Build the architecture index of one repository checkout from its manifest.
 * Sources are the checkout's tracked and untracked-but-not-ignored files that
 * match a manifest glob; only Markdown sources are split into sections.
 * @module @deepseek-ai/dsh-experimental-architecture/index-builder
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import picomatch from 'picomatch'
import { brandString } from '@deepseek-ai/dsh-brand'
import { indexSections } from './sections.ts'
import type { ArchitectureIndex, ArchitectureManifest, IndexDiagnostic, IndexedSection, SourcePath } from './types.ts'

/** Lists the checkout's candidate files under the given globs as repository-relative POSIX paths. */
export type ListFiles = (root: string, globs: readonly string[], signal: AbortSignal | undefined) => Promise<readonly string[]>

/** Inputs for one index build. */
export interface BuildIndexRequest {
  /** Canonical repository root. */
  readonly root: string
  /** Validated manifest of that root. */
  readonly manifest: ArchitectureManifest
  /** Byte cap on one source read. */
  readonly maxSourceBytes: number
  /** Lists candidate files. */
  readonly listFiles: ListFiles
  /** Cancels listing and reads. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Match candidate paths against manifest globs.
 * @param files - repository-relative POSIX paths.
 * @param manifest - source and exclude globs.
 * @returns paths matching a source glob and no exclude glob, sorted and deduplicated.
 */
export function matchSources(files: readonly string[], manifest: Pick<ArchitectureManifest, 'sources' | 'exclude'>): SourcePath[] {
  const included = picomatch([...manifest.sources], { dot: true })
  const excluded = manifest.exclude.length === 0 ? () => false : picomatch([...manifest.exclude], { dot: true })
  return [...new Set(files.filter(file => included(file) && !excluded(file)))].sort().map(file => brandString<SourcePath>(file))
}

/**
 * Build the index. A source that cannot be read, exceeds the byte cap, or is
 * not valid UTF-8 produces a diagnostic instead of sections.
 * @param request - root, manifest, limits, and file lister.
 * @returns the rebuilt index.
 */
export async function buildIndex(request: BuildIndexRequest): Promise<ArchitectureIndex> {
  const files = await request.listFiles(request.root, request.manifest.sources, request.signal)
  const sources = matchSources(files, request.manifest)
  const sections: IndexedSection[] = []
  const diagnostics: IndexDiagnostic[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const source of sources) {
    request.signal?.throwIfAborted()
    const absolute = join(request.root, source)
    try {
      const info = await stat(absolute)
      if (info.size > request.maxSourceBytes) {
        diagnostics.push({ path: source, message: `source is ${info.size} bytes, above the ${request.maxSourceBytes}-byte limit` })
        continue
      }
      const bytes = await readFile(absolute, { signal: request.signal })
      const text = decoder.decode(bytes)
      if (source.endsWith('.md')) sections.push(...indexSections(source, text))
    } catch (error) {
      // Node fs and TextDecoder reject only with Error instances.
      request.signal?.throwIfAborted()
      diagnostics.push({ path: source, message: (error as Error).message })
    }
  }
  return { root: request.root, sources, sections, diagnostics }
}
