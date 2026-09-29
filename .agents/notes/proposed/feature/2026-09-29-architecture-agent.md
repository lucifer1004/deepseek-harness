# Agent Note: Architecture agent with dashboard, architecture sessions, and binding consultations

Status: proposed

English | [中文](2026-09-29-architecture-agent.zh.md)

## Problem

A worker agent on a long task loses the project-wide view. After the first steps, its context fills with failing tests, diffs, and local code, and later requests weigh that recent detail over the design it read at the start. Compaction removes the early architecture reading first. The worker then fixes symptoms where they surface: special cases, fallback defaults, parallel implementations beside an existing extension point, and one-sided edits to parallel code. A system-prompt instruction to "think globally" does not change which facts fill the context.

The user has no view of the project architecture as the agents understand it. They cannot see which areas concurrent Sessions are changing, which architectural questions workers asked, or where an agent judged the design incorrectly, unless they read every transcript. They also have no conversation dedicated to architecture: an ordinary Session can write code at any step, so a design discussion can turn into implementation before the user agrees with the design.

Existing mechanisms each cover part of this. [Agent Teams](../../implemented/feature/2026-08-05-agent-teams.md) ties its roster and mailbox to one Lead root Session, while architecture outlives any one task. [Auto review](../../../../packages/experimental/auto-review/README.md) judges one pending tool call for safety, not the layer where a change belongs. [Side sessions](2026-07-08-interactive-side-sessions.md) fork one Session for a temporary discussion and hold no project-wide state. Community memory and "dream" plugins consolidate facts about the user and project into memory files; they do not anchor entries to code or repository documents, and none issues rulings that another agent must follow.

## Proposal

An **architecture agent** is a project-scoped product role with three entry points around one set of architecture sources:

| Entry point | User | Access to the architecture sources |
|---|---|---|
| Dashboard | the user, without a conversation | live read; accept local entries; adjudicate appeals |
| Architecture Session | the user with the architect preset | read, discuss, and edit on the main branch |
| Consultation | a worker agent | read through a binding Ruling; appeal to the user |

The role borrows three ideas from sleep-time and "dream" agents: context is prepared before a worker needs it, the worker and the architect use separate contexts, and background analysis only produces proposals for the user to review. Background analysis never rewrites the architecture sources itself.

### Architecture sources

The authoritative architecture record is repository files. A manifest at the workspace root, `architecture.yml`, lists the source documents by path or glob, for example `docs/architecture.md`, `docs/capability-seams.md`, and `.agents/notes/implemented/**` in the dsh pilot. A project keeps its existing document layout; the manifest only declares which files count.

Local architecture information that is not yet part of those documents lives under `.architecture/` in the same workspace: draft decisions, open questions, appeals, adjudications, and background proposals. The user decides whether `.architecture/` is tracked, ignored, or partly committed; the plugin keeps no second store outside the workspace. The dashboard shows the git status of every source and local entry: committed, modified, untracked, or ignored.

The plugin derives an **architecture index** from the manifest sources and `.architecture/`: components and responsibilities, decisions with their scope and rejected alternatives, constraints, open questions, and recorded deviations. Each index entry records its source path, heading anchor, and a hash of that section's content. The index is a cache for search and the dashboard; it is never authoritative, and rebuilding it from the files reproduces it exactly. Index rebuilds run on dashboard request and after every architecture edit; file watching is deferred.

### Edit rule

Only `architecture_edit` writes architecture sources, and only on the main branch in the primary worktree. The tool resolves the Session's checkout and refuses the write unless the checkout is the repository's primary worktree and `HEAD` is the configured `mainBranch`. `mainBranch` is a required configuration field without a default. No other tool and no other Session may change a manifest source, including a worker running in the primary worktree on `mainBranch`; a worker that disagrees with a source appeals instead.

Rulings always cite the primary worktree's content, even when the consulting worker runs in a linked worktree whose copy is older.

The rule is enforced at three layers, because no single layer covers every write path:

