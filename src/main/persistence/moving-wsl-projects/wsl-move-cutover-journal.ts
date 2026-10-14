/**
 * The WSL move journal: `orcad-migration-cutovers-wsl/<migrationId>.json` beside the profile.
 * A separate directory from the SSH journal, so an older build never reads a WSL record as SSH.
 */
import {
  WSL_MOVE_CUTOVER_PHASES,
  isWslMoveCutoverFinished,
  parseWslMoveCutover,
  type WslMoveCutover
} from '../../../shared/wsl-move/wsl-move-cutover'
import {
  createMigrationJournalDirectory,
  orderMigrationJournalChain
} from '../migrating-orcad-catalog/migration-journal-directory'

export class WslMoveJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The WSL move journal cannot be read, so the moving projects stay fenced: ${detail}`)
    this.name = 'WslMoveJournalUnreadableError'
  }
}

const journals = createMigrationJournalDirectory({
  directoryName: 'orcad-migration-cutovers-wsl',
  // A manifest carries catalog rows and dormant session state; blobs travel on their own channel.
  maxFileBytes: 16 * 1024 * 1024,
  parse: parseWslMoveCutover,
  unreadable: (detail) => new WslMoveJournalUnreadableError(detail)
})

export function wslMoveJournalDirectory(userDataPath: string): string {
  return journals.directory(userDataPath)
}

export function listWslMoveCutovers(userDataPath: string): WslMoveCutover[] {
  return journals.list(userDataPath)
}

/** Oldest first; throws unless the distro's journals form one chain of delta moves. */
export function listWslMoveCutoverChain(
  userDataPath: string,
  journalKey: string
): WslMoveCutover[] {
  const matches = listWslMoveCutovers(userDataPath).filter(
    (cutover) => cutover.journalKey === journalKey
  )
  return orderMigrationJournalChain(
    matches,
    (detail) => new WslMoveJournalUnreadableError(detail),
    journalKey
  )
}

/**
 * Durable before it returns. A new move into a distro must extend the head of its chain, and only
 * once that head finished: one in-flight move per distro (design, section 4.3).
 */
export function writeWslMoveCutover(userDataPath: string, cutover: WslMoveCutover): void {
  const parsed = parseWslMoveCutover(cutover)
  const chain = listWslMoveCutoverChain(userDataPath, parsed.journalKey)
  const existing = chain.find((entry) => entry.migrationId === parsed.migrationId)
  const head = chain.at(-1)
  if (existing) {
    assertWslMoveUpdate(existing, parsed, head)
  } else if (head) {
    if (!isWslMoveCutoverFinished(head)) {
      throw new Error('wsl_move_already_in_flight')
    }
    if (parsed.supersedesMigrationId !== head.migrationId) {
      throw new Error('wsl_move_must_extend_its_chain')
    }
  }
  journals.write(userDataPath, parsed)
}

/** A record only moves forward, keeps its binding, and only the head of its chain still moves. */
function assertWslMoveUpdate(
  existing: WslMoveCutover,
  next: WslMoveCutover,
  head: WslMoveCutover | undefined
): void {
  if (
    next.manifestSha256 !== existing.manifestSha256 ||
    next.supersedesMigrationId !== existing.supersedesMigrationId
  ) {
    throw new Error('wsl_move_binding_changed')
  }
  const order = (phase: WslMoveCutover['phase']): number => WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
  if (order(next.phase) < order(existing.phase)) {
    throw new Error('wsl_move_phase_regressed')
  }
  if (head && head.migrationId !== existing.migrationId && next.phase !== existing.phase) {
    throw new Error('wsl_move_superseded')
  }
}

export function removeWslMoveCutover(userDataPath: string, migrationId: string): void {
  journals.remove(userDataPath, migrationId)
}
