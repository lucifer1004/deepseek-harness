/**
 * The architect-model form over the `architecture` entry's live configuration: the provider, model, and reasoning
 * effort a consultation's architect runs on. The three fields are chosen together from the model catalog and saved in
 * one mutation, so a saved value always names one catalog route; clearing them returns the architect to the
 * consulting worker's model.
 */
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalog, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Namespace of the architecture service's settings: its profile entry id. */
export const ARCHITECTURE_NS = 'architecture'

/** The architecture service fields this form edits. */
export interface ArchitectModelSettings {
  readonly architectProvider?: string
  readonly architectModel?: string
  readonly architectReasoningEffort?: string
}

/** One architect model route: a provider, a model, and an optional reasoning effort. */
export interface ArchitectModelChoice {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** What the architect-model form renders. */
export interface ArchitectModelState {
  /** False while the Host does not serve the namespace; the form renders nothing. */
  readonly available: boolean
  /** Whether the Host document accepts writes. */
  readonly writable: boolean
  /** The saved route, or undefined when the architect runs on the worker's model. */
  readonly saved: ArchitectModelChoice | undefined
  /** The staged route: undefined for no edit, null for a staged clear. */
  readonly draft: ArchitectModelChoice | null | undefined
  /** Catalog routes the user may pick from. */
  readonly groups: readonly ModelProviderGroup[]
  readonly catalog: 'loading' | 'ready' | 'error'
  readonly saving: boolean
  /** Whether the last save did not land. */
  readonly failed: boolean
}

/** The form's observable state and staged actions. */
export interface ArchitectModelForm {
  readonly state: SnapshotStore<ArchitectModelState>
  /** Stage a route, or null to stage the return to the worker's model. */
  readonly stage: (choice: ArchitectModelChoice | null) => void
  /** Write the staged route in one mutation. */
  readonly save: () => Promise<void>
  /** Drop the staged route. */
  readonly discard: () => void
  /** Load the model catalog when it is not loaded. */
  readonly load: () => void
  /** Release the configuration subscription. */
  readonly dispose: () => void
}

function savedChoice(value: ArchitectModelSettings | undefined): ArchitectModelChoice | undefined {
  if (value?.architectProvider === undefined || value.architectModel === undefined) return undefined
  return {
    provider: value.architectProvider,
    model: value.architectModel,
    ...value.architectReasoningEffort === undefined ? {} : { reasoningEffort: value.architectReasoningEffort },
  }
}

const FIELDS = ['architectProvider', 'architectModel', 'architectReasoningEffort'] as const

/**
 * Bind the architect-model form to the `architecture` namespace and the Host model catalog.
 * @param scope - the `architecture` configuration form.
 * @param loadCatalog - reads the Host model catalog.
 * @returns the form.
 */
export function createArchitectModelForm(
  scope: ConfigForm<ArchitectModelSettings>,
  loadCatalog: () => Promise<RemoteResult<ModelCatalog>>,
): ArchitectModelForm {
  let draft: ArchitectModelChoice | null | undefined
  let groups: readonly ModelProviderGroup[] = []
  let catalog: ArchitectModelState['catalog'] = 'loading'
  let loading = false
  let saving = false
  let failed = false
  const project = (): ArchitectModelState => {
    const snapshot = scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      saved: savedChoice(snapshot.value),
      draft,
      groups,
      catalog,
      saving,
      failed,
    }
  }
  const state = createSnapshotStore(project())
  const publish = (): void => { state.set(project()) }
  const unsubscribe = scope.subscribe(publish)
  return {
    state,
    stage: (choice) => {
      draft = choice
      failed = false
      publish()
    },
    save: async () => {
      if (draft === undefined || saving) return
      const next = draft
      saving = true
      failed = false
      publish()
      const values: Record<(typeof FIELDS)[number], string | undefined> = {
        architectProvider: next?.provider,
        architectModel: next?.model,
        architectReasoningEffort: next?.reasoningEffort,
      }
      try {
        const landed = await scope.mutate(FIELDS.map((field) => {
          const value = values[field]
          return value === undefined ? { op: 'unset' as const, path: [field] } : { op: 'set' as const, path: [field], value }
        }))
        if (landed) draft = undefined
        failed = !landed
      } catch (_error) {
        // mutate rejected on transport: the draft stays so the user can save again.
        failed = true
      } finally {
        saving = false
        publish()
      }
    },
    discard: () => {
      if (draft === undefined && !failed) return
      draft = undefined
      failed = false
      publish()
    },
    load: () => {
      if (loading || catalog === 'ready') return
      loading = true
      catalog = 'loading'
      publish()
      void loadCatalog().then((response) => {
        loading = false
        if (response.ok) {
          groups = response.value.groups
          catalog = 'ready'
        } else {
          catalog = 'error'
        }
        publish()
      })
    },
    dispose: unsubscribe,
  }
}
