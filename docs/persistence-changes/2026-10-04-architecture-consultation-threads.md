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
    previous: "2026-10-13-user-rpc-principal"
    after: "28a9e537f986c42705cbf3d4c8289a804a8d315746d02caf42e554c30d4e6c94"
    decision: same-version
  - root: "event:architecture/consultation"
    previous: null
    after: "1afc132ab7b633cddd8444195792cc157648aa8374052701c13d6cecd0ef9d84"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "8be6c9ef42c7cd0f63012b866061173e759507d67fd1c95bdf2b4ef3f602878f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "b596f1cdae037035b9e53346ac0819179dfefada5116335cedd694cffba61bba"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "05ca4003b7ccb27ab703bee6e0219e71504ad830b2099db6e7963d3d101e8535"
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
