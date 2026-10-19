/** Terminal input must preserve literal drafts and never execute pasted commands. */
import { describe, expect, it, vi } from 'vitest'
import { DraftEditor } from '../src/editor.ts'
import { PasteDecoder } from '../src/paste.ts'
import { describe as presentValue, safeText, wrapText } from '../src/presenter.ts'
import { resolveServer } from '../src/transport.ts'

describe('terminal draft editing', () => {
  it('deletes and restores complete Unicode graphemes', () => {
    const editor = new DraftEditor()
    editor.insert('a👩‍💻e\u0301')
    editor.delete(true)
    expect(editor.text).toBe('a👩‍💻')
    editor.delete(true)
    expect(editor.text).toBe('a')
    editor.undo()
    expect(editor.text).toBe('a👩‍💻')
    editor.undo(true)
    expect(editor.text).toBe('a')
  })

  it('replaces a selection and retains multiline paste across undo', () => {
    const editor = new DraftEditor()
    editor.reset('first\nsecond')
    editor.anchor = 6
    editor.insert('literal\n:q\n')
    expect(editor.text).toBe('first\nliteral\n:q\n')
    editor.undo()
    expect(editor.text).toBe('first\nsecond')
  })

  it('moves between lines and yanks without submitting', () => {
    const editor = new DraftEditor()
    editor.reset('abc\nxyz')
    editor.vertical(-1)
    expect(editor.cursor).toBe(3)
    editor.yank(true)
    expect(editor.text).toBe('xyz')
    editor.paste()
    expect(editor.text).toBe('abc\nxyz')
  })
})

describe('bracketed paste', () => {
  it('preserves newlines and apparent commands for every byte split', () => {
    const bytes = Buffer.from('i\x1b[200~hello 世界\r\n:q\n\x1b[201~x')
    for (let split = 1; split < bytes.length; split++) {
      const keys: string[] = [],
        pastes: string[] = []
      const decoder = new PasteDecoder(
        bytes => keys.push(bytes.toString()),
        text => pastes.push(text),
        25,
      )
      decoder.push(bytes.subarray(0, split))
      decoder.push(bytes.subarray(split))
      expect(keys.join('')).toBe('ix')
      expect(pastes).toEqual(['hello 世界\n:q\n'])
      decoder.dispose()
    }
  })

  it('releases an ordinary Escape and drops an unfinished paste on disposal', () => {
    vi.useFakeTimers()
    try {
      const keys = vi.fn(),
        pasted = vi.fn()
      const decoder = new PasteDecoder(keys, pasted, 25)
      decoder.push(Buffer.from('\x1b'))
      vi.advanceTimersByTime(25)
      expect(keys).toHaveBeenCalledWith(Buffer.from('\x1b'))
      decoder.push(Buffer.from('\x1b[200~:q\n'))
      decoder.dispose()
      vi.runAllTimers()
      expect(pasted).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('terminal output and connection inputs', () => {
  it('removes model-supplied control sequences and preserves text', () => {
    expect(safeText('\x1b[2Jhello\x1b]52;c;ZXZpbA==\x07\n世界')).toBe('hello\n世界')
    expect(wrapText('ab世界👩‍💻', 4)).toEqual(['ab世', '界👩‍💻'])
  })

  it('keeps settled tool arguments, output and nested calls visible together', () => {
    expect(
      presentValue({
        root: {
          name: 'bash',
          call: { argsRaw: '{"command":"ls"}' },
          content: [{ type: 'text', text: 'file.txt' }],
          subCalls: [{ name: 'read', argsRaw: '{"path":"file.txt"}', content: [{ type: 'text', text: 'contents' }] }],
        },
      }),
    ).toBe('bash\n{"command":"ls"}\nfile.txt\nread\n{"path":"file.txt"}\ncontents')
  })

  it('accepts loopback mounts and refuses credential-bearing or nonlocal URLs', () => {
    expect(resolveServer('http://127.0.0.1:3032/harness').href).toBe('http://127.0.0.1:3032/harness/')
    expect(resolveServer('http://[::1]:4802/').hostname).toBe('[::1]')
    expect(() => resolveServer('http://remote.example/')).toThrow('localhost')
    expect(() => resolveServer('http://localhost/?token=secret')).toThrow('separately')
    expect(() => resolveServer('file:///tmp/')).toThrow('HTTP')
  })
})