1. **Tool guard.** The plugin registers a global `ctx.tools.guard()` that denies `write`, `edit`, and `str_replace_editor` calls whose path argument, resolved against the Session's cwd and canonicalized, names a manifest source or a path under `.architecture/`. Guards run after every `tools/pre-execute` listener and can only deny, so listener order cannot re-allow the call; PTC sub-calls pass through the same guard. The denial reason directs the model to `consult_architect` or `appeal_ruling`. `architecture_edit` is not a generic write tool and performs its own checks.
2. **Git checks.** Bash, terminals, PTC code, and their subprocesses write through the kernel sandbox, which grants the whole workspace root and cannot make a subpath inside it read-only on every runner. The plugin therefore ships a check script, not a hook installation: it rejects a commit that touches a manifest source outside the primary worktree or off `mainBranch`, and it rejects a branch whose diff against `mainBranch` touches a manifest source. The user wires the script into the repository's pre-commit hook and into the merge path, such as CI or the fork's local merge procedure. The merge-path check is the final enforcement point, because `git commit --no-verify` skips the pre-commit hook.
3. **Dashboard detection.** The dashboard reports any manifest source whose working copy differs from `mainBranch` in any worktree, so an edit that bypassed the first two layers is visible before it is committed.

The `fs/write-intent` and `fs/edit-intent` events are not used: each is a single decision slot that [fs-observation-policy](../../../../packages/fs/fs-observation-policy/README.md) occupies by registration order, and that package directs layered permission to the `tools/*` pipeline. A decorating `ctx.fs` provider, in the way [fs-sandbox](../../../../packages/fs/fs-sandbox/README.md) fences mutations after re-canonicalizing the target, would check the exact target instead of parsed arguments, but it replaces the composition's `ctx.fs` row; it is deferred unless the guard's argument parsing proves insufficient.

### Dashboard

The dashboard is a Web global panel registered in the `main` keyed slot of [ui-layout](../../../../packages/client/ui-layout/README.md) and selected from a pinned sidebar entry. It reads host state through Remote methods and needs no conversation. It has five views:

- **Architecture:** components, capability relationships, decisions, and constraints from the index, each linked to its source section.
- **Activity:** which areas each live worker Session is changing, projected from its tool calls and results, including two Sessions changing the same area.
- **Consultations:** each Ruling with its question, constraints, citations, consulting Session, and status.
- **Appeals and proposals:** pending appeals with the worker's reason and evidence, and background proposals. Each item offers accept, reject, or "discuss", which opens an Architecture Session seeded with that item.
- **Local entries:** `.architecture/` entries with their git status and an accept action that makes an uncommitted entry citable.

The dashboard adds nothing to any model request.

### Architecture Session

An Architecture Session is an ordinary Session bound to the `architect` agent preset and started from the dashboard, optionally seeded with a component, proposal, appeal, or open question. The preset supplies a persona, read and search tools, read access to other Sessions through `ctx.sessionQuery`, and the architecture tools. `ctx.architecture` creates the Session itself through `ctx.agents.create`, mounting the preset with `ctx.agentPresets.mount` in the creation setup as session-controller and webhook do, and in the same setup applies `agentCtx.tools.restrict({ allow })` with the architect tool names. The restriction removes every other tool from that agent's prompt and execution, including `write` and `edit`, which `dsh-tool-fs` always registers together with `read`.

Sandbox mode is not the enforcement: a preset cannot fix a Session's mode, which is a per-Session `sandbox/mode` event that permission-presets initializes from the user's default and the user can switch. Two mechanisms do not depend on it. The tool allow-list leaves the agent no generic write or execution tool, and the edit-rule guard denies `write`, `edit`, and `str_replace_editor` on architecture sources in every Session. A Session that selects the `architect` preset through the ordinary new-session path lacks the allow-list; the guard also denies every mutating tool for any agent whose composed preset is `architect`, so that path cannot write code either.

The architect edits sources only through `architecture_edit`. The model submits a structured edit (target file, section, and replacement text); host code validates that the target is a manifest source or a path under `.architecture/`, applies the edit rule, and writes the file. This follows the host-validated write pattern of community memory consolidation plugins, where the model holds no write tool and the host performs the validated write. The architect does not run git; the user reviews and commits the resulting diff.

