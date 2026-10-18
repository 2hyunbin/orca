// Claude Code stops painting its title glyph once OSC 7501 is answered, but Orca's title-driven
// machinery still reads titles: restore the glyph in the copy Orca scans, never in what is drawn.
import {
  hasLeadingAgentTitleDecoration,
  stripLeadingAgentTitleDecorationOrEmpty
} from './agent-title-decoration'
import { CLAUDE_IDLE } from './agent-title-glyphs'
import type { ProgramStatusRootChange } from './program-status-agent-status'
import { findOscTerminator } from './program-status-osc'
import type { ProgramStatusRecord } from './program-status-records'

type TitleGlyphProfile = { working: string; atRest: string; defaultTitle: string }

/** Keyed by OSC 7501 `app`. Glyphs match the program's own pre-7501 titles exactly. */
const TITLE_GLYPH_PROFILES: Readonly<Record<string, TitleGlyphProfile | undefined>> = {
  // Claude spins only while loading; at rest and on its prompts it shows `✳`.
  'claude-code': { working: '⠂', atRest: CLAUDE_IDLE, defaultTitle: 'Claude Code' }
}

const TITLE_INTRODUCERS = ['\x1b]0;', '\x1b]2;'] as const
// Why: bounds the work per title; a longer one still gets its glyph, it just isn't remembered.
const MAX_TITLE_SCAN_LENGTH = 4096

function profileFor(root: ProgramStatusRecord | undefined): TitleGlyphProfile | undefined {
  return root?.app === undefined ? undefined : TITLE_GLYPH_PROFILES[root.app]
}

function glyphFor(root: ProgramStatusRecord | undefined): string | null {
  const profile = profileFor(root)
  if (!profile) {
    return null
  }
  return root?.state === 'working' ? profile.working : profile.atRest
}

/** Where the next title's text starts, and the introducer's own index. */
function findNextTitle(data: string, from: number): { index: number; textStart: number } | null {
  let next: { index: number; textStart: number } | null = null
  for (const introducer of TITLE_INTRODUCERS) {
    const index = data.indexOf(introducer, from)
    if (index !== -1 && (next === null || index < next.index)) {
      next = { index, textStart: index + introducer.length }
    }
  }
  return next
}

export type ProgramStatusTitleGlyphs = {
  /** Re-glyph `data` using the chunk's root changes. `mapOffset` maps an input offset to the
   *  output, landing before or after any bytes inserted exactly there. */
  apply: (
    data: string,
    rootChanges: readonly ProgramStatusRootChange[]
  ) => { data: string; mapOffset: (offset: number, side?: 'before' | 'after') => number }
}

export function createProgramStatusTitleGlyphs(): ProgramStatusTitleGlyphs {
  let root: ProgramStatusRecord | undefined
  let lastTitle: string | null = null

  return {
    apply: (data, rootChanges) => {
      if (rootChanges.length === 0 && glyphFor(root) === null) {
        return { data, mapOffset: (offset) => offset }
      }
      const insertions: { at: number; length: number }[] = []
      let output = ''
      let cursor = 0
      const emitUntil = (end: number): void => {
        while (cursor < end) {
          const next = findNextTitle(data, cursor)
          if (next === null || next.textStart > end) {
            output += data.slice(cursor, end)
            cursor = end
            return
          }
          const { textStart } = next
          output += data.slice(cursor, textStart)
          cursor = textStart
          const terminator = findOscTerminator(data, textStart, textStart + MAX_TITLE_SCAN_LENGTH)
          const text = terminator === null ? null : data.slice(textStart, terminator.index)
          if (text !== null) {
            lastTitle = stripLeadingAgentTitleDecorationOrEmpty(text)
          }
          const glyph = glyphFor(root)
          // An unterminated title is judged by the bytes it has so far.
          const textSoFar = text ?? data.slice(textStart, textStart + MAX_TITLE_SCAN_LENGTH)
          if (glyph && text !== '' && !hasLeadingAgentTitleDecoration(textSoFar)) {
            output += `${glyph} `
            insertions.push({ at: textStart, length: glyph.length + 1 })
          }
        }
      }
      for (const change of rootChanges) {
        emitUntil(Math.min(change.offset, data.length))
        const before = glyphFor(root)
        root = change.root
        const after = glyphFor(root)
        if (after !== null && after !== before) {
          // ST, not BEL, so no bell detector can count the synthetic title's terminator.
          const title = `\x1b]2;${after} ${lastTitle || profileFor(root)?.defaultTitle || ''}\x1b\\`
          output += title
          insertions.push({ at: cursor, length: title.length })
        }
      }
      emitUntil(data.length)
      return {
        data: output,
        mapOffset: (offset, side = 'after') => {
          let shifted = offset
          for (const insertion of insertions) {
            if (insertion.at < offset || (side === 'after' && insertion.at === offset)) {
              shifted += insertion.length
            }
          }
          return shifted
        }
      }
    }
  }
}
