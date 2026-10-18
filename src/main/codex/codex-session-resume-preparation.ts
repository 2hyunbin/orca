import { join } from 'node:path'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import {
  resolveCodexSessionResumeProvenance,
  type CodexSessionResumePreparation
} from './codex-session-resume-home'

export type VerifiedCodexResumeSource = { homePath: string; transcriptPath: string }

/**
 * The launch decision for an automatic Codex resume: pin the verified origin home, or
 * fall back to a fresh session whose resume argv the PTY layer drops (#10793). The
 * caller supplies `resolveVerifiedResumeHome` because migration, project trust and hook
 * repair only run once provenance is verified — a fresh outcome must skip all of them.
 *
 * The three rescan ranking inputs stay required through this hop (#10801): defaulting or
 * nulling any of them would silently degrade the legacy rescan to pure path order.
 */
export async function prepareCodexSessionResume(args: {
  sessionId: string
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  getSelectedAccountCodexHome: () => string | null
  systemCodexHomePath: string | null
  sharedRuntimeCodexHomePath: string | null
  resolveVerifiedResumeHome: (source: VerifiedCodexResumeSource) => Promise<string>
  fileIsRegular?: (filePath: string) => boolean
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<CodexSessionResumePreparation> {
  const provenance = await resolveCodexSessionResumeProvenance({
    sessionId: args.sessionId,
    transcriptPath: args.transcriptPath,
    trustedCodexHomes: args.trustedCodexHomes,
    getSelectedAccountCodexHome: args.getSelectedAccountCodexHome,
    systemCodexHomePath: args.systemCodexHomePath,
    sharedRuntimeCodexHomePath: args.sharedRuntimeCodexHomePath,
    ...(args.fileIsRegular ? { fileIsRegular: args.fileIsRegular } : {}),
    ...(args.listSessionFiles ? { listSessionFiles: args.listSessionFiles } : {})
  })
  if (provenance.outcome === 'fresh') {
    return provenance
  }
  const codexHomePath = await args.resolveVerifiedResumeHome({
    homePath: provenance.homePath,
    transcriptPath: provenance.transcriptPath
  })
  return {
    outcome: 'resume',
    codexHomePath,
    transcriptPath: rolloutUnderHome(provenance, codexHomePath)
  }
}

// Why: every move into another home (account restart, legacy migration) keeps the rollout's
// sessions-relative path, and Codex appends to the copy in the home it launched with.
function rolloutUnderHome(source: VerifiedCodexResumeSource, homePath: string): string {
  if (
    normalizeRuntimePathForComparison(homePath) ===
    normalizeRuntimePathForComparison(source.homePath)
  ) {
    return source.transcriptPath
  }
  const relativePath = relativePathInsideRoot(
    join(source.homePath, 'sessions'),
    source.transcriptPath
  )
  return relativePath ? join(homePath, 'sessions', relativePath) : source.transcriptPath
}
