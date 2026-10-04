# Architecture agent

English | [中文](architecture-agent.zh.md)

The experimental architecture agent keeps worker agents inside the workspace's recorded architecture. The [service](../../packages/experimental/architecture/README.md) owns the manifest, section index, edit rule, consultations, and durable records. The [tool package](../../packages/experimental/tool-architecture/README.md) gives workers `consult_architect` and `appeal_ruling` and gives the architect its read and edit tools. The [Remote consumer](../../packages/experimental/api-architecture/README.md) serves the [dashboard](../../packages/experimental/client-ui-architecture/README.md). The [profile bundle](../../packages/experimental/architecture-profile/README.md) composes them with the `architect` preset.

## Sources and index

The repository's `architecture.yml` lists Markdown sources as globs, with an optional `exclude` list. The service indexes each source's headings as sections. An `IndexedSection` carries its path, GitHub-style anchor, title, level, line range, and content hash. `ArchitectureIndex` holds every section of every source from the primary worktree, plus diagnostics for sources that could not be read. The index revision hashes every section's path, anchor, and hash, so it changes whenever indexed content changes.

Architecture sources change only in the primary checkout: the primary git worktree, or, in a Jujutsu repository, colocated or not, the workspace that holds the repository. The checkout may be on any branch. A `CheckoutState` records the checkout's `VcsKind`, its root, and whether it is primary. The manifest's `mainBranch` names the branch, a bookmark in Jujutsu, whose committed content Rulings may cite; the service reads it from the primary checkout's manifest at each check, so a changed value applies at once. A global tool guard denies every other writer, including one that would create a file a source glob matches; the architect's `architecture_edit` tool checks the same rule, and an `ArchitectureEditRequest` may replace one section at the hash the architect read. `EditRefusal` names the violated condition.

## Consultation and Rulings

A worker's `ConsultRequest` runs an architect agent as a hidden child of the worker Session, on the configured architect model or, when none is set, on the worker's model. The architect may use only its configured tools and must call `submit_ruling`. The service turns the submission into a Ruling: a constraint binds only when every citation names an indexed section whose current content is committed on the main branch or accepted by the user. Other constraints become unresolved points with the reason. A submission may also carry proposed edits, each replacing one indexed section read at a stated content hash. The service validates each against the edit rule and the current index and drops an invalid one with its reason as an unresolved point; it writes none. A proposed edit binds no worker and makes nothing citable. A consultation never changes the record: the user authorizes every change, in an Architecture Session or by applying a proposed edit in the dashboard. `ConsultResult` is a Ruling with its index revision, a timeout, or an ended run without a submission.

After the worker's tool result is committed, the tool package writes a `RulingRecord` under `.architecture/rulings/`. The record copies the Ruling with its proposed edits, both Session ids, the index revision, a status, which proposed edits the user applied, and which the user dismissed; no proposed edit is both. The worker's log remains the authority for what the worker received; the record is a dashboard copy, and the worker never receives the applied or dismissed markers.

## Appeals and acceptance

A worker that disagrees with a constraint calls `appeal_ruling` with a reason and evidence. The service writes an `AppealRecord` under `.architecture/appeals/` and marks the Ruling appealed; the Ruling stays binding. The user decides in the dashboard. An `Adjudication` upholds the Ruling, overturns it, or grants an exception limited to a stated scope. The service steers the decision into the worker Session as an `architecture` user message. When that Session's agent is not live, the decision is delivered when the agent is next created.

An `Acceptance` records one section at the exact content hash the user reviewed. Accepted sections are citable before they are committed; any later change to the section removes that status. Applying a proposed edit with acceptance records an `Acceptance` of the section the write produced.

## Dashboard

The dashboard is a main panel with a sidebar entry. It follows one Workspace through the `architecture` Remote `follow` stream, which yields an `ArchitectureSnapshot` after every `architecture/changed` event for that repository. Its views show the index with each source's git status, Rulings with their status, whether a cited section changed, and their proposed edits against the current sections, appeals with the decision form, files under the local directory with their git status, and settings. The Settings view declares the repository's main branch through the `setMainBranch` Remote method, from the primary checkout, choosing among the repository's local branches or bookmarks, and edits the profile's architect model, the live `architectProvider`, `architectModel`, and `architectReasoningEffort` fields of the service configuration that each consultation reads. The Consultations view lists the pending proposed edits, those neither applied nor dismissed whose section still has the hash the architect read, grouped by target section. It applies a proposed edit through the `applyProposedEdit` Remote method, from the primary checkout under the edit rule, and optionally accepts the resulting section; a section that changed since the consultation is refused. It dismisses a proposed edit through the `dismissProposedEdit` Remote method, which marks the edit dismissed in the Ruling record and writes no architecture source. Discuss opens a new Session on the `architect` preset in the selected Workspace.

