---
description: "Serve the architecture dashboard state through the authenticated Web Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-api-architecture

English | [中文](README.zh.md)

## Summary

The `architecture` Remote connects the browser dashboard to `ctx.architecture` for one Workspace. It reads and follows snapshots, reads section text, accepts sections, and records appeal decisions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose with the [architecture service](../architecture/README.md), the Workspace registry, and Typert; the [profile bundle](../architecture-profile/README.md) adds this row. Every method takes a `WorkspaceId`, and the Host resolves it to the Workspace's directory, so the browser never sends a path.

`snapshot(workspaceId)` returns one `ArchitectureSnapshot`. `follow(workspaceId)` streams the last snapshot the service read for that repository first, with `fresh` false, when there is one; then a freshly read one, and another after each `architecture/changed` event for that repository. `section({ workspaceId, path, anchor })` returns a section's hash and text. `accept({ workspaceId, path, anchor, hash })` records an `Acceptance` at the reviewed hash. `adjudicate({ workspaceId, appealId, adjudication })` decides a pending appeal and delivers the decision to the worker Session. `setMainBranch({ workspaceId, branch })` declares the repository's main branch in its manifest and returns the manifest path; a refusal, from a linked checkout or for a name that is no local branch, fails with `architecture/failed` and the refusal's description as its reason. `applyProposedEdit({ workspaceId, rulingId, index, accept })` writes one proposed edit of a recorded Ruling from the primary checkout and returns its path, with the acceptance when `accept` recorded one; a refusal, an unknown Ruling or index, and an edit already applied or dismissed fail with `architecture/failed`. `dismissProposedEdit({ workspaceId, rulingId, index })` marks one proposed edit dismissed in the Ruling record and fails with `architecture/failed` for an unknown Ruling or index or an edit already applied or dismissed.

An unknown Workspace fails with `architecture/workspace-not-found`. A service failure, such as an invalid manifest or a stale hash, fails with `architecture/failed` and its reason. Client cancellation propagates as cancellation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The controller holds no state; the service owns the records and the change event. `follow` coalesces events that arrive while a snapshot is being read into one more read, and it ignores events for other repositories once the first snapshot names the repository root. No runtime invariant companion is published because the controller holds no state an independent observation could contradict.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Architecture agent subsystem](../../../docs/subsystems/architecture-agent.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the controller adds nothing to model requests itself. `adjudicate` delivers the decision to the worker Session through the service, which the [service README](../architecture/README.md#model-experience) describes.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The dashboard reads a whole snapshot on every change. Large indexes send every section each time; there is no incremental update. Each read waits for at least one version-control command, and under Linux user-systemd containment every spawn costs about 300 ms regardless of the command.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
