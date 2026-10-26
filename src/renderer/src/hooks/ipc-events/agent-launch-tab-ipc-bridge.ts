import type { AgentLaunchTabPublishRequest } from '../../../../shared/agent-launch-tab-publication'
import { publishAgentLaunchTab } from '@/lib/agent-launch-tab-publication'
import { applyAgentLaunchPaneVerdict } from '@/lib/agent-launch-pane-verdict-application'
import { keepAgentLaunchTabMainWrote } from '@/lib/agent-launch-tab-main-written'
import { afterLayoutFrame } from '@/runtime/layout-frame-position'
import { useAppStore } from '@/store'
import type { PaneAgentLaunchConfig } from '../../../../shared/sleeping-agent-launch-config'
import { tryMakePaneKey } from './agent-status-routing'

function replyToPublish(request: AgentLaunchTabPublishRequest): void {
  try {
    window.api.ui.replyAgentLaunchTabPublish({
      requestId: request.requestId,
      ...(request.shownByMain
        ? keepAgentLaunchTabMainWrote(request)
        : publishAgentLaunchTab(request))
    })
  } catch (error) {
    window.api.ui.replyAgentLaunchTabPublish({
      requestId: request.requestId,
      error: error instanceof Error ? error.message : 'agent_launch_tab_publish_failed'
    })
  }
}

function rememberAgentLaunchConfig(event: PaneAgentLaunchConfig): void {
  const paneKey = tryMakePaneKey(event.tabId, event.leafId)
  if (paneKey) {
    useAppStore.getState().registerAgentLaunchConfig(paneKey, event.launchConfig, {
      ...(event.launchAgent ? { agentType: event.launchAgent } : {}),
      ...(event.launchToken ? { launchToken: event.launchToken } : {}),
      tabId: event.tabId,
      leafId: event.leafId
    })
  }
}

export function registerAgentLaunchTabIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onPublishAgentLaunchTab((request) =>
      // A tab main wrote is kept once this window holds the frame that draws it.
      request.shownByMain
        ? afterLayoutFrame(request.shownByMain.frameSeq, () => replyToPublish(request))
        : replyToPublish(request)
    ),
    window.api.ui.onAgentLaunchPaneVerdict(applyAgentLaunchPaneVerdict),
    window.api.ui.onAgentLaunchConfig(rememberAgentLaunchConfig)
  )
}
