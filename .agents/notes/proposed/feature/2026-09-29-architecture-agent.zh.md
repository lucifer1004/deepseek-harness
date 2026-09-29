# Agent Note: 带仪表盘、架构会话和约束性咨询的架构 agent

Status: proposed

[English](2026-09-29-architecture-agent.md) | 中文

## 问题

执行长任务的 worker agent（智能体）会逐渐失去项目全局视角。最初几步之后，它的上下文里塞满了失败的测试、diff 和局部代码，后续请求会更看重这些近期细节，而不是开始时读过的设计。上下文压缩首先删掉的也是早期读过的架构内容。于是 worker 在症状出现的地方修症状：加特判、加回退默认值、在已有扩展点旁边另写一套平行实现、只改平行代码中的一侧。在系统提示里要求"要有全局思维"，改变不了上下文里装的是哪些事实。

用户也看不到 agent 所理解的项目架构。除非逐一阅读每份对话记录，否则用户无法知道并发会话正在修改哪些区域、worker 问过哪些架构问题、哪里有 agent 对设计判断有误。用户也没有一种专门讨论架构的对话：普通会话在任何一步都可能写代码，设计讨论可能在用户认可设计之前就变成了实现。

现有机制各自只覆盖一部分。[Agent Teams](../../implemented/feature/2026-08-05-agent-teams.zh.md) 的名册和邮箱绑定在一个 Lead 根会话上，而架构比任何单个任务存在得更久。[Auto review](../../../../packages/experimental/auto-review/README.zh.md) 判断的是单次待执行工具调用是否安全，而不是一项改动应该放在哪一层。[侧会话](2026-07-08-interactive-side-sessions.zh.md) 从一个会话 fork 出临时讨论，不保存项目级状态。社区里的记忆插件和"dream"插件把关于用户和项目的事实整合进记忆文件；它们不把条目锚定到代码或仓库文档，也没有一个会发出另一个 agent 必须遵守的裁决。

## 提案

**架构 agent** 是一个项目级的产品角色，围绕同一组架构来源提供三个入口：

| 入口 | 使用者 | 对架构来源的权限 |
|---|---|---|
| 仪表盘 | 用户，无需对话 | 实时读取；接受本地条目；裁决上诉 |
| 架构会话 | 用户与 architect preset | 在主分支上读取、讨论和编辑 |
| 咨询 | worker agent | 通过约束性 Ruling 读取；向用户上诉 |

这个角色借鉴了 sleep-time agent 和"dream"agent 的三个思路：在 worker 需要之前准备好上下文；worker 和架构师使用不同的上下文；后台分析只产出供用户审查的提案。后台分析本身从不改写架构来源。

### 架构来源

权威的架构记录是仓库文件。工作区根目录下的 manifest（元数据清单）`architecture.yml` 按路径或 glob 列出来源文档，例如 dsh 试点中的 `docs/architecture.md`、`docs/capability-seams.md` 和 `.agents/notes/implemented/**`。项目保留自己现有的文档布局；manifest 只声明哪些文件算数。

尚未写入这些文档的本地架构信息放在同一工作区的 `.architecture/` 下：决策草稿、开放问题、上诉、裁决、后台提案。`.architecture/` 是被跟踪、被忽略还是部分提交，由用户决定；插件不在工作区之外保留第二个存储。仪表盘显示每个来源和本地条目的 git 状态：已提交、已修改、未跟踪或已忽略。

插件从 manifest 来源和 `.architecture/` 推导出**架构索引**：组件与职责、带适用范围和被否方案的决策、约束、开放问题、已记录的偏离。每个索引条目记录其来源路径、标题锚点和该段内容的 hash。索引只是供搜索和仪表盘使用的缓存，从不具有权威性；从文件重建索引会得到完全相同的结果。索引在仪表盘请求时以及每次架构编辑后重建；文件监视留待以后。

### 编辑规则

