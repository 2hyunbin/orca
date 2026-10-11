import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

/** Copies a single-use, owner-approved pairing code; the legacy link above stays for older clients. */
export function SingleUsePairingCodeButton({ address }: { address: string }): React.JSX.Element {
  const [minting, setMinting] = useState(false)
  const mountedRef = useMountedRef()

  const copyCode = async (): Promise<void> => {
    setMinting(true)
    try {
      const result = await window.api.mobile.createLocalPairingTicket(
        address ? { address } : undefined
      )
      if (!result.available) {
        toast.error(
          result.guidance ??
            translate(
              'auto.components.settings.SingleUsePairingCodeButton.unavailable',
              'Could not create a pairing code. Check that Orca can listen on the network.'
            )
        )
        return
      }
      await window.api.ui.writeClipboardText(result.code)
      toast.success(
        translate(
          'auto.components.settings.SingleUsePairingCodeButton.copied',
          'Copied a single-use pairing code. It expires in 10 minutes.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.SingleUsePairingCodeButton.failed',
              'Failed to copy the pairing code.'
            )
      )
    } finally {
      if (mountedRef.current) {
        setMinting(false)
      }
    }
  }

  return (
    <div className="space-y-1">
      <Button variant="outline" size="sm" disabled={minting} onClick={() => void copyCode()}>
        {translate(
          'auto.components.settings.SingleUsePairingCodeButton.label',
          'Copy single-use pairing code'
        )}
      </Button>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.SingleUsePairingCodeButton.help',
          'Works once and expires in 10 minutes. When a device uses it, you approve it here after comparing a code.'
        )}
      </p>
    </div>
  )
}
