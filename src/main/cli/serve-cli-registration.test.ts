import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { registerCliForServe, type ServeCliRegistrationContext } from './serve-cli-registration'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function context(): Promise<ServeCliRegistrationContext> {
  const root = await mkdtemp(join(tmpdir(), 'orca-serve-registration-'))
  roots.push(root)
  const resourcesPath = join(root, 'resources')
  await mkdir(join(resourcesPath, 'bin'), { recursive: true })
  await writeFile(join(resourcesPath, 'bin', 'orca-ide'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  vi.stubEnv('APPIMAGE', '')
  vi.stubEnv('APPDIR', '')
  vi.stubEnv('ORCA_CLI_INSTALL_PATH', '')
  return {
    platform: 'linux',
    isPackaged: true,
    userDataPath: join(root, 'profile'),
    resourcesPath,
    appPath: join(resourcesPath, 'app.asar'),
    execPath: join(root, 'orca-ide'),
    homePath: join(root, 'home'),
    log: vi.fn()
  }
}

it.skipIf(process.platform === 'win32')(
  'registers the packaged CLI and bare dispatcher without Electron startup',
  async () => {
    const options = await context()
    await registerCliForServe(options)
    const bin = join(options.homePath ?? '', '.local', 'bin')
    expect(await readlink(join(bin, 'orca-ide'))).toBe(
      join(options.resourcesPath, 'bin', 'orca-ide')
    )
    expect(await readFile(join(bin, 'orca'), 'utf8')).toContain('exec ')
    await registerCliForServe(options)
    expect(await readlink(join(bin, 'orca-ide'))).toBe(
      join(options.resourcesPath, 'bin', 'orca-ide')
    )
  }
)

it.skipIf(process.platform === 'win32')(
  'preserves both foreign commands when serve starts',
  async () => {
    const options = await context()
    const bin = join(options.homePath ?? '', '.local', 'bin')
    await mkdir(bin, { recursive: true })
    for (const command of ['orca-ide', 'orca']) {
      await writeFile(join(bin, command), 'user-owned command')
    }
    await registerCliForServe(options)
    for (const command of ['orca-ide', 'orca']) {
      expect(await readFile(join(bin, command), 'utf8')).toBe('user-owned command')
    }
    expect(options.log).toHaveBeenCalledWith(expect.stringContaining('Refusing to replace'))
  }
)

it('does not mutate Windows PATH or create launchers during headless startup', async () => {
  const options = await context()
  await registerCliForServe({ ...options, platform: 'win32' })
  await expect(
    readFile(join(options.homePath ?? '', '.local', 'bin', 'orca-ide'))
  ).rejects.toThrow()
  expect(options.log).not.toHaveBeenCalled()
})