只有 `architecture_edit` 能写入架构来源，而且只能在主 worktree 的主分支上写入。该工具解析会话所在的检出，除非该检出是仓库的主 worktree 且 `HEAD` 为配置的 `mainBranch`，否则拒绝写入。`mainBranch` 是必填配置字段，没有默认值。其他任何工具和会话都不能修改 manifest 来源，包括运行在主 worktree 的 `mainBranch` 上的 worker；不认同某个来源的 worker 应当上诉。

即使咨询的 worker 运行在内容更旧的链接 worktree 中，Ruling 也始终引用主 worktree 的内容。

没有任何一层能覆盖所有写入路径，因此该规则在三层上执行：

1. **工具 guard。** 插件注册一个全局 `ctx.tools.guard()`：`write`、`edit` 和 `str_replace_editor` 调用的路径参数按会话 cwd 解析并规范化后，如果指向 manifest 来源或 `.architecture/` 下的路径，就拒绝该调用。guard 在所有 `tools/pre-execute` listener 之后运行，且只能拒绝，因此 listener 顺序无法重新放行该调用；PTC 子调用也经过同一个 guard。拒绝理由会引导模型改用 `consult_architect` 或 `appeal_ruling`。`architecture_edit` 不是通用写工具，它自行执行检查。
2. **Git 检查。** Bash、终端、PTC 代码及其子进程通过内核沙箱写入，而内核沙箱授权的是整个工作区根目录，并非每种运行器都能把其中的子路径设为只读。因此插件提供的是检查脚本，而不是安装 hook：脚本拒绝在主 worktree 之外或不在 `mainBranch` 上触及 manifest 来源的提交，并拒绝相对 `mainBranch` 的 diff 触及 manifest 来源的分支。由用户把脚本接入仓库的 pre-commit hook 和合并路径（例如 CI 或 fork 的本地合并流程）。合并路径上的检查是最终的执行点，因为 `git commit --no-verify` 会跳过 pre-commit hook。
3. **仪表盘检测。** 只要任何 worktree 中某个 manifest 来源的工作副本与 `mainBranch` 不同，仪表盘就会报告，因此绕过前两层的编辑在提交之前就是可见的。

不使用 `fs/write-intent` 和 `fs/edit-intent` 事件：它们各自是单一的决策槽，按注册顺序由 [fs-observation-policy](../../../../packages/fs/fs-observation-policy/README.zh.md) 占用，而且该包指明分层的权限控制应放在 `tools/*` 流水线上。像 [fs-sandbox](../../../../packages/fs/fs-sandbox/README.zh.md) 那样在重新规范化目标后拦截写入的装饰型 `ctx.fs` 提供方，检查的是确切的目标而不是解析出的参数，但它要替换组合中的 `ctx.fs` 行；除非 guard 的参数解析被证明不够用，否则推迟实现。

### 仪表盘

仪表盘是一个 Web 全局面板，注册在 [ui-layout](../../../../packages/client/ui-layout/README.zh.md) 的 `main` keyed slot 中，从侧栏的固定入口选中。它通过 Remote 方法读取宿主状态，不需要对话。它有五个视图：

- **架构：** 来自索引的组件、能力关系、决策和约束，每一项都链接到其来源段落。
- **活动：** 每个活跃 worker 会话正在修改哪些区域，由其工具调用和工具结果投影得出，包括两个会话修改同一区域的情况。
- **咨询：** 每条 Ruling 及其问题、约束、引用、发起咨询的会话和状态。
- **上诉与提案：** 待处理的上诉（附 worker 的理由和证据）以及后台提案。每一项提供接受、拒绝或"讨论"；"讨论"会打开一个以该项为种子的架构会话。
- **本地条目：** `.architecture/` 中的条目及其 git 状态，以及把未提交条目变为可引用的接受操作。

仪表盘不向任何模型请求添加内容。

### 架构会话

