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
  'Change the record only with `architecture_edit`, and only after the user agrees to the exact change. Prefer replacing one section, passing the hash you read, over rewriting a whole file. Edits land in the primary worktree on the main branch; the user reviews and commits them.',
  'When you state a binding requirement, cite the section that establishes it as `path#anchor`. A judgment without such a section is an open question for the user, not a requirement.',
].join('\n\n')

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
  sources: readonly string[]
  sections: ReadonlyArray<{ cite: string; title: string; level: number; line: number; hash: string }>
  diagnostics: readonly string[]
}): string {
  if (!value.hasManifest) return 'This workspace has no architecture manifest yet.'
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
          sources: { type: 'array', required: true, items: { type: 'string' } },
          sections: { type: 'array', required: true, items: SECTION_ROW },
          diagnostics: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderIndex(value) }],
    },
    async execute(args, exec) {
      const index = await ctx.architecture.rebuild(sessionCwd(exec), exec.signal)
      if (index === undefined) return { hasManifest: false, sources: [], sections: [], diagnostics: [] }
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
    description: 'Write an architecture source, the manifest, or a file under the local architecture directory, only after the user agreed to the change. With anchor, replace that section from its heading through its last line; include the heading in content, and pass the hash from architecture_read so a concurrent change is refused. Without anchor, content replaces or creates the whole file. Writes only in the primary worktree on the main branch.',
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
