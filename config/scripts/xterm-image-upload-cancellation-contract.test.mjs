import { PNG } from 'pngjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  write as writeAsync
} from './xterm-kitty-placeholder-test-terminal.mjs'
afterEach(() => vi.unstubAllGlobals())
function terminal() {
  const h = createPlaceholderTerminal()
  return { ...h, core: h.terminal, kittyStorage: h.kitty }
}

const rgba = Buffer.from([255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255])
const raw = rgba.toString('base64')
const image = new PNG({ width: 2, height: 2 })
image.data.set(rgba)
const png = PNG.sync.write(image).toString('base64')
const write = (h, sequence) => writeAsync(h.core, sequence)
const kitty = (command, payload = '') => `\x1b_G${command};${payload}\x1b\\`
const osc = (payload) => `\x1b]1337;${payload}\x07`
const multipart = 'MultipartFile=inline=1;width=2px;height=2px'

async function completeMultipart(h) {
  await write(h, osc(multipart))
  await write(h, osc(`FilePart=${png}`))
  await writeAsync(h.core, osc('FileEnd'))
  expect(h.storage._images.size).toBe(1)
  expect(h.decode).toHaveBeenCalled()
}

describe('unfinished image upload cancellation', () => {
  it.each(['kitty', 'iip'])(
    'ignores the active %s payload after an addon reset',
    async (protocol) => {
      const h = terminal()
      try {
        const start =
          protocol === 'kitty'
            ? `\x1b_Ga=T,f=32,s=2,v=2,i=7,q=2;${raw.slice(0, 4)}`
            : `\x1b]1337;File=inline=1;width=2px;height=2px:${png.slice(0, 4)}`
        const continuation = protocol === 'kitty' ? `${raw}\x1b\\` : `${png}\x07`
        await write(h, start)
        h.addon.reset()
        expect(h.addon._handlers.get(protocol)._aborted).toBe(true)
        await expect(write(h, continuation)).resolves.toBeUndefined()
        expect(h.storage._images.size).toBe(0)
        await completeMultipart(h)
      } finally {
        h.core.dispose()
      }
    }
  )

  it.each(['kitty', 'iip'])('releases unfinished %s payloads on disposal', async (protocol) => {
    const h = terminal()
    const handler = h.addon._handlers.get(protocol)
    try {
      await write(
        h,
        protocol === 'kitty'
          ? kitty('a=t,f=32,s=2,v=2,i=7,m=1,q=2', raw.slice(0, 4))
          : osc(multipart) + osc(`FilePart=${png.slice(0, 4)}`)
      )
      const decoder =
        protocol === 'kitty' ? handler._pendingTransmissions.get(7).decoder : handler._dec
      const release = vi.spyOn(decoder, 'release')
      h.addon.dispose()
      expect(release).toHaveBeenCalled()
      if (protocol === 'iip') {
        expect(decoder._inst).toBeNull()
      }
      expect(handler._aborted).toBe(true)
      expect(handler._pendingTransmissions?.size ?? 0).toBe(0)
      await write(h, 'AFTER_DISPOSE')
      expect(h.core.buffer.active.getLine(0).translateToString()).toContain('AFTER_DISPOSE')
    } finally {
      h.core.dispose()
    }
  })

  it('preserves a Kitty upload when a canceled continuation has not fed its decoder', async () => {
    const h = terminal()
    const handler = h.addon._handlers.get('kitty')
    try {
      await write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1,q=2', raw.slice(0, 4)))
      const pending = handler._pendingTransmissions.get(7)
      await write(h, '\x1b_Gi=7,m=1,q=2;\x18')
      expect(handler._pendingTransmissions.get(7)).toBe(pending)
      await write(h, kitty('m=0,q=2', raw.slice(4)))
      expect(new Uint8Array(await h.kittyStorage.getImage(7).data.arrayBuffer())).toEqual(
        new Uint8Array(rgba)
      )
    } finally {
      h.core.dispose()
    }
  })

  it('drops a canceled IIP FileEnd instead of displaying its complete payload', async () => {
    const h = terminal()
    try {
      await write(h, osc(multipart))
      await write(h, osc(`FilePart=${png}`))
      await write(h, '\x1b]1337;FileEnd\x18')
      await write(h, osc('FileEnd'))
      expect(h.storage._images.size).toBe(0)
      await completeMultipart(h)
    } finally {
      h.core.dispose()
    }
  })

  it.each(['\x18', '\x1a'])('removes only the Kitty upload canceled by %j', async (cancel) => {
    const h = terminal()
    const handler = h.addon._handlers.get('kitty')
    try {
      await write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1,q=2', raw.slice(0, 4)))
      await write(h, kitty('a=t,f=32,s=2,v=2,i=9,m=1,q=2', raw.slice(0, 4)))
      const canceled = handler._pendingTransmissions.get(7).decoder
      const release = vi.spyOn(canceled, 'release')
      await write(h, `\x1b_Gi=7,m=1,q=2;${raw.slice(4, 8)}${cancel}`)
      expect(release).toHaveBeenCalledTimes(1)
      expect(handler._pendingTransmissions.has(7)).toBe(false)
      expect(handler._pendingTransmissions.has(9)).toBe(true)
      expect(handler._lastPendingKey).toBe(9)
      expect(handler._activeDecoder).toBeNull()
      await write(h, kitty('m=0,q=2', raw.slice(4)))
      expect(new Uint8Array(await h.kittyStorage.getImage(9).data.arrayBuffer())).toEqual(
        new Uint8Array(rgba)
      )
      await write(h, kitty('a=t,f=32,s=2,v=2,i=7,q=2', raw))
      expect(new Uint8Array(await h.kittyStorage.getImage(7).data.arrayBuffer())).toEqual(
        new Uint8Array(rgba)
      )
    } finally {
      h.core.dispose()
    }
  })

  it('clears the implicit Kitty continuation key when its decoder is canceled', async () => {
    const h = terminal()
    const handler = h.addon._handlers.get('kitty')
    try {
      await write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1,q=2', raw.slice(0, 4)))
      await write(h, `\x1b_Gm=1,q=2;${raw.slice(4, 8)}\x18`)
      expect(handler._pendingTransmissions.size).toBe(0)
      expect(handler._lastPendingKey).toBeUndefined()
      await write(h, kitty('a=t,f=32,s=2,v=2,i=7,q=2', raw))
      expect(new Uint8Array(await h.kittyStorage.getImage(7).data.arrayBuffer())).toEqual(
        new Uint8Array(rgba)
      )
    } finally {
      h.core.dispose()
    }
  })

  it.each([
    ['an explicit id', 'i=7,'],
    ['the implicit continuation key', '']
  ])(
    'silently drops later chunks of a canceled Kitty upload addressed by %s',
    async (_name, idKey) => {
      const h = terminal()
      const handler = h.addon._handlers.get('kitty')
      const replies = vi.fn()
      h.core.onData(replies)
      try {
        await write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1', raw.slice(0, 4)))
        await write(h, `\x1b_G${idKey}m=1;${raw.slice(4, 8)}\x18`)
        const allocations = vi.spyOn(handler, '_streamPayload')
        await write(h, kitty(`${idKey}m=1`, raw.slice(8, 12)))
        await write(h, kitty(`${idKey}m=0`, raw.slice(12)))
        expect(allocations).not.toHaveBeenCalled()
        expect(handler._pendingTransmissions.size).toBe(0)
        expect(h.kittyStorage.getImage(7)).toBeUndefined()
        expect(replies).not.toHaveBeenCalled()
        await write(h, kitty('a=t,f=32,s=2,v=2,i=8', raw))
        expect(replies).toHaveBeenCalledWith('\x1b_Gi=8;OK\x1b\\')
        expect(new Uint8Array(await h.kittyStorage.getImage(8).data.arrayBuffer())).toEqual(
          new Uint8Array(rgba)
        )
      } finally {
        h.core.dispose()
      }
    }
  )

  it('accepts a restarted Kitty upload that reuses a canceled id', async () => {
    const h = terminal()
    const replies = vi.fn()
    h.core.onData(replies)
    try {
      await write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1', raw.slice(0, 4)))
      await write(h, `\x1b_Gi=7,m=1;${raw.slice(4, 8)}\x18`)
      await write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1', raw.slice(0, 8)))
      await write(h, kitty('m=0', raw.slice(8)))
      expect(replies).toHaveBeenCalledWith('\x1b_Gi=7;OK\x1b\\')
      expect(new Uint8Array(await h.kittyStorage.getImage(7).data.arrayBuffer())).toEqual(
        new Uint8Array(rgba)
      )
    } finally {
      h.core.dispose()
    }
  })

  it.each(['\x18', '\x1a'])(
    'drops an IIP multipart upload after a FilePart canceled by %j',
    async (cancel) => {
      const h = terminal()
      const handler = h.addon._handlers.get('iip')
      try {
        await write(h, osc(multipart))
        await write(h, osc(`FilePart=${png.slice(0, 4)}`))
        await write(h, `\x1b]1337;FilePart=${png.slice(4, 8)}${cancel}`)
        await write(h, osc(`FilePart=${png.slice(8)}`))
        await write(h, osc('FileEnd'))
        expect(h.storage._images.size).toBe(0)
        expect(handler._dec._inst).toBeNull()
        await completeMultipart(h)
      } finally {
        h.core.dispose()
      }
    }
  )

  it('does not allocate an IIP decoder for a canceled multipart header', async () => {
    const h = terminal()
    const handler = h.addon._handlers.get('iip')
    try {
      await write(h, `\x1b]1337;${multipart}\x18`)
      expect(handler._dec._inst).toBeNull()
      expect(handler._isMultipart).toBe(false)
      await completeMultipart(h)
    } finally {
      h.core.dispose()
    }
  })

  it('silences a canceled cell-size report without damaging an IIP multipart upload', async () => {
    const h = terminal()
    const replies = vi.fn()
    h.core.onData(replies)
    try {
      await write(h, osc(multipart))
      await write(h, osc(`FilePart=${png.slice(0, 8)}`))
      await write(h, '\x1b]1337;ReportCellSize\x18')
      expect(replies).not.toHaveBeenCalled()
      await write(h, osc(`FilePart=${png.slice(8)}`))
      await writeAsync(h.core, osc('FileEnd'))
      expect(h.storage._images.size).toBe(1)
    } finally {
      h.core.dispose()
    }
  })

  it.each(['\x1bc', 'addon reset'])('clears IIP multipart ownership on %j', async (reset) => {
    const h = terminal()
    const handler = h.addon._handlers.get('iip')
    try {
      await write(h, osc(multipart))
      await write(h, osc(`FilePart=${png.slice(0, 8)}`))
      if (reset === 'addon reset') {
        h.addon.reset()
      } else {
        await write(h, reset)
      }
      expect(handler._isMultipart).toBe(false)
      expect(handler._abortMulti).toBe(false)
      expect(handler._dec._inst).toBeNull()
      await completeMultipart(h)
    } finally {
      h.core.dispose()
    }
  })

  it.each(['header and payload together', 'payload in a later write'])(
    'invalidates an IIP multipart upload after Base64 failure with %s',
    async (boundary) => {
      const h = terminal()
      const handler = h.addon._handlers.get('iip')
      try {
        await write(h, osc(multipart))
        if (boundary === 'payload in a later write') {
          await write(h, '\x1b]1337;FilePart=')
        }
        await write(
          h,
          `${boundary === 'header and payload together' ? '\x1b]1337;FilePart=' : ''}${'!'.repeat(131072)}\x07`
        )
        expect(handler._abortMulti).toBe(true)
        expect(handler._dec._inst).toBeNull()
        await expect(write(h, osc(`FilePart=${png}`))).resolves.toBeUndefined()
        await write(h, osc('FileEnd'))
        expect(h.storage._images.size).toBe(0)
        await completeMultipart(h)
      } finally {
        h.core.dispose()
      }
    }
  )
})
