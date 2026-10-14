import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getEnvironmentSshStateGeneration } from '@/store/slices/runtime-environment-ssh'
import { resyncRuntimeEnvironmentSshTargets } from '@/runtime/runtime-environment-ssh-state'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { usePluginEnvironmentHost } from './plugin-environment-host-context'
import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import type { PluginEnvironmentProviderEntry } from '../../../../shared/plugins/plugin-environment-provider-api'
import type { EnvironmentRecipeResource } from '../../../../shared/environment-recipe-protocol'
import type { EnvironmentProviderSshPreview } from '../../../../shared/plugins/plugin-environment-provider-ssh-api'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  sshConnectFailureText,
  sshTargetConnectFailureText
} from '@/ssh/ssh-host-server-status-copy'
import { compactIpcErrorMessage } from '@/lib/ipc-error'
import { PluginEnvironmentResources } from './PluginEnvironmentResources'
import { PluginEnvironmentConnectionDialog } from './PluginEnvironmentConnectionDialog'

export function PluginEnvironmentConnectionResources({
  provider,
  onReviewing,
  onConnecting,
  ...resources
}: Omit<ComponentProps<typeof PluginEnvironmentResources>, 'onConnect'> & {
  provider: PluginEnvironmentProviderEntry
  onReviewing(operationId: string | null): void
  onConnecting?(busy: boolean): void
}): React.JSX.Element {
  const { api: providerApi, isRemote, environmentId, hostLabel } = usePluginEnvironmentHost()
  const [preview, setPreview] = useState<EnvironmentProviderSshPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectingVisible, setConnectingVisible] = useState(false)
  const [connectingName, setConnectingName] = useState<string | null>(null)
  const saving = useRef(false)
  const pending = useRef<string | null>(null)
  const reviewTicket = useRef<string | null>(null)
  const mounted = useMountedRef()
  useEffect(
    () => () => {
      onConnecting?.(false)
      if (pending.current) {
        void providerApi.cancelEnvironmentProvider?.({ operationId: pending.current })
      }
      if (reviewTicket.current) {
        void providerApi
          .discardEnvironmentProviderSshReview?.({ ticketId: reviewTicket.current })
          .catch(() => {})
      }
    },
    [providerApi, onConnecting]
  )
  const prepare = async (resource: EnvironmentRecipeResource): Promise<void> => {
    const api = providerApi.prepareEnvironmentProviderSsh
    if (pending.current || saving.current || !api || provider.configuration.status !== 'ready') {
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
        reviewTicket.current = result.ticketId
        setPreview(result)
      } else {
        void providerApi
          .discardEnvironmentProviderSshReview?.({ ticketId: result.ticketId })
          .catch(() => {})
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
  const performSave = async (identityFile?: string): Promise<void> => {
    const api = providerApi.saveEnvironmentProviderSsh
    if (!preview || !api) {
      throw new Error('Provider SSH support is unavailable')
    }
    if (isRemote && !environmentId) {
      throw new Error('The selected SSH control host is unavailable')
    }
    const generation = environmentId ? getEnvironmentSshStateGeneration(environmentId) : undefined
    const target = await api({
      ticketId: preview.ticketId,
      ...(preview.endpointUpdate ? { approveEndpointUpdate: true as const } : {}),
      ...(identityFile ? { identityFile } : {})
    })
    if (!mounted.current) {
      return
    }
    reviewTicket.current = null
    setConnectingName(preview.resource.name)
    setPreview(null)
    const feedbackTimer = setTimeout(() => {
      if (mounted.current) {
        setConnectingVisible(true)
      }
    }, 200)
    try {
      let state: SshConnectionState | null
      if (isRemote) {
        if (!environmentId || !providerApi.connectEnvironmentProviderSsh || !target.generation) {
          throw new Error('Provider SSH connection support is unavailable on this host')
        }
        state = await providerApi.connectEnvironmentProviderSsh({
          operationId: createBrowserUuid(),
          targetId: target.id,
          expectedGeneration: target.generation
        })
        if (mounted.current && state && generation !== undefined) {
          useAppStore
            .getState()
            .setEnvironmentSshConnectionState(environmentId, target.id, state, generation)
          void resyncRuntimeEnvironmentSshTargets(environmentId).catch(() => undefined)
        }
      } else {
        useAppStore.getState().setSshTargetsMetadata(await window.api.ssh.listTargets())
        state = await window.api.ssh.connect({ targetId: target.id })
      }
      if (!state || state.status !== 'connected') {
        throw new Error('SSH connection was not confirmed')
      }
      if (mounted.current) {
        toast.success(
          translate(
            'auto.components.settings.PluginEnvironmentConnectionResources.connected',
            'Connected to {{machine}} on {{host}}',
            { machine: preview.resource.name, host: hostLabel }
          )
        )
      }
    } catch (cause) {
      if (mounted.current) {
        const fallback = translate(
          'auto.components.settings.PluginEnvironmentConnectionResources.connectionError',
          'Could not connect. Check its credentials and host-key trust in SSH Hosts.'
        )
        const message = isRemote
          ? sshConnectFailureText(
              environmentId
                ? useAppStore
                    .getState()
                    .sshStateByEnvironment.get(environmentId)
                    ?.connectionStates.get(target.id)
                : undefined,
              cause instanceof Error ? cause.message : fallback
            )
          : sshTargetConnectFailureText(target.id, cause, fallback)
        const reason = compactIpcErrorMessage(message) ?? fallback
        setError(
          translate(
            'auto.components.settings.PluginEnvironmentConnectionResources.savedConnectionError',
            'The SSH host is saved. {{reason}}',
            { reason }
          )
        )
      }
    } finally {
      clearTimeout(feedbackTimer)
    }
  }
  const save = async (identityFile?: string): Promise<void> => {
    if (saving.current) {
      return
    }
    saving.current = true
    onConnecting?.(true)
    try {
      await performSave(identityFile)
    } finally {
      saving.current = false
      if (mounted.current) {
        setConnectingName(null)
        setConnectingVisible(false)
        onConnecting?.(false)
      }
    }
  }
  const supported = Boolean(
    providerApi.prepareEnvironmentProviderSsh &&
    providerApi.saveEnvironmentProviderSsh &&
    (!isRemote || providerApi.connectEnvironmentProviderSsh)
  )
  return (
    <>
      <div className="min-h-6">
        {connectingName && connectingVisible ? (
          <div className="flex items-center gap-2" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.settings.PluginEnvironmentConnectionResources.connecting',
                'Connecting to {{machine}} on {{host}}…',
                { machine: connectingName, host: hostLabel }
              )}
            </p>
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <PluginEnvironmentResources
        {...resources}
        blocked={resources.blocked || connectingName !== null}
        onConnect={supported ? (resource) => void prepare(resource) : undefined}
      />
      {preview ? (
        <PluginEnvironmentConnectionDialog
          preview={preview}
          onClose={() => {
            reviewTicket.current = null
            setPreview(null)
            void providerApi
              .discardEnvironmentProviderSshReview?.({ ticketId: preview.ticketId })
              .catch(() => {})
          }}
          onSave={save}
        />
      ) : null}
    </>
  )
}
