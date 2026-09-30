/** The experimental bundle carries one parseable layer: the service, the worker tool, and the architect preset. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { DEFAULT_ARCHITECT_TOOLS } from '@deepseek-ai/dsh-experimental-architecture'

interface Entry {
  id?: string
  name?: string
  config?: Record<string, unknown> & { plugins?: Entry[]; architectTools?: string[] }
}

const root = fileURLToPath(new URL('..', import.meta.url))

function inserted(): Entry[] {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
  const parsed = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'), { schema: entryListSchema }) as { insert?: Entry[] }[]
  return parsed.flatMap(patch => patch.insert ?? [])
}

describe('architecture profile bundle', () => {
  it('declares a public bundle over the architecture packages', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: { access?: string }
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-architecture': 'workspace:*',
      '@deepseek-ai/dsh-experimental-tool-architecture': 'workspace:*',
    })
  })

  it('leaves mainBranch to the profile and names the worker tool on the host', () => {
    const entries = inserted()
    const service = entries.find(entry => entry.id === 'architecture')
    expect(service?.name).toBe('@deepseek-ai/dsh-experimental-architecture')
    // A profile patch replaces the whole row config, so the row leaves every field to the service defaults.
    expect(service?.config).toBeUndefined()
    expect(entries.find(entry => entry.id === 'tool-architecture')?.name).toBe('@deepseek-ai/dsh-experimental-tool-architecture')
  })

  it('gives the architect preset exactly the tools the service allows it', () => {
    const entries = inserted()
    const allowed = new Set(DEFAULT_ARCHITECT_TOOLS)
    const preset = entries.find(entry => entry.id === 'preset-architect')
    expect(preset?.config?.id).toBe('architect')
    const rows = (preset?.config?.plugins ?? []).map(entry => entry.name)
    expect(rows).toContain('@deepseek-ai/dsh-experimental-tool-architecture/architect')
    expect(rows).toContain('@deepseek-ai/dsh-tool-web')
    expect(rows).not.toContain('@deepseek-ai/dsh-tool-bash')
    expect(rows).not.toContain('@deepseek-ai/dsh-tool-bash-persistent')
    for (const tool of ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'architecture_index', 'architecture_read', 'architecture_edit']) {
      expect(allowed.has(tool)).toBe(true)
    }
    for (const tool of ['write', 'edit', 'bash', 'consult_architect']) expect(allowed.has(tool)).toBe(false)
  })
})
