---
description: "Keep a repository's architecture documents authoritative: index their sections with stable anchors and content hashes, and allow edits only in the primary checkout."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-architecture

English | [中文](README.zh.md)

## Summary

Keep a repository's architecture documents authoritative while agents work on its code. You list the source documents in an `architecture.yml` manifest; the package indexes every Markdown section with a GitHub anchor and a content hash, so a ruling can cite `path#anchor` at an exact version. Built-in file tools cannot write those documents, and the package's own edit path writes them only in the primary checkout. The repository may be git, or Jujutsu colocated or not. `consult()` returns a Ruling whose binding constraints cite committed or user-accepted sections; Rulings, appeals, and acceptances are recorded under `.architecture/`.

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

Choose it when a repository keeps its architecture in committed documents and agents must not change them as a side effect of code work. Avoid it for a directory without version control: the edit rule and source listing read git or jj state, so outside a git or jj checkout the service refuses every edit and the dashboard asks for `git init` or `jj git init`. Without this package, architecture documents are ordinary files that any file tool may change.

### Minimal configuration

Add one row to a composition that already mounts `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-subprocess-local`:

```yaml
- id: architecture
  name: '@deepseek-ai/dsh-experimental-architecture'
```

Commit a manifest that names the repository's main branch and lists the source documents as workspace-relative globs:

```yaml
# architecture.yml
mainBranch: main
sources:
  - docs/architecture.md
  - docs/subsystems/*.md
exclude:
  - '**/*.zh.md'
```

Architecture sources change only in the primary checkout, on any branch: the primary git worktree, or in a jj repository the workspace that holds `.jj/repo` as a directory. Each repository's main branch is the manifest's `mainBranch`, or the service's `mainBranch` when the manifest names none, and Rulings bind only sections committed on it; in jj it is a local bookmark. A repository without a manifest may receive its first one through `edit()`; this is how an Architecture Session establishes the record. `setMainBranch()` declares any local branch or bookmark in an existing manifest from the primary checkout. It replaces only the value of `mainBranch` with a quoted string, or adds the key before the first key when absent, and keeps every other byte of the file. The service reads the manifest's branch on every check, so a changed branch applies at once. A repository with neither binds only sections the user accepted.

| Field | Default | Meaning |
|---|---|---|
| `mainBranch` | unset | Main branch of a repository whose manifest declares none. |
| `manifestPath` | `architecture.yml` | Workspace-relative path of the manifest. |
| `localDirectory` | `.architecture` | Workspace-relative directory for local architecture entries and the Ruling, appeal, and acceptance records; every path under it is protected. |
| `architectPreset` | `architect` | Agent preset whose agents may run only `architectTools`. |
| `architectTools` | `DEFAULT_ARCHITECT_TOOLS` | Tool names an `architectPreset` agent may see and run. The default holds `read`, `glob`, `grep`, `web_search`, `web_fetch`, the Session query tools, the three architecture tools, `ask_user_question`, and `todo_write`. |
| `gitTimeoutMs` | `10000` | Milliseconds one git or jj command may run. |
| `maxSourceBytes` | `1048576` | Byte cap on one source read while indexing. |
| `consultTimeoutMs` | `300000` | Milliseconds a consultation waits for the architect to submit a Ruling. |
| `consultNudgeMs` | `240000` | Milliseconds into a consultation at which the architect is told to submit now; less than `consultTimeoutMs`, or the plugin fails to load. |
| `architectProvider`, `architectModel` | unset | Provider route and model of the consulted architect, read at each consultation. With either unset, the architect runs on the consulting worker's model. |
| `architectReasoningEffort` | unset | Reasoning effort of the consulted architect; unset keeps the model's default. |

The three `architect*` fields are live: a settings write applies to the next consultation without a restart. The service registers no generated settings page for them; the [dashboard](../client-ui-architecture/README.md) edits them.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-architecture) is the exhaustive source for every accepted field.

### What success and failure look like

`ctx.architecture.rebuild(cwd)` returns the index of the repository containing `cwd`, or `undefined` when it has no manifest; an invalid manifest throws `ManifestError`. A source that is too large, unreadable, or not UTF-8 appears in `diagnostics` instead of failing the rebuild. A `write`, `edit`, or `str_replace_editor` call that targets a protected path fails with an error result that names the path. `ctx.architecture.edit()` returns `{ kind: 'written' }` or a refusal whose `kind` is `not-repository`, `linked-worktree`, `not-protected`, `unknown-section`, or `stale-section`, and `setMainBranch()` also refuses `unknown-branch`; `describeRefusal()` renders it as one sentence. `ctx.architecture.consult()` returns `{ kind: 'ruling' }`, `timeout`, or `no-submission`, and rejects when the worker cancels, the worker Session has no directory, or the repository has no manifest. `snapshot(cwd)` returns the dashboard state, or an empty one whose `unsupported` names `no-repository` or `vcs-missing` when `cwd` is outside git and jj or that system's executable is missing; `checkout(cwd)` returns the checkout only when the service can read it, and `branches(cwd)` lists every local branch or bookmark and the ones it is on: git's `HEAD` branch, or the bookmarks at `@` and `@-`; `appeal()`, `adjudicate()`, and `accept()` reject with a message naming an unknown Ruling or appeal, an already decided appeal, or a section hash that changed.

