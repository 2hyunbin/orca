import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import { openPluginCatalogSession } from '@/runtime/plugin-catalog-host-client'
import { pluginManagementSettingsSchema } from '../../../../shared/plugins/plugin-management-api'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SettingsHostScope } from './settings-host-scope'
import { PluginCatalogHostContext, type PluginCatalogHost } from './plugin-catalog-host-context'
import { PluginsSettingsSection } from './PluginsSettingsSection'
import { SettingsHostScopeUnavailableNotice } from './SettingsHostScopePicker'
import { SettingsSection } from './SettingsSection'
import { getPluginsSectionPresentation } from './plugins-search'
import { Button } from '../ui/button'

type Props = {
  hostScope: SettingsHostScope
  mounted: boolean
  settings: GlobalSettings
  updateSettings(updates: Partial<GlobalSettings>): Promise<void>
}
export function PluginCatalogHostSection(props: Props): React.JSX.Element {
  const environmentId =
    props.hostScope.target.kind === 'environment' ? props.hostScope.target.environmentId : null
  const environment = useAppStore((state) =>
    state.runtimeEnvironments.find((value) => value.id === environmentId)
  )
  const observedRuntimeId = useAppStore((state) =>
    environmentId
      ? state.runtimeStatusByEnvironmentId.get(environmentId)?.status?.runtimeId
      : undefined
  )
  if (!props.mounted) {
    return <SettingsSection id="plugins" {...getPluginsSectionPresentation()} />
  }
  if (!props.hostScope.available) {
    return <SettingsHostScopeUnavailableNotice />
  }
  if (!environmentId) {
    return <PluginsSettingsSection key="local" {...props} />
  }
  const runtimeId = observedRuntimeId ?? environment?.runtimeId
  const pairingRevision = environment?.pairingRevision ?? environment?.createdAt
  const hostLabel = environment?.name ?? environmentId
  if (!runtimeId || pairingRevision === undefined) {
    return (
      <CatalogReviewNotice
        hostLabel={hostLabel}
        failed
        onRetry={() => {
          void useAppStore.getState().refreshRuntimeEnvironmentStatus(environmentId)
        }}
      />
    )
  }
  return (
    <RemoteCatalogReview
      key={`${environmentId}:${pairingRevision}:${runtimeId}:${hostLabel}`}
      environmentId={environmentId}
      pairingRevision={pairingRevision}
      runtimeId={runtimeId}
      hostLabel={hostLabel}
      settings={props.settings}
    />
  )
}

type Selection = {
  environmentId: string
  pairingRevision: number
  runtimeId: string
  hostLabel: string
  settings: GlobalSettings
}
function RemoteCatalogReview(selection: Selection): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  return (
    <RemoteCatalogConnection
      key={attempt}
      {...selection}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  )
}
function RemoteCatalogConnection({
  environmentId,
  pairingRevision,
  runtimeId,
  hostLabel,
  settings,
  onRetry
}: Selection & { onRetry(): void }): React.JSX.Element {
  const [host, setHost] = useState<PluginCatalogHost | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const lifetime = new AbortController()
    let session: Awaited<ReturnType<typeof openPluginCatalogSession>> | undefined
    let refreshRequested = false
    let refreshTask: Promise<void> | undefined
    const unavailable = (): void => {
      if (!lifetime.signal.aborted) {
        setHost(null)
        setFailed(true)
      }
    }
    const refresh = (): Promise<void> => {
      refreshRequested = true
      refreshTask ??= readPreferences().finally(() => {
        refreshTask = undefined
      })
      return refreshTask
    }
    const readPreferences = async (): Promise<void> => {
      while (refreshRequested && session && !lifetime.signal.aborted) {
        refreshRequested = false
        const opened = session
        const [preferences, languagePacks, terminalThemes] = await Promise.all([
          opened.call('state', {}),
          opened.api.listLanguagePacks(),
          opened.api.listTerminalThemes?.() ?? []
        ])
        if (lifetime.signal.aborted) {
          return
        }
        setHost({
          api: opened.api,
          settings: preferences,
          hostLabel,
          languagePacks,
          terminalThemes,
          updateSettings: async (updates) => {
            await opened.call('updateSettings', pluginManagementSettingsSchema.parse(updates))
            await refresh()
          }
        })
      }
    }
    void openPluginCatalogSession(
      { sessionId: createBrowserUuid(), environmentId, pairingRevision, runtimeId },
      unavailable,
      lifetime.signal
    )
      .then(async (opened) => {
        session = opened
        if (lifetime.signal.aborted) {
          opened.close()
          return
        }
        opened.api.onChanged((change) => {
          if (change.environmentProviderId && !change.contentPacksChanged) {
            return
          }
          void refresh().catch(unavailable)
        })
        await refresh()
      })
      .catch(unavailable)
    return () => {
      lifetime.abort()
      session?.close()
    }
  }, [environmentId, pairingRevision, runtimeId, hostLabel])
  if (!host) {
    return <CatalogReviewNotice hostLabel={hostLabel} failed={failed} onRetry={onRetry} />
  }
  return (
    <PluginCatalogHostContext.Provider value={host}>
      <PluginsSettingsSection
        mounted
        settings={{ ...settings, ...host.settings }}
        updateSettings={host.updateSettings}
      />
    </PluginCatalogHostContext.Provider>
  )
}
function CatalogReviewNotice({
  hostLabel,
  failed,
  onRetry
}: {
  hostLabel: string
  failed: boolean
  onRetry(): void
}): React.JSX.Element {
  return (
    <SettingsSection id="plugins" {...getPluginsSectionPresentation(hostLabel)}>
      <p className="text-sm font-medium">{hostLabel}</p>
      <p role={failed ? 'alert' : 'status'} className="text-sm text-muted-foreground">
        {failed
          ? translate(
              'auto.components.settings.PluginCatalogHostSection.unavailable',
              'Could not open the catalog on this host. Check its connection and Orca version, then reopen the review.'
            )
          : translate(
              'auto.components.settings.PluginCatalogHostSection.opening',
              'Opening this host’s plugin catalog…'
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
    </SettingsSection>
  )
}