架构会话是绑定 `architect` agent preset、从仪表盘启动的普通会话，可以选择以某个组件、提案、上诉或开放问题为种子。该 preset 提供 persona、读取与搜索工具、通过 `ctx.sessionQuery` 读取其他会话的能力，以及架构工具。`ctx.architecture` 自己通过 `ctx.agents.create` 创建该会话：像 session-controller 和 webhook 那样在创建 setup 中用 `ctx.agentPresets.mount` 挂载 preset，并在同一 setup 中以架构师工具名调用 `agentCtx.tools.restrict({ allow })`。该限制会从这个 agent 的提示和执行中移除其他所有工具，包括 `dsh-tool-fs` 总是与 `read` 一起注册的 `write` 和 `edit`。

沙箱模式不是执行手段：preset 无法固定会话的沙箱模式，它是每个会话的 `sandbox/mode` 事件，由 permission-presets 按用户默认值初始化，用户也可以切换。有两种机制不依赖它：工具 allow-list 让该 agent 没有任何通用写工具或执行工具；编辑规则的 guard 在每个会话中拒绝对架构来源的 `write`、`edit` 和 `str_replace_editor`。通过普通新建会话路径选择 `architect` preset 的会话没有 allow-list；guard 还会对组合 preset 为 `architect` 的任何 agent 拒绝所有可变更工具，因此这条路径同样无法写代码。

架构师只能通过 `architecture_edit` 编辑来源。模型提交结构化编辑（目标文件、段落和替换文本）；宿主代码校验目标是 manifest 来源或 `.architecture/` 下的路径，应用编辑规则，然后写入文件。这沿用了社区记忆整合插件中由宿主校验写入的做法：模型不持有写工具，由宿主执行经过校验的写入。架构师不运行 git；由用户审查并提交产生的 diff。

首次建模在架构会话中进行。工作区没有 manifest 时，仪表盘提供"建立项目架构"，打开一个带建模 skill 的架构会话：架构师调查仓库，提出候选组件和现有文档，与用户逐项确认每项职责和决策，并在每次确认后通过 `architecture_edit` 起草 manifest 和文档。仪表盘根据会话记录的 preset 列出架构会话，因此不需要新增会话元数据。

目标项目有自己的文档规则时，架构师从项目的说明文件中读取这些规则；dsh 的规则来自其 `docs/AGENTS.md`。插件不硬编码任何文档规范。

### 咨询与 Ruling

worker 调用 `consult_architect(question, scope?)`，其中 `scope` 指定路径或组件。提供方以与架构会话相同的方式创建一个咨询 agent：通过 `ctx.agents.create` 挂载 `architect` preset 并应用架构师工具 allow-list，记录为 worker 会话的子会话并带 `origin: 'subagent'`，使侧栏隐藏它；它基于当前索引 revision 和主 worktree 的来源作答。咨询 agent 通过调用一个作用域内的 `submit_ruling` 工具报告答案，其参数就是 Ruling 的各个字段；宿主代码在 `consult_architect` 返回之前校验该提交。咨询可以并发执行，不排在架构会话后面。调用最多等待配置的 `consultTimeoutMs`；超时则取消咨询 agent，并返回一个没有约束的未决结果。

结果是一条 **Ruling**：一个 `RulingId`、索引 revision、零条或多条约束、零条或多条未决点。worker 必须遵守其中的约束。一条约束只有通过路径、锚点和内容 hash 引用了一个可引用的来源段落，才具有约束力；宿主在返回 Ruling 之前对照主 worktree 校验每处引用，并丢弃引用校验失败的约束。一个段落可引用，指它已提交在 `mainBranch` 上，或用户已在仪表盘中接受它（接受时会在 `.architecture/` 下记录所接受内容的 hash）。没有可引用来源的架构师判断会成为未决点和仪表盘上的开放问题，而不会成为约束。

worker 认为某条 Ruling 有误时调用 `appeal_ruling(rulingId, reason, evidence)`。上诉期间 Ruling 仍然有效：worker 可以继续不受影响的工作或停下来，但不得绕过约束。用户在仪表盘中裁决：

