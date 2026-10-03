---
description: "Show a Workspace's architecture record, Rulings, appeals, and local entries in a Web dashboard."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-architecture

English | [中文](README.zh.md)

## Summary

This browser plugin adds an Architecture page to the sidebar. It shows the selected Workspace's indexed sources and sections, the Rulings workers received, pending and decided appeals, and files under the local architecture directory. It updates live. Discuss architecture opens a new Session on the `architect` preset.

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

The [profile bundle](../architecture-profile/README.md) adds this row beside the [architecture Remote](../api-architecture/README.md), which the plugin mounts when it loads. The page follows the first Workspace until the user picks another from the Workspace menu.

The Architecture view groups sources by directory, all open for up to 12 sources and closed beyond; a source shows its section count and, unless committed, its git status. A search over paths and section titles opens what it matches, showing every section of a source whose path matches and only the matching sections otherwise, and Uncommitted narrows the list to sources that are not committed. Expanding a source lists its sections, and selecting a section opens its text. A section whose source is not committed offers Accept this content, which records the reviewed hash so Rulings may cite it. The Consultations view lists Rulings collapsed to one line: the question, the status, whether a cited section changed since issue, and the number of constraints, unresolved points, and proposed edits. An opened Ruling shows its summary, constraints with citations, and proposed edits, with the unresolved points folded. Each proposed edit shows its rationale; Show changes reads the current section and diffs it against the proposed text, and only then offers Apply and accept, which writes it and accepts the written section, and Apply only, which writes it. A refusal shows its reason. A proposal whose section changed after the architect read it shows Section changed and no actions. The Appeals view shows each appeal's reason and evidence, with decided appeals collapsed; a pending appeal takes Uphold, Overturn, or Grant exception with a scope, plus an optional note. The Local entries view lists files under the local directory with their git status.

The Settings view has two groups. **This repository** picks the main branch from the repository's local branches or jj bookmarks, marking the ones the primary checkout is on, plus the declared one; Write rewrites the manifest's `mainBranch` at once in the primary checkout, and the change takes effect for others once the user commits it. A refusal shows its reason under the control. **All repositories** stages the architect model and its reasoning effort from the Host model catalog, or Use the consulting session's model, and Save writes all three fields to the `architecture` entry of the profile. The same model field is the configuration page of the bundle's `architecture` row on the Plugins page.

A read failure keeps the last snapshot and shows the error above it. A failed acceptance, decision, Session opening, branch write, or model save shows a notice beside its control.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`createDashboardSource` owns one reconnecting `follow` stream and replaces it when the Workspace changes. Discuss creates a Session in the Workspace, selects the `architect` preset through `remote.agentPresets.select`, and opens it; it does not seed a message. `createArchitectModelForm` binds `ctx.configForms.get('architecture')` and `remote.session.modelCatalog`, stages one route at a time, and writes the provider, model, and effort in one `mutate` so a saved value always names one catalog route; the dashboard view and the `plugins.row.config` entry keyed `@deepseek-ai/dsh-experimental-architecture-profile#architecture` share it. Without the settings client, only the repository group renders. The page composes the shared Client primitives: `SegmentedTabs`, `DisclosureRow`, `Menu`, `SegmentedControl`, `PathLabel`, `Tag`, `Input`, `Button`, and `MarkdownText`, and uses native selects styled like the Models settings page's; times use `relativeTime` in the Workspace sidebar's wording. Copy lives in the `architecture` locale namespace. No runtime invariant companion is published because the plugin holds only the Remote stream, the settings form, and their derived stores.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Architecture agent subsystem](../../../docs/subsystems/architecture-agent.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the dashboard adds nothing to model requests itself. Decisions and acceptances go through the [architecture Remote](../api-architecture/README.md); the [service README](../architecture/README.md#model-experience) describes their model-visible effects.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The page has no search or filter over sections or Rulings.
- Background proposals and a live Activity view of worker Sessions are not implemented.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
