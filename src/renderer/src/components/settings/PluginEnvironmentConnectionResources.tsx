import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type { EnvironmentRecipeResource } from '../../../../shared/environment-recipe-protocol'
import type { EnvironmentProviderSshPreview } from '../../../../shared/plugins/plugin-environment-provider-ssh-api'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { sshTargetConnectFailureText } from '@/ssh/ssh-host-server-status-copy'
import { PluginEnvironmentResources } from './PluginEnvironmentResources'
import { PluginEnvironmentConnectionDialog } from './PluginEnvironmentConnectionDialog'

export function PluginEnvironmentConnectionResources({
  provider,
  onReviewing,
  ...resources
}: Omit<ComponentProps<typeof PluginEnvironmentResources>, 'onConnect'> & {
  provider: PluginEnvironmentProviderEntry
  onReviewing(operationId: string | null): void
}): React.JSX.Element {
  const [preview, setPreview] = useState<EnvironmentProviderSshPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<string | null>(null)
  const mounted = useMountedRef()
  useEffect(
    () => () => {
      if (pending.current) {
        void window.api.plugins.cancelEnvironmentProvider?.({ operationId: pending.current })
      }
    },
    []
  )
  const prepare = async (resource: EnvironmentRecipeResource): Promise<void> => {
    const api = window.api.plugins.prepareEnvironmentProviderSsh
    if (pending.current || !api || provider.configuration.status !== 'ready') {
      return
    }
    const operationId = createBrowserUuid()
    pending.current = operationId
    onReviewing(operationId)
    setError(null)
    try {
      const result = await api({
        operationId,
        review: { ...provider.review, contextId: provider.configuration.contextId },
        resourceId: resource.id,
        expectedRevision: resource.revision
      })
      if (mounted.current) {
        setPreview(result)
      }
    } catch {
      if (mounted.current) {
        setError(
          translate(
            'auto.components.settings.PluginEnvironmentConnectionResources.reviewError',
            'Could not confirm this machine’s current connection details. Refresh inventory and check the provider before connecting.'
          )
        )
      }
    } finally {
      pending.current = null
      if (mounted.current) {
        onReviewing(null)
      }
    }
  }
  const save = async (identityFile?: string): Promise<void> => {
    const api = window.api.plugins.saveEnvironmentProviderSsh
    if (!preview || !api) {
      throw new Error('Provider SSH support is unavailable')
    }
    const target = await api({
      ticketId: preview.ticketId,
      ...(identityFile ? { identityFile } : {})
    })
    if (!mounted.current) {
      return
    }
    setPreview(null)
    try {
      useAppStore.getState().setSshTargetsMetadata(await window.api.ssh.listTargets())
      const state = await window.api.ssh.connect({ targetId: target.id })
      if (!state || state.status !== 'connected') {
        throw new Error('SSH connection was not confirmed')
      }
    } catch (cause) {
      if (mounted.current) {
        setError(
          sshTargetConnectFailureText(
            target.id,
            cause,
            translate(
              'auto.components.settings.PluginEnvironmentConnectionResources.connectionError',
              'The SSH host is saved, but could not connect. Check its credentials and host-key trust in SSH Hosts.'
            )
          )
        )
      }
    }
  }
  const supported = Boolean(
    window.api.plugins.prepareEnvironmentProviderSsh &&
    window.api.plugins.saveEnvironmentProviderSsh
  )
  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <PluginEnvironmentResources
        {...resources}
        onConnect={supported ? (resource) => void prepare(resource) : undefined}
      />
      {preview ? (
        <PluginEnvironmentConnectionDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onSave={save}
        />
      ) : null}
    </>
  )
}