- **维持：** 通知 worker 继续遵守该 Ruling。
- **推翻：** 用户在主分支上的架构会话中修订来源，产生新的索引 revision，worker 收到修订后的约束。
- **给予例外：** 用户在 `.architecture/` 下记录一个限定范围的例外或偏离，worker 收到该记录。

裁决通过 `agent.steer()` 送达 worker，因此作为普通输入进入该会话的日志。worker 会话未加载时，裁决保留在其上诉记录中待送达，并在该会话的 agent 下一次创建时送达。之后若被引用段落的 hash 发生变化，仪表盘会把引用它的 Ruling 标为过期。

咨询只以工具的形式提供。由 worker 决定何时咨询；没有 `tools/pre-execute` listener 要求在编辑某个区域之前先咨询。是否需要强制咨询，根据试点中的观察再决定。

### 持久记录

Ruling 作为 `consult_architect` 的工具结果到达 worker 模型，并作为该结果的 `meta` 持久化（工具注册表把它原样存入 `tool/result`），因此 worker 的请求仍可从其日志重建。worker 的日志是 worker 收到了什么的权威记录。在 `tools/result` 通知确认结果之后，提供方在 `.architecture/rulings/` 下为仪表盘写一条 Ruling 记录；崩溃后缺失的记录可以通过 `ctx.sessionQuery` 从 worker 日志重建。上诉、裁决、接受记录、例外和提案同样是 `.architecture/` 下的文件。本提案不新增 `SessionEventMap` 类型；只有当工具结果元数据无法承载仪表盘或回放所需的内容时，才引入新的事件类型。

### 后台提案

定时或手动触发的后台分析读取最近的 worker 会话和索引，把提案写入 `.architecture/proposals/`。例如：某个被引用段落的代码锚点已不存在；两个会话对同一接口假设了不同的设计；针对同一约束的反复上诉；某个区域反复出现的修症状式改动。提案永远不可引用。接受一条提案会打开一个架构会话或记录一个本地条目；除了在编辑规则下通过 `architecture_edit`，任何内容都不会进入来源文档。

### 包

这项工作放在所维护的 dsh fork 的 `packages/experimental/` 下，使用 `@deepseek-ai/dsh-experimental-*` 前缀，发布包不依赖它们：

| 包 | 角色 |
|---|---|
| `dsh-experimental-architecture` | `ctx.architecture` 的 Service Definition 与 Service Provider：manifest 加载、索引、编辑规则检查与工具 guard、提交检查脚本、咨询、Ruling 校验、上诉记录、活动投影、后台提案和 Remote 方法 |
| `dsh-experimental-tool-architecture` | Consumer：供 worker 使用的 `consult_architect` 和 `appeal_ruling`；供 `architect` preset 使用的架构读取、`architecture_edit` 和会话摘要工具 |
| `dsh-experimental-client-ui-architecture` | 仪表盘面板、侧栏入口和架构会话创建 |
| `dsh-experimental-architecture-profile` | 可选启用的 bundle patch，挂载上面各行和 `architect` preset，方式与 Agent Teams profile 相同 |

该设计不需要修改 agent loop（智能体循环）。它使用 agent preset 和 persona、带作用域工具限制的 `ctx.agents.create`、`ctx.tools.guard()`、`agent.steer()`、`ctx.sessionQuery` 和布局 `main` slot。

### 试点

试点在本仓库上进行。其 manifest 列出现有的架构文档、生成的关系图和已实现的 Agent Note，首次建模主要是确认索引和补齐缺口。包把项目特有的行为放在 manifest 和项目说明文件中，这样同样的包无需 dsh 专属代码就能用于其他仓库。

对当前源码的检查已经回答了三个实现问题。preset 无法固定会话的沙箱模式，因此由工具 allow-list 和 guard 执行禁止写入的规则。进程内 spawn 提供方支持 `outputSchema`，但 spawn 出的子 agent 会加入其父 agent 的 preset，因此通过 `ctx.subagents` 启动的咨询会带着 worker 的工具运行；咨询 agent 改为直接创建。工具结果的 `meta` 会原样持久化，但 session projection 只汇总单个会话，而仪表盘需要所有会话，因此由 `.architecture/rulings/` 下的 Ruling 记录服务仪表盘，worker 日志仍是权威。

