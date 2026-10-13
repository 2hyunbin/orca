import type { PluginViewerCamera } from '@orca/plugin-sdk/viewer'
import { STL_LIMITS, StlFailure } from './stl-limits'
import type { StlMesh } from './stl-mesh'

type Vertex = { x: number; y: number; z: number }

function edge(a: Vertex, b: Vertex, x: number, y: number): number {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x)
}

export async function renderStlMesh(
  mesh: StlMesh,
  width: number,
  height: number,
  camera: PluginViewerCamera
): Promise<Uint8ClampedArray> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > STL_LIMITS.canvasDimension ||
    height > STL_LIMITS.canvasDimension ||
    !Number.isFinite(camera.yaw) ||
    !Number.isFinite(camera.pitch) ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom < 0.05 ||
    camera.zoom > 20
  ) {
    throw new StlFailure('limit_exceeded')
  }
  const started = performance.now()
  let lastYield = started
  let samples = 0
  const pixels = new Uint8ClampedArray(width * height * 4)
  const depths = new Float64Array(width * height).fill(-Infinity)
  const yaw = (camera.yaw * Math.PI) / 180
  const pitch = (camera.pitch * Math.PI) / 180
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const scale = Math.min(width, height) * 0.7 * camera.zoom
  const vertex = (index: number): Vertex => {
    const x = mesh.vertices[index]
    const y = mesh.vertices[index + 1]
    const z = mesh.vertices[index + 2]
    const turnedX = x * cy + z * sy
    const turnedZ = z * cy - x * sy
    return {
      x: width / 2 + turnedX * scale,
      y: height / 2 - (y * cp - turnedZ * sp) * scale,
      z: y * sp + turnedZ * cp
    }
  }
  for (let triangle = 0; triangle < mesh.triangles; triangle++) {
    if (performance.now() - started >= STL_LIMITS.renderMs) {
      throw new StlFailure('limit_exceeded')
    }
    if (performance.now() - lastYield >= 24) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      lastYield = performance.now()
    }
    const a = vertex(triangle * 9)
    const b = vertex(triangle * 9 + 3)
    const c = vertex(triangle * 9 + 6)
    const area = edge(a, b, c.x, c.y)
    if (Math.abs(area) < 0.001) {
      continue
    }
    const startX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
    const endX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
    const startY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
    const endY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
    const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y)
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z)
    const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    const light = Math.abs(nz) / Math.hypot(nx * scale, ny * scale, nz)
    const shade = Math.round(161 + 89 * light)
    for (let y = startY; y <= endY; y++) {
      samples += Math.max(0, endX - startX + 1)
      if (
        samples > STL_LIMITS.rasterSamples ||
        performance.now() - started >= STL_LIMITS.renderMs
      ) {
        throw new StlFailure('limit_exceeded')
      }
      for (let x = startX; x <= endX; x++) {
        const wa = edge(b, c, x + 0.5, y + 0.5) / area
        const wb = edge(c, a, x + 0.5, y + 0.5) / area
        const wc = 1 - wa - wb
        if (wa < 0 || wb < 0 || wc < 0) {
          continue
        }
        const depth = wa * a.z + wb * b.z + wc * c.z
        const index = y * width + x
        if (depth <= depths[index]) {
          continue
        }
        depths[index] = depth
        pixels[index * 4] = shade
        pixels[index * 4 + 1] = shade
        pixels[index * 4 + 2] = shade
        pixels[index * 4 + 3] = 255
      }
    }
  }
  return pixels
}
