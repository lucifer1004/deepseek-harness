// Preset rows standing in for the agent-plane tool rows a real preset mounts.
// Import-free: the Loader resolves entry modules through Node's ESM resolver,
// which cannot see this workspace's TypeScript sources.
export const name = 'preset-tools'
export const inject = ['tools']

export function apply(ctx, config) {
  for (const tool of config.tools) {
    ctx.effect(() => ctx.tools.register({
      name: tool,
      description: `fixture tool ${tool}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => Promise.resolve(`ran:${tool}`),
    }))
  }
}
