import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'
import { createStlAdapter } from './stl-adapter'

declare const orcaViewer: PluginViewerWorkerSdk
orcaViewer.register(createStlAdapter(orcaViewer))
