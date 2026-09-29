---
description: "Keep a repository's architecture documents authoritative: index their sections with stable anchors and content hashes, and allow edits only in the primary worktree on the configured main branch."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-architecture

English | [中文](README.zh.md)

## Summary

Keep a repository's architecture documents authoritative while agents work on its code. You list the source documents in an `architecture.yml` manifest; the package indexes every Markdown section with a GitHub anchor and a content hash, so a later ruling can cite `path#anchor` at an exact version. Built-in file tools cannot write those documents from any Session, and the package's own edit path writes them only in the primary worktree on your main branch. It is the foundation of the proposed architecture agent and has no tools or UI yet.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package beside the tool registry and a subprocess runtime, name your main branch, and commit an `architecture.yml` at the repository root.

### When to choose it

Choose it when a repository keeps its architecture in committed documents and agents must not change them as a side effect of code work. Avoid it for a repository without git, because the edit rule and source listing both read git state. Without this package, architecture documents are ordinary files that any file tool may change.

### Minimal configuration

Add one row to a composition that already mounts `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-subprocess-local`:

```yaml
- id: architecture
  name: '@deepseek-ai/dsh-experimental-architecture'
  config:
    mainBranch: main
```

Commit a manifest that lists the source documents as workspace-relative globs:

```yaml
# architecture.yml
sources:
  - docs/architecture.md
  - docs/subsystems/*.md
```

| Field | Default | Meaning |
|---|---|---|
| `mainBranch` | required | Branch whose primary-worktree checkout is the only place architecture sources change. |
| `manifestPath` | `architecture.yml` | Workspace-relative path of the manifest. |
| `localDirectory` | `.architecture` | Workspace-relative directory for local architecture entries; every path under it is protected. |
| `architectPreset` | `architect` | Agent preset whose agents may run only `architectTools`. |
| `architectTools` | `[]` | Tool names an `architectPreset` agent may run. |
| `gitTimeoutMs` | `10000` | Milliseconds one git command may run. |
| `maxSourceBytes` | `1048576` | Byte cap on one source read while indexing. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-architecture) is the exhaustive source for every accepted field.

### What success and failure look like

`ctx.architecture.rebuild(cwd)` returns the index of the repository containing `cwd`, or `undefined` when it has no manifest; an invalid manifest throws `ManifestError`. A source that is too large, unreadable, or not UTF-8 appears in `diagnostics` instead of failing the rebuild. A `write`, `edit`, or `str_replace_editor` call that targets a protected path fails with an error result that names the path. `ctx.architecture.edit()` returns `{ kind: 'written' }` or a refusal whose `kind` is `not-repository`, `linked-worktree`, `wrong-branch`, or `not-protected`; `describeRefusal()` renders it as one sentence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The manifest names authoritative files; the index is a cache that `rebuild()` recreates from those files. The index is always built from the repository's primary worktree, because that is where the edit rule lets sources change. Source discovery uses `git ls-files --cached --others --exclude-standard`, so untracked but not ignored drafts are indexed and ignored files are not. Only Markdown sources are split into sections. A section runs from its heading to the next heading of any level, so editing a subsection leaves its parent's hash unchanged. Anchors apply GitHub's slug rule to the heading's plain text, including `-1`, `-2` suffixes for repeated headings; a hard line break inside a heading contributes no space.

The tool guard is synchronous, so checkout discovery reads `.git`, `commondir`, and `HEAD` from disk instead of running git. A linked worktree's copy of a protected file is protected too, so a worker in a worktree cannot change a source there and merge it back. Before the first rebuild, the manifest and the local directory are already protected. Target paths are canonicalized through symlinked ancestors before comparison. No runtime invariant companion is published: the service derives the protected-path set from the index it builds, so no independent observation can diverge from it.

| Source | Responsibility |
|---|---|
| [src/index.ts](src/index.ts) | `ctx.architecture` service, edit rule, and tool guard |
| [src/manifest.ts](src/manifest.ts) | Manifest parsing and validation |
| [src/index-builder.ts](src/index-builder.ts) | Glob matching and index construction |
| [src/sections.ts](src/sections.ts) | Markdown section splitting, anchors, and hashes |
| [src/repository.ts](src/repository.ts) | Synchronous checkout discovery |
| [src/git-files.ts](src/git-files.ts) | Bounded `git ls-files` listing |
| [src/guard.ts](src/guard.ts) | Write-target resolution and protected-path matching |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages explain the design this package belongs to and the extension points it uses.

- [Architecture agent Agent Note](../../../.agents/notes/proposed/feature/2026-09-29-architecture-agent.md) — the proposed architecture agent, its Session, rulings, and appeals.
- [Tool registry](../../core/tools/README.md) — tool guards and how a denial reaches the model.
- [Agent preset registry](../../preset/agent-preset-registry/README.md) — how an agent's composed preset is resolved.
- [Experimental packages](../AGENTS.md) — rules for packages under `packages/experimental/`.

-----

<a id="model-experience"></a>
## Model Experience

### Guard denial

#### What the model sees

When a `write`, `edit`, or `str_replace_editor` call targets a protected path, the tool registry returns an error result instead of running the tool. The text is `<path> is an architecture source. Architecture sources change only through the architecture agent on the main branch; do not edit them directly.`, where `<path>` is the absolute target. When an agent composed with `architectPreset` calls a tool outside `architectTools`, the text is `The <tool> tool is unavailable to the architect: it discusses and records architecture and does not change code. Use the architecture tools instead.`.

#### Token effect

Each denied call adds one short error result, about 30 tokens plus the path, in place of the tool's normal output. Allowed calls add nothing.

#### KV Cache effect

A denial is an ordinary tool result that appends after the reusable history prefix. The package adds no system-prompt text or tool schema, so it never changes an earlier part of the request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the package does not protect or provide yet.

- **Shell writes are not guarded** — `bash`, `pwsh`, terminals, and `run_code` can still change a protected file; the git check script proposed in the Agent Note is the planned backstop.
- **Only built-in file tools are recognized** — the guard knows the argument names of `write`, `edit`, and `str_replace_editor`; another plugin's file tool is not checked.
- **The index is in memory** — nothing rebuilds it automatically when a source changes outside `edit()`, and it is lost on restart.
- **No model-facing tools, Session, or dashboard** — consultation, rulings, appeals, and the Architecture Session are proposed in the Agent Note and not implemented.
- **Experimental prototype with no stability promise** — its contracts can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

This package is milestone 1 of the architecture agent. The next milestones are the `architecture_edit` and `consult_architect` tools, the Architecture Session preset, and the dashboard.

</details>
