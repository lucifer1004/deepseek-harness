---
description: "让 worker agent 通过 consult_architect 向架构 agent 咨询，并为架构师提供列出、读取与编辑架构记录的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-architecture

[English](README.md) | 中文

## 概述

本包把 [`@deepseek-ai/dsh-experimental-architecture`](../architecture/README.zh.md) 暴露给模型。根入口为 worker agent 提供 `consult_architect`：它向架构师提出设计问题，并返回一份由约束性要求与非约束性未决点组成的 Ruling；以及 `appeal_ruling`：请用户就某条约束作出裁决。`./architect` 入口为架构师 agent 提供 `architecture_index`、`architecture_read` 与 `architecture_edit`，使 Architecture Session 能与你讨论架构记录，并写入你同意的修改。本包是实验性的，没有稳定性承诺。

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

在 worker agent 获得工具的位置挂载根入口，在架构师 preset 内挂载 `./architect` 入口。[架构 profile bundle](../architecture-profile/README.zh.md) 会同时完成两者。

### 何时选择

当 agent 应在修改代码前对照已提交的架构记录检查设计决定，并且你需要一个维护该记录而不编辑代码的会话时，选择本包。没有它时，架构服务只守护架构记录，没有模型能咨询或编辑它。

### 最小可用示例

```yaml
- id: tool-architecture
  name: '@deepseek-ai/dsh-experimental-tool-architecture'

- id: preset-architect
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: architect
    plugins:
      - id: tool-architecture-architect
        name: '@deepseek-ai/dsh-experimental-tool-architecture/architect'
```

两个入口都注入 `architecture`、`tools` 与 `systemPrompt`。服务的 `architectTools` 默认列出这些架构师工具名；省略其中某个的列表会对架构师隐藏该工具并拒绝其调用。

### 成功与失败的表现

`consult_architect` 返回 `status: 'ruling'`，附带摘要、带已校验引用的约束、未决点，以及列出裁定提议改写的每个章节及其理由的 `proposedEdits`；或返回不含约束的 `status: 'timeout'` 或 `'no-submission'`。空问题、没有 agent 的调用、没有工作目录的会话，以及没有 manifest 的仓库都会使调用失败。`appeal_ruling` 返回申诉 id；理由为空、Ruling 没有记录或 Ruling 发给了其他会话时失败。对没有 manifest 的工作区，`architecture_index` 返回 `hasManifest: false`，并渲染为 `COLD_START_GUIDANCE`：调查代码与现有文档，提出一份声明 checkout 当前分支的 manifest 和一份精简的首个文档，在用户同意后写入它们。该值的 `checkout` 给出版本控制系统、该 checkout 是否为主 checkout，以及它当前所在的分支或书签，渲染时列在指引之后。位于 git 或 jj checkout 之外的会话既看不到 worker 工具，也看不到 worker 指引。引用不是 `path#anchor` 或不对应任何已索引章节时，`architecture_read` 失败。服务拒绝编辑时（包括 `expectedHash` 已过期），`architecture_edit` 以 `architecture_edit refused: <reason>` 失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个工具从调用方 agent 的会话头读取工作目录并委托给 `ctx.architecture`；校验、引用检查与编辑规则都在服务中。`architecture_index` 每次调用都重建索引，因此能反映 `architecture_edit` 之外的编辑。`architecture_edit` 在调用服务前拒绝没有 `anchor` 的 `expectedHash`。根入口在注册表的 `tools/result` 事件报告 `consult_architect` 成功结果之后写入 Ruling 记录，因此仪表盘不会列出 worker 未收到的 Ruling；记录写入失败会被记入日志，不改变结果。本包不发布 runtime invariant companion：除注册项与等待结果的 Ruling 外，本包不持有任何状态。

| 源码 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | `consult_architect`、`appeal_ruling`、worker 指引、Ruling 渲染与 Ruling 记录 |
| [src/architect.ts](src/architect.ts) | `architecture_index`、`architecture_read`、`architecture_edit` 与架构师指引 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [架构服务](../architecture/README.zh.md)——索引、编辑规则、咨询与引用检查。
- [架构 profile bundle](../architecture-profile/README.zh.md)——挂载两个入口的组合。
- [架构 agent Agent Note](../../../.agents/notes/proposed/feature/2026-09-29-architecture-agent.zh.md)——本包实现的设计。

-----

<a id="model-experience"></a>
## 模型体验

### Worker 与架构师工具

#### 模型看到什么

worker 看到 `consult_architect(question, scope?)` 和一段导出为 `WORKER_POLICY` 的指引：在转移职责、修改公共接口或数据格式、引入依赖或模式之前进行咨询，约束具有约束力而未决点没有；当某条约束对本次修改不正确时，带着具体证据调用 `appeal_ruling(rulingId, reason, evidence?)`。申诉结果为 `Appeal <id> filed against Ruling <id>. The Ruling stays binding until the user decides; the decision arrives as a message.`结果文本以 `Ruling <id>: <summary>` 开头，随后列出带 `path#anchor` 引用的 `Binding constraints:`，以及带原因的 `Unresolved, not binding:`。架构师看到三个架构工具和一段导出为 `ARCHITECT_POLICY` 的指引：不修改代码，只在用户同意后编辑，并为每条要求引用章节。

#### Token 影响

worker 指引为每个 worker 请求增加约 170 token，`consult_architect` 与 `appeal_ruling` schema 约 230 token。一次申诉结果约 40 token。一份 Ruling 结果约 20 token 加上其陈述与引用；有修改提议时再加约 40 token 及每条提议的章节与理由，提议文本本身不进入 worker 的上下文。架构师指引为每个架构师请求增加约 200 token，三个 schema 约 400 token；在 dsh 仓库上，`architecture_index` 列出约 2,400 个章节。

#### KV Cache 影响

指引与 schema 是挂载时注册的固定文本，因此留在可复用前缀中。工具结果追加在其后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **索引列表不分页**——不带 `path` 的 `architecture_index` 返回所有章节，对大型记录而言很大。
- **由 worker 决定何时咨询**——没有在修改前自动咨询的钩子。
- **实验原型，无稳定性承诺**——孵化期间工具名、schema 与文本仍可变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