## Commit and CI check

The service package ships `scripts/check-architecture.sh`, a POSIX shell script users wire into their own hooks. In git, `staged` mode refuses a commit that changes the manifest or a source outside the primary worktree; in jj, `working` mode refuses such working-copy changes outside the primary workspace. `range` mode lists the manifest and source paths a commit range changes and does not fail, so review of a merge into the main branch sees every architecture change.

## Design rationale

The [architecture agent proposal](../../.agents/notes/proposed/feature/2026-09-29-architecture-agent.md) explains the file authority, binding constraints with appeals, and primary-checkout-only edits.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxarchitecture--architectureservice"></a>

### `ctx.architecture` — `ArchitectureService`

Workspace architecture sources, index, and edit rule.

```ts cordis-catalog
/**
 * The version control of the checkout containing a directory and the repository's local branches.
 * @param cwd - absolute directory inside the checkout.
 * @param signal - cancels git and jj queries.
 * @returns the system, whether the checkout is the primary one, the branch or bookmark names it is on now, and every
 * local branch or bookmark.
 * @throws when `cwd` is not inside a usable git or jj checkout, or version control fails.
 */
async branches(cwd: string, signal?: AbortSignal): Promise<CheckoutBranches>

/**
 * The checkout containing a directory, when the service can read its version control.
 * @param cwd - absolute directory.
 * @returns the checkout, or undefined outside git and jj or when that system's executable is not installed.
 */
checkout(cwd: string): CheckoutState | undefined

/**
 * Load the manifest and rebuild the index of the checkout containing `cwd`.
 * Rulings and the tool guard read the primary worktree, so the index is
 * always built from the primary worktree of that repository.
 * @param cwd - absolute directory inside the checkout.
 * @param signal - cancels the rebuild.
 * @returns the rebuilt index, or undefined when the repository has no manifest.
 * @throws {ManifestError} for a manifest that violates the manifest schema.
 * @throws when `cwd` is not inside a git or jj checkout, or version control fails.
 */
async rebuild(cwd: string, signal?: AbortSignal): Promise<ArchitectureIndex | undefined>

/**
 * The last index built for the repository containing `cwd`.
 * @param cwd - absolute directory inside the checkout.
 * @returns the index, or undefined before the first rebuild or without a manifest.
 */
index(cwd: string): ArchitectureIndex | undefined

/**
 * Whether an absolute path is protected in the repository containing it,
 * by the last rebuild of that repository. The manifest and the local
 * directory are protected even before a rebuild.
 * @param path - absolute path; need not exist.
 * @returns true when only {@link edit} may write the path.
 */
isProtected(path: string): boolean

/**
 * Write one architecture file, or replace one of its indexed sections, under
 * the edit rule. The target must be the manifest, an indexed source, or a
 * path under the local directory, and the checkout must be the primary
 * worktree or jj workspace, on any branch. A section edit reads the current file,
 * refuses when the section is missing or its hash differs from
 * `expectedHash`, and replaces the section's lines. The write replaces the
 * file atomically and rebuilds the index.
 * @param request - Session directory, target, optional section, and content.
 * @returns the written path, or the refusal.
 */
async edit(request: ArchitectureEditRequest): Promise<ArchitectureEditResult>

/**
 * Read one indexed section as it is in the primary worktree.
 * @param cwd - absolute directory inside the checkout.
 * @param path - source path from the index.
 * @param anchor - section anchor within that source.
 * @param signal - cancels the read.
 * @returns the section and its text, or undefined when the index has no such section.
 */
async readSection( cwd: string, path: string, anchor: string, signal?: AbortSignal, ): Promise<{ section: IndexedSection; text: string } | undefined>

/**
 * Ask the architect one question on behalf of a worker. The service rebuilds
 * the index of the worker's repository, runs an architect agent as a hidden
 * child of the worker's Session, and validates its submission into a Ruling
 * whose every constraint cites a section committed on `mainBranch`.
 * @param request - worker, question, scope, and cancellation.
 * @returns the Ruling, or an unresolved result naming why there is none.
 * @throws when the worker has no working directory, the repository has no manifest, or the agent services are not mounted.
 */
async consult(request: ConsultRequest): Promise<ConsultResult>

/**
 * Record a Ruling for the dashboard. Call after the worker's log committed
 * the consulting tool result, so the record never names a Ruling the worker
 * did not receive.
 * @param cwd - the worker Session's directory.
 * @param record - Ruling, Sessions, and index revision; status starts at `issued`.
 */
async recordRuling(cwd: string, record: Omit<RulingRecord, 'version' | 'issuedAt' | 'status' | 'appliedEdits' | 'dismissedEdits'>): Promise<void>

/**
 * File a worker's appeal against a recorded Ruling. The Ruling stays binding
 * while the appeal is pending.
 * @param request - Session directory, Ruling, appellant Session, reason, and evidence.
 * @returns the appeal record.
 * @throws when the repository has no record of the Ruling, or the Ruling is not the appellant's.
 */
async appeal(request: { readonly cwd: string readonly rulingId: RulingId readonly workerSession: SessionId readonly reason: string readonly evidence: readonly string[] }): Promise<AppealRecord>

/**
 * Record the user's decision on a pending appeal and deliver it to the
 * worker's Session when that Session's agent is live. An undelivered
 * decision is delivered when the Session's agent is next created.
 * @param cwd - any directory inside the repository.
 * @param appealId - the pending appeal.
 * @param adjudication - uphold, overturn, or a scoped exception.
 * @returns the decided appeal record.
 * @throws when the appeal does not exist or is already decided.
 */
async adjudicate(cwd: string, appealId: AppealId, adjudication: Adjudication): Promise<AppealRecord>

/**
 * Deliver every decided, undelivered appeal of a Session whose agent is now live.
 * @param agent - the live agent.
 */
async deliverPending(agent: Agent): Promise<void>

/**
 * Apply one proposed edit of a recorded Ruling from the primary checkout, under the edit rule. The write is refused
 * when the section changed since the architect read it. With `accept`, the section the write produced is accepted.
 * @param request - repository directory, Ruling, the edit's index in `ruling.proposedEdits`, and whether to accept.
 * @returns the written path, or the refusal; an accepted section is returned with the written result.
 * @throws when the Ruling is not recorded, the index names no proposed edit, or the edit was already applied or dismissed.
 */
async applyProposedEdit(request: ApplyProposedEditRequest): Promise<ApplyProposedEditResult>

/**
 * Dismiss one proposed edit of a recorded Ruling, so the dashboard stops offering it. Writes only the Ruling record;
 * the worker never sees the marker, and the edit stays a non-binding proposal.
 * @param request - repository directory, Ruling, and the edit's index in `ruling.proposedEdits`.
 * @throws when the Ruling is not recorded, the index names no proposed edit, or the edit was already applied or dismissed.
 */
async dismissProposedEdit(request: DismissProposedEditRequest): Promise<void>

/**
 * Accept a section's current content so Rulings may cite it before it is
 * committed on `mainBranch`. Accepting again replaces the earlier hash.
 * @param cwd - any directory inside the repository.
 * @param path - source path of the section.
 * @param anchor - section anchor.
 * @param hash - the content hash the user reviewed; refused when the section has changed since.
 * @returns the recorded acceptance.
 * @throws when the section is not indexed or its hash differs from `hash`.
 */
async accept(cwd: string, path: string, anchor: string, hash: string): Promise<Acceptance>

/**
 * Read the whole dashboard state of a repository. Rebuilds the index first.
 * @param cwd - any directory inside the repository.
 * @param signal - cancels the rebuild and git reads.
 * @returns the snapshot; outside a usable git or jj checkout, an empty snapshot with `unsupported` set.
 * @throws for an invalid manifest or a version-control failure.
 */
async snapshot(cwd: string, signal?: AbortSignal): Promise<ArchitectureSnapshot>

/**
 * Declare the repository's main branch in its manifest, from the primary checkout. The branch must be one of the
 * repository's local branches or bookmarks.
 * @param cwd - any directory inside the repository.
 * @param branch - the branch or jj bookmark to declare.
 * @param signal - cancels git and jj queries.
 * @returns the written manifest path, or the refusal.
 * @throws {ManifestError} when the repository has no valid manifest or `branch` is not a branch name.
 */
async setMainBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<ArchitectureEditResult>

/**
 * Evaluate the edit rule without writing: architecture files change only in the primary checkout, on any branch.
 * @param cwd - Session directory.
 * @param path - target, relative to the repository root or absolute.
 * @returns the refusal, or undefined when {@link edit} would write.
 */
checkEdit(cwd: string, path: string): EditRefusal | undefined
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/experimental/architecture/src/index.ts`](../../packages/experimental/architecture/src/index.ts)

