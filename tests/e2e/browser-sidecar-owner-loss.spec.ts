import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { BROWSER_SIDECAR_OWNER_ENV } from '../../src/shared/browser-sidecar-lifetime'
import { getRuntimeMetadataPath } from '../../src/shared/runtime-bootstrap'
import { expect, test } from './helpers/orca-app'
import { resolveElectronExecutable } from './helpers/daemon-generation-runtime-fixture'
import { isolatedServeProfile } from './helpers/orca-serve-cli-host'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'

test.use({ seedTestRepo: false })

for (const early of [false, true]) {
  test(`hidden browser exits after owner loss ${early ? 'during startup' : 'after readiness'}`, async () => {
    const profile = mkdtempSync(
      join(process.platform === 'win32' ? tmpdir() : '/tmp', 'orca-owner-')
    )
    const isolation = isolatedServeProfile(profile, {
      NODE_ENV: 'development',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_HEADLESS: '1'
    })
    const child = spawnProcess({
      program: resolveElectronExecutable(process.cwd()),
      args: [
        join(process.cwd(), 'out', 'main', 'index.js'),
        '--serve',
        '--serve-port',
        '0',
        '--serve-json',
        '--serve-no-pairing',
        '--password-store=basic',
        '--use-mock-keychain',
        `--user-data-dir=${profile}`
      ],
      env: { ...isolation.env, [BROWSER_SIDECAR_OWNER_ENV]: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json'
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384)
    })
    child.stdout?.resume()
    try {
      if (!early) {
        await expect
          .poll(() => existsSync(getRuntimeMetadataPath(profile)), {
            message: 'Browser should become ready while its owner is connected',
            timeout: 30_000
          })
          .toBe(true)
        expect(child.exitCode, stderr).toBeNull()
      }
      child.disconnect()
      await expect
        .poll(() => child.exitCode, {
          message: 'Owner loss should gracefully stop the real browser process',
          timeout: 15_000
        })
        .toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await expect
          .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 5_000 })
          .toBe(true)
      }
      await cleanupE2EDaemons(profile)
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
