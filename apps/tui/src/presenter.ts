/** Terminal-safe text projection of the shared Chat target. */
import { t } from './copy.ts'

import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client/headless'
import { pretty } from './model.ts'

/** Transcript detail selected by the terminal user. */
export type TranscriptMode = 'clean' | 'raw'

/** Screen rows plus the source-row locations of collapsible tool calls. */
export interface TranscriptPresentation {
  readonly rows: string[]
  readonly toolRows: ReadonlyMap<number, string>
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const reasoningPreviewLength = 20

type TranscriptSnapshot = {
  readonly order: ChatSnapshot['order']
  readonly nodes: {
    get(key: string): { readonly kind: string; readonly visibility: 'visible' | 'hidden'; readonly data: unknown } | undefined
  }
}

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
    for (const { segment } of graphemeSegmenter.segment(line)) {
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
 * @param mode - readable conversation output or complete diagnostic data.
 * @returns terminal-safe display rows. */
export function transcript(
  snapshot: TranscriptSnapshot | undefined,
  renderers: ReadonlyMap<string, (data: unknown) => readonly string[]>,
  mode: TranscriptMode = 'clean',
): string[] {
  return presentTranscript(snapshot, renderers, mode, true).rows
}

/** Build interactive display rows while keeping tool output collapsed by default.
 * @param snapshot - selected shared Chat target.
 * @param renderers - registered extension renderers.
 * @param mode - readable conversation output or complete diagnostic data.
 * @param expandedTools - keys of tool calls expanded on screen, or true to expand every tool call.
 * @returns display rows and the row-to-tool mapping used for pointer interaction. */
export function presentTranscript(
  snapshot: TranscriptSnapshot | undefined,
  renderers: ReadonlyMap<string, (data: unknown) => readonly string[]>,
  mode: TranscriptMode = 'clean',
  expandedTools: ReadonlySet<string> | true = new Set(),
): TranscriptPresentation {
  if (!snapshot) return { rows: [], toolRows: new Map() }
  const rows: string[] = []
  const collapsibleRows = new Map<number, string>()
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (!node || node.visibility === 'hidden') continue
    const renderer = renderers.get(node.kind)
    if (renderer) {
      rows.push(`── ${node.kind} ──`, ...renderer(node.data), '')
      continue
    }
    if (mode === 'raw') {
      rows.push(`── ${node.kind} ──`, ...describe(node.data).split('\n'), '')
      continue
    }
    const expanded = expandedTools === true || expandedTools.has(key)
    const clean = cleanNode(node.kind, node.data, expanded, expandedTools !== true)
    if (clean !== undefined) {
      if (node.kind === 'tool-call') collapsibleRows.set(rows.length, key)
      rows.push(...clean, '')
    }
  }
  return { rows: rows.map(safeText), toolRows: collapsibleRows }
}

function cleanNode(kind: string, data: unknown, expanded: boolean, interactive: boolean): string[] | undefined {
  switch (kind) {
    case 'user':
    case 'steering':
      return headed(t('you'), cleanText(data))
    case 'assistant-step':
      return assistantRows(data)
    case 'tool-call':
      return toolRows(data, expanded, interactive)
    case 'turn-error':
      return headed(t('errorLabel'), compactMessage(data, t('turnFailed')))
    case 'turn-max-tokens':
      return headed(t('notice'), compactMessage(data, t('maximumTokensReached')))
    case 'model-retry':
      return headed(t('notice'), compactMessage(data, t('modelRequestRetrying')))
    case 'compaction':
    case 'manual-compaction':
      return [`── ${t('contextCompacted')} ──`]
    case 'command':
      return headed(t('command'), compactMessage(data, t('commandCompleted')))
    case 'unknown':
      return headed(t('notice'), compactMessage(data, t('unrecognizedConversationEvent')))
    case 'context':
    case 'system-prompt':
    case 'turn-process':
    case 'turn-tail':
    case 'turn-trigger':
      return undefined
    default:
      return headed(kind, compactMessage(data, `[${kind}]`))
  }
}

function headed(label: string, lines: readonly string[]): string[] | undefined {
  const visible = lines.flatMap(line => line.split('\n')).filter(line => line.trim() !== '')
  return visible.length === 0 ? undefined : [`── ${label} ──`, ...visible]
}

function assistantText(value: unknown): string[] {
  if (!record(value) || !Array.isArray(value.blocks)) return cleanText(value)
  return value.blocks.flatMap((block) => {
    if (!record(block) || block.kind !== 'text' || typeof block.text !== 'string') return []
    return terminalMarkdown(block.text)
  })
}

function terminalMarkdown(text: string): string[] {
  const rows: string[] = []
  let fence: string | undefined
  for (const source of text.split('\n')) {
    const delimiter = /^\s{0,3}```\s*([^`]*)$/u.exec(source)
    if (delimiter) {
      if (fence === undefined) {
        fence = delimiter[1]?.trim() ?? ''
        rows.push(fence === '' ? `┌─ ${t('code')}` : `┌─ ${t('code')} · ${fence}`)
      } else {
        rows.push('└─')
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) {
      rows.push(`│ ${source}`)
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*$/u.exec(source)
    if (heading) {
      rows.push(`◆ ${renderMarkdownInline(heading[1] ?? '')}`)
      continue
    }
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(source)) {
      rows.push('────────────────')
      continue
    }
    const task = /^(\s*)[-+*]\s+\[([ xX])\]\s+(.+)$/u.exec(source)
    if (task) {
      rows.push(`${task[1] ?? ''}${task[2]?.toLowerCase() === 'x' ? '☑' : '☐'} ${renderMarkdownInline(task[3] ?? '')}`)
      continue
    }
    const bullet = /^(\s*)[-+*]\s+(.+)$/u.exec(source)
    if (bullet) {
      rows.push(`${bullet[1] ?? ''}• ${renderMarkdownInline(bullet[2] ?? '')}`)
      continue
    }
    const quote = /^(\s*)>\s?(.*)$/u.exec(source)
    if (quote) {
      rows.push(`${quote[1] ?? ''}│ ${renderMarkdownInline(quote[2] ?? '')}`)
      continue
    }
    rows.push(renderMarkdownInline(source))
  }
  return rows
}

