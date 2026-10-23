import { EventEmitter } from 'node:events'
import type * as Fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { nativeEvents } = vi.hoisted(() => {
  const callbacks: (() => void)[] = []
  return { nativeEvents: callbacks }
})

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs')
  return {
    ...actual,
    watch: vi.fn((_path: string, _options: unknown, callback: () => void) => {
      nativeEvents.push(callback)
      const watcher: EventEmitter = Object.assign(new EventEmitter(), {
        close: () => watcher.emit('close')
      })
      return watcher
    })
  }
})

import { watchFileAcrossReplacement, type RebindingFileWatch } from './rebinding-file-watch'

let directory: string
let fileWatch: RebindingFileWatch | null

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-rebinding-noise-'))
  nativeEvents.length = 0
  fileWatch = null
})

afterEach(async () => {
  await fileWatch?.close()
  rmSync(directory, { recursive: true, force: true })
})

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

describe('watchFileAcrossReplacement event filtering', () => {
  it('drops attribute-only events such as macOS mmap reads of git metadata', async () => {
    const path = join(directory, 'packed-refs')
    writeFileSync(path, 'refs')
    const onChange = vi.fn()
    fileWatch = watchFileAcrossReplacement(path, onChange, (error) => {
      throw error
    })
    await settle()

    for (let read = 0; read < 50; read++) {
      nativeEvents.at(-1)?.()
    }
    await settle()
    expect(onChange).not.toHaveBeenCalled()

    writeFileSync(path, 'refs and more')
    for (let read = 0; read < 50; read++) {
      nativeEvents.at(-1)?.()
    }
    await settle()
    expect(onChange).toHaveBeenCalledOnce()
  })
})
