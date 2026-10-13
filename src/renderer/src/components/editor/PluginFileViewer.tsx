import { pluginViewerFailureMessage } from './plugin-viewer-failure-message'
import { pluginViewerReloadProvenance } from './plugin-viewer-reload-provenance'
import { pluginViewerRuntimeIdentity } from './plugin-viewer-runtime-identity'
import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext,
  type EditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'
import { pluginViewerSelectedFileAccess } from './plugin-viewer-selected-file-access'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  pluginViewerOpenResponseSchema,
  type PluginViewerGuestLease
} from '../../../../shared/plugins/plugin-viewer-open'
import type { PluginViewerStatus } from '../../../../shared/plugins/plugin-viewer-frame-protocol'
import { attachPluginViewerWebview } from './plugin-viewer-webview'
import { pluginViewerChrome } from './plugin-viewer-chrome'
import { PluginFileViewerPicker } from './PluginFileViewerPicker'
import {
  pluginViewerViewportForTab,
  withPluginViewerTabViewport
} from '../../../../shared/plugins/plugin-viewer-view-state'

function ViewerSession({
  file,
  scopeId,
  dark,
  retry,
  pickerOpen
}: {
  file: OpenFile
  scopeId: string
  dark: boolean
  retry(): void
  pickerOpen: boolean
}): React.JSX.Element {
  const [snapshot] = useState(file)
  const [status, setStatus] = useState<PluginViewerStatus>({ type: 'loading' })
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let closed = false
    let lease: PluginViewerGuestLease | null = null
    let detach: (() => void) | null = null
    let provenance: EditorFileOperationProvenance | null = null
    const stopOwnerWatch = useAppStore.subscribe((current) => {
      if (closed || !provenance) {
        return
      }
      try {
        assertEditorFileOperationCurrent(current, snapshot.worktreeId, provenance)
      } catch {
        receive({ type: 'error', code: 'unauthorized' })
      }
    })
    const release = (): void => {
      stopOwnerWatch()
      const dispose = detach
      detach = null
      dispose?.()
      const closing = lease
      lease = null
      if (closing) {
        void window.api.plugins.closeViewerTab?.(closing).catch(() => {})
      }
    }
    const receive = (value: PluginViewerStatus): void => {
      if (closed) {
        return
      }
      setStatus(value)
      if (value.type === 'error') {
        closed = true
        release()
      }
      if (value.type === 'ready' || (value.type === 'error' && value.code === 'unauthorized')) {
        useAppStore.setState((state) => ({
          openFiles: state.openFiles.map((current) =>
            current.id === snapshot.id &&
            current.mode === 'plugin-viewer' &&
            current.fileContentReloadNonce === snapshot.fileContentReloadNonce &&
            current.pluginViewer &&
            current.pluginViewer.key === snapshot.pluginViewer?.key
              ? {
                  ...current,
                  operationProvenance:
                    value.type === 'ready'
                      ? (provenance ?? current.operationProvenance)
                      : current.operationProvenance,
                  pluginViewerOwnerExpired: value.type === 'error' ? true : undefined,
                  pluginViewer:
                    value.type === 'ready'
                      ? {
                          ...current.pluginViewer,
                          ...withPluginViewerTabViewport(
                            current.pluginViewer,
                            scopeId,
                            value.viewport
                          )
                        }
                      : current.pluginViewer
                }
              : current
          )
        }))
      }
    }
    void (async () => {
      const state = useAppStore.getState()
      let route
      let operation
      try {
        provenance =
          snapshot.operationProvenance ??
          captureEditorFileOperationProvenance(
            state,
            snapshot.worktreeId,
            snapshot.runtimeEnvironmentId,
            snapshot.runtimeEnvironmentId !== undefined
          )
        route = assertEditorFileOperationCurrent(state, snapshot.worktreeId, provenance)
        operation = getEditorFileOperationContext(
          state,
          { ...snapshot, operationProvenance: provenance },
          null
        )
      } catch {
        receive({ type: 'error', code: 'unauthorized' })
        return
      }
      if (!snapshot.pluginViewer || !window.api.plugins.openViewerTab) {
        receive({ type: 'error', code: 'unsupported_host' })
        return
      }
      const runtimeId = route.runtimeEnvironmentId
        ? pluginViewerRuntimeIdentity(state, route.runtimeEnvironmentId)
        : null
      if (route.runtimeEnvironmentId && !runtimeId) {
        receive({ type: 'error', code: 'unauthorized' })
        return
      }
      const response = pluginViewerOpenResponseSchema.parse(
        await window.api.plugins.openViewerTab({
          filePath: snapshot.filePath,
          workspaceId: snapshot.worktreeId,
          tabId: scopeId,
          viewerKey: snapshot.pluginViewer.key,
          executionHostId: route.runtimeEnvironmentId
            ? toRuntimeExecutionHostId(route.runtimeEnvironmentId)
            : route.executionHostId,
          expectedSshConnectionGeneration: route.runtimeEnvironmentId
            ? undefined
            : operation.expectedSshConnectionGeneration,
          expectedEnvironmentPairingRevision: provenance.generation.runtimePairingRevision,
          expectedEnvironmentRuntimeId: runtimeId ?? undefined,
          access: pluginViewerSelectedFileAccess(state, {
            ...snapshot,
            operationProvenance: provenance
          }),
          chrome: pluginViewerChrome(
            dark,
            pluginViewerViewportForTab(snapshot.pluginViewer, scopeId)
          )
        })
      )
      if (!response.ok) {
        receive({ type: 'error', code: response.error })
        return
      }
      lease = response.lease
      if (closed) {
        release()
        return
      }
      try {
        assertEditorFileOperationCurrent(useAppStore.getState(), snapshot.worktreeId, provenance)
      } catch {
        receive({ type: 'error', code: 'unauthorized' })
        return
      }
      if (!container.current) {
        release()
        return
      }
      const dispose = attachPluginViewerWebview({
        container: container.current,
        identity: `viewer:${scopeId}`,
        lease,
        label: snapshot.relativePath,
        onStatus: receive
      })
      if (closed) {
        dispose()
      } else {
        detach = dispose
      }
    })().catch(() => {
      release()
      receive({ type: 'error', code: 'unavailable' })
    })
    return () => {
      stopOwnerWatch()
      closed = true
      release()
    }
  }, [snapshot, scopeId, dark])
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-editor-surface">
      <div
        ref={container}
        className="min-h-0 flex-1"
        style={{ pointerEvents: pickerOpen ? 'none' : undefined }}
      />
      {status.type === 'loading' && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-editor-surface text-sm text-muted-foreground"
          role="status"
        >
          {translate('plugins.viewer.loading', 'Opening file…')}
        </div>
      )}
      {status.type === 'error' && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-editor-surface p-6 text-center"
          role="alert"
        >
          <p className="text-sm text-muted-foreground">{pluginViewerFailureMessage(status.code)}</p>
          {status.code !== 'unauthorized' && (
            <Button size="sm" variant="outline" onClick={retry}>
              {translate('plugins.viewer.retry', 'Retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function PluginFileViewer({
  file,
  scopeId
}: {
  file: OpenFile
  scopeId: string
}): React.JSX.Element {
  const dark = useDocumentDarkTheme()
  const [reload, setReload] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const retry = (): void => {
    const state = useAppStore.getState()
    const current = state.openFiles.find((candidate) => candidate.id === file.id)
    if (
      current?.mode === 'plugin-viewer' &&
      current.worktreeId === file.worktreeId &&
      current.filePath === file.filePath &&
      current.pluginViewer?.key === file.pluginViewer?.key &&
      current.fileContentReloadNonce === file.fileContentReloadNonce
    ) {
      try {
        const operationProvenance = pluginViewerReloadProvenance(state, current)
        useAppStore.setState({
          openFiles: state.openFiles.map((candidate) =>
            candidate === current
              ? { ...candidate, operationProvenance, pluginViewerOwnerExpired: undefined }
              : candidate
          )
        })
      } catch {
        // Reload cannot move an existing tab to a different owner.
      }
    }
    setReload((value) => value + 1)
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-plugin-file-viewer>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="min-w-0 flex-1 truncate" title={file.filePath}>
          {file.relativePath}
        </span>
        <span className="text-muted-foreground">
          {translate('plugins.viewer.readOnly', 'Read only')}
        </span>
        <PluginFileViewerPicker file={file} viewStateId={scopeId} onOpenChange={setPickerOpen} />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={retry}
          aria-label={translate('plugins.viewer.reload', 'Reload viewer')}
        >
          <RotateCw />
        </Button>
      </div>
      <ViewerSession
        key={`${file.id}:${file.pluginViewer?.key}:${reload}:${file.fileContentReloadNonce ?? 0}:${dark}`}
        file={file}
        scopeId={scopeId}
        dark={dark}
        retry={retry}
        pickerOpen={pickerOpen}
      />
    </div>
  )
}
