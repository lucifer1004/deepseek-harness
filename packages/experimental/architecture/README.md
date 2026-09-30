---
description: "Keep a repository's architecture documents authoritative: index their sections with stable anchors and content hashes, and allow edits only in the primary worktree on the configured main branch."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-architecture

English | [中文](README.zh.md)

## Summary

Keep a repository's architecture documents authoritative while agents work on its code. You list the source documents in an `architecture.yml` manifest; the package indexes every Markdown section with a GitHub anchor and a content hash, so a ruling can cite `path#anchor` at an exact version. Built-in file tools cannot write those documents, and the package's own edit path writes them only in the primary worktree on your main branch. `consult()` returns a Ruling whose binding constraints cite committed or user-accepted sections; Rulings, appeals, and acceptances are recorded under `.architecture/`.

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
exclude:
  - '**/*.zh.md'
```

| Field | Default | Meaning |
|---|---|---|
| `mainBranch` | required | Branch whose primary-worktree checkout is the only place architecture sources change. |
| `manifestPath` | `architecture.yml` | Workspace-relative path of the manifest. |
| `localDirectory` | `.architecture` | Workspace-relative directory for local architecture entries and the Ruling, appeal, and acceptance records; every path under it is protected. |
| `architectPreset` | `architect` | Agent preset whose agents may run only `architectTools`. |
| `architectTools` | `[]` | Tool names an `architectPreset` agent may run. |
| `gitTimeoutMs` | `10000` | Milliseconds one git command may run. |
| `maxSourceBytes` | `1048576` | Byte cap on one source read while indexing. |
| `consultTimeoutMs` | `300000` | Milliseconds a consultation waits for the architect to submit a Ruling. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-architecture) is the exhaustive source for every accepted field.

### What success and failure look like

`ctx.architecture.rebuild(cwd)` returns the index of the repository containing `cwd`, or `undefined` when it has no manifest; an invalid manifest throws `ManifestError`. A source that is too large, unreadable, or not UTF-8 appears in `diagnostics` instead of failing the rebuild. A `write`, `edit`, or `str_replace_editor` call that targets a protected path fails with an error result that names the path. `ctx.architecture.edit()` returns `{ kind: 'written' }` or a refusal whose `kind` is `not-repository`, `linked-worktree`, `wrong-branch`, `not-protected`, `unknown-section`, or `stale-section`; `describeRefusal()` renders it as one sentence. `ctx.architecture.consult()` returns `{ kind: 'ruling' }`, `timeout`, or `no-submission`, and rejects when the worker cancels, the worker Session has no directory, or the repository has no manifest. `snapshot(cwd)` returns the dashboard state; `appeal()`, `adjudicate()`, and `accept()` reject with a message naming an unknown Ruling or appeal, an already decided appeal, or a section hash that changed.

### Check commits and CI

The package ships [`scripts/check-architecture.sh`](scripts/check-architecture.sh), a POSIX shell script that uses only git. Run `check-architecture.sh --main-branch main staged` from a pre-commit hook to refuse a commit that changes the manifest or a source outside the primary worktree on `main`. Run `check-architecture.sh --main-branch main range origin/main HEAD` in CI on other branches to refuse a range that changes them. `--manifest <path>` reads another manifest path. It exits 1 on a violation and 2 on a usage error or a manifest it cannot read; it reads only block lists under `sources:` and `exclude:`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The manifest names authoritative files; the index is a cache that `rebuild()` recreates from those files. The index is always built from the repository's primary worktree, because that is where the edit rule lets sources change. Source discovery runs `git ls-files --cached --others --exclude-standard` with the source globs as `:(glob)` pathspecs, so untracked but not ignored drafts are indexed and ignored files are not; a listing that does not end in NUL is rejected as truncated. A leading `!` in `sources` is rejected because picomatch would match every other path; excluded paths go under `exclude`. Only Markdown sources are split into sections. A section runs from its heading to the next heading of any level, so editing a subsection leaves its parent's hash unchanged. Anchors apply GitHub's slug rule to the heading's plain text, including `-1`, `-2` suffixes for repeated headings; a hard line break inside a heading contributes no space.

The tool guard is synchronous, so checkout discovery reads `.git`, `commondir`, and `HEAD` from disk instead of running git. A linked worktree's copy of a protected file is protected too, so a worker in a worktree cannot change a source there and merge it back. Before the first rebuild, the manifest and the local directory are already protected. Target paths are canonicalized through symlinked ancestors before comparison. No runtime invariant companion is published: the service derives the protected-path set from the index it builds, so no independent observation can diverge from it.

A consultation creates the architect as a hidden child agent of the worker's Session with `origin: 'subagent'`, mounts `architectPreset` into it, keeps only the `architectTools` that preset provides, and registers a scoped `submit_ruling` tool with a prompt section. The first submission concludes the turn; a guard denies every later call. The run ends at submission, at `consultTimeoutMs`, or when the worker's signal aborts, and the architect agent is disposed in every case. The host then checks each cited `path#anchor`: the section must be in the current index and have the same content hash in the file committed at `refs/heads/<mainBranch>`. A constraint with no citation or any failed citation becomes an unresolved point whose reason names the failure, so an uncommitted draft never binds a worker. A section edit replaces the lines from the section heading through its last line, keeps the blank lines that separated it from the next heading, and is refused when `expectedHash` differs from the section's current hash.

