import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

export function createRemoteRestartOfferLifecycle({
  read,
  requestDialog,
  currentAction
}: {
  read: (current: () => boolean) => Promise<{ candidates: readonly ResumeCandidate[] }>
  requestDialog: () => void
  currentAction: () => number
}) {
  let runtimeId: string | undefined
  let readyKey: string | undefined
  let createdHere = new Set<string>()

  async function ready(nextRuntimeId: string): Promise<void> {
    const changed = runtimeId !== nextRuntimeId
    runtimeId = nextRuntimeId
    const issued = currentAction()
    const readKey = readyKey
    try {
      createdHere = new Set((await window.api.runtimeEnvironments.desktopCreatedChatIds?.()) ?? [])
    } catch {
      createdHere = new Set()
    }
    const current = () =>
      runtimeId === nextRuntimeId && readyKey === readKey && currentAction() === issued
    const result = await read(current)
    if (current() && changed && result.candidates.length > 0) {
      requestDialog()
    }
  }

  return {
    observeRuntimeStatus: (status: RuntimeEnvironmentStatus | undefined) => {
      const snapshot = status?.snapshot
      const verified = snapshot
        ? snapshot.verification === 'verified' && snapshot.transport === 'ready'
        : !!status?.status
      const id = verified ? status?.status?.runtimeId : undefined
      const nextKey = id ? `${id}:${status?.hostContactEpoch ?? 0}` : undefined
      if (nextKey === readyKey) {
        return
      }
      readyKey = nextKey
      if (id) {
        void ready(id)
      }
    },
    startedHere: (sessionId: string) => createdHere.has(sessionId)
  }
}