## 考虑过的替代方案

**用一个长期存在的架构师会话回答所有咨询。** 它能保持一段连续的对话，但上下文会无限增长，上下文压缩会丢掉旧的推理，并发咨询还要排在同一个收件箱后面。基于仓库来源启动全新实例，能让每次回答都反映当前状态并且可以并发，连续性由来源文件承载。

**以宿主侧存储为权威。** 结构化存储会简化查询和实时更新，但会让架构记录留在仓库之外。其他贡献者和 agent 无法随代码一起审查、分支或共享它。仓库文件才是权威，索引只是可重建的缓存。

**建议性的咨询。** 建议会让处在局部压力下的 worker 恰好在关键时刻忽略设计。约束性 Ruling 加上向用户上诉，既保持约束的刚性，又给 worker 一条报告判断错误的路径。要求引用，能防止无依据的架构师判断变成约束。

**允许从任何 worktree 或分支编辑架构。** 这能让分支工作更新自己的设计，但并行的 worktree 会在架构本身上产生分歧，Ruling 也失去唯一的权威文本。编辑规则为 Ruling 提供唯一来源；分支工作通过上诉或架构会话影响设计。

**只按位置限制、允许主 worktree 的 `mainBranch` 上任何写入者修改的规则。** 这样表述更简单，但运行在那里的 worker 可以用通用工具改写来源，从而改变约束自己的规则，绕过上诉路径。编辑规则既限制位置，也限制写入者。

**在内核沙箱中设置只读子路径。** 给 `SandboxExecutionPolicy` 增加只读子路径列表可以直接阻止 Bash 写入。但这会改变公共的沙箱策略和每一种运行器：bwrap 的只读绑定只覆盖命令启动时已存在的路径，Landlock 的授权只能叠加、无法把子目录从已授权的根目录中排除，而 `danger-full-access` 会完全跳过限制。提交和合并检查在权威记录发生变化的地方执行该规则，不需要这项改动。

**以 Agent Teams 为宿主。** Team 状态属于一个 Lead 根会话及其生命周期，而架构 agent 以工作区为范围，服务于互不相关的根会话。Agent Teams 的持久邮箱和恢复机制仍是有用的参考实现。

**通过 subagent 服务咨询。** 使用 spawn 提供方的 `ctx.subagents` 支持结构化输出 schema 和工具过滤，并能复用 subagent 的生命周期和 UI。但 spawn 出的子 agent 会加入其父 agent 的 preset，因此会带着 worker 的 persona 和工具运行；工具过滤只能缩小这个集合，无法加入架构师工具。直接以 `architect` preset 创建咨询 agent，能让架构会话和咨询中的架构师组合保持一致。

**用 session projection 为仪表盘汇总 Ruling。** projection 汇总单个会话的事件，并按会话读取，因此覆盖所有 worker 会话的仪表盘需要打开每个会话的日志才能列出 Ruling。`.architecture/` 下的 Ruling 记录让仪表盘只需读取一个目录，并保持 worker 日志作为重建记录所依据的权威。

**逐次改动的代码评审。** 评审每个 diff 或待执行的工具调用能发现一些放错位置的改动，但它不提供仪表盘、架构对话和项目级记录，并且发生在 worker 已经选定设计之后。

**像 dream 式整合那样自动改写架构记录。** 改写记忆文件的整合会把未经审查的结论放进具有约束力的来源。后台分析只产出提案。

**在编辑选定区域之前强制咨询。** 一个 `tools/pre-execute` 检查可以要求在编辑 manifest 声明的区域之前先取得 Ruling。这一项推迟到试点表明 worker 自行判断时是否能可靠地咨询之后再定。

## 验收标准

