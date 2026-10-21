import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ platform: 'win32', env: {}, execPath: 'node' }))
const run = vi.hoisted(() => vi.fn())
const initialize = vi.hoisted(() => vi.fn())
vi.mock('node:process', () => ({ default: host }))
vi.mock('@orca/process-host', () => ({ runProcessSync: run }))
vi.mock('./initialize-windows-native-toolchain.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  initializeWindowsNativeToolchain: initialize
}))

import { nodeGypRebuild } from './orcad-prebuild-node-gyp.mjs'

let directory
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orcad-node-gyp-'))
  host.platform = 'win32'
  host.env = { PATH: 'original', TOKEN: 'preserved' }
  run.mockReset().mockReturnValue({ code: 0 })
  initialize.mockReset()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const rebuild = () =>
  nodeGypRebuild({ stagedDir: directory, workDir: directory, nodeDir: 'pinned-headers' })

it('passes the initialized Windows toolchain only to the compiler child', async () => {
  initialize.mockReturnValue({ Path: 'compiler', VCINSTALLDIR: 'selected' })
  await rebuild()
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      env: { Path: 'compiler', VCINSTALLDIR: 'selected', TOKEN: 'preserved' },
      args: expect.arrayContaining(['rebuild', '--nodedir=pinned-headers']),
      cwd: directory,
      stdio: 'inherit'
    })
  )
  expect(host.env).toEqual({ PATH: 'original', TOKEN: 'preserved' })
})

it('retains discovery when initialization is unavailable or a compiler is already selected', async () => {
  await rebuild()
  expect(run.mock.calls[0][0].env).toBe(host.env)
})

it('does not discover Windows tools on other hosts', async () => {
  host.platform = 'linux'
  await rebuild()
  expect(initialize).not.toHaveBeenCalled()
  expect(run.mock.calls[0][0].env).toBe(host.env)
})

it('propagates compiler failures', async () => {
  run.mockReturnValue({ code: 9 })
  await expect(rebuild()).rejects.toThrow('status 9')
})
