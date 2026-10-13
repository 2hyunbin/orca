import { createTerminalEscapeScanner } from './terminal-escape-scanner'

export const CODEX_CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.'

const NOTICE = /^[■⚠]\s+Selected model is at capacity\. Please try a different model\.$/
const MAX_NOTICE_LENGTH = 160

/** Only a newly painted native notice at the end of the conversation can close a turn. */
export class CodexCapacityNoticeTracker {
  private tail = ''
  private pending = false
  private synchronized = false
  private readonly scanner = createTerminalEscapeScanner({
    onCsi: (marker, params, final) => {
      if (marker === '?' && params === '2026') {
        this.synchronized = final === 'h'
      } else if ((final === 'H' || final === 'f') && this.tail && !this.tail.endsWith(' ')) {
        this.tail += ' '
      }
    },
    onText: (text) => {
      if (!this.tail && !text.includes('■') && !text.includes('⚠')) {
        return
      }
      const input = (this.tail + text).replace(/\s+/g, ' ')
      if (/[■⚠]\s+Selected model is at capacity\. Please try a different model\./.test(input)) {
        this.pending = true
      }
      this.tail = input.includes('■') || input.includes('⚠') ? input.slice(-MAX_NOTICE_LENGTH) : ''
    }
  })

  observe(data: string, readScreen: () => readonly string[]): boolean {
    this.scanner.observe(data)
    if (!this.pending || this.synchronized) {
      return false
    }
    this.pending = false
    this.tail = ''
    const lines = readScreen()
    const composer = lines.findLastIndex((line) => /^\s*›/.test(line))
    if (composer === -1) {
      return false
    }
    const above = lines.slice(0, composer).filter((line) => line.trim() !== '')
    let notice = ''
    for (let index = above.length - 1; index >= 0 && notice.length < MAX_NOTICE_LENGTH; index--) {
      notice = `${above[index].trim()} ${notice}`.trim()
      if (NOTICE.test(notice)) {
        return true
      }
    }
    return false
  }
}
