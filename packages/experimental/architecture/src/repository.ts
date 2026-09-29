/**
 * Locate the git checkout containing a path by reading `.git` metadata from
 * the filesystem, synchronously, so the synchronous tool guard and the edit
 * rule use the same answer. A linked worktree's `.git` file names its private
 * git directory, whose `commondir` file names the shared repository directory.
 * @module @deepseek-ai/dsh-experimental-architecture/repository
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { CheckoutState } from './types.ts'

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    // readFileSync failed: the metadata file is absent or unreadable, which callers treat as "not present".
    return undefined
  }
}

function kind(path: string): 'file' | 'directory' | undefined {
  try {
    const info = statSync(path)
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
  } catch {
    // statSync failed: nothing exists at this path.
    return undefined
  }
}

/**
 * Describe the checkout containing a path.
 * @param start - absolute path inside the checkout; need not exist.
 * @returns the checkout, or undefined when no enclosing directory holds `.git`.
 */
export function locateCheckout(start: string): CheckoutState | undefined {
  // Walk up to an existing directory; the filesystem root always is one.
  let directory = start
  while (kind(directory) !== 'directory') directory = dirname(directory)
  directory = realpathSync.native(directory)
  for (;;) {
    const dotGit = join(directory, '.git')
    const found = kind(dotGit)
    if (found !== undefined) return describe(directory, dotGit, found)
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function describe(root: string, dotGit: string, found: 'file' | 'directory'): CheckoutState | undefined {
  let gitDir = dotGit
  if (found === 'file') {
    const pointer = readTrimmed(dotGit)
    const target = pointer?.startsWith('gitdir:') === true ? pointer.slice('gitdir:'.length).trim() : undefined
    if (target === undefined || target.length === 0) return undefined
    gitDir = isAbsolute(target) ? target : resolve(root, target)
  }
  const commonPointer = readTrimmed(join(gitDir, 'commondir'))
  let primaryRoot: string
  if (commonPointer === undefined) {
    // No commondir: this git directory is the repository's own, so this checkout is primary.
    primaryRoot = root
  } else {
    const common = realpathSync.native(isAbsolute(commonPointer) ? commonPointer : resolve(gitDir, commonPointer))
    // A bare repository has no primary work tree; every checkout of it is linked.
    primaryRoot = basename(common) === '.git' ? dirname(common) : common
  }
  const head = readTrimmed(join(gitDir, 'HEAD'))
  const branch = head?.startsWith('ref: refs/heads/') === true ? head.slice('ref: refs/heads/'.length) : undefined
  return { root, primaryRoot, isPrimary: root === primaryRoot, branch }
}
