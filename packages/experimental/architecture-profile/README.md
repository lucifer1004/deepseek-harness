---
description: "Add the architecture service, the consult_architect tool, and an architect preset for Architecture Sessions with one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-architecture-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-architecture-profile` adds the [architecture agent](../architecture/README.md) to a Web profile in one layer. Worker agents gain `consult_architect` and `appeal_ruling`, the sidebar gains an **Architecture** dashboard, and the preset selector gains **Architect**, a Session that reads code and the web, discusses the architecture record with you, and edits only that record. Built-in file tools in every Session stop writing architecture sources. You name the main branch in your profile patch; the bundle does not guess it.

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

### Install into a profile

Add the bundle after `@deepseek-ai/dsh-web-app` in a Web profile's `dsh.profile.bundles`. Each repository names its main branch in its `architecture.yml`, so one profile serves repositories on different branches; to give every manifest without one a default, set it in the profile's `cordis.patch.yml`:

```yaml
- id: architecture
  config:
    mainBranch: main
```

Commit an `architecture.yml` manifest at the repository root, as the [service README](../architecture/README.md#use-this-package) describes. Start an **Architect** Session from the repository's primary worktree on the main branch to create or change the record; its edits appear as uncommitted changes for you to review and commit.

### What you get

The layer inserts the `architecture` service, the worker `consult_architect` and `appeal_ruling` tools, the [architecture Remote](../api-architecture/README.md) and [dashboard](../client-ui-architecture/README.md), and an `architect` preset. The preset mounts persona, agent instructions, `read`/`glob`/`grep`, `web_search`/`web_fetch`, Session query tools, `ask_user_question`, `todo_write`, and the three architect tools. The service shows an `architect` agent only its `architectTools`, so the preset's `write` and `edit` and the Host worker tools stay out of its tool list. The `architecture` row carries no config: a profile patch replaces a row's whole `config`, so the profile sets `mainBranch` and the service defaults supply the rest.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). The `architect` preset mounts `tool-fs` whole because the package has no read-only entry, and the service's architect guard denies its write tools. The service config omits `mainBranch`, so a profile that forgets it fails at load.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Service, worker tools, dashboard Remote and UI, and `architect` preset rows |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| — | No runtime invariant companion is published; the package carries only a static profile patch. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Architecture service](../architecture/README.md) — index, edit rule, consultation, and citation checks.
- [Architecture tools](../tool-architecture/README.md) — the worker and architect tool surfaces.
- [Web app bundle](../../bundle/web-app/README.md) — the per-preset composition this layer follows.

-----

<a id="model-experience"></a>
## Model Experience

### Architect preset and consultation

#### What the model sees

Worker and architect prompts, schemas, and results belong to [`@deepseek-ai/dsh-experimental-tool-architecture`](../tool-architecture/README.md) and the [service](../architecture/README.md#model-experience). The `architect` preset's persona opens with `You are the architecture agent for this workspace, powered by the {{model}} model.` and ends with `Your working directory is {{cwd}}.`.

#### Token effect

The bundle adds the persona lines, about 25 tokens, to architect requests; the tool packages own the rest.

#### KV Cache effect

The preset's composition is fixed while its patch is unchanged, so its prefix is stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — no shipped profile enables the bundle.
- **Web profile required** — the rows follow `dsh-web-app`'s per-preset tool composition; other profiles are not tested.
- **Worker presets are unchanged** — `consult_architect` and `appeal_ruling` are host rows; a preset that restricts its tools must allow them explicitly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