### Check commits and CI

The package ships [`scripts/check-architecture.sh`](scripts/check-architecture.sh), a POSIX shell script that uses only git or jj. In git, run `check-architecture.sh staged` from a pre-commit hook to refuse a commit that changes the manifest or a source from a linked worktree. Run `check-architecture.sh range origin/main HEAD` in CI to list, on standard output, the manifest and source paths a branch changes, so a reviewer sees them before merging; it does not fail on them. `--manifest <path>` reads another manifest path. In a jj repository, colocated or not, run `check-architecture.sh working` before `jj git push` to refuse working-copy changes to the manifest or a source from a secondary workspace, and `check-architecture.sh range main @-` in CI, where both arguments are revsets. It exits 1 on a violation and 2 on a usage error or a manifest it cannot read; it reads only block lists under `sources:` and `exclude:` and a plain `mainBranch:` value.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The manifest names authoritative files; the index is a cache that `rebuild()` recreates from those files. The index is always built from the repository's primary worktree, because that is where the edit rule lets sources change. Source discovery runs `git ls-files --cached --others --exclude-standard` with the source globs as `:(glob)` pathspecs, or `jj file list` of the working-copy commit, which jj snapshots first; either way untracked but not ignored drafts are indexed and ignored files are not, and a listing that does not end in NUL is rejected as truncated. jj reads committed files with `--ignore-working-copy`. A leading `!` in `sources` is rejected because picomatch would match every other path; excluded paths go under `exclude`. Only Markdown sources are split into sections. A section runs from its heading to the next heading of any level, so editing a subsection leaves its parent's hash unchanged. Anchors apply GitHub's slug rule to the heading's plain text, including `-1`, `-2` suffixes for repeated headings; a hard line break inside a heading contributes no space.

The tool guard is synchronous, so checkout discovery reads `.jj/repo`, `.git`, `commondir`, and `HEAD` from disk instead of running a version-control command; a `.jj` directory wins over a colocated `.git`. A linked worktree's or secondary jj workspace's copy of a protected file is protected too, so a worker there cannot change a source and merge it back. Before the first rebuild, the manifest and the local directory are already protected. After a rebuild, every path the manifest's globs match is protected, including one that does not exist yet, so a file tool cannot create a new source; `edit()` can. Target paths are canonicalized through symlinked ancestors before comparison. No runtime invariant companion is published: the service derives the protected-path set from the index it builds, so no independent observation can diverge from it.

A consultation creates the architect as a hidden child agent of the worker's Session with `origin: 'subagent'` and the worker's agent options, replacing the provider, model, and reasoning effort when `architectProvider` and `architectModel` are set. It mounts `architectPreset` into it, keeps only the `architectTools` that preset provides except `architecture_edit` and `ask_user_question`, because no user takes part in a consultation and a worker's report of consent does not authorize a write, and registers a scoped `submit_ruling` tool with a prompt section. The first submission concludes the turn; a guard denies every later call. The architect's prompt states the `consultTimeoutMs` budget, and at `consultNudgeMs` the service steers a submit-now notice into the architect's Session unless the turn has ended. The run ends at submission, at `consultTimeoutMs`, or when the worker's signal aborts, and the architect agent is disposed in every case. The host then checks each cited `path#anchor`: the section must be in the current index and have the same content hash in the file committed at `refs/heads/<mainBranch>`, or at the jj bookmark `mainBranch`. A constraint with no citation or any failed citation becomes an unresolved point whose reason names the failure, so an uncommitted draft never binds a worker. A proposed edit is kept only when it names an indexed section at its current hash and has content; otherwise it becomes an unresolved point with the reason. `applyProposedEdit({ cwd, rulingId, index, accept })` writes a recorded Ruling's proposed edit through `edit()` with the hash the architect read, adds its index to the record's `appliedEdits`, and with `accept` records an `Acceptance` of the indexed section whose hash matches the proposed content, found again after the write because a changed heading changes the anchor. It checks the edit's markers, writes, and records the application in one serialized step, returns the edit refusal, and rejects for an unknown Ruling or index or an edit already applied or dismissed. `dismissProposedEdit({ cwd, rulingId, index })` adds the index to the record's `dismissedEdits` under the same rejections and writes no source; `appliedEdits` and `dismissedEdits` stay disjoint, and the worker sees neither. A section edit replaces the lines from the section heading through its last line, keeps the blank lines that separated it from the next heading, and is refused when `expectedHash` differs from the section's current hash.

