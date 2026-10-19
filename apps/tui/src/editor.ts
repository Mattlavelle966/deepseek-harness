/** Unicode-aware multiline draft editing with a bounded undo history. */
export class DraftEditor {
  text = ''
  cursor = 0
  anchor: number | undefined
  private undoStack: string[] = []
  private redoStack: string[] = []
  private clipboard = ''

  /** Replace the draft after submission, session selection, or a form transition. */
  reset(text = ''): void {
    this.text = text
    this.cursor = text.length
    this.anchor = undefined
    this.undoStack = []
    this.redoStack = []
  }

  /** Insert literal paste or typed input, replacing an active selection. */
  insert(value: string): void {
    this.change(() => {
      const [start, end] = this.range()
      this.text = this.text.slice(0, start) + value + this.text.slice(end)
      this.cursor = start + value.length
      this.anchor = undefined
    })
  }

  /** Delete one grapheme before or after the caret. */
  delete(backward: boolean): void {
    if (this.anchor !== undefined && this.anchor !== this.cursor) {
      this.insert('')
      return
    }
    const next = this.boundary(backward ? -1 : 1)
    this.anchor = next
    this.insert('')
  }

  /** Move by grapheme, preserving complete surrogate and combining sequences. */
  move(direction: -1 | 1): void {
    this.cursor = this.boundary(direction)
  }

  /** Move by visual text line while preserving the text column. */
  vertical(direction: -1 | 1): void {
    const start = this.text.lastIndexOf('\n', this.cursor - 1) + 1
    const column = this.cursor - start
    if (direction < 0) {
      const previousEnd = start - 1
      if (previousEnd < 0) {
        this.cursor = 0
        return
      }
      const previousStart = this.text.lastIndexOf('\n', previousEnd - 1) + 1
      this.cursor = Math.min(previousStart + column, previousEnd)
    } else {
      const end = this.text.indexOf('\n', this.cursor)
      if (end < 0) {
        this.cursor = this.text.length
        return
      }
      const nextEnd = this.text.indexOf('\n', end + 1)
      this.cursor = Math.min(end + 1 + column, nextEnd < 0 ? this.text.length : nextEnd)
    }
  }

  /** Move to a line edge or the next/previous word boundary. */
  motion(key: string): void {
    if (key === '0' || key === 'HOME') this.cursor = this.text.lastIndexOf('\n', this.cursor - 1) + 1
    else if (key === '$' || key === 'END') {
      const end = this.text.indexOf('\n', this.cursor)
      this.cursor = end < 0 ? this.text.length : end
    } else if (key === 'w') {
      const match = /\S+\s*|\s+/u.exec(this.text.slice(this.cursor))
      this.cursor += match?.[0].length ?? 0
    } else if (key === 'b') {
      const match = /\S+\s*$/u.exec(this.text.slice(0, this.cursor))
      this.cursor = match?.index ?? 0
    }
  }

  /** Copy the selection, or the current complete line when nothing is selected. */
  yank(remove = false): void {
    if (this.anchor === undefined) {
      this.motion('0')
      this.anchor = this.cursor
      const end = this.text.indexOf('\n', this.cursor)
      this.cursor = end < 0 ? this.text.length : end + 1
    }
    const [start, end] = this.range()
    this.clipboard = this.text.slice(start, end)
    if (remove) this.insert('')
    else this.anchor = undefined
  }

  /** Paste text from this editor's yank register. */
  paste(): void {
    this.insert(this.clipboard)
  }

  /** Undo or redo one edit. */
  undo(redo = false): void {
    const source = redo ? this.redoStack : this.undoStack
    const target = redo ? this.undoStack : this.redoStack
    const text = source.pop()
    if (text === undefined) return
    target.push(this.text)
    this.text = text
    this.cursor = Math.min(this.cursor, text.length)
    this.anchor = undefined
  }

  private range(): [number, number] {
    return [Math.min(this.cursor, this.anchor ?? this.cursor), Math.max(this.cursor, this.anchor ?? this.cursor)]
  }

  private change(operation: () => void): void {
    const before = this.text
    operation()
    if (before === this.text) return
    this.undoStack.push(before)
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
  }

  private boundary(direction: number): number {
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(this.text)]
    if (direction < 0) return segments.findLast(part => part.index < this.cursor)?.index ?? 0
    return segments.find(part => part.index > this.cursor)?.index ?? this.text.length
  }
}
