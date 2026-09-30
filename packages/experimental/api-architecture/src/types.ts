/** Client-safe request and error vocabulary of the `architecture` Remote namespace. */
import type { Adjudication, AppealId } from '@deepseek-ai/dsh-experimental-architecture/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type {
  Acceptance,
  Adjudication,
  AppealId,
  AppealRecord,
  ArchitectureIndex,
  ArchitectureSnapshot,
  Citation,
  Constraint,
  GitFileStatus,
  IndexedSection,
  LocalEntry,
  Ruling,
  RulingId,
  RulingRecord,
  RulingStatus,
  UnresolvedPoint,
} from '@deepseek-ai/dsh-experimental-architecture/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested Workspace is not registered. */
    'architecture/workspace-not-found': { readonly workspaceId: string }
    /** The architecture service refused or failed the request. */
    'architecture/failed': { readonly reason: string }
  }
}

/** One section to read. */
export interface ArchitectureSectionRequest {
  readonly workspaceId: WorkspaceId
  /** Source path from the index. */
  readonly path: string
  /** Section anchor. */
  readonly anchor: string
}

/** One section and its text. */
export interface ArchitectureSectionValue {
  readonly path: string
  readonly anchor: string
  readonly hash: string
  readonly text: string
}

/** Accept one section at the hash the user reviewed. */
export interface ArchitectureAcceptRequest extends ArchitectureSectionRequest {
  readonly hash: string
}

/** Decide one pending appeal. */
export interface ArchitectureAdjudicateRequest {
  readonly workspaceId: WorkspaceId
  readonly appealId: AppealId
  readonly adjudication: Adjudication
}
