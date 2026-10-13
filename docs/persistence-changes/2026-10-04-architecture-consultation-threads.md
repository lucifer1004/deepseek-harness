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
    previous: "2026-10-05-working-directory-attribution"
    after: "c74b83e6a9710b7731cbb0c997729cf7d039f1d7e43b1a03a670b2126981f760"
    decision: same-version
  - root: "event:architecture/consultation"
    previous: null
    after: "1afc132ab7b633cddd8444195792cc157648aa8374052701c13d6cecd0ef9d84"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "3cff684ef29fddec2c0edac0b6c0f550a582d45114dfbe8fe3bdeec778e0c013"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "66a1eb86e7fe32433a76638b75e7aaf067626ffed70c4a475a9553a8e34413e9"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "df1d20ce54bdd64db9942bd3269a6ecb82fa7a768d18b2186304aa5cc165595d"
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