<a id="ctxarchitecturecontroller--architecturecontroller"></a>

### `ctx.architectureController` — `ArchitectureController`

The `architecture` Remote namespace over `ctx.architecture`, addressed by Workspace.

```ts cordis-catalog
/**
 * Read the dashboard state of a Workspace, rebuilding its index.
 * @param workspaceId - Workspace whose repository is shown.
 * @param signal - Client cancellation.
 * @returns the complete snapshot.
 */
@Remote async snapshot(workspaceId: WorkspaceId, signal: AbortSignal): Promise<ArchitectureSnapshot>

/**
 * Follow the dashboard state of a Workspace: yield a snapshot now and after
 * each `architecture/changed` notification for its repository. Notifications
 * that arrive while a snapshot is being read coalesce into one more read.
 * @param workspaceId - Workspace whose repository is shown.
 * @param signal - Client observation lifetime.
 * @returns complete snapshots, oldest first.
 */
@Remote({ mode: 'stream' }) async *follow(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<ArchitectureSnapshot>

/**
 * Read one indexed section's text from the primary worktree.
 * @param request - Workspace, path, and anchor.
 * @param signal - Client cancellation.
 * @returns the section's hash and text.
 */
@Remote async section(request: ArchitectureSectionRequest, signal: AbortSignal): Promise<ArchitectureSectionValue>

/**
 * Accept a section's reviewed content so Rulings may cite it before it is committed.
 * @param request - Workspace, section, and the reviewed hash.
 * @returns the recorded acceptance.
 */
@Remote async accept(request: ArchitectureAcceptRequest): Promise<Acceptance>

/**
 * Apply one proposed edit of a recorded Ruling from the primary checkout, and optionally accept the written section.
 * @param request - Workspace, Ruling, edit index, and whether to accept.
 * @param signal - Client cancellation.
 * @returns the written path, and the acceptance when one was recorded.
 * @throws `architecture/failed` naming the refusal, an unknown Ruling or edit, or an edit already applied.
 */
@Remote async applyProposedEdit( request: ArchitectureApplyEditRequest, signal: AbortSignal, ): Promise<{ readonly path: string; readonly acceptance?: Acceptance | undefined }>

/**
 * Dismiss one proposed edit of a recorded Ruling; writes only the Ruling record.
 * @param request - Workspace, Ruling, and edit index.
 * @throws `architecture/failed` for an unknown Ruling or edit, or an edit already applied or dismissed.
 */
@Remote async dismissProposedEdit(request: ArchitectureDismissEditRequest): Promise<void>

/**
 * Declare the repository's main branch in its manifest, from the primary checkout.
 * @param request - Workspace and branch.
 * @param signal - Client cancellation.
 * @returns the written manifest path.
 * @throws `architecture/failed` naming the refusal when the rule is not met, or the manifest is missing or invalid.
 */
@Remote async setMainBranch(request: ArchitectureMainBranchRequest, signal: AbortSignal): Promise<{ readonly path: string }>

/**
 * Decide a pending appeal and deliver the decision to the worker Session.
 * @param request - Workspace, appeal, and decision.
 * @returns the decided appeal.
 */
@Remote async adjudicate(request: ArchitectureAdjudicateRequest): Promise<AppealRecord>
```

Types: [WorkspaceId](workspace.md)

Source: [`packages/experimental/api-architecture/src/index.ts`](../../packages/experimental/api-architecture/src/index.ts)

<a id="architecture-events"></a>

### `architecture/*` events

<a id="architecturechanged--emit"></a>

#### `architecture/changed` — emit

The architecture state of a repository changed: its index, a Ruling, an appeal, or an acceptance. Emitted after the change is written.

```ts cordis-catalog
/**
 * The architecture state of a repository changed: its index, a Ruling,
 * an appeal, or an acceptance. Emitted after the change is written.
 * @param root - canonical primary-worktree root of the repository.
 * @mode emit
 */
'architecture/changed'(root: string): void
```

Source: [`packages/experimental/architecture/src/index.ts`](../../packages/experimental/architecture/src/index.ts)
<!-- END GENERATED cordis-surface -->
