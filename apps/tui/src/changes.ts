import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One changed path in the Host's recorded per-turn summary. */
export interface ChangedFile {
  readonly path: string
  readonly display: string
  readonly added: number
  readonly deleted: number
  readonly binary?: true
  readonly oversized?: true
}

/** Browser-compatible subset returned by api/changes.summary. */
export interface ChangesSummary {
  readonly turn: number
  readonly files: readonly ChangedFile[]
  readonly total: number
  readonly added: number
  readonly deleted: number
}

export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

/** Browser-compatible response returned by api/changes.diff. */
export type ChangesDiff =
  | { readonly kind: 'binary'; readonly path: string; readonly display: string }
  | { readonly kind: 'oversized'; readonly path: string; readonly display: string }
  | {
    readonly kind: 'text'
    readonly path: string
    readonly display: string
    readonly before: boolean
    readonly after: boolean
    readonly coarse: boolean
    readonly hunks: readonly DiffHunk[]
  }

export type ChangesSummaryState = ChangesSummary | 'loading' | 'missing'
export type ChangesDiffState = ChangesDiff | 'loading' | 'missing' | 'error'

/** UI state supplied to the transcript renderer for one completed turn. */
export interface TurnChangesPresentation {
  readonly key: string
  readonly summary: ChangesSummaryState
  readonly expanded: boolean
  readonly diffs: ReadonlyMap<number, ChangesDiffState>
}

export function changesKey(sessionId: SessionId, seq: number): string {
  return `${sessionId}:${seq}`
}

export function changesSummaryUrl(sessionId: SessionId, seq: number): string {
  return `api/changes.summary?${new URLSearchParams({ sessionId, seq: String(seq) })}`
}

export function changesDiffUrl(sessionId: SessionId, seq: number, index: number): string {
  return `api/changes.diff?${new URLSearchParams({ sessionId, seq: String(seq), index: String(index) })}`
}

export function decodeChangesSummary(value: unknown): ChangesSummary | undefined {
  if (!record(value) || !integer(value.turn) || value.turn < 1 || !integer(value.total)
    || !integer(value.added) || !integer(value.deleted) || !Array.isArray(value.files)) return undefined
  const files: ChangedFile[] = []
  for (const candidate of value.files) {
    if (!record(candidate) || typeof candidate.path !== 'string' || candidate.path === ''
      || typeof candidate.display !== 'string' || candidate.display === ''
      || !integer(candidate.added) || !integer(candidate.deleted)
      || (candidate.binary !== undefined && candidate.binary !== true)
      || (candidate.oversized !== undefined && candidate.oversized !== true)) return undefined
    files.push({
      path: candidate.path,
      display: candidate.display,
      added: candidate.added,
      deleted: candidate.deleted,
      ...candidate.binary === true ? { binary: true as const } : {},
      ...candidate.oversized === true ? { oversized: true as const } : {},
    })
  }
  return { turn: value.turn, files, total: value.total, added: value.added, deleted: value.deleted }
}

export function decodeChangesDiff(value: unknown): ChangesDiff | undefined {
  if (!record(value) || typeof value.path !== 'string' || value.path === ''
    || typeof value.display !== 'string' || value.display === '') return undefined
  if (value.kind === 'binary' || value.kind === 'oversized') {
    return { kind: value.kind, path: value.path, display: value.display }
  }
  if (value.kind !== 'text' || typeof value.before !== 'boolean' || typeof value.after !== 'boolean'
    || typeof value.coarse !== 'boolean' || !Array.isArray(value.hunks)) return undefined
  const hunks: DiffHunk[] = []
  for (const candidate of value.hunks) {
    if (!record(candidate) || !integer(candidate.oldStart) || !integer(candidate.oldLines)
      || !integer(candidate.newStart) || !integer(candidate.newLines) || !Array.isArray(candidate.lines)
      || !candidate.lines.every(line => typeof line === 'string' && /^[+ -]/u.test(line))) return undefined
    hunks.push({
      oldStart: candidate.oldStart,
      oldLines: candidate.oldLines,
      newStart: candidate.newStart,
      newLines: candidate.newLines,
      lines: candidate.lines,
    })
  }
  return {
    kind: 'text', path: value.path, display: value.display,
    before: value.before, after: value.after, coarse: value.coarse, hunks,
  }
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
