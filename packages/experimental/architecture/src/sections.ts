/**
 * Split one Markdown source into heading-delimited sections with GitHub-style
 * anchors and content hashes. A section runs from its heading through the line
 * before the next heading of any level, so a nested heading starts a new section
 * and editing it leaves the parent's hash unchanged.
 * @module @deepseek-ai/dsh-experimental-architecture/sections
 */

import { createHash } from 'node:crypto'
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { toString } from 'mdast-util-to-string'
import { gfm } from 'micromark-extension-gfm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { IndexedSection, SectionHash, SourcePath } from './types.ts'

interface Heading {
  readonly level: number
  readonly line: number
  readonly title: string
}

function headings(source: string): Heading[] {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const found: Heading[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'heading' && node.position !== undefined) {
      found.push({ level: node.depth, line: node.position.start.line, title: toString(node, { includeHtml: false }).trim() })
      return
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return found
}

/**
 * GitHub's heading slug: lowercase, drop everything except letters, numbers,
 * underscores, spaces, and hyphens, then turn spaces into hyphens.
 * @param title - rendered heading text.
 * @returns the anchor GitHub assigns the first heading with this text.
 */
export function githubSlug(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-')
}

/**
 * Hash section text after normalizing line endings and trailing whitespace, so
 * a CRLF checkout or a trailing blank line does not change the hash.
 * @param text - the section's lines joined by newlines.
 * @returns the SHA-256 hex digest.
 */
export function hashSection(text: string): SectionHash {
  const normalized = text.replaceAll('\r\n', '\n').split('\n').map(line => line.trimEnd()).join('\n').trim()
  return brandString<SectionHash>(createHash('sha256').update(normalized).digest('hex'))
}

/**
 * The text of one section as {@link indexSections} hashed it.
 * @param source - the source's UTF-8 text.
 * @param section - a section indexed from that text.
 * @returns the section's lines from its heading through its last line.
 */
export function sectionText(source: string, section: Pick<IndexedSection, 'line' | 'endLine'>): string {
  return source.split('\n').slice(section.line - 1, section.endLine).join('\n')
}

/**
 * Index every section of one Markdown source. Text before the first heading
 * becomes a level-0 section with an empty anchor when it contains anything but
 * whitespace. Repeated slugs receive GitHub's `-1`, `-2`, … suffixes.
 * @param path - the source's workspace-relative path.
 * @param source - the source's UTF-8 text.
 * @returns the sections in file order.
 */
export function indexSections(path: SourcePath, source: string): IndexedSection[] {
  const lines = source.split('\n')
  const found = headings(source)
  const sections: IndexedSection[] = []
  const firstLine = found[0]?.line ?? lines.length + 1
  const preamble = lines.slice(0, firstLine - 1).join('\n')
  if (preamble.trim().length > 0) {
    sections.push({ path, anchor: '', title: '', level: 0, line: 1, endLine: firstLine - 1, hash: hashSection(preamble) })
  }
  const taken = new Set<string>()
  const bumps = new Map<string, number>()
  for (const [index, heading] of found.entries()) {
    const base = githubSlug(heading.title)
    let anchor = base
    let bump = bumps.get(base) ?? 0
    while (taken.has(anchor)) {
      bump += 1
      anchor = `${base}-${bump}`
    }
    bumps.set(base, bump)
    taken.add(anchor)
    const end = found[index + 1]?.line ?? lines.length + 1
    const text = lines.slice(heading.line - 1, end - 1).join('\n')
    const { title, level, line } = heading
    sections.push({ path, anchor, title, level, line, endLine: end - 1, hash: hashSection(text) })
  }
  return sections
}
