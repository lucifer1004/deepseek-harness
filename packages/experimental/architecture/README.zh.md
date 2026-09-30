---
description: "让仓库的架构文档保持权威：为其章节建立带稳定锚点与内容哈希的索引，并且只允许在主分支的主 worktree 中编辑它们。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-architecture

[English](README.md) | 中文

## 概述

在 agent 修改代码时，让仓库的架构文档保持权威。你在 `architecture.yml` manifest 中列出来源文档；本包为每个 Markdown 章节建立带 GitHub 锚点与内容哈希的索引，裁定可以按确切版本引用 `path#anchor`。内置文件工具不能写这些文档，本包自己的编辑路径只在主分支的主 worktree 中写入。`consult()` 返回一份 Ruling，其约束性要求引用已提交或经用户接受的章节；Ruling、申诉与接受记录保存在 `.architecture/` 下。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包挂载在工具注册表与子进程运行时旁边，指定主分支，并在仓库根目录提交 `architecture.yml`。

### 何时选择

当仓库把架构保存在已提交的文档中，且 agent 不得在修改代码时顺带改动这些文档时，选择本包。没有 git 的仓库不适用，因为编辑规则与来源列举都读取 git 状态。没有本包时，架构文档只是任何文件工具都能修改的普通文件。

### 最小配置

在已挂载 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-subprocess-local` 的组合中加入一行：

```yaml
- id: architecture
  name: '@deepseek-ai/dsh-experimental-architecture'
  config:
    mainBranch: main
```

提交一个以工作区相对 glob 列出来源文档的 manifest：

```yaml
# architecture.yml
sources:
  - docs/architecture.md
  - docs/subsystems/*.md
exclude:
  - '**/*.zh.md'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mainBranch` | 必填 | 只有在该分支的主 worktree checkout 中才能修改架构来源。 |
| `manifestPath` | `architecture.yml` | manifest 的工作区相对路径。 |
| `localDirectory` | `.architecture` | 本地架构条目及 Ruling、申诉与接受记录的工作区相对目录；其下所有路径都受保护。 |
| `architectPreset` | `architect` | 该 agent preset 的 agent 只能运行 `architectTools`。 |
| `architectTools` | `DEFAULT_ARCHITECT_TOOLS` | `architectPreset` agent 可以看到并运行的工具名。默认值包含 `read`、`glob`、`grep`、`web_search`、`web_fetch`、会话查询工具、三个架构工具、`ask_user_question` 与 `todo_write`。 |
| `gitTimeoutMs` | `10000` | 单条 git 命令可运行的毫秒数。 |
| `maxSourceBytes` | `1048576` | 建立索引时单个来源读取的字节上限。 |
| `consultTimeoutMs` | `300000` | 一次咨询等待架构师提交 Ruling 的毫秒数。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-architecture)是所有可接受字段的完整来源。

### 成功与失败的表现

`ctx.architecture.rebuild(cwd)` 返回包含 `cwd` 的仓库的索引；仓库没有 manifest 时返回 `undefined`；manifest 无效时抛出 `ManifestError`。过大、不可读或不是 UTF-8 的来源会出现在 `diagnostics` 中，而不会让重建失败。目标为受保护路径的 `write`、`edit` 或 `str_replace_editor` 调用会以指明该路径的错误结果失败。`ctx.architecture.edit()` 返回 `{ kind: 'written' }`，或 `kind` 为 `not-repository`、`linked-worktree`、`wrong-branch`、`not-protected`、`unknown-section`、`stale-section` 之一的拒绝；`describeRefusal()` 把它渲染成一句话。`ctx.architecture.consult()` 返回 `{ kind: 'ruling' }`、`timeout` 或 `no-submission`；worker 取消、worker 会话没有目录或仓库没有 manifest 时则 reject。`snapshot(cwd)` 返回仪表盘状态；`appeal()`、`adjudicate()` 与 `accept()` 在 Ruling 或申诉未知、申诉已裁决或章节哈希已变化时 reject，并在消息中指明原因。

### 检查提交与 CI

本包附带 [`scripts/check-architecture.sh`](scripts/check-architecture.sh)，这是一个只使用 git 的 POSIX shell 脚本。在 pre-commit hook 中运行 `check-architecture.sh --main-branch main staged`，可拒绝在 `main` 主 worktree 之外修改 manifest 或来源的提交。在其他分支的 CI 中运行 `check-architecture.sh --main-branch main range origin/main HEAD`，可拒绝修改它们的提交范围。`--manifest <path>` 读取其他 manifest 路径。违规时退出码为 1，用法错误或无法读取的 manifest 为 2；它只读取 `sources:` 与 `exclude:` 下的块列表。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

