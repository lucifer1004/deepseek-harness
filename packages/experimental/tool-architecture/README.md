---
description: "Let worker agents consult the architecture agent through consult_architect, and give the architect tools to list, read, and edit the architecture record."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-architecture

English | [中文](README.zh.md)

## Summary

This package puts [`@deepseek-ai/dsh-experimental-architecture`](../architecture/README.md) in front of models. Its root entry gives worker agents `consult_architect`, which asks the architect a design question and returns a Ruling of binding constraints and non-binding unresolved points, and `appeal_ruling`, which asks the user to decide against a constraint. Its `./architect` entry gives the architect agent `architecture_index`, `architecture_read`, and `architecture_edit`, so an Architecture Session can discuss the record with you and write the change you agree to. The package is experimental and has no stability promise.

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

Mount the root entry where worker agents get their tools and the `./architect` entry inside the architect preset. The [architecture profile bundle](../architecture-profile/README.md) does both.

### When to choose it

Choose it when agents should check design decisions against a committed architecture record before changing code, and when you want a Session that maintains that record without editing code. Without it, the architecture service only guards the record and no model can consult or edit it.

### Smallest working example

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

Both entries inject `architecture`, `tools`, and `systemPrompt`. The service's `architectTools` lists the architect tool names by default; a list that omits one hides that tool from the architect and denies its calls.

### What success and failure look like

`consult_architect` returns `status: 'ruling'` with a summary, constraints with their verified citations, and unresolved points, or `status: 'timeout'` or `'no-submission'` with no constraints. An empty question, a call without an agent, a Session without a working directory, and a repository without a manifest fail the call. `appeal_ruling` returns the appeal id, and fails for an empty reason, a Ruling with no record, or a Ruling issued to another Session. `architecture_index` returns `hasManifest: false` for a workspace without a manifest. `architecture_read` fails for a citation that is not `path#anchor` or names no indexed section. `architecture_edit` fails with `architecture_edit refused: <reason>` when the service refuses the edit, including a stale `expectedHash`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every tool reads the working directory from the calling agent's Session header and delegates to `ctx.architecture`; validation, citation checks, and the edit rule live in the service. `architecture_index` rebuilds the index on each call, so it reflects edits made outside `architecture_edit`. `architecture_edit` rejects `expectedHash` without `anchor` before calling the service. The root entry writes the Ruling record after the registry's `tools/result` event reports a successful `consult_architect` result, so the dashboard never lists a Ruling the worker did not receive; a failed record write is logged and does not change the result. No runtime invariant companion is published: the package holds no state beyond its registrations and the Rulings awaiting their result.

| Source | Responsibility |
|---|---|
| [src/index.ts](src/index.ts) | `consult_architect`, `appeal_ruling`, worker guidance, Ruling rendering, and Ruling records |
| [src/architect.ts](src/architect.ts) | `architecture_index`, `architecture_read`, `architecture_edit`, and architect guidance |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Architecture service](../architecture/README.md) — index, edit rule, consultation, and citation checks.
- [Architecture profile bundle](../architecture-profile/README.md) — the composition that mounts both entries.
- [Architecture agent Agent Note](../../../.agents/notes/proposed/feature/2026-09-29-architecture-agent.md) — the design this package implements.

-----

<a id="model-experience"></a>
## Model Experience

### Worker and architect tools

#### What the model sees

A worker sees `consult_architect(question, scope?)` and a guidance section, exported as `WORKER_POLICY`, telling it to consult before moving responsibilities, changing a public interface or data format, or adding a dependency or pattern, that constraints bind while unresolved points do not, and to call `appeal_ruling(rulingId, reason, evidence?)` with concrete evidence when a constraint is wrong for the change. An appeal result reads `Appeal <id> filed against Ruling <id>. The Ruling stays binding until the user decides; the decision arrives as a message.` The result text starts `Ruling <id>: <summary>`, then lists `Binding constraints:` with their `path#anchor` citations and `Unresolved, not binding:` with reasons. An architect sees the three architecture tools and a guidance section, exported as `ARCHITECT_POLICY`, telling it not to change code, to edit only after the user agrees, and to cite sections for every requirement.

#### Token effect

The worker guidance adds about 170 tokens and the `consult_architect` and `appeal_ruling` schemas about 230 tokens to every worker request. An appeal result costs about 40 tokens. A Ruling result costs about 20 tokens plus its statements and citations. The architect guidance adds about 200 tokens and the three schemas about 400 tokens to every architect request; `architecture_index` on the dsh repository lists about 2,400 sections.

#### KV Cache effect

Guidance and schemas are fixed text registered at mount, so they stay in the reusable prefix. Tool results append after it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The index listing is not paginated** — `architecture_index` without `path` returns every section, which is large for a big record.
- **The worker decides when to consult** — no hook consults automatically before a change.
- **Experimental prototype with no stability promise** — tool names, schemas, and texts can change while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
