import { useEffect, useState } from 'react'
import type {
  PairingApprovalAnswer,
  PairingApprovalPrompt
} from '../../../../shared/pairing-approval-prompt'
import { PairingApprovalDialog } from './PairingApprovalDialog'

/** Shows the host's pairing approvals one at a time; a prompt the host withdrew disappears. */
export function PairingApprovalHost(): React.JSX.Element | null {
  const [prompts, setPrompts] = useState<PairingApprovalPrompt[]>([])

  useEffect(() => {
    const mobile = window.api?.mobile
    const dropPrompt = (requestId: string): void =>
      setPrompts((current) => current.filter((prompt) => prompt.requestId !== requestId))
    const unsubscribeRequested = mobile?.onPairingApprovalRequested?.((prompt) =>
      setPrompts((current) => [...current, prompt])
    )
    const unsubscribeCancelled = mobile?.onPairingApprovalCancelled?.(({ requestId }) =>
      dropPrompt(requestId)
    )
    return () => {
      unsubscribeRequested?.()
      unsubscribeCancelled?.()
    }
  }, [])

  const current = prompts[0]
  if (!current) {
    return null
  }
  const answer = (reply: PairingApprovalAnswer): void => {
    setPrompts((pending) => pending.filter((prompt) => prompt.requestId !== reply.requestId))
    void window.api.mobile.answerPairingApproval(reply)
  }
  // Why keyed: a new prompt must never inherit a code typed for the previous one.
  return <PairingApprovalDialog key={current.requestId} prompt={current} onAnswer={answer} />
}
