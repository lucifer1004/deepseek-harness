---
description: "通过带认证的 Web Remote 提供架构仪表盘状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-api-architecture

[English](README.md) | 中文

## 概述

`architecture` Remote 将浏览器仪表盘连接至某个工作区的 `ctx.architecture`，用于读取和跟随快照、读取章节文本、接受章节，以及记录申诉裁决。

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

与[架构服务](../architecture/README.zh.md)、工作区注册表和 Typert 组合；[Profile Bundle](../architecture-profile/README.zh.md)会添加这一行。每个方法都接收 `WorkspaceId`，由 Host 解析为工作区目录，因此浏览器从不发送路径。

`snapshot(workspaceId)` 返回一个 `ArchitectureSnapshot`。`follow(workspaceId)` 立即流出一个快照，并在该仓库每次发生 `architecture/changed` 事件后再流出一个。`section({ workspaceId, path, anchor })` 返回章节的哈希和文本。`accept({ workspaceId, path, anchor, hash })` 按审阅时的哈希记录 `Acceptance`。`adjudicate({ workspaceId, appealId, adjudication })` 裁决待处理的申诉，并把裁决送达工作 Session。`setMainBranch({ workspaceId, branch })` 在仓库的 manifest 中声明主分支并返回 manifest 路径；从链接 checkout 调用或名称不是本地分支而被拒绝时，以 `architecture/failed` 失败，原因为拒绝的描述。

未知工作区以 `architecture/workspace-not-found` 失败。服务失败（例如 manifest 无效或哈希过期）以 `architecture/failed` 及其原因失败。客户端取消作为取消传播。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

控制器不持有状态；服务拥有记录和变更事件。`follow` 把读取快照期间到达的事件合并为一次额外读取，并在第一个快照给出仓库根目录后忽略其他仓库的事件。本包不发布 runtime invariant companion：控制器不持有可被独立观察反驳的状态。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[架构 Agent 子系统](../../../docs/subsystems/architecture-agent.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为控制器本身不向模型请求添加任何内容。`adjudicate` 通过服务把裁决送达工作 Session，详见[服务 README](../architecture/README.zh.md#model-experience)。

#### KV 缓存影响

没有直接影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仪表盘在每次变更时读取完整快照。大型索引每次都会发送全部章节；没有增量更新。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
