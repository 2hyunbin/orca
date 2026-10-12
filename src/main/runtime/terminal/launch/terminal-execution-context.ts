import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'

export type RuntimeTerminalExecutionContextHost = {
  getPtysById(): ReadonlyMap<string, RuntimePtyWorktreeRecord>
  getWslDistroByPtyId(): Map<string, string>
  getEarlyExitedPtyIncarnations(): Map<string, PtyIncarnationId | null>
  disposeHeadlessTerminal(): (ptyId: string) => void
  getOsc7ScanTailByPtyId(): Map<string, string>
  getTerminalCwdByPtyId(): Map<string, string>
  getTerminalFileUriHostnameByPtyId(): Map<string, string>
  getHeadlessTerminals(): { has(ptyId: string): boolean }
  replaceHeadlessTerminalAfterExecutionContextChange(): (ptyId: string) => void
  getTerminalSpawnCommandsByPtyId(): Map<string, string>
}

export class RuntimeTerminalExecutionContext {
  constructor(private readonly host: RuntimeTerminalExecutionContextHost) {}
  preparePtyExecutionContext(
    ptyId: string,
    wslDistro: string | null,
    options: { resetIncarnation?: boolean; preserveExisting?: boolean } = {}
  ): boolean {
    const pty = this.host.getPtysById().get(ptyId)
    const hadExistingContext = this.host.getWslDistroByPtyId().has(ptyId) || pty !== undefined
    if (options.preserveExisting && hadExistingContext) {
      // Why: attach-time settings are only a fallback; a live PTY's recorded
      // execution namespace remains authoritative until its provider replies.
      return false
    }

    if (options.resetIncarnation) {
      // Why: an explicit new lifecycle supersedes an unidentifiable exit from the reused PTY id.
      this.host.getEarlyExitedPtyIncarnations().delete(ptyId)
      this.host.disposeHeadlessTerminal()(ptyId)
      this.host.getOsc7ScanTailByPtyId().delete(ptyId)
      this.host.getTerminalCwdByPtyId().delete(ptyId)
      this.host.getTerminalFileUriHostnameByPtyId().delete(ptyId)
      this.host.getWslDistroByPtyId().delete(ptyId)
    }

    const previous = this.host.getWslDistroByPtyId().get(ptyId) ?? null
    if (wslDistro) {
      this.host.getWslDistroByPtyId().set(ptyId, wslDistro)
    } else {
      this.host.getWslDistroByPtyId().delete(ptyId)
    }
    if (pty) {
      pty.wslDistro = wslDistro
    }
    if (
      !options.resetIncarnation &&
      previous !== wslDistro &&
      this.host.getHeadlessTerminals().has(ptyId)
    ) {
      // Why: bytes parsed with two distro namespaces would leave an internally
      // inconsistent CWD; rebuild from the provider's authoritative snapshot.
      this.host.getTerminalCwdByPtyId().delete(ptyId)
      this.host.replaceHeadlessTerminalAfterExecutionContextChange()(ptyId)
    }
    return options.resetIncarnation === true || !hadExistingContext || previous !== wslDistro
  }

  noteTerminalSpawnCommand(ptyId: string, command: string | null | undefined): void {
    const trimmed = typeof command === 'string' ? command.trim() : ''
    if (trimmed.length > 0) {
      this.host.getTerminalSpawnCommandsByPtyId().set(ptyId, trimmed)
    }
  }
}
