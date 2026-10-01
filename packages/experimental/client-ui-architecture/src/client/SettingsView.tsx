/**
 * The dashboard's Settings view, in two groups:
 * - **This repository** declares the main branch in the committed manifest, from the primary checkout.
 * - **All repositories** edits the profile's architect model.
 *
 * The branch write is immediate and reports its outcome in place, because the manifest change is itself the result the
 * user reviews and commits. The model form stages a choice and saves it like every settings page.
 */
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchitectureSnapshot } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArchitectModelChoice, ArchitectModelForm, ArchitectModelState } from './architect-model.ts'
import type { ArchitectureKey } from './locales.ts'
import css from './SettingsView.module.css'

/** The dashboard's translate function. */
export type Translate = (key: ArchitectureKey, vars?: Record<string, string>) => string

/** Outcome of the last main-branch write. */
type BranchOutcome = { readonly kind: 'written' } | { readonly kind: 'failed'; readonly message: string }

/** Props of the Settings view. */
export interface SettingsViewProps {
  readonly workspaceId: WorkspaceId
  readonly snapshot: ArchitectureSnapshot
  /** Declare the main branch; resolves to the failure message, or undefined when the manifest was written. */
  readonly setMainBranch: (workspaceId: WorkspaceId, branch: string) => Promise<string | undefined>
  /** The profile's architect-model form; undefined when the client has no settings service. */
  readonly architectModel: ArchitectModelForm | undefined
  readonly t: Translate
}

/**
 * Render the dashboard's Settings view.
 * @param props - the Workspace, its snapshot, the branch write, the model form, and copy.
 * @returns the view.
 */
export function SettingsView(props: SettingsViewProps): ReactNode {
  const { t, architectModel } = props
  return (
    <div className={css.settings}>
      <section className={css.group} aria-labelledby="architecture-settings-repository">
        <h2 id="architecture-settings-repository" className={css.groupTitle}>{t('settings.repository')}</h2>
        <p className={css.groupHint}>{t('settings.repository.hint', { manifest: props.snapshot.manifestPath })}</p>
        <MainBranchField {...props} />
      </section>
      {architectModel !== undefined && (
        <section className={css.group} aria-labelledby="architecture-settings-profile">
          <h2 id="architecture-settings-profile" className={css.groupTitle}>{t('settings.profile')}</h2>
          <p className={css.groupHint}>{t('settings.profile.hint')}</p>
          <ArchitectModelField form={architectModel} t={t} />
        </section>
      )}
    </div>
  )
}

