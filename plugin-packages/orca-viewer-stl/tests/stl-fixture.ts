import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'

export function stlBytes(
  triangles: readonly (readonly number[])[] = [[-1, -1, 0, 1, -1, 0, 0, 1, 0]]
): Uint8Array {
  const bytes = new Uint8Array(84 + triangles.length * 50)
  bytes.set(new TextEncoder().encode('solid is allowed in a binary header'))
  const view = new DataView(bytes.buffer)
  view.setUint32(80, triangles.length, true)
  for (let triangle = 0; triangle < triangles.length; triangle++) {
    view.setFloat32(84 + triangle * 50 + 8, 1, true)
    for (let component = 0; component < 9; component++) {
      view.setFloat32(84 + triangle * 50 + 12 + component * 4, triangles[triangle][component], true)
    }
  }
  return bytes
}

export function stlSdk(
  bytes: Uint8Array
): Pick<PluginViewerWorkerSdk, 'readBytes'> & { reads: number[] } {
  const reads: number[] = []
  return {
    reads,
    async readBytes(position, length) {
      if (length > 192 * 1024 || position < 0 || position + length > bytes.length) {
        throw new Error('invalid document read')
      }
      reads.push(length)
      return bytes.slice(position, position + length)
    }
  }
}

export function stlDocument(bytes: Uint8Array) {
  return {
    name: 'Model.stl',
    size: bytes.length,
    revision: 'stl-revision',
    features: { rangeRead: true, watch: false }
  }
}
