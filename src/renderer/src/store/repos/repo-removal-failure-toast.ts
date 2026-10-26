import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { ERROR_TOAST_DURATION } from './repo-state'

/** An unreachable paired server gets a local-removal action instead of a dead-end error. */
export function toastProjectRemovalFailure(
  error: unknown,
  options: { hostUnreachable: boolean; removeLocally: () => void }
): void {
  toast.error(
    translate('auto.store.slices.repos.removeProjectFailed', 'Failed to remove project'),
    {
      description: options.hostUnreachable
        ? translate(
            'auto.store.slices.repos.removeProjectHostUnreachable',
            'Its server can’t be reached. Remove it from this desktop now, and Orca removes it from the server when it reconnects.'
          )
        : (readIpcErrorMessage(error) ?? String(error)),
      duration: ERROR_TOAST_DURATION,
      ...(options.hostUnreachable
        ? {
            action: {
              label: translate(
                'auto.store.slices.repos.removeProjectLocallyNow',
                'Remove from this desktop now'
              ),
              onClick: options.removeLocally
            }
          }
        : {})
    }
  )
}
