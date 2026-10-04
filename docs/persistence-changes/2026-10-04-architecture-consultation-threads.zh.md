---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-04-architecture-consultation-threads

[English](2026-10-04-architecture-consultation-threads.md) | 中文

## 概述

新增按仅归属来源限定的 architecture 消息来源，以及仅写入日志的 architecture/consultation 事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-04-architecture-consultation-threads
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "10778259058757ff9f13490713559813f82bf4e329b60857abf72c9e387988c4"
    decision: same-version
  - root: "event:architecture/consultation"
    previous: null
    after: "1afc132ab7b633cddd8444195792cc157648aa8374052701c13d6cecd0ef9d84"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "fa4155a418cc65f08fa109c8097992f7c7f2c0440567b5bfe050bd61433bbd49"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "f81fe10a8466167f2a32f3c51562a91fbf4153f5fa99f011688e609fd07acef5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "4a3e4ac79604f3726a265de8359f0c4147239cc589497a909e5e2d9153e82c17"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两者都是格式 4 下的增量变更。读取方在没有生产者时也会保留 architecture 来源的消息及其元数据；只有架构服务读取该种类，用于推导咨询的待定 Ruling id。architecture/consultation 在咨询的架构师会话开始时写入一次，不带 surfaceOp，也从不进入模型历史。此变更之前写入的日志两者都不包含。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/architecture packages/experimental/tool-architecture：全部测试通过，其中包括从 JSONL 持久化的架构师会话在超时后恢复咨询。pnpm run test:snapshot -t architecture：4 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
