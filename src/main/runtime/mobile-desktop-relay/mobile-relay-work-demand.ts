/** Explicit workspace/chat actions may wake a host; catalog and status observers never do. */
export function mobileRelayRequestsWork(method: string): boolean {
  return WORK_METHODS.has(method)
}

const WORK_METHODS = new Set([
  'worktree.activate',
  'agent.launch',
  'agent.launchReplay',
  'agentSession.createSupport',
  'agentSession.create',
  'agentSession.ensure',
  'agentSession.send',
  'agentSession.queuedMessageSend',
  'agentSession.queuedMessagesResume',
  'agentSession.subscribe',
  'nativeChat.subscribe',
  'session.tabs.subscribe',
  'terminal.subscribe',
  'clipboard.startImageUpload',
  'clipboard.saveImageAsTempFile'
])

export type MobileRelayWorkDemand = {
  ready: Promise<void>
  release: () => void
}