Initial modeling happens in an Architecture Session. When the workspace has no manifest, the dashboard offers "establish the project architecture", which opens an Architecture Session with a modeling skill: the architect surveys the repository, proposes candidate components and existing documents, confirms each responsibility and decision with the user, and drafts the manifest and documents through `architecture_edit` after each confirmation. The dashboard lists Architecture Sessions by their recorded preset, so no new Session metadata is required.

When the target project has its own documentation rules, the architect reads them from the project's instruction files; dsh's rules come from its `docs/AGENTS.md`. The plugin hardcodes no documentation policy.

### Consultation and Rulings

A worker calls `consult_architect(question, scope?)`, where `scope` names paths or components. The provider creates a consultation agent in the same way as an Architecture Session: `ctx.agents.create` with the `architect` preset mounted and the architect tool allow-list applied, recorded as a child of the worker's Session with `origin: 'subagent'` so that the sidebar hides it, over the current index revision and the primary worktree's sources. The consultation agent reports its answer by calling a scoped `submit_ruling` tool whose arguments are the Ruling fields; host code validates the submission before `consult_architect` returns it. Consultations run concurrently and do not queue behind an Architecture Session. The call waits up to the configured `consultTimeoutMs`; on timeout it cancels the consultation agent and returns an unresolved result without constraints.

The result is a **Ruling**: a `RulingId`, the index revision, zero or more constraints, and zero or more unresolved points. The worker must follow its constraints. A constraint is binding only when it cites a citable source section by path, anchor, and content hash; the host verifies each citation against the primary worktree before returning the Ruling and discards any constraint whose citation fails. A section is citable when it is committed on `mainBranch`, or when the user accepted it in the dashboard, which records the accepted content hash under `.architecture/`. An architect judgment with no citable source becomes an unresolved point and an open question on the dashboard, never a constraint.

A worker that judges a Ruling wrong calls `appeal_ruling(rulingId, reason, evidence)`. The Ruling stays binding during the appeal: the worker may continue unaffected work or stop, but must not bypass the constraint. The user adjudicates in the dashboard:

- **Uphold:** the worker is told to keep following the Ruling.
- **Overturn:** the user revises the sources in an Architecture Session on the main branch, which produces a new index revision, and the worker receives the revised constraints.
- **Grant an exception:** the user records a scoped exception or deviation under `.architecture/`, and the worker receives it.

The adjudication reaches the worker through `agent.steer()`, so it enters that Session's log as an ordinary input. When the worker Session is not loaded, the adjudication stays pending in its appeal record and is delivered when that Session's agent is next created. When a cited section's hash changes later, the dashboard marks the Rulings that cite it as stale.

Consultation is available as a tool only. Workers decide when to consult; no `tools/pre-execute` listener requires a consultation before editing an area. Whether required consultation is needed is decided from pilot observations.

### Durable records

The Ruling reaches the worker model as the `consult_architect` tool result and is persisted as that result's `meta`, which the tool registry stores verbatim on `tool/result`, so the worker's request remains reconstructable from its log. The worker's log is the authority for what the worker received. After the `tools/result` notification confirms the result, the provider writes a Ruling record under `.architecture/rulings/` for the dashboard; a record missing after a crash can be rebuilt from the worker's log through `ctx.sessionQuery`. Appeals, adjudications, acceptances, exceptions, and proposals are also files under `.architecture/`. The proposal adds no `SessionEventMap` type; a new event type is introduced only if tool-result metadata cannot carry what the dashboard or replay needs.

### Background proposals

A scheduled or manually triggered background pass reads recent worker Sessions and the index and writes proposals under `.architecture/proposals/`. Examples are a cited section whose code anchor no longer exists, two Sessions that assumed different designs for the same interface, a repeated appeal against the same constraint, and a recurring symptom fix in one area. Proposals are never citable. Accepting one opens an Architecture Session or records a local entry; nothing reaches a source document except through `architecture_edit` under the edit rule.

### Packages

The work lives under `packages/experimental/` in the maintained dsh fork, with the `@deepseek-ai/dsh-experimental-*` prefix and no dependency from release packages:

