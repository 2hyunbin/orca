import { Button } from '@/components/ui/button'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { usePluginFileViewerStore, refreshPluginFileViewers } from '@/store/plugin-file-viewers'
import type { OpenFile } from '@/store/slices/editor'
import { getPluginFileOpeningPlan, matchingPluginFileViewers } from '@/lib/plugin-file-opening-plan'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { PluginFileViewerPicker } from './PluginFileViewerPicker'
import { openPluginFileChoice } from './open-plugin-file-choice'

export function FileOpeningSurface({
  file,
  scopeId
}: {
  file: OpenFile
  scopeId: string
}): React.JSX.Element {
  const registry = usePluginFileViewerStore(
    useShallow((state) => ({
      status: state.status,
      viewers: state.viewers,
      syntaxPacks: state.syntaxPacks
    }))
  )
  const settings = useAppStore((state) => state.settings)
  const plan = getPluginFileOpeningPlan(file.filePath, settings, registry)
  const needsViewer = file.pluginViewerUserSelectedFile && plan.kind === 'core'
  const loading =
    plan.kind === 'loading' ||
    (needsViewer && (registry.status === 'idle' || registry.status === 'loading'))
  const failed = plan.kind === 'failed' || (needsViewer && registry.status === 'failed')
  const unsupported =
    plan.kind === 'unsupported' || (needsViewer && registry.status === 'unsupported')
  const retry = (): void => {
    useAppStore.setState((state) => ({
      openFiles: state.openFiles.map((item) =>
        item.id === file.id ? { ...item, fileOpeningChoicePending: false } : item
      )
    }))
    void refreshPluginFileViewers()
  }
  const core = async (): Promise<void> => {
    try {
      await openPluginFileChoice(file, 'core')
    } catch {
      toast.error(
        translate('plugins.viewer.ownerChanged', 'Reopen the file after its connection settles.')
      )
    }
  }
  const message = file.fileOpeningOwnerUnresolved
    ? translate('plugins.viewer.ownerChanged', 'Reopen the file after its connection settles.')
    : loading
      ? translate('plugins.viewer.finding', 'Finding available file viewers…')
      : failed
        ? translate(
            'plugins.viewer.discoveryFailed',
            'Could not load available viewers. Try again.'
          )
        : unsupported
          ? translate(
              'plugins.viewer.unsupportedHost',
              'This connection does not support plugin file viewers yet.'
            )
          : plan.kind === 'missing'
            ? translate(
                'plugins.viewer.missingDefault',
                'The saved viewer is disabled, missing, or incompatible with this file.'
              )
            : needsViewer
              ? matchingPluginFileViewers(registry, file.filePath).length > 0
                ? translate('plugins.viewer.chooseInstalled', 'Choose a viewer to open this file.')
                : translate(
                    'plugins.viewer.noneInstalled',
                    'No installed viewer matches this file.'
                  )
              : plan.kind === 'choose'
                ? translate(
                    'plugins.viewer.chooseViewer',
                    'Several viewers match this file. Choose one to open it.'
                  )
                : plan.kind === 'plugin' && file.fileOpeningChoicePending
                  ? translate(
                      'plugins.viewer.chooseInstalled',
                      'Choose a viewer to open this file.'
                    )
                  : translate('plugins.viewer.opening', 'Opening file…')
  return (
    <div className="flex h-full min-h-0 flex-col" data-file-opening>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="min-w-0 flex-1 truncate" title={file.filePath}>
          {file.relativePath}
        </span>
        <PluginFileViewerPicker file={file} viewStateId={scopeId} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="max-w-md text-sm text-muted-foreground" role="status">
          {message}
        </p>
        {plan.kind === 'missing' && (
          <p className="max-w-md break-all font-mono text-xs text-muted-foreground">
            {plan.viewerKey}
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          {!file.fileOpeningOwnerUnresolved &&
            !loading &&
            !unsupported &&
            (needsViewer || failed || plan.kind === 'missing' || plan.kind === 'choose') && (
              <Button
                size="sm"
                onClick={() => useAppStore.getState().openPluginFileViewerCatalog()}
              >
                {translate('plugins.viewer.browse', 'Browse file viewers')}
              </Button>
            )}
          {(failed || plan.kind === 'missing') && (
            <Button size="sm" variant="outline" onClick={retry}>
              {translate('plugins.viewer.retry', 'Retry')}
            </Button>
          )}
          {!file.pluginViewerUserSelectedFile && (
            <Button
              size="sm"
              variant="outline"
              disabled={file.fileOpeningOwnerUnresolved}
              onClick={() => void core()}
            >
              {translate('plugins.viewer.useOrcaOnce', 'Use Orca once')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useAppStore.getState().closeFile(file.id)}
          >
            {translate('plugins.viewer.close', 'Close')}
          </Button>
        </div>
      </div>
    </div>
  )
}
