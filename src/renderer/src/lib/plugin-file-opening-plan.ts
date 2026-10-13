import { detectKnownFileLanguage } from './language-detect'
import { IMAGE_FILE_MIME_TYPES } from '../../../shared/image-file-extensions'
import { MEDIA_FILE_MIME_TYPES } from '../../../shared/media-file-extensions'
import { matchingPluginSyntaxLanguages } from './monaco-languages/plugin-syntax-slot-pool'
import { selectedPluginSyntaxAssociation } from '../../../shared/plugins/plugin-syntax-associations'
import {
  selectedPluginViewerAssociation,
  viewerFileBasename
} from '../../../shared/plugins/plugin-viewer-associations'
import { pluginViewerSelectorMatches } from '../../../shared/plugins/plugin-viewer-contributions'
import type { PluginFileViewerRegistry } from '@/store/plugin-file-viewers'
import type { PluginViewerMetadata } from '../../../shared/plugins/plugin-viewer-package'
import type { GlobalSettings } from '../../../shared/global-settings-types'

export type PluginFileOpeningPlan =
  | { kind: 'core' }
  | { kind: 'plugin'; viewer: PluginViewerMetadata }
  | { kind: 'choose' }
  | { kind: 'loading' | 'failed' | 'unsupported' }
  | { kind: 'missing'; viewerKey: string }

export function matchingPluginFileViewers(
  registry: PluginFileViewerRegistry,
  filePath: string
): PluginViewerMetadata[] {
  return registry.viewers
    .filter((viewer) =>
      viewer.selector.some((selector) => pluginViewerSelectorMatches(selector, filePath))
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key))
}
export function getPluginFileOpeningPlan(
  filePath: string,
  settings: Pick<GlobalSettings, 'pluginViewerAssociations' | 'pluginSyntaxAssociations'> | null,
  registry: PluginFileViewerRegistry
): PluginFileOpeningPlan {
  if (!settings && registry.status !== 'unsupported') {
    return { kind: 'loading' }
  }
  const choice = selectedPluginViewerAssociation(settings?.pluginViewerAssociations ?? [], filePath)
  if (choice?.viewerKey === 'core') {
    return { kind: 'core' }
  }
  if (!choice) {
    const name = viewerFileBasename(filePath)
    const extension = name.slice(name.lastIndexOf('.'))
    if (
      detectKnownFileLanguage(filePath) ||
      Object.hasOwn(IMAGE_FILE_MIME_TYPES, extension) ||
      extension === '.pdf' ||
      Object.hasOwn(MEDIA_FILE_MIME_TYPES, extension) ||
      selectedPluginSyntaxAssociation(settings?.pluginSyntaxAssociations ?? [], filePath) ||
      matchingPluginSyntaxLanguages(registry.syntaxPacks, filePath).length > 0
    ) {
      return { kind: 'core' }
    }
  }
  if (registry.status === 'loading' || registry.status === 'idle') {
    return { kind: 'loading' }
  }
  if (registry.status === 'failed') {
    return { kind: 'failed' }
  }
  if (registry.status === 'unsupported') {
    return choice ? { kind: 'unsupported' } : { kind: 'core' }
  }
  const matches = matchingPluginFileViewers(registry, filePath)
  if (choice) {
    const viewer = matches.find((item) => item.key === choice.viewerKey)
    return viewer ? { kind: 'plugin', viewer } : { kind: 'missing', viewerKey: choice.viewerKey }
  }
  return matches.length === 1
    ? { kind: 'plugin', viewer: matches[0] }
    : matches.length > 1
      ? { kind: 'choose' }
      : { kind: 'core' }
}
