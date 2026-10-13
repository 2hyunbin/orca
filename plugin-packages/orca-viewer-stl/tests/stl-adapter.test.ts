import { describe, expect, it } from 'vitest'
import { createStlAdapter } from '../src/stl-adapter'
import { readStlMesh } from '../src/stl-mesh'
import { renderStlMesh } from '../src/stl-rasterizer'
import { STL_LIMITS } from '../src/stl-limits'
import { stlBytes, stlDocument, stlSdk } from './stl-fixture'

const camera = { yaw: 0, pitch: 0, zoom: 1 }
const triangle = [-1, -1, 0, 1, -1, 0, 0, 1, 0]

describe('independently packaged binary STL adapter', () => {
  it('uses the generic SDK to open a binary mesh and returns actual owned RGBA pixels', async () => {
    const bytes = stlBytes()
    const adapter = createStlAdapter(stlSdk(bytes))
    expect(await adapter.open(stlDocument(bytes))).toEqual({
      kind: 'canvas',
      width: 512,
      height: 512
    })
    const view = await adapter.render({ kind: 'canvas', width: 128, height: 128, camera })
    if (view.kind !== 'canvas') {
      throw new Error('expected canvas')
    }
    expect(view.pixels.byteLength).toBe(128 * 128 * 4)
    expect(view.pixels.buffer).toBeInstanceOf(ArrayBuffer)
    expect(view.pixels.byteOffset).toBe(0)
    const center = (64 * 128 + 64) * 4
    expect([...view.pixels.subarray(center, center + 4)]).toEqual([250, 250, 250, 255])
    expect([...view.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0])
  })

  it('normalizes translated meshes and changes projected pixels for orbit and zoom', async () => {
    const bytes = stlBytes([
      triangle.map((value, component) => value + [100, -50, 20][component % 3])
    ])
    const mesh = await readStlMesh(stlSdk(bytes), bytes.length)
    expect([...mesh.vertices]).toEqual([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0])
    const first = await renderStlMesh(mesh, 128, 128, camera)
    const orbited = await renderStlMesh(mesh, 128, 128, { ...camera, yaw: 60, pitch: 15 })
    const zoomed = await renderStlMesh(mesh, 128, 128, { ...camera, zoom: 1.25 })
    expect(orbited).not.toEqual(first)
    expect(zoomed).not.toEqual(first)
    const covered = (pixels: Uint8ClampedArray) =>
      pixels.filter((_, index) => index % 4 === 3 && pixels[index] > 0).length
    expect(covered(zoomed)).toBeGreaterThan(covered(first))
    expect(covered(orbited)).toBeLessThan(covered(first))
  })

  it('reads multiple bounded binary chunks without JSON or text conversion', async () => {
    const bytes = stlBytes(Array.from({ length: 5000 }, () => triangle))
    const sdk = stlSdk(bytes)
    expect((await readStlMesh(sdk, bytes.length)).triangles).toBe(5000)
    expect(sdk.reads.length).toBeGreaterThan(2)
    expect(Math.max(...sdk.reads)).toBeLessThanOrEqual(192 * 1024)
    expect(sdk.reads.reduce((sum, value) => sum + value, 0)).toBe(bytes.length)
  })

  it.each([Number.NaN, Infinity, -Infinity])(
    'rejects non-finite vertices and normals: %s',
    async (value) => {
      const vertices = stlBytes([[value, ...triangle.slice(1)]])
      await expect(readStlMesh(stlSdk(vertices), vertices.length)).rejects.toMatchObject({
        code: 'parse_failed'
      })
      const normals = stlBytes()
      new DataView(normals.buffer).setFloat32(84, value, true)
      await expect(readStlMesh(stlSdk(normals), normals.length)).rejects.toMatchObject({
        code: 'parse_failed'
      })
    }
  )

  it('refuses empty, ASCII, truncated, trailing and unsupported color records', async () => {
    const cases = [
      stlBytes([]),
      new TextEncoder().encode('solid ASCII mesh\nendsolid'),
      stlBytes().slice(0, -1),
      new Uint8Array([...stlBytes(), 0])
    ]
    for (const bytes of cases) {
      await expect(readStlMesh(stlSdk(bytes), bytes.length)).rejects.toMatchObject({
        code: 'unsupported_format'
      })
    }
    const color = stlBytes()
    new DataView(color.buffer).setUint16(84 + 48, 0x8001, true)
    await expect(readStlMesh(stlSdk(color), color.length)).rejects.toMatchObject({
      code: 'unsupported_format'
    })
  })

  it('bounds triangle count before allocating geometry and rejects short reads', async () => {
    const bytes = stlBytes()
    new DataView(bytes.buffer).setUint32(80, STL_LIMITS.triangles + 1, true)
    await expect(readStlMesh(stlSdk(bytes), bytes.length)).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
    await expect(
      readStlMesh({ readBytes: async () => new Uint8Array(0) }, 84)
    ).rejects.toMatchObject({ code: 'parse_failed' })
  })

  it('handles extreme finite coordinates without overflow and refuses zero-size meshes', async () => {
    const maximum = 3.4e38
    const bytes = stlBytes([[-maximum, -maximum, 0, maximum, -maximum, 0, 0, maximum, 0]])
    const mesh = await readStlMesh(stlSdk(bytes), bytes.length)
    expect([...mesh.vertices].every(Number.isFinite)).toBe(true)
    const degenerate = stlBytes([Array.from({ length: 9 }, () => 5)])
    await expect(readStlMesh(stlSdk(degenerate), degenerate.length)).rejects.toMatchObject({
      code: 'unsupported_format'
    })
  })

  it('bounds rendering dimensions and raster work independently of input size', async () => {
    const bytes = stlBytes(Array.from({ length: 1000 }, () => triangle))
    const mesh = await readStlMesh(stlSdk(bytes), bytes.length)
    await expect(renderStlMesh(mesh, 1025, 1, camera)).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
    await expect(
      renderStlMesh(mesh, 128, 128, { ...camera, zoom: Infinity })
    ).rejects.toMatchObject({ code: 'limit_exceeded' })
    await expect(renderStlMesh(mesh, 128, 128, camera)).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
  })
})
