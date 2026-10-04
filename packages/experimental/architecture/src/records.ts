/**
 * Durable architecture records under the local directory: one JSON file per
 * Ruling and per appeal, and one acceptance list. Every write replaces its file
 * through a temporary file and a rename, so a reader never observes a partial
 * record. Readers validate each file and report an invalid one instead of
 * guessing its content.
 * @module @deepseek-ai/dsh-experimental-architecture/records
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Acceptance, AppealId, AppealRecord, RulingId, RulingRecord, SectionHash, SourcePath } from './types.ts'

/** Subdirectory of Ruling records. */
export const RULINGS_DIRECTORY = 'rulings'
/** Subdirectory of appeal records. */
export const APPEALS_DIRECTORY = 'appeals'
/** File of accepted sections. */
export const ACCEPTANCES_FILE = 'acceptances.json'

const sourcePath = z.string().min(1).transform(value => brandString<SourcePath>(value))
const sectionHash = z.string().regex(/^[0-9a-f]{64}$/).transform(value => brandString<SectionHash>(value))
const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const rulingId = z.string().min(1).transform(value => brandString<RulingId>(value))
const appealId = z.string().min(1).transform(value => brandString<AppealId>(value))
const note = { note: z.string().optional() }

const rulingSchema = z.strictObject({
  version: z.literal(1),
  ruling: z.strictObject({
    id: rulingId,
    question: z.string(),
    scope: z.array(z.string()),
    summary: z.string(),
    constraints: z.array(z.strictObject({
      statement: z.string(),
      citations: z.array(z.strictObject({ path: sourcePath, anchor: z.string(), hash: sectionHash })),
    })),
    unresolved: z.array(z.strictObject({ statement: z.string(), reason: z.string().optional() })),
    proposedEdits: z.array(z.strictObject({
      path: sourcePath,
      anchor: z.string(),
      hash: sectionHash,
      content: z.string(),
      rationale: z.string(),
    })),
  }),
  workerSession: sessionId,
  architectSession: sessionId,
  revision: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  status: z.enum(['issued', 'appealed', 'upheld', 'overturned', 'excepted']),
  appliedEdits: z.array(z.number().int().nonnegative()),
  // Records written before dismissal existed carry no field; they have dismissed nothing.
  dismissedEdits: z.array(z.number().int().nonnegative()).default([]),
})

const appealSchema = z.strictObject({
  version: z.literal(1),
  id: appealId,
  rulingId,
  workerSession: sessionId,
  reason: z.string(),
  evidence: z.array(z.string()),
  filedAt: z.number().int().nonnegative(),
  adjudication: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('uphold'), ...note }),
    z.strictObject({ kind: z.literal('overturn'), ...note }),
    z.strictObject({ kind: z.literal('exception'), scope: z.string().min(1), ...note }),
  ]).optional(),
  decidedAt: z.number().int().nonnegative().optional(),
  delivered: z.boolean(),
})

const acceptancesSchema = z.strictObject({
  version: z.literal(1),
  acceptances: z.array(z.strictObject({
    path: sourcePath,
    anchor: z.string(),
    hash: sectionHash,
    acceptedAt: z.number().int().nonnegative(),
  })),
})

/** A record file that exists but does not parse as its record type. */
export interface RecordProblem {
  /** Path relative to the local directory. */
  readonly file: string
  /** Why the file was rejected. */
  readonly message: string
}

/** Records read from one local directory. */
export interface RecordSet {
  /** Ruling records by id. */
  readonly rulings: ReadonlyMap<RulingId, RulingRecord>
  /** Appeal records by id. */
  readonly appeals: ReadonlyMap<AppealId, AppealRecord>
  /** Accepted sections. */
  readonly acceptances: readonly Acceptance[]
  /** Files that could not be read as records. */
  readonly problems: readonly RecordProblem[]
}

/** Reads and writes the records of one local directory. */
export class RecordStore {
  /**
   * @param directory - absolute local architecture directory of the primary worktree.
   */
  constructor(private readonly directory: string) {}

  /**
   * Read every record. A missing directory yields an empty set.
   * @returns the records and the files that failed to parse.
   */
  async read(): Promise<RecordSet> {
    const problems: RecordProblem[] = []
    const rulings = new Map<RulingId, RulingRecord>()
    for (const [file, value] of await this.readDirectory(RULINGS_DIRECTORY, rulingSchema, problems)) {
      if (`${value.ruling.id}.json` !== file) problems.push({ file: join(RULINGS_DIRECTORY, file), message: `names Ruling ${value.ruling.id}` })
      else rulings.set(value.ruling.id, value)
    }
    const appeals = new Map<AppealId, AppealRecord>()
    for (const [file, value] of await this.readDirectory(APPEALS_DIRECTORY, appealSchema, problems)) {
      if (`${value.id}.json` !== file) problems.push({ file: join(APPEALS_DIRECTORY, file), message: `names appeal ${value.id}` })
      else appeals.set(value.id, value)
    }
    const acceptances = await this.readFile(ACCEPTANCES_FILE, acceptancesSchema, problems)
    return { rulings, appeals, acceptances: acceptances?.acceptances ?? [], problems }
  }

  /**
   * Write one Ruling record.
   * @param record - the record; its Ruling id names the file.
   */
  async writeRuling(record: RulingRecord): Promise<void> {
    await this.write(join(RULINGS_DIRECTORY, `${record.ruling.id}.json`), record)
  }

  /**
   * Write one appeal record.
   * @param record - the record; its id names the file.
   */
  async writeAppeal(record: AppealRecord): Promise<void> {
    await this.write(join(APPEALS_DIRECTORY, `${record.id}.json`), record)
  }

  /**
   * Replace the acceptance list.
   * @param acceptances - every accepted section.
   */
  async writeAcceptances(acceptances: readonly Acceptance[]): Promise<void> {
    await this.write(ACCEPTANCES_FILE, { version: 1, acceptances })
  }

  private async write(file: string, value: object): Promise<void> {
    const target = join(this.directory, file)
    await mkdir(join(target, '..'), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`)
    await rename(temporary, target)
  }

  private async readDirectory<T>(name: string, schema: z.ZodType<T>, problems: RecordProblem[]): Promise<Array<[string, T]>> {
    let files: string[]
    try {
      files = await readdir(join(this.directory, name))
    } catch (error: unknown) {
      if (isMissing(error)) return []
      throw error
    }
    const values: Array<[string, T]> = []
    for (const file of files.filter(entry => entry.endsWith('.json')).sort()) {
      const value = await this.readFile(join(name, file), schema, problems)
      if (value !== undefined) values.push([file, value])
    }
    return values
  }

  private async readFile<T>(file: string, schema: z.ZodType<T>, problems: RecordProblem[]): Promise<T | undefined> {
    let text: string
    try {
      text = await readFile(join(this.directory, file), 'utf8')
    } catch (error: unknown) {
      if (isMissing(error)) return undefined
      throw error
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error: unknown) {
      // JSON.parse throws only SyntaxError.
      problems.push({ file, message: `is not JSON: ${(error as SyntaxError).message}` })
      return undefined
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      problems.push({ file, message: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') })
      return undefined
    }
    return parsed.data
  }
}

/**
 * Whether a filesystem error reports a missing path.
 * @param error - the thrown value.
 * @returns true for `ENOENT`.
 */
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
