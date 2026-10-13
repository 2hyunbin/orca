import type { PluginViewerAdapter, PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'
import { StlFailure } from './stl-limits'
import { readStlMesh, type StlMesh } from './stl-mesh'
import { renderStlMesh } from './stl-rasterizer'

export function createStlAdapter(
  sdk: Pick<PluginViewerWorkerSdk, 'readBytes'>
): PluginViewerAdapter {
  let mesh: StlMesh | undefined
  return {
    async open(document) {
      mesh = undefined
      mesh = await readStlMesh(sdk, document.size)
      return { kind: 'canvas', width: 512, height: 512 }
    },
    async render(viewport) {
      if (!mesh || viewport.kind !== 'canvas') {
        throw new StlFailure('unsupported_format')
      }
      const pixels = await renderStlMesh(mesh, viewport.width, viewport.height, viewport.camera)
      return { kind: 'canvas', width: viewport.width, height: viewport.height, pixels }
    }
  }
}
