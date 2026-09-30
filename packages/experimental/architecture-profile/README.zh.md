---
description: "用一个实验 bundle 加入架构服务、consult_architect 工具以及用于 Architecture Session 的 architect preset。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-architecture-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-architecture-profile` 用一层把[架构 agent](../architecture/README.zh.md) 加入 Web profile。worker agent 获得 `consult_architect` 与 `appeal_ruling`，侧边栏获得**架构**仪表盘，preset 选择器获得 **Architect**：这种会话读取代码与网络，与你讨论架构记录，并且只编辑该记录。每个会话中的内置文件工具都不再能写架构来源。主分支由你在 profile patch 中指定；bundle 不会猜测它。

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

### 安装到 profile

在 Web profile 的 `dsh.profile.bundles` 中把本 bundle 加在 `@deepseek-ai/dsh-web-app` 之后。每个仓库在自己的 `architecture.yml` 中声明主分支，因此一个 profile 可以服务主分支不同的多个仓库；如需为未声明主分支的 manifest 提供默认值，在该 profile 的 `cordis.patch.yml` 中设置：

```yaml
- id: architecture
  config:
    mainBranch: main
```

按照[服务 README](../architecture/README.zh.md#use-this-package) 的说明，在仓库根目录提交 `architecture.yml` manifest。在主分支上的仓库主 worktree 中启动 **Architect** 会话来创建或修改记录；它的编辑以未提交修改的形式出现，由你审阅并提交。

### 你会得到什么

这一层插入 `architecture` 服务、worker 的 `consult_architect` 与 `appeal_ruling` 工具、[架构 Remote](../api-architecture/README.zh.md) 与[仪表盘](../client-ui-architecture/README.zh.md)，以及 `architect` preset。该 preset 挂载 persona、agent 指令、`read`/`glob`/`grep`、`web_search`/`web_fetch`、会话查询工具、`ask_user_question`、`todo_write` 以及三个架构师工具。服务只向 `architect` agent 展示其 `architectTools`，因此 preset 的 `write`、`edit` 与 Host 上的 worker 工具都不在它的工具列表中。`architecture` 这一行不带 config：profile patch 会替换一行的整个 `config`，所以由 profile 设置 `mainBranch`，其余字段取服务默认值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。`architect` preset 完整挂载 `tool-fs`，因为该包没有只读入口，服务的架构师守卫会拒绝其写入工具。服务配置不含 `mainBranch`，因此遗漏它的 profile 会在加载时失败。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 服务、worker 工具、仪表盘 Remote 与 UI，以及 `architect` preset 行 |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |
| — | 本包不发布 runtime invariant companion：本包只携带静态 profile patch。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [架构服务](../architecture/README.zh.md)——索引、编辑规则、咨询与引用检查。
- [架构工具](../tool-architecture/README.zh.md)——worker 与架构师的工具集合。
- [Web app bundle](../../bundle/web-app/README.zh.md)——本层遵循的按 preset 组合方式。

-----

<a id="model-experience"></a>
## 模型体验

### Architect preset 与咨询

#### 模型看到什么

worker 与架构师的提示词、schema 和结果归 [`@deepseek-ai/dsh-experimental-tool-architecture`](../tool-architecture/README.zh.md) 与[服务](../architecture/README.zh.md#model-experience)所有。`architect` preset 的 persona 以 `You are the architecture agent for this workspace, powered by the {{model}} model.` 开头，以 `Your working directory is {{cwd}}.` 结尾。

#### Token 影响

本 bundle 为架构师请求增加 persona 两行，约 25 token；其余由工具包负责。

#### KV Cache 影响

patch 不变时 preset 的组合固定，因此其前缀稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅按需启用**——没有已发布的 profile 启用本 bundle。
- **需要 Web profile**——这些行遵循 `dsh-web-app` 的按 preset 工具组合；其他 profile 未经测试。
- **worker preset 不变**——`consult_architect` 与 `appeal_ruling` 是 host 行；限制自身工具的 preset 必须显式允许它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
