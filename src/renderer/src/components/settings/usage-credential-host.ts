import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { UsageCredentialsHostOutdatedError } from '@/runtime/runtime-usage-credentials-client'

/** Where a usage key is saved: this computer, or the Settings host whose usage poller reads it. */
export type UsageCredentialHost = {
  owner: RuntimeClientTarget
  /** Null for this computer. */
  label: string | null
}

export const LOCAL_USAGE_CREDENTIAL_HOST: UsageCredentialHost = {
  owner: { kind: 'local' },
  label: null
}

/** `unreachable` is unverifiable, not "no key": the host may well hold one. */
export type UsageCredentialAccess = 'checking' | 'ready' | 'outdated' | 'unreachable'

export function usageCredentialAccessAfterError(error: unknown): 'outdated' | 'unreachable' {
  return error instanceof UsageCredentialsHostOutdatedError ? 'outdated' : 'unreachable'
}

export function usageCredentialAccessNotice(
  host: UsageCredentialHost,
  access: UsageCredentialAccess
): string | null {
  if (host.label === null) {
    return null
  }
  // Why: an unanswered host is not one without a key.
  if (access === 'checking') {
    return translate(
      'auto.components.settings.usageCredentialHost.checking',
      'Checking {{host}}…',
      {
        host: host.label
      }
    )
  }
  if (access === 'outdated') {
    return translate(
      'auto.components.settings.usageCredentialHost.outdated',
      'Update Orca on {{host}} to save this key there.',
      { host: host.label }
    )
  }
  if (access === 'unreachable') {
    return translate(
      'auto.components.settings.usageCredentialHost.unreachable',
      'Could not reach {{host}}, so whether a key is saved there is unknown.',
      { host: host.label }
    )
  }
  return null
}

/** The storage line under a saved key: this computer, or the selected host. */
export function usageCredentialStoredLabel(host: UsageCredentialHost): string {
  return host.label === null
    ? translate('auto.components.settings.AccountsPane.0b8c1c7e02', 'Stored locally')
    : translate('auto.components.settings.usageCredentialHost.storedOnHost', 'Stored on {{host}}', {
        host: host.label
      })
}
