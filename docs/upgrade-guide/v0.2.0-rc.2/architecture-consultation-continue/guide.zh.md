---
kind: upgrade-guide
description: "实验性的 consult_architect 工具结果新增必填的 consultation 字段，其架构师会话记录新的 architecture 来源消息和 architecture/consultation 事件。"
---
# `consult_architect` 结果给出可以接续的咨询

[English](guide.md) | 中文

## 变更

这会影响加载了实验性[架构包](../../../../packages/experimental/architecture/README.zh.md)的部署，以及读取 `consult_architect` 结果的代码。

之前，`consult_architect` 的值包含 `status`、`rulingId`、约束、未决点和修改提议，每次调用都会新建一个架构师。现在该值还带有必填的 `consultation`，即架构师会话的 id。工具新增可选参数 `continue`，用来指定一次咨询，服务会为新的一轮恢复那个架构师会话。只有发起咨询的 worker 会话可以接续它，次数不限。超时或未提交的一轮保留其 Ruling id，这次咨询中的下一次提交以该 id 发布。

架构师会话中的问题消息来源由 `{ kind: 'user' }` 改为 `{ kind: 'architecture', rulingId }`，因此会话不再根据问题得到标题。会话开头还会写入一条仅记录在日志中的 `architecture/consultation` 事件。[持久化记录](../../../persistence-changes/2026-10-04-architecture-consultation-threads.zh.md)把两者确认为格式 4 下的增量变更。

## 迁移

1. 构造或检查 `consult_architect` 值的代码（例如 PTC 脚本或测试夹具）补上 `consultation`；`@deepseek-ai/dsh-experimental-tool-architecture` 的 `consultValue()` 会设置它。
2. 读取架构师会话并假定问题来源为 `user` 的代码，改为读取带 `rulingId` 的 `source.kind === 'architecture'`。
3. 确认方法：调用 `consult_architect`，再以返回的 `consultation` 作为 `continue` 调用一次，第二次结果给出同一个咨询。
