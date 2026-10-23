import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'

export const TEXT_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isTextSearchQueryTooLarge(
  query: string,
  maxBytes = TEXT_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export type TextMatchOptions = {
  matchCase?: boolean
  wholeWord?: boolean
}

export function findTextMatchRanges(
  text: string,
  query: string,
  options: TextMatchOptions = {}
): { start: number; end: number }[] {
  if (!query) {
    return []
  }
  if (isTextSearchQueryTooLarge(query)) {
    return []
  }

  const ranges = options.matchCase
    ? findCaseSensitiveMatchRanges(text, query)
    : findCaseInsensitiveMatchRanges(text, query)

  if (!options.wholeWord) {
    return ranges
  }
  return ranges.filter((range) => isWholeWordMatch(text, range.start, range.end))
}

function findCaseSensitiveMatchRanges(
  text: string,
  query: string
): { start: number; end: number }[] {
  const matches: { start: number; end: number }[] = []
  let searchStart = 0

  while (searchStart <= text.length - query.length) {
    const matchStart = text.indexOf(query, searchStart)
    if (matchStart === -1) {
      break
    }
    matches.push({ start: matchStart, end: matchStart + query.length })
    searchStart = matchStart + query.length
  }

  return matches
}

function findCaseInsensitiveMatchRanges(
  text: string,
  query: string
): { start: number; end: number }[] {
  const normalizedText = buildLocaleLowercaseIndex(text)
  const normalizedQuery = buildLocaleLowercaseIndex(query).text
  const matches: { start: number; end: number }[] = []
  let searchStart = 0

  while (searchStart <= normalizedText.text.length - normalizedQuery.length) {
    const matchStart = normalizedText.text.indexOf(normalizedQuery, searchStart)
    if (matchStart === -1) {
      break
    }

    const matchEnd = matchStart + normalizedQuery.length
    matches.push({
      start: normalizedText.originalOffset(matchStart, false),
      end: normalizedText.originalOffset(matchEnd - 1, true)
    })
    // Why: advance by at least 1 to guarantee forward progress even if a
    // future locale edge-case produces a zero-length normalizedQuery.
    searchStart = matchEnd + (normalizedQuery.length === 0 ? 1 : 0)
  }

  return matches
}

// Why: whole-word matching treats Unicode letters, digits, and underscore as
// word characters so a match only counts when both edges sit on a word boundary,
// mirroring the editor's "whole word" find toggle.
const WORD_CHARACTER = /[\p{L}\p{N}_]/u

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER.test(char)
}

function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) {
    return undefined
  }

  const previousCodeUnit = text.charCodeAt(index - 1)
  if (
    previousCodeUnit >= 0xdc00 &&
    previousCodeUnit <= 0xdfff &&
    index > 1 &&
    text.charCodeAt(index - 2) >= 0xd800 &&
    text.charCodeAt(index - 2) <= 0xdbff
  ) {
    return text.slice(index - 2, index)
  }

  return text[index - 1]
}

function codePointAt(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index)
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint)
}

function isWholeWordMatch(text: string, start: number, end: number): boolean {
  const before = codePointBefore(text, start)
  const after = codePointAt(text, end)
  return !isWordCharacter(before) && !isWordCharacter(after)
}

function buildLocaleLowercaseIndex(text: string): {
  text: string
  originalOffset: (offset: number, end: boolean) => number
} {
  // ASCII has no contextual casing or multi-unit characters, so every offset stays identical.
  if (!/[\u0080-\uffff]/.test(text)) {
    return {
      text: text.toLocaleLowerCase(),
      originalOffset: (offset, end) => offset + (end ? 1 : 0)
    }
  }

  const chunks: string[] = []
  const chunk: string[] = []
  const normalizedSpans: number[] = []
  const originalSpans: number[] = []
  let normalizedLength = 0
  let originalOffset = 0

  for (const char of text) {
    const normalizedChar = char.toLocaleLowerCase()
    const originalEnd = originalOffset + char.length
    // Only multi-unit characters need a span; ordinary offsets follow the preceding shift.
    if (char.length !== 1 || normalizedChar.length !== 1) {
      normalizedSpans.push(normalizedLength, normalizedLength + normalizedChar.length)
      originalSpans.push(originalOffset, originalEnd)
    }
    chunk.push(normalizedChar)
    if (chunk.length === 1024) {
      chunks.push(chunk.join(''))
      chunk.length = 0
    }
    normalizedLength += normalizedChar.length
    originalOffset = originalEnd
  }
  if (chunk.length > 0) {
    chunks.push(chunk.join(''))
  }

  let spanOffset = 0
  let shift = 0

  return {
    text: chunks.join(''),
    // Search visits match starts and ends in order, so each span is visited once.
    originalOffset: (offset, end) => {
      while (spanOffset < normalizedSpans.length && normalizedSpans[spanOffset + 1]! <= offset) {
        shift = originalSpans[spanOffset + 1]! - normalizedSpans[spanOffset + 1]!
        spanOffset += 2
      }
      if (spanOffset < normalizedSpans.length && normalizedSpans[spanOffset]! <= offset) {
        return originalSpans[spanOffset + (end ? 1 : 0)]!
      }
      return offset + shift + (end ? 1 : 0)
    }
  }
}
