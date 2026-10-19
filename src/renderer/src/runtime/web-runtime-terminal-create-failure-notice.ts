import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** The user asked for a terminal and the host failed to make one; say why and offer a retry. */
export function notifyWebRuntimeTerminalCreateFailure(message: string, retry: () => void): void {
  toast.error(
    translate(
      'auto.runtime.webRuntimeSession.terminalCreateFailed',
      'Couldn’t open a new terminal on the host.'
    ),
    {
      ...(message ? { description: message } : {}),
      action: {
        label: translate('auto.runtime.webRuntimeSession.terminalCreateRetry', 'Try again'),
        onClick: retry
      }
    }
  )
}
