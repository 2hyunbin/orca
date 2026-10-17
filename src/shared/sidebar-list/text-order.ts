// Why not localeCompare: Electron, the phone WebView and Node ship different ICU data, so the same
// sidebar must not order its text through a collator. Everything here is plain Unicode arithmetic.

const DIGIT_0 = 0x30
const DIGIT_9 = 0x39

function isAsciiDigit(code: number): boolean {
  return code >= DIGIT_0 && code <= DIGIT_9
}

function foldSidebarText(text: string): string {
  // Why lowercase before NFC: lowercasing can emit decomposed sequences ("İ" becomes "i" + U+0307).
  return text.toLowerCase().normalize('NFC')
}

function codePointLength(code: number): number {
  return code > 0xffff ? 2 : 1
}

/** Code-point order; plain `<` on strings compares UTF-16 units, which misplaces astral characters. */
export function compareCodePoints(left: string, right: string): number {
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const a = left.codePointAt(i) ?? 0
    const b = right.codePointAt(j) ?? 0
    if (a !== b) {
      return a < b ? -1 : 1
    }
    i += codePointLength(a)
    j += codePointLength(b)
  }
  return i < left.length ? 1 : j < right.length ? -1 : 0
}

function digitRunEnd(text: string, start: number): number {
  let end = start
  while (end < text.length && isAsciiDigit(text.charCodeAt(end))) {
    end++
  }
  return end
}

function skipLeadingZeros(text: string, start: number, end: number): number {
  let index = start
  while (index < end - 1 && text.charCodeAt(index) === DIGIT_0) {
    index++
  }
  return index
}

/** Digit runs compare as numbers ("w2" < "w10"); everything else by code point. */
function compareNatural(left: string, right: string): number {
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const a = left.codePointAt(i) ?? 0
    const b = right.codePointAt(j) ?? 0
    if (isAsciiDigit(a) && isAsciiDigit(b)) {
      const leftEnd = digitRunEnd(left, i)
      const rightEnd = digitRunEnd(right, j)
      const leftStart = skipLeadingZeros(left, i, leftEnd)
      const rightStart = skipLeadingZeros(right, j, rightEnd)
      const lengthDelta = leftEnd - leftStart - (rightEnd - rightStart)
      if (lengthDelta !== 0) {
        return lengthDelta < 0 ? -1 : 1
      }
      // Same digit count without leading zeros, so digit-wise order is numeric order.
      const byDigits = compareCodePoints(
        left.slice(leftStart, leftEnd),
        right.slice(rightStart, rightEnd)
      )
      if (byDigits !== 0) {
        return byDigits
      }
      i = leftEnd
      j = rightEnd
      continue
    }
    if (a !== b) {
      return a < b ? -1 : 1
    }
    i += codePointLength(a)
    j += codePointLength(b)
  }
  return i < left.length ? 1 : j < right.length ? -1 : 0
}

/**
 * Device-independent order for sidebar text: case-folded and NFC-normalized, digit runs by value,
 * the rest by code point. Returns 0 only for canonically equal text; callers break that tie by
 * host-qualified id.
 */
export function compareSidebarText(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  return (
    compareNatural(foldSidebarText(left), foldSidebarText(right)) ||
    // Why: "Alpha"/"alpha" and "w02"/"w2" fold equal but must still order the same everywhere.
    compareCodePoints(left.normalize('NFC'), right.normalize('NFC'))
  )
}
