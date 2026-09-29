/**
 * Parse and validate the workspace architecture manifest. The manifest names the
 * repository files that are authoritative architecture sources; an absent
 * manifest means the workspace has no architecture sources yet.
 * @module @deepseek-ai/dsh-experimental-architecture/manifest
 */

import { posix } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { ArchitectureManifest } from './types.ts'

/** Error thrown for a manifest that exists but violates the manifest schema. */
export class ManifestError extends Error {
  override readonly name = 'ManifestError'
}

const relativeGlob = z.string().min(1).refine(
  glob => !posix.isAbsolute(glob) && !glob.includes('\\') && !glob.split('/').includes('..'),
  { message: 'must be a workspace-relative POSIX glob without ".." segments' },
)

const manifestSchema = z.strictObject({
  sources: z.array(relativeGlob).min(1),
})

/**
 * Parse manifest text.
 * @param text - UTF-8 contents of the manifest file.
 * @param path - manifest path used in error messages.
 * @returns the validated manifest.
 * @throws {ManifestError} when the text is not YAML or does not match the manifest schema.
 */
export function parseManifest(text: string, path: string): ArchitectureManifest {
  let value: unknown
  try {
    value = parseYaml(text)
  } catch (error) {
    // The yaml parser throws only YAMLError instances.
    throw new ManifestError(`${path}: invalid YAML: ${(error as Error).message}`)
  }
  const result = manifestSchema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new ManifestError(`${path}: ${issues.join('; ')}`)
  }
  return { sources: result.data.sources }
}