| Package | Role |
|---|---|
| `dsh-experimental-architecture` | Service Definition and Provider for `ctx.architecture`: manifest loading, index, edit-rule checks and tool guard, commit check script, consultation, Ruling validation, appeal records, activity projection, background proposals, and Remote methods |
| `dsh-experimental-tool-architecture` | Consumer: `consult_architect` and `appeal_ruling` for workers; architecture read, `architecture_edit`, and Session-digest tools for the `architect` preset |
| `dsh-experimental-client-ui-architecture` | Dashboard panel, sidebar entry, and Architecture Session creation |
| `dsh-experimental-architecture-profile` | Opt-in bundle patch that mounts the rows above and the `architect` preset, in the same way as the Agent Teams profile |

The design requires no change to the agent loop. It uses agent presets and personas, `ctx.agents.create` with scoped tool restrictions, `ctx.tools.guard()`, `agent.steer()`, `ctx.sessionQuery`, and the layout `main` slot.

### Pilot

The pilot runs on this repository. Its manifest lists the existing architecture documents, generated relationship graphs, and implemented Agent Notes, and initial modeling mainly confirms the index and fills gaps. The package keeps project-specific behavior in the manifest and the project's instruction files so that the same packages apply to other repositories without dsh-specific code.

Inspection of the current source settled three implementation questions. A preset cannot fix a Session's sandbox mode, so tool allow-lists and the guard enforce the no-write rule. The in-process spawn provider supports `outputSchema`, but a spawned child joins its parent's preset, so a consultation started through `ctx.subagents` would run with the worker's tools; consultation agents are created directly instead. Tool-result `meta` is persisted verbatim, but session projections fold one Session and the dashboard needs every Session, so Ruling records under `.architecture/rulings/` serve the dashboard while worker logs stay authoritative.

## Alternatives considered

**One long-lived architect Session that answers every consultation.** It would carry one continuous conversation, but its context grows without bound, compaction drops old reasoning, and concurrent consultations queue behind one inbox. Fresh instances over the repository sources keep each answer current and concurrent, while the sources hold the continuity.

**A host-side store as the authority.** Structured storage would simplify querying and live updates, but it would keep the architecture record outside the repository. Other contributors and agents could not review, branch, or share it with the code. Repository files are the authority, and the index is only a rebuildable cache.

**Advisory consultations.** Advice lets a worker under local pressure ignore the design exactly when it matters. Binding Rulings plus appeal to the user keep the constraint firm and give the worker a path to report a wrong judgment. Requiring citations keeps unsupported architect judgments from becoming constraints.

**Architecture edits from any worktree or branch.** This would let branch work update its own design, but parallel worktrees would diverge on the architecture itself, and Rulings would lack one authoritative text. The edit rule gives Rulings one source; branch work reaches the design through an appeal or an Architecture Session.

**A location-only rule that permits any writer on `mainBranch` in the primary worktree.** It would be simpler to state, but a worker running there could rewrite a source with generic tools and change the constraints it is bound by, bypassing the appeal path. The edit rule restricts the writer as well as the location.

**Read-only subpaths in the kernel sandbox.** Adding a read-only subpath list to `SandboxExecutionPolicy` would stop Bash writes directly. It changes the public sandbox policy and every runner: bwrap read-only binds cover only paths that exist when the command starts, Landlock grants are additive and cannot remove a subdirectory from a granted root, and `danger-full-access` bypasses confinement entirely. Commit and merge checks enforce the rule where the authoritative record changes, without that change.

**Agent Teams as the host.** Team state belongs to one Lead root Session and its lifecycle, while the architecture agent is scoped to the workspace and serves unrelated root Sessions. Agent Teams' durable mailbox and recovery remain useful reference implementations.

**Consultation through the subagent service.** `ctx.subagents` with the spawn provider supports a structured output schema and a tool filter, and it would reuse the subagent lifecycle and UI. A spawned child joins its parent's preset, however, so it would run with the worker's persona and tools; a tool filter can only narrow that set and cannot add the architect tools. Creating the consultation agent directly with the `architect` preset keeps the architect composition identical in Architecture Sessions and consultations.

**A session projection of Rulings for the dashboard.** Projections fold one Session's events and are read per Session, so a dashboard over every worker Session would open each Session's log to list Rulings. Ruling records under `.architecture/` give the dashboard one directory to read and keep the worker log as the authority from which records are rebuilt.