function MainBranchField({ workspaceId, snapshot, setMainBranch, t }: SettingsViewProps): ReactNode {
  const id = useId()
  const all = snapshot.branches?.all ?? []
  const current = snapshot.branches?.current ?? []
  const declared = snapshot.mainBranch
  const [choice, setChoice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<BranchOutcome | undefined>(undefined)
  // A new snapshot (another Workspace, a branch switch) restarts the choice from what the repository declares.
  useEffect(() => { setChoice(undefined) }, [workspaceId, declared])
  useEffect(() => { setOutcome(undefined) }, [workspaceId])
  // A declared branch that no longer exists stays listed so the select shows what the manifest says.
  const options = [...new Set([...declared === undefined ? [] : [declared], ...all])]
  const selected = choice ?? declared ?? ''
  const hint = snapshot.vcs === 'jj' ? t('settings.mainBranch.hint.jj') : t('settings.mainBranch.hint')
  const blocked = !snapshot.hasManifest
    ? t('settings.mainBranch.noManifest', { manifest: snapshot.manifestPath })
    : all.length === 0 ? (snapshot.vcs === 'jj' ? t('settings.mainBranch.noBookmarks') : t('settings.mainBranch.noBranches')) : undefined
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={id}>{t('settings.mainBranch')}</label>
      <div className={css.control}>
        <select
          id={id}
          className={css.select}
          value={selected}
          disabled={blocked !== undefined || busy}
          onChange={(event) => {
            setChoice(event.target.value)
            setOutcome(undefined)
          }}
        >
          {declared === undefined && <option value="" disabled>{t('settings.mainBranch.choose')}</option>}
          {options.map(branch => (
            <option key={branch} value={branch}>
              {current.includes(branch) ? `${branch} · ${t('settings.mainBranch.current')}` : branch}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={blocked !== undefined || busy || selected === '' || selected === declared}
          onClick={() => {
            setBusy(true)
            setOutcome(undefined)
            void setMainBranch(workspaceId, selected).then((message) => {
              setBusy(false)
              setOutcome(message === undefined ? { kind: 'written' } : { kind: 'failed', message })
            })
          }}
        >
          {t('settings.mainBranch.apply')}
        </Button>
      </div>
      <p className={css.hint}>{blocked ?? hint}</p>
      {outcome !== undefined && (
        <p className={outcome.kind === 'failed' ? css.failed : css.hint} role="status">
          {outcome.kind === 'written'
            ? t('settings.mainBranch.written', { manifest: snapshot.manifestPath })
            : t('settings.mainBranch.failed', { message: outcome.message })}
        </p>
      )}
    </div>
  )
}

/** The value of a model option: provider and model, joined by a character no route id contains. */
function routeKey(choice: Pick<ArchitectModelChoice, 'provider' | 'model'>): string {
  return `${choice.provider}\n${choice.model}`
}

/**
 * Render the architect-model field: the catalog model, its reasoning effort, and the save.
 * @param props - the model form and copy.
 * @returns the field, or the unavailable line while the Host does not serve the namespace.
 */
export function ArchitectModelField({ form, t }: { form: ArchitectModelForm; t: Translate }): ReactNode {
  const id = useId()
  const state: ArchitectModelState = useSyncExternalStore(
    listener => form.state.subscribe(listener),
    () => form.state.getSnapshot(),
  )
  useEffect(() => { form.load() }, [form])
  // Leaving the view drops a staged choice, as every settings page does.
  useEffect(() => () => { form.discard() }, [form])
  if (!state.available) return <p className={css.hint} role="status">{t('settings.unavailable')}</p>
  const current = state.draft === undefined ? state.saved : state.draft ?? undefined
  const models = state.groups.flatMap(group => group.models.map(model => ({ group, model })))
  const listed = current === undefined || models.some(entry => entry.group.id === current.provider && entry.model.id === current.model)
  const efforts = current === undefined
    ? []
    : models.find(entry => entry.group.id === current.provider && entry.model.id === current.model)?.model.reasoning?.efforts ?? []
  const disabled = !state.writable || state.saving
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={id}>{t('settings.architectModel')}</label>
      {!state.writable && <p className={css.hint} role="status">{t('settings.readOnly')}</p>}
      <div className={css.control}>
        <select
          id={id}
          className={css.select}
          value={current === undefined ? '' : routeKey(current)}
          disabled={disabled}
          onChange={(event) => {
            const picked = models.find(entry => routeKey({ provider: entry.group.id, model: entry.model.id }) === event.target.value)
            form.stage(picked === undefined ? null : { provider: picked.group.id, model: picked.model.id })
          }}
        >
          <option value="">{t('settings.architectModel.worker')}</option>
          {!listed && (
            <option value={routeKey(current)}>{t('settings.architectModel.unlisted', { model: `${current.provider}/${current.model}` })}</option>
          )}
          {state.groups.map(group => (
            <optgroup key={group.id} label={group.name}>
              {group.models.map(model => (
                <option key={model.id} value={routeKey({ provider: group.id, model: model.id })}>{model.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {efforts.length > 0 && current !== undefined && (
          <select
            aria-label={t('settings.architectModel.effort')}
            className={css.select}
            value={current.reasoningEffort ?? ''}
            disabled={disabled}
            onChange={(event) => {
              const effort = event.target.value
              form.stage({ provider: current.provider, model: current.model, ...effort === '' ? {} : { reasoningEffort: effort } })
            }}
          >
            <option value="">{t('settings.architectModel.effortDefault')}</option>
            {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
          </select>
        )}
        <Button size="sm" variant="primary" disabled={disabled || state.draft === undefined} onClick={() => { void form.save() }}>
          {state.saving ? t('settings.saving') : t('settings.save')}
        </Button>
      </div>
      <p className={css.hint}>{t('settings.architectModel.hint')}</p>
      {state.catalog === 'error' && (
        <p className={css.failed} role="status">
          {t('settings.architectModel.catalogFailed')}
          {' '}
          <Button size="sm" variant="ghost" onClick={form.load}>{t('settings.architectModel.retry')}</Button>
        </p>
      )}
      {state.failed && <p className={css.failed} role="status">{t('settings.saveFailed')}</p>}
    </div>
  )
}
