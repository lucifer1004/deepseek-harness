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

[Profile Bundle](../architecture-profile/README.zh.md)在[架构 Remote](../api-architecture/README.zh.md)旁添加这一行，插件加载时挂载该 Remote。页面默认跟随第一个工作区，直到用户从工作区菜单选择另一个。

“架构”视图列出每个来源及其 git 状态；展开来源会列出其章节，选择章节会打开其文本。来源未提交的章节提供“接受此内容”，记录审阅时的哈希，使裁定可以引用它。“咨询”视图列出裁定及其状态、约束、引用、未决点，以及引用章节在发布后是否变化。“申诉”视图展示每个申诉的理由和证据；待处理的申诉可以维持、推翻或按范围授予豁免，并可附加说明。“本地条目”视图列出本地目录下的文件及其 git 状态。

读取失败时保留上一个快照，并在其上方显示错误。接受、裁决或开启 Session 失败时，在对应控件旁显示提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`createDashboardSource` 持有一个可重连的 `follow` 流，并在工作区变化时替换它。“讨论架构”在工作区中创建 Session，通过 `remote.agentPresets.select` 选择 `architect` 预设并打开它；它不预填消息。页面由共享的 Client primitives 组成：`SegmentedTabs`、`DisclosureRow`、`Menu`、`SegmentedControl`、`PathLabel`、`Tag`、`Input`、`Button` 与 `MarkdownText`；时间通过 `relativeTime` 按工作区侧边栏的措辞显示。文案位于 `architecture` locale 命名空间。本包不发布 runtime invariant companion：插件只持有 Remote 流及其派生 store。

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
