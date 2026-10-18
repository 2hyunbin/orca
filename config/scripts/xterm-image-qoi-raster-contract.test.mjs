import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
const compactQoi = Buffer.from('716f696600000008000000080400ffff0000fffdc00000000000000001', 'hex')
const qoi = Buffer.concat([
  compactQoi.subarray(0, 14),
  Buffer.from(Array.from({ length: 64 }, () => [255, 255, 0, 0, 255]).flat()),
  compactQoi.subarray(-8)
])

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')
const { ImageAddon } = require(process.env.ORCA_IMAGE_CONTRACT_ADDON_PATH ?? '@xterm/addon-image')

class RawPixels {
  constructor(data, width, height) {
    this.data = data
    this.width = width
    this.height = height
  }
}

class Bitmap {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.close = vi.fn()
  }
}

function terminal(options = {}) {
  vi.stubGlobal('ImageData', RawPixels)
  vi.stubGlobal('ImageBitmap', Bitmap)
  vi.stubGlobal('window', { ImageBitmap: Bitmap })
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        data: undefined,
        getContext: () => ({
          putImageData: (pixels) => {
            canvas.data = pixels.data
          }
        })
      }
      return canvas
    }
  })
  vi.stubGlobal('createImageBitmap', async (source) => source)
  const core = new Terminal({ allowProposedApi: true, logLevel: 'off' })
  const addon = new ImageAddon({ enableSizeReports: false, showPlaceholder: false, ...options })
  core.loadAddon(addon)
  return { core, addon, storage: addon._storage }
}

const sequence = `\x1b]1337;File=inline=1;width=1px;height=1px;preserveAspectRatio=0:${qoi.toString('base64')}\x07AFTER`
const write = (core, data = sequence) => new Promise((resolve) => core.write(data, resolve))
afterEach(() => vi.unstubAllGlobals())

describe('QOI bitmap resize ownership', () => {
  it('releases the intermediate bitmap and retains the final image until reset', async () => {
    const h = terminal()
    const original = new Bitmap(8, 8)
    const resized = new Bitmap(1, 1)
    vi.stubGlobal('createImageBitmap', async (source, options) =>
      source instanceof RawPixels && !options.resizeWidth ? original : resized
    )
    try {
      await write(h.core)
      expect(original.close).toHaveBeenCalledOnce()
      expect(resized.close).not.toHaveBeenCalled()
      expect([...h.storage._images.values()][0].orig).toBe(resized)
      h.addon.reset()
      expect(resized.close).toHaveBeenCalledOnce()
      expect(h.core.buffer.active.getLine(0).translateToString(true)).toContain('AFTER')
    } finally {
      h.core.dispose()
    }
  })

  it.each(['throw', 'reject'])(
    'releases decoded pixels on resize %s and consumes the suffix',
    async (failure) => {
      const h = terminal()
      const original = new Bitmap(8, 8)
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubGlobal('createImageBitmap', (source, options) => {
        if (source instanceof RawPixels) {
          return Promise.resolve(
            options.resizeWidth ? new Bitmap(options.resizeWidth, options.resizeHeight) : original
          )
        }
        if (failure === 'throw') {
          throw new Error('native resize failed')
        }
        return Promise.reject(new Error('native resize failed'))
      })
      try {
        await write(h.core)
        expect(original.close).toHaveBeenCalledOnce()
        expect(h.storage._images.size).toBe(0)
        expect(h.core.buffer.active.getLine(0).translateToString(true)).toBe('AFTER')
      } finally {
        warning.mockRestore()
        h.core.dispose()
      }
    }
  )

  it('closes both bitmaps when reset interrupts the pending resize', async () => {
    const h = terminal()
    const original = new Bitmap(8, 8)
    const resized = new Bitmap(1, 1)
    let finish
    const decode = vi.fn((source, options) =>
      source instanceof RawPixels
        ? Promise.resolve(options.resizeWidth ? resized : original)
        : new Promise((resolve) => {
            finish = resolve
          })
    )
    vi.stubGlobal('createImageBitmap', decode)
    try {
      const pending = write(h.core)
      await vi.waitFor(() => expect(decode).toHaveBeenCalled())
      expect(decode.mock.calls[0][1]).toEqual({ premultiplyAlpha: 'premultiply' })
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      h.addon.reset()
      finish(resized)
      await pending
      expect(original.close).toHaveBeenCalledOnce()
      expect(resized.close).toHaveBeenCalledOnce()
      expect(h.storage._images.size).toBe(0)
      expect(h.core.buffer.active.getLine(0).translateToString(true)).toBe('AFTER')
    } finally {
      h.core.dispose()
    }
  })
})

