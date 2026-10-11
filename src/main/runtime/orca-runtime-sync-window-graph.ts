import type { RuntimeSessionWindowGraph } from './session-graph/session-window-graph'
import { OrcaRuntimeWithAttachWindow } from './orca-runtime-attach-window'

export class OrcaRuntimeWithSyncWindowGraph extends OrcaRuntimeWithAttachWindow {
  shouldRelayTerminalBrowserOpens(
    ...args: Parameters<RuntimeSessionWindowGraph['shouldRelayTerminalBrowserOpens']>
  ): ReturnType<RuntimeSessionWindowGraph['shouldRelayTerminalBrowserOpens']> {
    return this.runtimeSessionWindowGraph.shouldRelayTerminalBrowserOpens(...args)
  }

  syncWindowGraph(
    ...args: Parameters<RuntimeSessionWindowGraph['syncWindowGraph']>
  ): ReturnType<RuntimeSessionWindowGraph['syncWindowGraph']> {
    return this.runtimeSessionWindowGraph.syncWindowGraph(...args)
  }
}