Records are JSON files under the local directory: `rulings/<id>.json`, `appeals/<id>.json`, and `acceptances.json`. Each write goes through a temporary file and a rename. A reader validates every file and reports an invalid one in the snapshot's `problems` instead of reading it. Writes to one repository's records are serialized. `recordRuling()` stores the Ruling a worker received with its index revision; `appeal()` accepts only a Ruling issued to the appellant's Session. `adjudicate()` records the decision, sets the Ruling's status, and calls `agent.steer()` on the worker's live agent with a message whose source is `{ kind: 'architecture', appealId }`; the `agent/created` listener delivers decisions that were made while the agent was not live. `accept()` refuses a hash that differs from the section's current hash, and a citation to an accepted section at that hash verifies without being committed. Every change emits `architecture/changed` with the repository root after the write; an `edit()` that changes no indexed section, such as a new `mainBranch`, emits it too.

| Source | Responsibility |
|---|---|
| [src/index.ts](src/index.ts) | `ctx.architecture` service, edit rule, and tool guard |
| [src/manifest.ts](src/manifest.ts) | Manifest parsing and validation |
| [src/index-builder.ts](src/index-builder.ts) | Glob matching and index construction |
| [src/sections.ts](src/sections.ts) | Markdown section splitting, anchors, and hashes |
| [src/repository.ts](src/repository.ts) | Synchronous git and jj checkout discovery |
| [src/vcs.ts](src/vcs.ts) | Version-control query interface and the bounded command runner |
| [src/git-files.ts](src/git-files.ts) | Git listing, committed reads, status, and branch check |
| [src/jj-files.ts](src/jj-files.ts) | Jujutsu listing, committed reads, status, and bookmark listing |
| [src/guard.ts](src/guard.ts) | Write-target resolution and protected-path matching |
| [src/citations.ts](src/citations.ts) | Citation parsing and verification against `mainBranch` |
| [src/ruling.ts](src/ruling.ts) | Submission validation into a Ruling |
| [src/consultation.ts](src/consultation.ts) | Architect agent run and `submit_ruling` |
| [src/records.ts](src/records.ts) | Ruling, appeal, and acceptance record files |
| [scripts/check-architecture.sh](scripts/check-architecture.sh) | Commit check for source changes outside the primary checkout, and CI listing of a range's source changes |

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

When a `write`, `edit`, or `str_replace_editor` call targets a protected path, the tool registry returns an error result instead of running the tool. The text is `<path> is an architecture source. Architecture sources change only through the architecture agent; do not edit them directly.`, where `<path>` is the absolute target. When an agent composed with `architectPreset` calls a tool outside `architectTools`, the text is `The <tool> tool is unavailable to the architect: it discusses and records architecture and does not change code. Use the architecture tools instead.`.

#### Token effect

Each denied call adds one short error result, about 30 tokens plus the path, in place of the tool's normal output. Allowed calls add nothing.

#### KV Cache effect

A denial is an ordinary tool result that appends after the reusable history prefix. The guard adds no system-prompt text or tool schema, so it never changes an earlier part of the request.

### Consultation

#### What the model sees

The architect agent of a consultation receives the worker's question, followed by `Scope: <paths>` when the worker named any, as its first user message. Its system prompt gains the consultation instruction exported as `CONSULTATION_INSTRUCTION` followed by the time budget from `consultationBudget()`, `You have <consultTimeoutMs in seconds> seconds for this consultation, after which it ends with no answer.` and the instruction to submit before then, and its tool list gains `submit_ruling` with `summary`, `constraints` (each a `statement` and `cites`), `unresolved`, and the optional `proposedEdits` (each a `cite`, the `hash` it read, the new `content`, and a `rationale`). A second submission returns `the ruling is already submitted, so submit_ruling is not executed`. When the architect is still working at `consultNudgeMs`, it receives at its next step a user message whose source is `architecture` with `deadline: true`, built by `consultationDeadlineNotice()`: `About <seconds> seconds remain. Stop reading and call \`submit_ruling\` now with what you have; put every point you could not settle in \`unresolved\`.`

The architect runs on `architectModel` when one is configured, otherwise on the worker's model, so the same question may be answered by a different model than the one that asked it.

#### Token effect

The instruction and time budget add about 290 tokens and the `submit_ruling` schema about 260 tokens to each architect request; a deadline notice adds about 40 tokens to the requests after it. The worker Session pays only for its own tool call and result.

#### KV Cache effect

Each consultation is a new Session with its own prefix, so it neither reuses nor invalidates the worker's cached prefix. The time budget is fixed for the run, so the architect's system prompt stays stable; the deadline notice appends after the existing history.

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