**Per-change code review.** Reviewing each diff or pending tool call detects some misplaced changes, but it offers no dashboard, no architecture conversation, and no project-wide record, and it runs after the worker has already chosen a design.

**Automatic rewriting of the architecture record, as in dream-style consolidation.** Consolidation that rewrites memory files would put unreviewed conclusions into binding sources. Background passes produce proposals only.

**Required consultation before editing selected areas.** A `tools/pre-execute` check could require a Ruling before edits to manifest-declared areas. It is deferred until the pilot shows whether workers consult reliably when left to judge.

## Acceptance criteria

- Mounting the profile patch adds the dashboard entry, the `architect` preset, and the worker tools; release profiles and packages remain unchanged.
- A workspace without a manifest can establish one through an Architecture Session, and every source write passes through `architecture_edit` after user confirmation.
- `architecture_edit` rejects a target outside the manifest and `.architecture/`, and rejects every write from a linked worktree or a branch other than `mainBranch`; tests exercise both denials through the tool executor.
- The tool guard denies `write`, `edit`, and `str_replace_editor` on a manifest source or `.architecture/` path in every Session, including the primary worktree on `mainBranch`, for direct and PTC calls, and for a relative, symlinked, or `..` spelling of the path.
- The check script rejects a commit or branch diff that touches a manifest source outside the primary worktree or `mainBranch`, and accepts an `architecture_edit` result committed on `mainBranch` in the primary worktree.
- An Architecture Session and a consultation agent see and can execute only the architect tools; a Session that selects the `architect` preset through the ordinary new-session path is denied every mutating tool by the guard, under every sandbox mode.
- `consult_architect` returns a Ruling whose every constraint cites a citable section with a matching hash; a constraint with an invalid, stale, or uncited source is removed or returned as an unresolved point.
- An appeal appears in the dashboard, and each adjudication reaches the worker as a logged input in its Session.
- The dashboard shows Rulings, appeals, activity, and local entries without a conversation and updates without a page refresh.
- Replaying a worker Session reproduces every consultation result from its log, and deleting `.architecture/rulings/` followed by a rebuild restores the same Ruling records.
- A real-composition test boots the profile through the Loader, and a recorded-session snapshot covers the model-visible consultation and appeal text.

## Risks

- **Citation gaming:** an architect can cite a section that is only loosely related to its constraint. Hash checks prove the section exists but not that it supports the constraint; the dashboard makes each citation reviewable, and repeated appeals show weak rulings.
- **Stale worktree copies:** a worker in a linked worktree may read an older architecture document than the one its Ruling cites. The Ruling text carries the cited content, and the dashboard reports diverged sources.
- **Bypass through Bash:** the tool guard does not cover Bash, terminals, PTC code, or subprocesses, so a worker can still change a source file in its working copy. The change becomes authoritative only through a commit and merge; the check script rejects it at those points only when the user wires it into the pre-commit hook and the merge path, and dashboard detection reports it before commit.
- **Guard argument parsing:** the guard recognizes only the listed tools' path arguments and canonicalizes with local synchronous path resolution. A newly added write tool, or a remote `ctx.fs` provider whose paths do not exist on the Harness host, is not covered until the guard learns it or the decorating `ctx.fs` provider replaces it.
- **Documentation rules without commands:** the architect cannot run generators or pairing records. An edit to a bilingual or generated document leaves the checks for the user to run before commit.
- **Sandbox mode is not pinned:** a user can switch an Architecture Session to a writable sandbox mode. The tool allow-list and the guard keep it from writing code, but a new tool added to the `architect` preset without a matching guard entry would run under whatever mode the user chose.
- **Consultation cost and latency:** each consultation starts a model run. `consultTimeoutMs` bounds waiting, and unresolved results do not block the worker.
- **Over-constraint:** binding Rulings can freeze a design that should change. The appeal path and the user's overturn decision are the correction mechanism; the dashboard's appeal count shows where it is used.
- **Tool-only consultation:** workers may not consult when they should. This is accepted for the pilot and measured before any required-consultation check is considered.