- 挂载 profile patch 会添加仪表盘入口、`architect` preset 和 worker 工具；发布版 profile 和包保持不变。
- 没有 manifest 的工作区可以通过架构会话建立 manifest，每次来源写入都在用户确认后经过 `architecture_edit`。
- `architecture_edit` 拒绝 manifest 和 `.architecture/` 之外的目标，并拒绝来自链接 worktree 或 `mainBranch` 以外分支的每次写入；测试通过工具执行器覆盖这两种拒绝。
- 工具 guard 在每个会话中（包括主 worktree 的 `mainBranch` 上）拒绝对 manifest 来源或 `.architecture/` 路径的 `write`、`edit` 和 `str_replace_editor` 调用，覆盖直接调用和 PTC 调用，也覆盖该路径的相对写法、符号链接写法和 `..` 写法。
- 检查脚本拒绝在主 worktree 之外或 `mainBranch` 之外触及 manifest 来源的提交或分支 diff，并接受在主 worktree 的 `mainBranch` 上提交的 `architecture_edit` 结果。
- 架构会话和咨询 agent 只能看到并执行架构师工具；通过普通新建会话路径选择 `architect` preset 的会话，在任何沙箱模式下都被 guard 拒绝所有可变更工具。
- `consult_architect` 返回的 Ruling 中每条约束都引用了一个 hash 匹配的可引用段落；引用无效、过期或缺失的约束会被移除，或作为未决点返回。
- 上诉出现在仪表盘中，每次裁决都作为已记录的输入送达 worker 所在的会话。
- 仪表盘无需对话即可显示 Ruling、上诉、活动和本地条目，并且无需刷新页面即可更新。
- 回放 worker 会话可以从其日志重现每一次咨询结果；删除 `.architecture/rulings/` 后重建，会恢复相同的 Ruling 记录。
- 一个真实组合测试通过 loader 启动该 profile，并有一个已录制会话快照覆盖模型可见的咨询和上诉文本。

## 风险

- **引用投机：** 架构师可以引用一个与其约束只有松散关系的段落。hash 校验只能证明该段落存在，不能证明它支持该约束；仪表盘让每处引用都可审查，反复出现的上诉会暴露薄弱的裁决。
- **worktree 副本过时：** 链接 worktree 中的 worker 读到的架构文档可能比其 Ruling 引用的版本更旧。Ruling 文本中携带了被引用的内容，仪表盘也会报告不一致的来源。
- **通过 Bash 绕过：** 工具 guard 不覆盖 Bash、终端、PTC 代码或子进程，因此 worker 仍能修改其工作副本中的来源文件。这样的修改只有经过提交和合并才会成为权威；只有当用户把检查脚本接入 pre-commit hook 和合并路径时，脚本才会在这些位置拒绝它，而仪表盘检测会在提交前报告它。
- **guard 的参数解析：** guard 只识别所列工具的路径参数，并用本地同步路径解析做规范化。新增的写工具，或路径在 Harness 宿主上不存在的远程 `ctx.fs` 提供方，在 guard 学会识别它们或由装饰型 `ctx.fs` 提供方取代之前都不在覆盖范围内。
- **文档规则没有命令支持：** 架构师不能运行生成器或双语配对记录命令。编辑双语文档或生成文档后，需要用户在提交前自行运行相应检查。
- **沙箱模式未被固定：** 用户可以把架构会话切换到可写的沙箱模式。工具 allow-list 和 guard 让它无法写代码，但如果给 `architect` preset 新增工具而没有相应的 guard 条目，该工具会在用户选择的任何模式下运行。
- **咨询成本和延迟：** 每次咨询都会启动一次模型运行。`consultTimeoutMs` 限制等待时间，未决结果不会阻塞 worker。
- **过度约束：** 约束性 Ruling 可能冻结一个本应改变的设计。上诉路径和用户的推翻决定是纠正机制；仪表盘上的上诉计数显示纠正机制在哪里被使用。
- **只以工具形式提供咨询：** worker 可能在应当咨询时没有咨询。试点接受这一点，并在考虑任何强制咨询检查之前先做度量。