Records are JSON files under the local directory: `rulings/<id>.json`, `appeals/<id>.json`, and `acceptances.json`. Each write goes through a temporary file and a rename. A reader validates every file and reports an invalid one in the snapshot's `problems` instead of reading it. Writes to one repository's records are serialized. `recordRuling()` stores the Ruling a worker received with its index revision; `appeal()` accepts only a Ruling issued to the appellant's Session. `adjudicate()` records the decision, sets the Ruling's status, and calls `agent.steer()` on the worker's live agent with a message whose source is `{ kind: 'architecture', appealId }`; the `agent/created` listener delivers decisions that were made while the agent was not live. `accept()` refuses a hash that differs from the section's current hash, and a citation to an accepted section at that hash verifies without being committed. Every change emits `architecture/changed` with the repository root after the write.

| Source | Responsibility |
|---|---|
| [src/index.ts](src/index.ts) | `ctx.architecture` service, edit rule, and tool guard |
| [src/manifest.ts](src/manifest.ts) | Manifest parsing and validation |
| [src/index-builder.ts](src/index-builder.ts) | Glob matching and index construction |
| [src/sections.ts](src/sections.ts) | Markdown section splitting, anchors, and hashes |
| [src/repository.ts](src/repository.ts) | Synchronous checkout discovery |
| [src/git-files.ts](src/git-files.ts) | Bounded `git ls-files` listing and committed-file reads |
| [src/guard.ts](src/guard.ts) | Write-target resolution and protected-path matching |
| [src/citations.ts](src/citations.ts) | Citation parsing and verification against `mainBranch` |
| [src/ruling.ts](src/ruling.ts) | Submission validation into a Ruling |
| [src/consultation.ts](src/consultation.ts) | Architect agent run and `submit_ruling` |
| [src/records.ts](src/records.ts) | Ruling, appeal, and acceptance record files |
| [scripts/check-architecture.sh](scripts/check-architecture.sh) | Commit and CI check for source changes outside the main branch |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages explain the design this package belongs to and the extension points it uses.

- [Architecture agent subsystem](../../../docs/subsystems/architecture-agent.md) — types, records, and the generated `ctx.architecture` API.
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

A denial is an ordinary tool result that appends after the reusable history prefix. The guard adds no system-prompt text or tool schema, so it never changes an earlier part of the request.

### Consultation

#### What the model sees

The architect agent of a consultation receives the worker's question, followed by `Scope: <paths>` when the worker named any, as its first user message. Its system prompt gains the consultation instruction exported as `CONSULTATION_INSTRUCTION`, and its tool list gains `submit_ruling` with `summary`, `constraints` (each a `statement` and `cites`), and `unresolved`. A second submission returns `the ruling is already submitted, so submit_ruling is not executed`.

#### Token effect

The instruction adds about 140 tokens and the `submit_ruling` schema about 150 tokens to each architect request. The worker Session pays only for its own tool call and result.

#### KV Cache effect

Each consultation is a new Session with its own prefix, so it neither reuses nor invalidates the worker's cached prefix.

### Appeal decision

#### What the model sees

When the user decides an appeal, the worker Session receives one user message whose source is `architecture`. Upheld: `The user upheld Ruling <id> on your appeal <appeal>. Keep following its constraints.` Overturned: the Ruling's constraints no longer bind and the worker should consult again before relying on the revised design. Exception: `limited to: <scope>`, with the constraints still binding outside it. A user note follows as `The user notes: <note>`. `adjudicationText()` builds the text.

#### Token effect

Each decision adds one message of about 30 to 60 tokens plus the note to the worker Session.

#### KV Cache effect

The message is steered into the worker's inbox and appends after the reusable prefix; it does not change earlier requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the package does not protect or provide yet.

- **Shell writes are not guarded** — `bash`, `pwsh`, terminals, and `run_code` can still change a protected file; [`scripts/check-architecture.sh`](scripts/check-architecture.sh) refuses such changes at commit or in CI once the user wires it in.
- **Only built-in file tools are recognized** — the guard knows the argument names of `write`, `edit`, and `str_replace_editor`; another plugin's file tool is not checked.
- **The index is in memory** — nothing rebuilds it automatically when a source changes outside `edit()`, and it is lost on restart.
- **Records are local files** — Ruling, appeal, and acceptance records are JSON files under the local directory in the primary worktree; whether they are tracked is the user's choice, and nothing merges records written in different clones.
- **Experimental prototype with no stability promise** — its contracts can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

This package carries milestones 1 to 3 of the architecture agent. Background proposals and an Activity view are the remaining proposed work.

</details>
