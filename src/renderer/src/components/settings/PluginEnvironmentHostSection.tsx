import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import { openPluginEnvironmentProviderSession } from '@/runtime/plugin-environment-provider-session-client'
import { Button } from '../ui/button'
import {
  PluginEnvironmentHostContext,
  type PluginEnvironmentHost
} from './plugin-environment-host-context'
import { PluginEnvironmentProvidersSection } from './PluginEnvironmentProvidersSection'
import { SettingsHostScopeUnavailableNotice } from './SettingsHostScopePicker'
import type { SettingsHostScope } from './settings-host-scope'

type RemoteProviderSelection = {
  environmentId: string
  pairingRevision: number
  runtimeId: string
  hostLabel: string
  onBrowsePlugins(): void
}

export function PluginEnvironmentHostSection({
  hostScope,
  onBrowsePlugins
}: {
  hostScope: SettingsHostScope
  onBrowsePlugins(): void
}): React.JSX.Element {
  const environmentId =
    hostScope.target.kind === 'environment' ? hostScope.target.environmentId : null
  const environment = useAppStore((state) =>
    state.runtimeEnvironments.find((value) => value.id === environmentId)
  )
  const observedRuntimeId = useAppStore((state) =>
    environmentId
      ? state.runtimeStatusByEnvironmentId.get(environmentId)?.status?.runtimeId
      : undefined
  )
  if (!hostScope.available) {
    return <SettingsHostScopeUnavailableNotice />
  }
  if (!environmentId) {
    return <PluginEnvironmentProvidersSection onBrowsePlugins={onBrowsePlugins} />
  }
  const runtimeId = observedRuntimeId ?? environment?.runtimeId
  const revision = environment?.pairingRevision ?? environment?.createdAt
  const hostLabel = environment?.name ?? environmentId
  if (!runtimeId || revision === undefined) {
    return (
      <ProviderReviewNotice
        hostLabel={hostLabel}
        failed
        onRetry={() => {
          void useAppStore.getState().refreshRuntimeEnvironmentStatus(environmentId)
        }}
      />
    )
  }
  return (
    <RemoteProviderReview
      key={`${environmentId}:${revision}:${runtimeId}:${hostLabel}`}
      environmentId={environmentId}
      runtimeId={runtimeId}
      pairingRevision={revision}
      hostLabel={hostLabel}
      onBrowsePlugins={onBrowsePlugins}
    />
  )
}

function RemoteProviderReview(selection: RemoteProviderSelection): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  return (
    <RemoteProviderConnection
      key={attempt}
      {...selection}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  )
}

function RemoteProviderConnection({
  environmentId,
  pairingRevision,
  runtimeId,
  hostLabel,
  onBrowsePlugins,
  onRetry
}: RemoteProviderSelection & {
  onRetry(): void
}): React.JSX.Element {
  const [host, setHost] = useState<PluginEnvironmentHost | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const lifetime = new AbortController()
    let session: Awaited<ReturnType<typeof openPluginEnvironmentProviderSession>> | undefined
    void openPluginEnvironmentProviderSession(
      {
        sessionId: createBrowserUuid(),
        environmentId,
        pairingRevision,
        runtimeId
      },
      () => {
        setHost(null)
        setFailed(true)
      },
      lifetime.signal
    )
      .then((opened) => {
        session = opened
        if (lifetime.signal.aborted) {
          opened.close()
          return
        }
        setHost({ api: opened.api, hostLabel, isRemote: true, environmentId })
      })
      .catch(() => {
        if (!lifetime.signal.aborted) {
          setFailed(true)
        }
      })
    return () => {
      lifetime.abort()
      session?.close()
    }
  }, [environmentId, pairingRevision, runtimeId, hostLabel])
  if (!host) {
    return <ProviderReviewNotice hostLabel={hostLabel} failed={failed} onRetry={onRetry} />
  }
  return (
    <PluginEnvironmentHostContext.Provider value={host}>
      <PluginEnvironmentProvidersSection onBrowsePlugins={onBrowsePlugins} />
    </PluginEnvironmentHostContext.Provider>
  )
}

function ProviderReviewNotice({
  hostLabel,
  failed,
  onRetry
}: {
  hostLabel: string
  failed: boolean
  onRetry(): void
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">
        {translate(
          'auto.components.settings.PluginEnvironmentProvidersSection.title',
          'Environment providers'
        )}
      </h3>
      <p className="text-xs text-muted-foreground">{hostLabel}</p>
      <p role={failed ? 'alert' : 'status'} className="text-sm text-muted-foreground">
        {failed
          ? translate(
              'auto.components.settings.PluginEnvironmentHostSection.unavailable',
              'Could not open providers on this host. Check its connection and Orca version, then reopen the review.'
            )
          : translate(
              'auto.components.settings.PluginEnvironmentHostSection.opening',
              'Opening providers on this host…'
            )}
      </p>
      {failed ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {translate(
            'auto.components.settings.PluginEnvironmentHostSection.retry',
            'Reopen review'
          )}
        </Button>
      ) : null}
    </section>
  )
}
