---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-04-architecture-consultation-threads

English | [中文](2026-10-04-architecture-consultation-threads.zh.md)

## Summary

Adds the architecture message source, qualified as attribution-only, and the log-only architecture/consultation event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Both are additive at format 4. Readers preserve an architecture-sourced message and its metadata without the producer; only the architecture service reads the kind, to derive a consultation's pending Ruling id. architecture/consultation is written once at the start of a consultation's architect Session, carries no surfaceOp, and never enters model history. Logs written before this change contain neither.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/architecture packages/experimental/tool-architecture: all tests passed, including a consultation resumed after a timeout from its JSONL-persisted architect Session. pnpm run test:snapshot -t architecture: 4 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