manifest 指定权威文件；索引是 `rebuild()` 从这些文件重新生成的缓存。索引总是从仓库的主 worktree 构建，因为编辑规则只允许来源在那里改变。来源发现以来源 glob 作为 `:(glob)` pathspec 运行 `git ls-files --cached --others --exclude-standard`，因此未跟踪但未被忽略的草稿会进入索引，被忽略的文件不会；不以 NUL 结尾的列举会被视为截断而拒绝。`sources` 中以 `!` 开头的条目会被拒绝，因为 picomatch 会让它匹配所有其他路径；要排除的路径写在 `exclude` 下。只有 Markdown 来源会被拆分为章节。一个章节从其标题延伸到下一个任意级别的标题，因此编辑子章节不会改变父章节的哈希。锚点对标题的纯文本应用 GitHub 的 slug 规则，包括重复标题的 `-1`、`-2` 后缀；标题内的硬换行不产生空格。

工具守卫是同步的，因此 checkout 发现从磁盘读取 `.git`、`commondir` 与 `HEAD`，而不运行 git。linked worktree 中受保护文件的副本同样受保护，因此 worktree 中的 worker 不能在那里修改来源再 merge 回来。在第一次重建之前，manifest 与本地目录就已受保护。比较之前，目标路径会经由符号链接祖先目录规范化。本包不发布 runtime invariant companion：服务从自己构建的索引推导受保护路径集，不存在能与之相互偏离的独立观察。

咨询把架构师创建为 worker 会话的隐藏子 agent，`origin` 为 `'subagent'`，向其挂载 `architectPreset`，只保留该 preset 提供的 `architectTools`，但不含 `architecture_edit` 与 `ask_user_question`，因为咨询中没有用户参与，并注册一个作用域内的 `submit_ruling` 工具和一段提示词。第一次提交结束该轮；之后的每次调用都被守卫拒绝。运行在提交时、到达 `consultTimeoutMs` 时或 worker 的信号中止时结束，架构师 agent 在每种情况下都会被释放。随后宿主检查每个被引用的 `path#anchor`：该章节必须在当前索引中，且在 `refs/heads/<mainBranch>` 上已提交的文件中具有相同的内容哈希。没有引用或任一引用失败的约束会成为未决点，其原因指明失败，因此未提交的草稿永远不会约束 worker。章节编辑替换从章节标题到其最后一行的内容，保留它与下一个标题之间的空行；`expectedHash` 与章节当前哈希不同时被拒绝。

记录是本地目录下的 JSON 文件：`rulings/<id>.json`、`appeals/<id>.json` 与 `acceptances.json`。每次写入都经过临时文件与重命名。读取方校验每个文件，把无效文件报告在快照的 `problems` 中，而不读取它。对同一仓库记录的写入是串行的。`recordRuling()` 保存 worker 收到的 Ruling 及其索引修订；`appeal()` 只接受发给申诉方会话的 Ruling。`adjudicate()` 记录裁决、设置 Ruling 状态，并对 worker 的活动 agent 调用 `agent.steer()`，消息来源为 `{ kind: 'architecture', appealId }`；`agent/created` 监听器在 agent 下次创建时送达其不活动期间作出的裁决。`accept()` 拒绝与章节当前哈希不同的哈希；对已按该哈希接受的章节的引用无需提交即可通过校验。每次变更在写入后以仓库根目录发出 `architecture/changed`。

| 源码 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | `ctx.architecture` 服务、编辑规则与工具守卫 |
| [src/manifest.ts](src/manifest.ts) | manifest 解析与校验 |
| [src/index-builder.ts](src/index-builder.ts) | glob 匹配与索引构建 |
| [src/sections.ts](src/sections.ts) | Markdown 章节拆分、锚点与哈希 |
| [src/repository.ts](src/repository.ts) | 同步 checkout 发现 |
| [src/git-files.ts](src/git-files.ts) | 有界的 `git ls-files` 列举与已提交文件读取 |
| [src/guard.ts](src/guard.ts) | 写入目标解析与受保护路径匹配 |
| [src/citations.ts](src/citations.ts) | 引用解析，以及对照 `mainBranch` 的校验 |
| [src/ruling.ts](src/ruling.ts) | 把提交校验为 Ruling |
| [src/consultation.ts](src/consultation.ts) | 架构师 agent 运行与 `submit_ruling` |
| [src/records.ts](src/records.ts) | Ruling、申诉与接受记录文件 |
| [scripts/check-architecture.sh](scripts/check-architecture.sh) | 针对主分支之外来源修改的提交与 CI 检查 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面说明本包所属的设计以及它使用的扩展点。

