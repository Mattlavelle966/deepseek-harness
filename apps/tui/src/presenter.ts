/** Terminal-safe text projection of the shared Chat target. */
import { t } from './copy.ts'

import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client/headless'
import { pretty } from './model.ts'

/** Remove terminal control sequences from untrusted model, file, and tool text. */
export function safeText(value: string): string {
  return stripAnsi(value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\t/g, '    ')
}

/** Wrap by terminal cell width without breaking a grapheme cluster. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  width = Math.max(1, width)
  for (const line of safeText(text).split('\n')) {
    let current = ''
    let cells = 0
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)) {
      const size = stringWidth(segment)
      if (cells + size > width && current) {
        lines.push(current)
        current = ''
        cells = 0
      }
      current += segment
      cells += size
    }
    lines.push(current)
  }
  return lines
}

/** Render an arbitrary registered Chat payload without executing its content. */
export function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (!record(value)) return pretty(value)
  if (Array.isArray(value)) return value.map(describe).join('\n')
  if (Array.isArray(value.blocks))
    return value.blocks
      .map((block) => {
        if (!record(block)) return pretty(block)
        if (block.kind === 'reasoning')
          return t('reasoning', [typeof block.text === 'string' ? block.text : pretty(block.text)])
        if (typeof block.text === 'string') return block.text
        if (block.kind === 'tool-call')
          return `[${String(block.name)}]\n${typeof block.argsRaw === 'string' ? block.argsRaw : pretty(block.argsRaw)}`
        return pretty(block)
      })
      .join('\n')
  if (record(value.root)) return describe(value.root)
  if (typeof value.name === 'string') {
    const args =
      typeof value.argsRaw === 'string'
        ? value.argsRaw
        : record(value.call) && typeof value.call.argsRaw === 'string'
          ? value.call.argsRaw
          : pretty(value.args)
    const output = Array.isArray(value.content)
      ? describe(value.content)
      : value.result === undefined
        ? ''
        : describe(value.result)
    const children = Array.isArray(value.subCalls) ? value.subCalls.map(describe) : []
    return [`${value.isError === true ? '[error] ' : ''}${value.name}`, args, output, ...children]
      .filter(Boolean)
      .join('\n')
  }
  if (Array.isArray(value.content)) {
    return value.content
      .map(block => (record(block) && typeof block.text === 'string' ? block.text : pretty(block)))
      .join('\n')
  }
  if (typeof value.text === 'string') return value.text
  return pretty(value)
}

/** Build display rows from the existing shared Chat snapshot.
 * @param snapshot - selected shared Chat target.
 * @param renderers - registered extension renderers.
 * @returns terminal-safe display rows. */
export function transcript(
  snapshot: ChatSnapshot | undefined,
  renderers: ReadonlyMap<string, (data: unknown) => readonly string[]>,
): string[] {
  if (!snapshot) return []
  const rows: string[] = []
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (!node || node.visibility === 'hidden') continue
    const renderer = renderers.get(node.kind)
    rows.push(`── ${node.kind} ──`, ...(renderer ? renderer(node.data) : describe(node.data).split('\n')), '')
  }
  return rows.map(safeText)
}

/** Narrow structured fallback data without trusting wire or extension values. */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
