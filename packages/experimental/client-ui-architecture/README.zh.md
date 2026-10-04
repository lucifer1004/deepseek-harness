---
description: "在 Web 仪表盘中展示工作区的架构记录、裁定、申诉和本地条目。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-architecture

[English](README.md) | 中文

## 概述

这个浏览器插件在侧边栏中添加“架构”页面，展示所选工作区的已索引来源与章节、工作 Agent 收到的裁定、待处理和已裁决的申诉，以及本地架构目录下的文件。页面实时更新。“讨论架构”以 `architect` 预设开启新 Session。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

[Profile Bundle](../architecture-profile/README.zh.md)在[架构 Remote](../api-architecture/README.zh.md)旁添加这一行，插件加载时挂载该 Remote。页面默认跟随第一个工作区，直到用户从工作区菜单选择另一个。在主视图显示某个会话时打开页面，会切换到包含该会话的工作区；页面保持打开期间用户的选择不会被覆盖。

“架构”视图按目录分组列出来源，来源不超过 12 个时目录全部展开，超过则全部收起；每个来源显示章节数，未提交的还显示其 git 状态。可按路径和章节标题搜索，搜索会展开匹配项：路径匹配的来源显示全部章节，否则只显示匹配的章节；“未提交”只列出未提交的来源。展开来源会列出其章节，选择章节会打开其文本。来源未提交的章节提供“接受此内容”，记录审阅时的哈希，使裁定可以引用它。“咨询”标签显示仍可应用的修改提议数。该视图顶部是“待处理”：这些提议按要改写的章节分组，每条以其裁定的短编号和问题为标题，同一章节的多个方案会标明只能应用其中一个。下面的“全部裁定”列出每个裁定，可按问题、裁定编号或裁定引用、提议修改的章节筛选。该视图把每个裁定折叠为一行：问题、worker 称呼裁定时用的编号首段、状态、引用章节在发布后是否变化、约束与未决点的数量，以及待处理提议数；提议都已应用或不采用时显示“提议已全部处理”，没有可应用的提议时显示提议总数。展开后显示摘要、带引用的约束和修改提议，未决点默认折叠。每条修改提议显示其理由；“查看改动”读取当前章节并与提议文本对比，之后才提供“应用并接受”（写入并接受写入后的章节）和“仅应用”（只写入）。“不采用”记录用户不会应用该提议，并把它移出“待处理”。被拒绝时显示原因。提议都已应用或不采用的裁定显示“提议已全部处理”。架构师读取之后章节已变化的提议显示“章节已变化”，不提供操作。“申诉”视图展示每个申诉的理由和证据，已裁决的申诉默认折叠；待处理的申诉可以维持、推翻或按范围授予豁免，并可附加说明。“本地条目”视图列出本地目录下的文件及其 git 状态。

“设置”视图分两组。**本仓库**从仓库的本地分支或 jj 书签以及已声明的分支中选择主分支，并标出主 checkout 当前所在的那些；“写入”立即在主 checkout 中改写 manifest 的 `mainBranch`，用户提交后才对其他人生效。被拒绝时控件下方显示原因。**全局**从 Host 模型列表中暂存架构师模型及其推理强度，或选择“沿用工作会话的模型”，“保存”把三个字段写入 profile 的 `architecture` 条目。同一模型字段也是 Plugins 页面上该 bundle 的 `architecture` 行的配置页。

读取失败时保留上一个快照，并在其上方显示错误。接受、裁决、开启 Session、写入分支或保存模型失败时，在对应控件旁显示提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`createDashboardSource` 持有一个可重连的 `follow` 流，并在工作区变化时替换它。“讨论架构”在工作区中创建 Session，通过 `remote.agentPresets.select` 选择 `architect` 预设并打开它；它不预填消息。`createArchitectModelForm` 绑定 `ctx.configForms.get('architecture')` 与 `remote.session.modelCatalog`，每次暂存一个路由，并在一次 `mutate` 中写入 provider、模型和推理强度，因此保存的值总是指向一个模型列表中的路由；仪表盘视图与键为 `@deepseek-ai/dsh-experimental-architecture-profile#architecture` 的 `plugins.row.config` 条目共用它。没有设置客户端时只渲染本仓库一组。页面由共享的 Client primitives 组成：`SegmentedTabs`、`DisclosureRow`、`Menu`、`SegmentedControl`、`PathLabel`、`Tag`、`Input`、`Button` 与 `MarkdownText`，并使用样式与 Models 设置页面一致的原生 select；时间通过 `relativeTime` 按工作区侧边栏的措辞显示。文案位于 `architecture` locale 命名空间。本包不发布 runtime invariant companion：插件只持有 Remote 流、设置表单及其派生 store。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[架构 Agent 子系统](../../../docs/subsystems/architecture-agent.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为仪表盘本身不向模型请求添加任何内容。裁决与接受经由[架构 Remote](../api-architecture/README.zh.md)；其对模型可见的影响见[服务 README](../architecture/README.zh.md#model-experience)。

#### KV 缓存影响

没有直接影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 页面不提供对章节或裁定的搜索与筛选。
- 后台提案和工作 Session 的实时活动视图尚未实现。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
