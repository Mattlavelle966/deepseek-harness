import { describe, expect, it } from 'vitest'
import { decodeChangesDiff, decodeChangesSummary } from '../src/changes.ts'

describe('recorded change responses', () => {
  it('accepts the change summary shape served to the Web UI', () => {
    expect(decodeChangesSummary({
      turn: 2,
      files: [{ path: 'src/a.ts', display: 'src/a.ts', added: 3, deleted: 1 }],
      total: 1,
      added: 3,
      deleted: 1,
    }))?.toMatchObject({ turn: 2, total: 1, added: 3, deleted: 1 })
  })

  it('accepts safe unified hunks and rejects malformed line prefixes', () => {
    const base = {
      kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true, coarse: false,
    }
    expect(decodeChangesDiff({
      ...base,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    })?.kind).toBe('text')
    expect(decodeChangesDiff({
      ...base,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['unsafe'] }],
    })).toBeUndefined()
  })
})
