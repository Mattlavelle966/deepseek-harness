import { describe, expect, it } from 'vitest'
import { presentTranscript, sessionMetricsLine, transcript } from '../src/presenter.ts'
import type { TurnChangesPresentation } from '../src/changes.ts'

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
    ['tail', { kind: 'turn-tail', visibility: 'visible', data: { turn: 1, tokenUsage: {
      totalTokens: 999,
      uncachedInputTokens: 99,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 25,
    } } }],
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
    expect(output).toContain('── Turn 1 · 999 tokens · 89% cache · in 99 · read 800 · write 0 · out 100 · reasoning 25 ──')
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

  it('shows the latest 100 graphemes while reasoning is streaming', () => {
    const latest = '界'.repeat(100)
    const values = new Map([
      ['assistant', {
        kind: 'assistant-step',
        visibility: 'visible' as const,
        data: {
          status: 'running',
          blocks: [{ kind: 'reasoning', text: `older reasoning ${latest}` }],
        },
      }],
    ])
    const output = presentTranscript({
      order: [...values.keys()],
      nodes: { get: (key: string) => values.get(key) },
    }, new Map()).rows.join('\n')

    expect(output).toContain(`── Thinking · …${latest} ──`)
    expect(output).not.toContain('older reasoning')
  })

  it('projects common Markdown into readable terminal rows', () => {
    const values = new Map([
      ['assistant', {
        kind: 'assistant-step',
        visibility: 'visible' as const,
        data: {
          status: 'settled',
          blocks: [{
            kind: 'text',
            text: '# Result\n- **fast** output\n> Read [the docs](https://example.test)\n```ts\nconst ok = true\n```',
          }],
        },
      }],
    ])
    const output = presentTranscript({
      order: [...values.keys()],
      nodes: { get: (key: string) => values.get(key) },
    }, new Map()).rows.join('\n')

    expect(output).toContain('◆ Result')
    expect(output).toContain('• fast output')
    expect(output).toContain('│ Read the docs (https://example.test)')
    expect(output).toContain('┌─ code · ts\n│ const ok = true\n└─')
    expect(output).not.toContain('**')
  })

  it('retains the existing structured diagnostic projection in raw mode', () => {
    const output = transcript(snapshot(), new Map(), 'raw').join('\n')
    expect(output).toContain('── turn-process ──')
    expect(output).toContain('"toolCallCount": 1')
    expect(output).toContain('"totalTokens": 999')
  })

  it('shows session usage, cache, output, and context occupancy compactly', () => {
    expect(sessionMetricsLine({
      turns: 12,
      steps: 34,
      totalTokens: 12_345,
      cacheReadTokens: 8_000,
      billedInputTokens: 10_000,
      outputTokens: 2_345,
      contextTokens: 32_000,
      contextWindow: 128_000,
    })).toBe('12 turns · 34 steps · 12.3K tokens · 80% cache · out 2.3K · 25% context')
  })

  it('renders recorded changed files as a collapsible inline diff', () => {
    const changes: TurnChangesPresentation = {
      key: 'session:40',
      expanded: true,
      summary: {
        turn: 1,
        total: 1,
        added: 2,
        deleted: 1,
        files: [{ path: 'src/app.ts', display: 'src/app.ts', added: 2, deleted: 1 }],
      },
      diffs: new Map([[0, {
        kind: 'text',
        path: 'src/app.ts',
        display: 'src/app.ts',
        before: true,
        after: true,
        coarse: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+line'] }],
      }]]),
    }
    const output = presentTranscript(snapshot(), new Map(), 'clean', new Set(), new Map([[1, changes]]))
    expect(output.rows.join('\n')).toContain(
      '── ▾ Git diff · 1 file · +2 −1 ──\n┌─ src/app.ts · +2 −1\n@@ -1,1 +1,2 @@\n-old\n+new\n+line\n└─',
    )
    expect(output.changeRows.get(output.rows.indexOf('── ▾ Git diff · 1 file · +2 −1 ──'))).toBe('session:40')
  })
})
