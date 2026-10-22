import { OrcaRuntimeService } from '../orca-runtime'

export class TerminalCloseRuntime extends OrcaRuntimeService {
  dropArchivedPtyRecord(ptyId: string): void {
    this.dropDisconnectedPtyRecord(ptyId)
  }
}
