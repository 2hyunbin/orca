import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/**
 * The user asked for a terminal and the host never mirrored one, so no pane exists to show why.
 * No retry button: a reply lost in transit may still have created it.
 */
export function notifyWebRuntimeTerminalCreateFailure(
  kind: 'refused' | 'unconfirmed',
  message: string
): void {
  if (kind === 'unconfirmed') {
    toast.error(
      translate(
        'auto.runtime.webRuntimeSession.terminalCreateUnconfirmed',
        'Orca lost contact with the host before it confirmed the new terminal.'
      ),
      {
        description: translate(
          'auto.runtime.webRuntimeSession.terminalCreateUnconfirmedHint',
          'It may still appear when the host answers again. If it doesn’t, open a new terminal.'
        )
      }
    )
    return
  }
  toast.error(
    translate(
      'auto.runtime.webRuntimeSession.terminalCreateFailed',
      'Couldn’t open a new terminal on the host.'
    ),
    message ? { description: message } : undefined
  )
}
