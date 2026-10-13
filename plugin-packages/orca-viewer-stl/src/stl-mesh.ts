import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'
import { STL_LIMITS, StlFailure } from './stl-limits'

export type StlMesh = { vertices: Float64Array; triangles: number }

export async function readStlMesh(
  sdk: Pick<PluginViewerWorkerSdk, 'readBytes'>,
  size: number
): Promise<StlMesh> {
  const started = performance.now()
  if (!Number.isSafeInteger(size) || size < 84 || size > STL_LIMITS.inputBytes) {
    throw new StlFailure(size > STL_LIMITS.inputBytes ? 'limit_exceeded' : 'unsupported_format')
  }
  const read = async (position: number, length: number): Promise<DataView> => {
    const bytes = await sdk.readBytes(position, length)
    if (bytes.length !== length) {
      throw new StlFailure('parse_failed')
    }
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  const header = await read(0, 84)
  const triangles = header.getUint32(80, true)
  if (triangles > STL_LIMITS.triangles) {
    throw new StlFailure('limit_exceeded')
  }
  if (!triangles || size !== 84 + triangles * 50) {
    throw new StlFailure('unsupported_format')
  }
  const vertices = new Float64Array(triangles * 9)
  const minimum = [Infinity, Infinity, Infinity]
  const maximum = [-Infinity, -Infinity, -Infinity]
  const perChunk = Math.floor(STL_LIMITS.chunkBytes / 50)
  for (let triangle = 0; triangle < triangles; triangle += perChunk) {
    if (performance.now() - started >= STL_LIMITS.parseMs) {
      throw new StlFailure('limit_exceeded')
    }
    const count = Math.min(perChunk, triangles - triangle)
    const records = await read(84 + triangle * 50, count * 50)
    for (let record = 0; record < count; record++) {
      for (let normal = 0; normal < 3; normal++) {
        if (!Number.isFinite(records.getFloat32(record * 50 + normal * 4, true))) {
          throw new StlFailure('parse_failed')
        }
      }
      if (records.getUint16(record * 50 + 48, true) !== 0) {
        throw new StlFailure('unsupported_format')
      }
      for (let component = 0; component < 9; component++) {
        const value = records.getFloat32(record * 50 + 12 + component * 4, true)
        if (!Number.isFinite(value)) {
          throw new StlFailure('parse_failed')
        }
        vertices[(triangle + record) * 9 + component] = value
        const axis = component % 3
        minimum[axis] = Math.min(minimum[axis], value)
        maximum[axis] = Math.max(maximum[axis], value)
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  const center = minimum.map((value, axis) => value / 2 + maximum[axis] / 2)
  const scale = Math.max(...maximum.map((value, axis) => value - minimum[axis]))
  if (!(scale > 0)) {
    throw new StlFailure('unsupported_format')
  }
  for (let component = 0; component < vertices.length; component++) {
    vertices[component] = (vertices[component] - center[component % 3]) / scale
  }
  return { vertices, triangles }
}