- [架构 Agent 子系统](../../../docs/subsystems/architecture-agent.zh.md)——类型、记录与生成的 `ctx.architecture` API。
- [架构 agent Agent Note](../../../.agents/notes/proposed/feature/2026-09-29-architecture-agent.zh.md)——拟议的架构 agent、其会话、裁定与申诉。
- [工具注册表](../../core/tools/README.zh.md)——工具守卫，以及拒绝如何到达模型。
- [Agent preset 注册表](../../preset/agent-preset-registry/README.zh.md)——如何解析 agent 的组合 preset。
- [实验包](../AGENTS.md)——`packages/experimental/` 下包的规则。

-----

<a id="model-experience"></a>
## 模型体验

### 守卫拒绝

#### 模型看到什么

当 `write`、`edit` 或 `str_replace_editor` 调用的目标是受保护路径时，工具注册表返回错误结果而不运行该工具。文本为 `<path> is an architecture source. Architecture sources change only through the architecture agent on the main branch; do not edit them directly.`，其中 `<path>` 是绝对目标路径。当以 `architectPreset` 组合的 agent 调用 `architectTools` 之外的工具时，文本为 `The <tool> tool is unavailable to the architect: it discusses and records architecture and does not change code. Use the architecture tools instead.`。

#### Token 影响

每次被拒绝的调用以一条约 30 token 加路径长度的简短错误结果替代工具的正常输出。被允许的调用不增加任何内容。

#### KV Cache 影响

拒绝是一条普通工具结果，追加在可复用历史前缀之后。守卫不增加系统提示词文本或工具 schema，因此从不改变请求中更早的部分。

### 咨询

#### 模型看到什么

咨询中的架构师 agent 把 worker 的问题作为第一条用户消息收到；worker 指定了范围时，其后跟随 `Scope: <paths>`。它的系统提示词增加导出为 `CONSULTATION_INSTRUCTION` 的咨询说明，工具列表增加 `submit_ruling`，参数为 `summary`、`constraints`（每项含 `statement` 与 `cites`）和 `unresolved`。第二次提交返回 `the ruling is already submitted, so submit_ruling is not executed`。

#### Token 影响

该说明为每个架构师请求增加约 140 token，`submit_ruling` schema 约 150 token。worker 会话只承担自己的工具调用与结果。

#### KV Cache 影响

每次咨询都是一个拥有独立前缀的新会话，因此既不复用也不使 worker 已缓存的前缀失效。

### 申诉裁决

#### 模型看到什么

用户裁决申诉后，worker 会话收到一条来源为 `architecture` 的用户消息。维持：`The user upheld Ruling <id> on your appeal <appeal>. Keep following its constraints.` 推翻：该 Ruling 的约束不再具有约束力，worker 在依赖修订后的设计之前应再次咨询。豁免：`limited to: <scope>`，范围之外约束仍然有效。用户说明以 `The user notes: <note>` 附在其后。`adjudicationText()` 生成该文本。

#### Token 影响

每次裁决向 worker 会话增加一条约 30 至 60 token 的消息，另加说明的长度。

#### KV Cache 影响

该消息被 steer 进 worker 的收件箱，追加在可复用前缀之后；不会改变之前的请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包目前不保护或尚未提供的内容。

- **Shell 写入不受守卫**——`bash`、`pwsh`、终端与 `run_code` 仍可修改受保护文件；用户接入 [`scripts/check-architecture.sh`](scripts/check-architecture.sh) 后，它会在提交时或 CI 中拒绝此类修改。
- **只识别内置文件工具**——守卫知道 `write`、`edit` 与 `str_replace_editor` 的参数名；其他插件的文件工具不受检查。
- **索引仅在内存中**——来源在 `edit()` 之外改变时不会自动重建，重启后也会丢失。
- **记录是本地文件**——Ruling、申诉与接受记录是主 worktree 本地目录下的 JSON 文件；是否纳入版本控制由用户决定，不同克隆中写入的记录不会合并。
- **实验原型，无稳定性承诺**——孵化期间约定仍可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

本包承载架构 agent 的里程碑 1 至 3。后台提案与活动视图是剩余的拟议工作。

</details>
