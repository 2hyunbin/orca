import type { ParsedAgentStatusPayload } from './agent-status-types'
import { createAgentStatusOscProcessor, type ProcessedAgentStatusChunk } from './agent-status-osc'
import { createProgramStatusProjector } from './program-status-agent-status'
import { createProgramStatusTitleGlyphs } from './program-status-title-glyphs'
import type { ProgramStatusFacet } from './program-status-facet'

export type ProgramStatusSideEffectScan = {
  /** The chunk as Orca's side-effect scanners should read it: titles carry the status glyph a
   *  program stopped painting once OSC 7501 was answered. Never draw it or feed it to an emulator. */
  scanData: string
  payloads: ParsedAgentStatusPayload[]
  /** End offset of the last payload in `scanData`, ahead of the title it implies. */
  lastPayloadScanOffset: number | null
  mapOffset: (offset: number) => number
  /** See ProcessedAgentStatusChunk.programStatusFacet. */
  facet?: ProgramStatusFacet | null
}

/** Stateful per-PTY OSC 7501 reader for side effects: status payloads plus a re-glyphed title copy. */
export function createProgramStatusSideEffectScanner(): (
  data: string
) => ProgramStatusSideEffectScan {
  const programStatus = createProgramStatusProjector()
  const titleGlyphs = createProgramStatusTitleGlyphs()
  return (data) => {
    const { payloads, rootChanges, facet } = programStatus.process(data)
    const scanned = titleGlyphs.apply(data, rootChanges)
    const lastOffset = payloads.at(-1)?.offset
    return {
      scanData: scanned.data,
      payloads: payloads.map(({ payload }) => payload),
      lastPayloadScanOffset:
        lastOffset === undefined ? null : scanned.mapOffset(lastOffset, 'before'),
      mapOffset: (offset) => scanned.mapOffset(offset),
      ...(facet !== undefined ? { facet } : {})
    }
  }
}

/**
 * Every in-band agent status a PTY stream carries, for main's side-effect scan: Orca's OSC 9999
 * payloads (stripped) and the Program Status Protocol, OSC 7501 (kept, with re-glyphed titles).
 * Main never draws `cleanData`; its emulator and stream consumers read raw bytes.
 */
export function createTerminalAgentStatusProcessor(): (data: string) => ProcessedAgentStatusChunk {
  const processAgentStatusOsc = createAgentStatusOscProcessor()
  const scanProgramStatus = createProgramStatusSideEffectScanner()
  return (data) => {
    const chunk = processAgentStatusOsc(data)
    const scan = scanProgramStatus(chunk.cleanData)
    if (
      scan.payloads.length === 0 &&
      scan.scanData === chunk.cleanData &&
      scan.facet === undefined
    ) {
      return chunk
    }
    const legacyOffset =
      chunk.lastPayloadCleanOffset === null ? null : scan.mapOffset(chunk.lastPayloadCleanOffset)
    return {
      cleanData: scan.scanData,
      payloads: [...chunk.payloads, ...scan.payloads],
      lastPayloadCleanOffset:
        scan.lastPayloadScanOffset === null
          ? legacyOffset
          : Math.max(legacyOffset ?? 0, scan.lastPayloadScanOffset),
      ...(scan.payloads.length > 0 ? { programStatusPayloads: new Set(scan.payloads) } : {}),
      ...(scan.facet !== undefined ? { programStatusFacet: scan.facet } : {})
    }
  }
}
