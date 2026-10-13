import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'
import { createXlsxAdapter } from './xlsx-adapter'

declare const orcaViewer: PluginViewerWorkerSdk
orcaViewer.register(createXlsxAdapter(orcaViewer))
