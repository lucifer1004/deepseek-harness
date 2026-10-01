/**
 * Architect-side tools: list the architecture index, read one section, and
 * edit architecture sources under the main-branch edit rule. Mount this
 * plugin inside the `architect` preset; workers mount the package root.
 * @module @deepseek-ai/dsh-experimental-tool-architecture/architect
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { describeRefusal } from '@deepseek-ai/dsh-experimental-architecture'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-architecture-architect'
/** Services required by the architect tools. */
export const inject = ['architecture', 'tools', 'systemPrompt']

/** Model-facing guidance for the architect. */
export const ARCHITECT_POLICY = [
  'You are the architecture agent for this workspace. You discuss, record, and defend its architecture; you do not change code.',
  'The architecture record is the set of documents listed in the manifest. Use `architecture_index` to see its sections and `architecture_read` to read one. Read code and other files with the read and search tools, and use web search and fetch for external references such as library documentation and prior art.',
  'Change the record only with `architecture_edit`, and only after the user agrees to the exact change. Prefer replacing one section, passing the hash you read, over rewriting a whole file. Edits land in the primary checkout on whatever branch it is on; the user reviews them and commits them to the main branch, and only then do they bind workers.',
  'When you state a binding requirement, cite the section that establishes it as `path#anchor`. A judgment without such a section is an open question for the user, not a requirement.',
].join('\n\n')

/** Model-facing guidance for a workspace without a manifest, returned by `architecture_index`. */
export const COLD_START_GUIDANCE = [
  'This workspace has no architecture manifest yet. To establish the record with the user:',
  '1. Survey the code and existing design documents (README, ADRs, design notes) with the read and search tools.',
  '2. Propose the manifest: `mainBranch`, the branch or jj bookmark whose committed sections Rulings may cite, usually the one the project integrates into (the local ones are listed below), and `sources`, globs of the documents that hold the architecture; list suitable existing documents instead of copying them.',
  '3. Propose a small first document for what no existing document states: module boundaries, dependency direction, extension points, and data ownership. Grow it later from the unresolved points of consultations.',
  '4. After the user agrees, write the manifest first with `architecture_edit`, then each new document, and ask the user to review them and commit them to `mainBranch`. Only sections committed there, or accepted by the user, can be cited in Rulings.',
].join('\n')

function sessionCwd(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('the calling Session has no working directory')
  return cwd
}

const SECTION_ROW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cite: { type: 'string', required: true },
    title: { type: 'string', required: true },
    level: { type: 'integer', required: true },
    line: { type: 'integer', required: true },
    hash: { type: 'string', required: true },
  },
} as const

/**
 * Render an index listing for the model: one line per section, indented by heading level.
 * @param value - the `architecture_index` value.
 * @returns the model-facing text.
 */
export function renderIndex(value: {
  hasManifest: boolean
  checkout?: { vcs: string; isPrimary: boolean; current: readonly string[]; all: readonly string[] } | undefined
  sources: readonly string[]
  sections: ReadonlyArray<{ cite: string; title: string; level: number; line: number; hash: string }>
  diagnostics: readonly string[]
}): string {
  if (!value.hasManifest) {
    const checkout = value.checkout
    if (checkout === undefined) return COLD_START_GUIDANCE
    const kind = checkout.vcs === 'jj' ? 'jj workspace' : 'git checkout'
    const where = checkout.isPrimary
      ? `This is the primary ${kind}`
      : `This is not the primary ${kind}, so nothing can be written from here`
    const names = (list: readonly string[]): string => list.map(name => `\`${name}\``).join(', ')
    const [noun, nouns] = checkout.vcs === 'jj' ? ['bookmark', 'bookmarks'] : ['branch', 'branches']
    const on = checkout.current.length === 0
      ? `it is on no ${checkout.vcs === 'jj' ? 'bookmark (none points to @ or @-)' : 'branch (detached HEAD)'}`
      : `it is on ${names(checkout.current)}`
    const local = checkout.all.length === 0
      ? `The repository has no local ${noun} yet; ask the user which name to use.`
      : `Local ${nouns}: ${names(checkout.all)}.`
    return `${COLD_START_GUIDANCE}\n\n${where}; ${on}. ${local}`
  }
  return [
    `${value.sources.length} source(s), ${value.sections.length} section(s).`,
    ...value.sections.map((section) => {
      const indent = '  '.repeat(Math.max(0, section.level - 1))
      return `${indent}${section.cite} — ${section.title || '(preamble)'} [line ${section.line}, ${section.hash.slice(0, 12)}]`
    }),
    ...value.diagnostics.map(line => `! ${line}`),
  ].join('\n')
}

