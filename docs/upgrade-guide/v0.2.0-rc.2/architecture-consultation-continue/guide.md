---
kind: upgrade-guide
description: "The experimental consult_architect tool result gains a required consultation field, and its architect Session logs new architecture-sourced messages and an architecture/consultation event."
---
# `consult_architect` results name a consultation that can be continued

English | [中文](guide.zh.md)

## Change

This affects deployments that load the experimental [architecture packages](../../../../packages/experimental/architecture/README.md), and code that reads `consult_architect` results.

Before, a `consult_architect` value had `status`, `rulingId`, the constraints, unresolved points, and proposed edits, and every call started a new architect. Now the value also carries a required `consultation`: the id of the architect Session. The tool takes an optional `continue` parameter that names a consultation, and the service resumes that architect Session for another turn. Only the worker Session that started a consultation may continue it, and it may continue it any number of times. A timeout or a turn without a submission keeps its Ruling id, and the next submission in the consultation issues under it.

The architect Session's question messages now have the source `{ kind: 'architecture', rulingId }` instead of `{ kind: 'user' }`, so it gets no title from the question. The Session also starts with a log-only `architecture/consultation` event. The [persistence record](../../../persistence-changes/2026-10-04-architecture-consultation-threads.md) acknowledges both as additive changes at format 4.

## Migration

1. Code that builds or checks a `consult_architect` value, such as a PTC script or a test fixture, adds `consultation`; `consultValue()` in `@deepseek-ai/dsh-experimental-tool-architecture` sets it.
2. Code that reads an architect Session and expects the question to have source `user` reads `source.kind === 'architecture'` with `rulingId` instead.
3. To confirm, call `consult_architect`, then call it again with `continue` set to the returned `consultation`: the second result names the same consultation.
