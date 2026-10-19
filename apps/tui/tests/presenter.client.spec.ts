import { describe, expect, it } from 'vitest'
import { presentTranscript, transcript } from '../src/presenter.ts'

function snapshot() {
  const values = new Map<string, { kind: string; visibility: 'visible'; data: unknown }>([
    ['user', { kind: 'user', visibility: 'visible', data: { content: [{ type: 'text', text: 'Hello' }] } }],
    ['process', { kind: 'turn-process', visibility: 'visible', data: { turn: 1, toolCallCount: 1 } }],
    ['assistant', {
      kind: 'assistant-step',
      visibility: 'visible',
      data: { blocks: [
        { kind: 'reasoning', text: 'private reasoning' },
        { kind: 'text', text: 'I will check.' },
        { kind: 'tool-call', name: 'bash', argsRaw: '{"command":"pwd"}' },
      ] },
    }],
    ['tool', {
      kind: 'tool-call',
      visibility: 'visible',
      data: { root: {
        kind: 'tool-result',
        name: 'bash',
        call: { argsRaw: '{"command":"pwd"}' },
        content: [{ type: 'text', text: '/workspace' }],
        isError: false,
        subCalls: [],
      } },
    }],
    ['tail', { kind: 'turn-tail', visibility: 'visible', data: { turn: 1, tokenUsage: { totalTokens: 999 } } }],
  ])
  return {
    order: [...values.keys()],
    nodes: { get: (key: string) => values.get(key) },
  }
}

describe('terminal transcript modes', () => {
  it('exports readable messages and compact tool results', () => {
    const output = transcript(snapshot(), new Map()).join('\n')
    expect(output).toContain('── You ──\nHello')
    expect(output).toContain('── Assistant ──\nI will check.')
    expect(output).toContain('── bash · done ──\n/workspace')
    expect(output).not.toContain('private reasoning')
    expect(output).not.toContain('argsRaw')
    expect(output).not.toContain('totalTokens')
  })

  it('collapses tool output on screen until the tool call is expanded', () => {
    const collapsed = presentTranscript(snapshot(), new Map())
    const collapsedOutput = collapsed.rows.join('\n')
    expect(collapsedOutput).toContain('── ▸ bash · done ──')
    expect(collapsedOutput).not.toContain('/workspace')
    expect(collapsed.toolRows.get(collapsed.rows.indexOf('── ▸ bash · done ──'))).toBe('tool')

    const expandedOutput = presentTranscript(snapshot(), new Map(), 'clean', new Set(['tool'])).rows.join('\n')
    expect(expandedOutput).toContain('── ▾ bash · done ──\n/workspace')
  })

  it('retains the existing structured diagnostic projection in raw mode', () => {
    const output = transcript(snapshot(), new Map(), 'raw').join('\n')
    expect(output).toContain('── turn-process ──')
    expect(output).toContain('"toolCallCount": 1')
    expect(output).toContain('"totalTokens": 999')
  })
})
