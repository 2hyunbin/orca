import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import {
  nodeMirrorOfferLabel,
  nodeMirrorRecovery,
  nodeMirrorSettingsLabel
} from '@/ssh/ssh-host-node-download-copy'
import {
  openNodeDistMirrorDialog,
  openNodeDistMirrorSettings
} from '@/ssh/node-dist-mirror-recovery'
import { Button } from '../ui/button'

/** The way out of a setup that couldn't download Node.js: set a mirror, or check the one set. */
export function SshHostNodeMirrorAction({
  targetId,
  status
}: {
  targetId: string
  status: SshManagedServerStatus | undefined
}): React.JSX.Element | null {
  const configuredMirror = useAppStore((s) => s.settings?.nodeDistMirrorUrl)
  const recovery = nodeMirrorRecovery(status, configuredMirror)
  if (!recovery) {
    return null
  }
  return recovery === 'offer' ? (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => openNodeDistMirrorDialog(targetId)}
    >
      {nodeMirrorOfferLabel()}
    </Button>
  ) : (
    <Button type="button" size="xs" variant="link" onClick={openNodeDistMirrorSettings}>
      {nodeMirrorSettingsLabel()}
    </Button>
  )
}