/**
 * Register the architect tools and guidance.
 * @param ctx - plugin context with `architecture`, `tools`, and `systemPrompt`.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:architect',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text: ARCHITECT_POLICY,
  }), 'architecture: architect guidance')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'architecture_index',
    description: 'Rebuild and list the architecture index of this workspace: every source document and every section with its citation, title, heading level, line, and content hash. Returns hasManifest false when the workspace has no manifest yet.',
    parameters: {
      path: { type: 'string', description: 'Only list sections of this source path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hasManifest: { type: 'boolean', required: true },
          checkout: {
            type: 'object',
            additionalProperties: false,
            properties: {
              vcs: { type: 'string', required: true },
              isPrimary: { type: 'boolean', required: true },
              current: { type: 'array', required: true, items: { type: 'string' } },
              all: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          sources: { type: 'array', required: true, items: { type: 'string' } },
          sections: { type: 'array', required: true, items: SECTION_ROW },
          diagnostics: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderIndex(value) }],
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      const index = await ctx.architecture.rebuild(cwd, exec.signal)
      if (index === undefined) {
        const checkout = await ctx.architecture.branches(cwd, exec.signal)
        return {
          hasManifest: false,
          checkout: { vcs: checkout.vcs, isPrimary: checkout.isPrimary, current: [...checkout.current], all: [...checkout.all] },
          sources: [],
          sections: [],
          diagnostics: [],
        }
      }
      const sections = index.sections.filter(section => args.path === undefined || section.path === args.path)
      return {
        hasManifest: true,
        sources: [...index.sources],
        sections: sections.map(section => ({ cite: `${section.path}#${section.anchor}`, title: section.title, level: section.level, line: section.line, hash: section.hash })),
        diagnostics: index.diagnostics.map(diagnostic => `${diagnostic.path}: ${diagnostic.message}`),
      }
    },
  })), 'architecture: architecture_index')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'architecture_read',
    description: 'Read one architecture section by its citation, as it is in the primary worktree. Call architecture_index first; the index must contain the section.',
    parameters: {
      cite: { type: 'string', required: true, description: 'Section citation as path#anchor, from architecture_index.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cite: { type: 'string', required: true },
          hash: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.cite} [${value.hash}]\n\n${value.text}` }],
    },
    async execute(args, exec) {
      const at = args.cite.indexOf('#')
      if (at <= 0) throw new Error(`"${args.cite}" is not a path#anchor citation`)
      const found = await ctx.architecture.readSection(sessionCwd(exec), args.cite.slice(0, at), args.cite.slice(at + 1), exec.signal)
      if (found === undefined) throw new Error(`"${args.cite}" names no indexed section; call architecture_index to list sections`)
      return { cite: args.cite, hash: found.section.hash, text: found.text }
    },
  })), 'architecture: architecture_read')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'architecture_edit',
    description: 'Write an architecture source, the manifest, or a file under the local architecture directory, only after the user agreed to the change. With anchor, replace that section from its heading through its last line; include the heading in content, and pass the hash from architecture_read so a concurrent change is refused. Without anchor, content replaces or creates the whole file. Writes only in the primary worktree or jj workspace, on any branch.',
    parameters: {
      path: { type: 'string', required: true, description: 'Target path relative to the repository root.' },
      content: { type: 'string', required: true, description: 'New content of the section, including its heading, or of the whole file.' },
      anchor: { type: 'string', description: 'Section anchor to replace.' },
      expectedHash: { type: 'string', description: 'Hash of the section as you read it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Wrote ${value.path}. The user reviews and commits the change.` }],
    },
    async execute(args, exec) {
      if (args.expectedHash !== undefined && args.anchor === undefined) throw new Error('expectedHash requires anchor')
      const result = await ctx.architecture.edit({
        cwd: sessionCwd(exec),
        path: args.path,
        anchor: args.anchor,
        expectedHash: args.expectedHash,
        content: args.content,
        signal: exec.signal,
      })
      if (result.kind === 'refused') throw new Error(`architecture_edit refused: ${describeRefusal(result.refusal)}`)
      return { path: result.path }
    },
  })), 'architecture: architecture_edit')
}
