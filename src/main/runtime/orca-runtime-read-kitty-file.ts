import { OrcaRuntimeWithResolveWorktreeSelector } from './orca-runtime-resolve-worktree-selector'
import { getProviderForPty } from '../ipc/pty/provider/registry'
import { readTerminalKittyFile } from './terminal-kitty-file-read'
import type {
  TerminalKittyFileRequest,
  TerminalKittyFileResult
} from '../../shared/terminal-kitty-file'

export class OrcaRuntimeWithReadKittyFile extends OrcaRuntimeWithResolveWorktreeSelector {
  async readKittyFile(
    handle: string,
    request: TerminalKittyFileRequest,
    signal?: AbortSignal
  ): Promise<TerminalKittyFileResult> {
    const leaf = this.resolveLiveLeafForHandle(handle)
    const ptyId = leaf?.ptyId
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    if (!ptyId || !pty?.connected) {
      throw new Error('no_connected_pty')
    }
    if (pty.connectionId) {
      throw new Error('Kitty image file must be read on the terminal execution host')
    }
    getProviderForPty(ptyId)
    const incarnation = pty.incarnationId
    if (request.expectedIncarnationId && request.expectedIncarnationId !== incarnation) {
      throw new Error('terminal_handle_stale')
    }
    const workspace = await this.resolveWorktreeSelector(`id:${pty.worktreeId}`)
    const result = await readTerminalKittyFile(
      request,
      {
        workspacePath: workspace.path,
        wslDistro: this.wslDistroByPtyId.get(ptyId) ?? pty.wslDistro
      },
      signal
    )
    if (
      this.resolveLiveLeafForHandle(handle)?.ptyId !== ptyId ||
      !pty.connected ||
      this.ptysById.get(ptyId) !== pty ||
      pty.incarnationId !== incarnation
    ) {
      throw new Error('terminal_handle_stale')
    }
    return result
  }
}
