# 架构 Agent

[English](architecture-agent.md) | 中文

实验性架构 Agent 让工作 Agent 始终遵循工作区已记录的架构。[服务](../../packages/experimental/architecture/README.zh.md)拥有 manifest、章节索引、编辑规则、咨询和持久记录。[工具包](../../packages/experimental/tool-architecture/README.zh.md)为工作 Agent 提供 `consult_architect` 和 `appeal_ruling`，为架构师提供读取与编辑工具。[Remote 消费者](../../packages/experimental/api-architecture/README.zh.md)为[仪表盘](../../packages/experimental/client-ui-architecture/README.zh.md)提供服务。[Profile Bundle](../../packages/experimental/architecture-profile/README.zh.md)将它们与 `architect` 预设组合。

## 来源与索引

仓库的 `architecture.yml` 以 glob 列出 Markdown 来源，并可附带 `exclude` 列表。服务将每个来源的标题索引为章节。`IndexedSection` 携带路径、GitHub 风格锚点、标题、层级、行范围和内容哈希。`ArchitectureIndex` 包含主工作树中每个来源的全部章节，以及无法读取的来源的诊断信息。索引修订对每个章节的路径、锚点和哈希求哈希，因此索引内容一旦变化，修订就会变化。

架构来源只能在主 checkout 中修改：即 git 的主工作树，或 Jujutsu 仓库（共置与否均可）中持有仓库的 workspace。checkout 可以处于任意分支。`CheckoutState` 记录 checkout 的 `VcsKind`、根目录以及它是否为主 checkout。manifest 的 `mainBranch` 指明裁定可以引用哪个分支（Jujutsu 中为书签）上已提交的内容；服务每次检查都从主 checkout 的 manifest 读取它，因此修改后立即生效。全局工具守卫拒绝其他所有写入者，包括会创建匹配来源 glob 之文件的写入者；架构师的 `architecture_edit` 工具检查同一规则，`ArchitectureEditRequest` 可以按架构师读取时的哈希替换一个章节。`EditRefusal` 指明被违反的条件。

## 咨询与裁定

工作 Agent 的 `ConsultRequest` 在其 Session 下以隐藏子 Agent 的形式运行架构师，使用配置的架构师模型；未配置时使用工作 Agent 的模型。架构师只能使用配置的工具，并且必须调用 `submit_ruling`。服务把提交内容转换为裁定（Ruling）：只有当约束的每条引用都指向当前内容已提交到主分支或已被用户接受的已索引章节时，该约束才具有约束力。其他约束连同原因成为未决点。提交内容还可以附带修改提议，每条按指明的内容哈希替换一个已索引章节。服务按编辑规则和当前索引校验每条提议，把无效的提议连同原因转为未决点；它不写入任何提议。修改提议不约束任何工作 Agent，也不会让任何内容变得可引用。咨询从不修改记录：每次修改都由用户授权，可以在架构会话中进行，也可以在仪表盘中应用修改提议。`ConsultResult` 是附带索引修订的裁定、超时，或未提交即结束的运行。

工作 Agent 的工具结果提交后，工具包在 `.architecture/rulings/` 下写入 `RulingRecord`。记录复制裁定及其修改提议、两个 Session id、索引修订、状态，以及用户已应用了哪些修改提议。工作 Agent 的日志仍是其所收到内容的权威来源；记录只是仪表盘的副本。

## 申诉与接受

不同意某条约束的工作 Agent 调用 `appeal_ruling`，并给出理由和证据。服务在 `.architecture/appeals/` 下写入 `AppealRecord`，并将裁定标记为申诉中；裁定仍具有约束力。用户在仪表盘中裁决。`Adjudication` 维持裁定、推翻裁定，或授予限定于指定范围的豁免。服务把裁决作为 `architecture` 用户消息 steer 进工作 Session。该 Session 的 Agent 未运行时，裁决在该 Agent 下次创建时送达。

`Acceptance` 按用户审阅时的确切内容哈希记录一个章节。已接受的章节在提交之前即可被引用；章节之后的任何修改都会取消这一状态。连同接受一起应用修改提议时，会为写入产生的章节记录一条 `Acceptance`。

## 仪表盘

仪表盘是一个主面板，并带有侧边栏入口。它通过 `architecture` Remote 的 `follow` 流跟随一个工作区；该仓库每次发生 `architecture/changed` 事件后，流都会产出一个 `ArchitectureSnapshot`。其视图展示带有各来源 git 状态的索引、带有状态、引用章节是否变化以及对照当前章节的修改提议的裁定、带有裁决表单的申诉，本地目录下的文件及其 git 状态，以及设置。设置视图通过 `setMainBranch` Remote 方法在主 checkout 中声明仓库的主分支，可从仓库的本地分支或书签中选择，并编辑 profile 中的架构师模型，即服务配置中每次咨询都会读取的实时字段 `architectProvider`、`architectModel` 和 `architectReasoningEffort`。“咨询”视图通过 `applyProposedEdit` Remote 方法，在主 checkout 中按编辑规则应用修改提议，并可同时接受由此产生的章节；咨询之后已变化的章节会被拒绝。“讨论架构”在所选工作区中以 `architect` 预设开启新 Session。

## 提交与 CI 检查

服务包附带 `scripts/check-architecture.sh`，这是一个由用户自行接入 hook 的 POSIX shell 脚本。在 git 中，`staged` 模式拒绝在主工作树之外修改 manifest 或来源的提交；在 jj 中，`working` 模式拒绝在主 workspace 之外对它们的工作副本修改。`range` 模式列出一个提交范围修改的 manifest 与来源路径，但不会失败，使合并到主分支前的审阅能看到每一处架构改动。

## 设计依据

[架构 Agent 提案](../../.agents/notes/proposed/feature/2026-09-29-architecture-agent.zh.md)解释了文件权威、带申诉的约束，以及仅限主 checkout 的编辑。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
async recordRuling(cwd: string, record: Omit<RulingRecord, 'version' | 'issuedAt' | 'status' | 'appliedEdits'>): Promise<void>

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
 * @throws when the Ruling is not recorded, the index names no proposed edit, or the edit was already applied.
 */
async applyProposedEdit(request: ApplyProposedEditRequest): Promise<ApplyProposedEditResult>

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

Types: [Agent](core.zh.md) · [SessionId](core.zh.md)

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

Types: [WorkspaceId](workspace.zh.md)

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