describe('QOI stream boundaries through the installed parser', () => {
  it.each([
    ['29-byte compact QOI', compactQoi, Array.from({ length: 64 }, () => [255, 0, 0, 255]).flat()],
    [
      'minimum QOI',
      Buffer.from('716f696600000001000000010300c00000000000000001', 'hex'),
      [0, 0, 0, 255]
    ],
    [
      'RGB, diff, luma, index and run QOI',
      Buffer.from('716f696600000006000000010301fe1002037fa18704c10000000000000001', 'hex'),
      [16, 2, 3, 255, 17, 3, 4, 255, 18, 4, 4, 255, 16, 2, 3, 255, 16, 2, 3, 255, 16, 2, 3, 255]
    ],
    [
      'a final run overshooting the declared size (clamped, as qoi.h does)',
      Buffer.concat([compactQoi.subarray(0, 20), Buffer.from([193]), compactQoi.subarray(-8)]),
      Array.from({ length: 64 }, () => [255, 0, 0, 255]).flat()
    ],
    [
      'bytes after the end marker (ignored, as qoi.h does)',
      Buffer.concat([compactQoi, Buffer.from([1, 2, 3])]),
      Array.from({ length: 64 }, () => [255, 0, 0, 255]).flat()
    ]
  ])('%s preserves every pixel and consumes the suffix', async (_name, bytes, expected) => {
    const h = terminal()
    try {
      await write(h.core, `\x1b]1337;File=inline=1:${bytes.toString('base64')}\x07AFTER`)
      expect(h.addon._storage._images.size).toBe(1)
      expect([...h.addon._storage._images.values()][0].orig.data).toEqual(
        new Uint8ClampedArray(expected)
      )
      expect(
        Array.from({ length: 10 }, (_, row) =>
          h.core.buffer.active.getLine(row).translateToString(true)
        ).join('\n')
      ).toContain('AFTER')
    } finally {
      h.core.dispose()
    }
  })

  it.each([
    ['header only', compactQoi.subarray(0, 14)],
    ['truncated end marker', compactQoi.subarray(0, 28)],
    [
      'missing RGBA bytes',
      Buffer.concat([
        compactQoi.subarray(0, 14),
        Buffer.from([255, 255, 0]),
        compactQoi.subarray(-8)
      ])
    ],
    ['short pixel stream', Buffer.concat([compactQoi.subarray(0, 19), compactQoi.subarray(-8)])],
    [
      'missing luma byte',
      Buffer.concat([compactQoi.subarray(0, 14), Buffer.from([128]), compactQoi.subarray(-8)])
    ],
    [
      'extra encoded pixel',
      Buffer.concat([qoi.subarray(0, -8), Buffer.from([0]), qoi.subarray(-8)])
    ],
    ['invalid channels', Buffer.from(qoi).fill(2, 12, 13)],
    ['invalid color space', Buffer.from(qoi).fill(2, 13, 14)],
    [
      'negative signed dimensions',
      Buffer.from(compactQoi).fill(255, 4, 12).fill(248, 7, 8).fill(248, 11, 12)
    ],
    ['invalid end marker', Buffer.from(qoi).fill(0, qoi.length - 1)],
    [
      'trailing bytes but no end marker',
      Buffer.concat([compactQoi.subarray(0, 21), Buffer.alloc(9)])
    ]
  ])('silently drops QOI with %s and accepts the next image', async (_name, bytes) => {
    const h = terminal()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const replies = vi.fn()
      h.core.onData(replies)
      await write(h.core, `BEFORE\x1b]1337;File=inline=1:${bytes.toString('base64')}\x07AFTER`)
      expect(h.addon._storage._images.size).toBe(0)
      expect(replies).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledWith('IIP: unsupported image type')
      expect(h.core.buffer.active.getLine(0).translateToString(true)).toBe('BEFOREAFTER')
      await write(h.core, `\x1b]1337;File=inline=1:${qoi.toString('base64')}\x07VALID`)
      expect(h.addon._storage._images.size).toBe(1)
      expect(warning).toHaveBeenCalledOnce()
      expect(
        Array.from({ length: 10 }, (_, row) =>
          h.core.buffer.active.getLine(row).translateToString(true)
        ).join('\n')
      ).toContain('VALID')
    } finally {
      warning.mockRestore()
      h.core.dispose()
    }
  })

  it('rejects declared dimensions over the pixel limit before scanning the pixel stream', async () => {
    const h = terminal({ pixelLimit: 63 })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A scan would report this truncated stream as unsupported instead.
      const truncated = Buffer.concat([compactQoi.subarray(0, 19), compactQoi.subarray(-8)])
      await write(h.core, `\x1b]1337;File=inline=1:${truncated.toString('base64')}\x07AFTER`)
      expect(warning).toHaveBeenCalledWith('IIP: image dimension issue 8x8')
      expect(h.addon._storage._images.size).toBe(0)
    } finally {
      warning.mockRestore()
      h.core.dispose()
    }
  })
})
