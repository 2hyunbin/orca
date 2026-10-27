import { toast } from 'sonner'
import type {
  GoogleCookieClearLocalTarget,
  GoogleCookieClearResult
} from '../../../shared/browser-google-cookie-clear'
import { BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY } from '../../../shared/browser-runtime-capabilities'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import {
  getBrowserProfilesForHost,
  getBrowserSettingsHostId,
  getBrowserSettingsRuntimeEnvironmentId
} from '@/store/slices/browser/browser-host-state'
import { translate } from '@/i18n/i18n'

export type GoogleCookieClearOffer = {
  executionMachine: 'client' | 'remote'
  onClick: () => void
}

type ClearTarget = {
  profileId: string
  label: string
} & (
  | { local: GoogleCookieClearLocalTarget }
  | {
      environmentId: string
      pairingRevision: number
      runtimeId: string
    }
)

async function captureTarget(profileId: string, label?: string): Promise<ClearTarget | null> {
  const state = useAppStore.getState()
  const hostId = getBrowserSettingsHostId(state)
  const environmentId = getBrowserSettingsRuntimeEnvironmentId(state)
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  const status = environmentId
    ? state.runtimeStatusByEnvironmentId.get(environmentId)?.status
    : null
  const profileLabel =
    label ?? getBrowserProfilesForHost(state, hostId).find((entry) => entry.id === profileId)?.label
  if (!profileLabel) {
    return null
  }
  const local = await window.api.browser.sessionGoogleCookieClearTarget({
    profileId,
    environmentId
  })
  if (local) {
    return { profileId, label: profileLabel, local }
  }
  if (!environment || !status?.capabilities?.includes(BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY)) {
    return null
  }
  return {
    profileId,
    label: profileLabel,
    environmentId: environment.id,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    runtimeId: status.runtimeId
  }
}

export async function offerGoogleCookieClear(
  profileId: string,
  label: string | undefined,
  confirm: ConfirmationDialogContextValue,
  run: (target: () => Promise<void>) => void
): Promise<GoogleCookieClearOffer | undefined> {
  const target = await captureTarget(profileId, label).catch(() => null)
  if (!target) {
    return undefined
  }
  const values = { profile: target.label }
  return {
    executionMachine: 'local' in target ? 'client' : 'remote',
    onClick: () =>
      run(async () => {
        if (
          !(await confirm({
            title: translate(
              'browser.googleCookieClear.confirmTitle',
              'Clear Google cookies from {{profile}}?',
              values
            ),
            description: translate(
              'browser.googleCookieClear.confirmDescription',
              "You'll be signed out of Google in Orca's browser for this profile. Other sites stay signed in."
            ),
            confirmLabel: translate('browser.googleCookieClear.clear', 'Clear'),
            cancelLabel: translate('browser.googleCookieClear.cancel', 'Cancel'),
            confirmVariant: 'destructive'
          }))
        ) {
          return
        }
        let result: GoogleCookieClearResult = 'unverified'
        try {
          result =
            'local' in target
              ? await window.api.browser.sessionClearGoogleCookies(target.local)
              : await callRuntimeRpc<GoogleCookieClearResult>(
                  { kind: 'environment', environmentId: target.environmentId },
                  'browser.profileClearGoogleCookies',
                  { profileId: target.profileId },
                  {
                    expectedEnvironmentPairingRevision: target.pairingRevision,
                    expectedEnvironmentRuntimeId: target.runtimeId
                  }
                )
        } catch {
          /* The result below also covers a disconnected or replaced destination. */
        }
        const messages: Record<GoogleCookieClearResult, string> = {
          cleared: translate(
            'browser.googleCookieClear.cleared',
            'Google cookies cleared from {{profile}}.',
            values
          ),
          empty: translate(
            'browser.googleCookieClear.empty',
            'No Google cookies to clear in {{profile}}.',
            values
          ),
          remaining: translate(
            'browser.googleCookieClear.remaining',
            "Some Google cookies couldn't be removed from {{profile}}. Try again.",
            values
          ),
          unverified: translate(
            'browser.googleCookieClear.unverified',
            "Couldn't check {{profile}}'s Google cookies. Try again.",
            values
          )
        }
        const message = messages[result] ?? messages.unverified
        if (result === 'cleared' || result === 'empty') {
          toast.success(message)
        } else {
          toast.error(message)
        }
      })
  }
}
