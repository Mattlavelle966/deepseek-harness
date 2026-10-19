/** Bracketed-paste framing in front of Terminal Kit's ordinary key decoder. */
import { StringDecoder } from 'node:string_decoder'

const START = '\x1b[200~'
const END = '\x1b[201~'

/** Preserve literal pasted newlines and commands across arbitrary stdin chunk boundaries. */
export class PasteDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private paste = false
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param keys - ordinary bytes forwarded to the terminal library.
   * @param pasted - one complete literal paste, never interpreted as keybindings.
   * @param escapeDelayMs - delay for a partial escape prefix outside a paste.
   */
  constructor(
    private readonly keys: (bytes: Buffer) => void,
    private readonly pasted: (text: string) => void,
    private readonly escapeDelayMs: number,
  ) {}

  /** Accept bytes from the owned stdin subscription. */
  push(bytes: Buffer): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending += this.decoder.write(bytes)
    while (this.pending) {
      if (this.paste) {
        const end = this.pending.indexOf(END)
        if (end < 0) return
        const text = this.pending.slice(0, end)
        this.pending = this.pending.slice(end + END.length)
        this.paste = false
        this.pasted(text.replace(/\r\n?/g, '\n'))
      } else {
        const start = this.pending.indexOf(START)
        if (start >= 0) {
          if (start) this.keys(Buffer.from(this.pending.slice(0, start)))
          this.pending = this.pending.slice(start + START.length)
          this.paste = true
        } else {
          let held = 0
          for (let length = 1; length < START.length; length++) {
            if (this.pending.endsWith(START.slice(0, length))) held = length
          }
          const ordinary = this.pending.slice(0, this.pending.length - held)
          this.pending = held ? this.pending.slice(-held) : ''
          if (ordinary) this.keys(Buffer.from(ordinary))
          if (held)
            this.timer = setTimeout(() => {
              const bytes = Buffer.from(this.pending)
              this.pending = ''
              this.timer = undefined
              this.keys(bytes)
            }, this.escapeDelayMs)
          return
        }
      }
    }
  }

  /** Drop an incomplete paste when the terminal is suspended or disposed. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = ''
    this.paste = false
  }
}