function renderMarkdownInline(source: string): string {
  const code: string[] = []
  const holdCode = (_match: string, value: string): string => {
    code.push(value)
    return `\uE000${code.length - 1}\uE001`
  }
  return source
    .replace(/`([^`]+)`/gu, holdCode)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, 'image: $1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 ($2)')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/~~([^~]+)~~/gu, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, '$1')
    .replace(/(?<!_)_([^_]+)_(?!_)/gu, '$1')
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/gu, '$1')
    .replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => `‹${code[Number(index)] ?? ''}›`)
}

function assistantRows(value: unknown): string[] | undefined {
  const rows: string[] = []
  const preview = runningReasoningPreview(value)
  if (preview !== undefined) rows.push(`── ${t('thinking')} · ${preview} ──`)
  const answer = headed(t('assistant'), assistantText(value))
  if (answer !== undefined) rows.push(...answer)
  return rows.length === 0 ? undefined : rows
}

function runningReasoningPreview(value: unknown): string | undefined {
  if (!record(value) || value.status !== 'running' || !Array.isArray(value.blocks)) return undefined
  for (let index = value.blocks.length - 1; index >= 0; index--) {
    const block: unknown = value.blocks[index]
    if (!record(block) || block.kind !== 'reasoning' || typeof block.text !== 'string') continue
    const text = safeText(block.text).replaceAll('**', '').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const graphemes = [...graphemeSegmenter.segment(text)].map(item => item.segment)
    const preview = graphemes.slice(-reasoningPreviewLength).join('')
    return graphemes.length > reasoningPreviewLength ? `…${preview}` : preview
  }
  return undefined
}

function cleanText(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(cleanText)
  if (!record(value)) return []
  if (typeof value.text === 'string') return [value.text]
  if (Array.isArray(value.content)) return value.content.flatMap(cleanText)
  if (Array.isArray(value.blocks)) return value.blocks.flatMap(cleanText)
  return []
}

function compactMessage(value: unknown, fallback: string): string[] {
  if (!record(value)) return [fallback]
  for (const field of ['message', 'summary', 'reason', 'title', 'text'] as const) {
    const candidate = value[field]
    if (typeof candidate === 'string' && candidate.trim() !== '') return [candidate]
  }
  if (record(value.current)) return compactMessage(value.current, fallback)
  if (record(value.command)) return compactMessage(value.command, fallback)
  return [fallback]
}

function toolRows(value: unknown, expanded: boolean, interactive: boolean): string[] | undefined {
  const disclosure = interactive ? `${expanded ? '▾' : '▸'} ` : ''
  if (!record(value) || !record(value.root)) return [`── ${disclosure}${t('tool')} · ${t('running')} ──`]
  return toolBlockRows(value.root, 0, expanded, interactive)
}

function toolBlockRows(
  value: Record<string, unknown>,
  depth: number,
  expanded: boolean,
  interactive: boolean,
): string[] {
  const name = typeof value.name === 'string' && value.name !== '' ? value.name : t('tool')
  const settled = value.kind === 'tool-result'
  const status = settled ? (value.isError === true ? t('failed') : t('done')) : t('running')
  const indent = '  '.repeat(depth)
  const disclosure = interactive ? `${expanded ? '▾' : '▸'} ` : ''
  const rows = [`${indent}── ${disclosure}${name} · ${status} ──`]
  if (expanded && settled && Array.isArray(value.content)) {
    const output = value.content.flatMap(cleanText).flatMap(line => line.split('\n'))
    while (output.at(-1)?.trim() === '') output.pop()
    rows.push(...output.map(line => `${indent}${line}`))
  }
  if (expanded && settled && value.isError === true && rows.length === 1) {
    rows.push(`${indent}${compactMessage(value.error, t('toolFailed'))[0]}`)
  }
  if (expanded && Array.isArray(value.subCalls)) {
    for (const child of value.subCalls)
      if (record(child)) rows.push(...toolBlockRows(child, depth + 1, true, interactive))
  }
  return rows
}

/** Narrow structured fallback data without trusting wire or extension values. */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
