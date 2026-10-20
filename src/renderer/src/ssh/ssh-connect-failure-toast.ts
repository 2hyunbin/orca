import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { sshTargetConnectFailureText } from './ssh-host-server-status-copy'
import {
  nodeMirrorOfferLabel,
  nodeMirrorRecovery,
  nodeMirrorSettingsLabel
} from './ssh-host-node-download-copy'
import { openNodeDistMirrorDialog, openNodeDistMirrorSettings } from './node-dist-mirror-recovery'

/**
 * A failed connect's toast, with the Node.js mirror recovery when the setup couldn't download
 * Node. Only this computer's own SSH targets get it: a server's target reads that server's setting.
 */
export function toastSshConnectFailure(
  targetId: string,
  error: unknown,
  fallback: string,
  ownerEnvironmentId: string | null = null
): void {
  const text = sshTargetConnectFailureText(targetId, error, fallback)
  const { sshConnectionStates, settings } = useAppStore.getState()
  const recovery = ownerEnvironmentId
    ? null
    : nodeMirrorRecovery(
        sshConnectionStates.get(targetId)?.managedServer,
        settings?.nodeDistMirrorUrl
      )
  if (!recovery) {
    toast.error(text)
    return
  }
  toast.error(text, {
    action:
      recovery === 'offer'
        ? { label: nodeMirrorOfferLabel(), onClick: () => openNodeDistMirrorDialog(targetId) }
        : { label: nodeMirrorSettingsLabel(), onClick: openNodeDistMirrorSettings }
  })
}
