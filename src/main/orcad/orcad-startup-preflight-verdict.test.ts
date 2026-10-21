import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import {
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME
} from '../../shared/orcad-artifacts'
import {
  claimStartupPreflightSkip,
  computeStartupPreflightFingerprint,
  forgetSlotStartupPreflightVerdict,
  forgetStartupPreflightVerdict,
  readStartupPreflightVerdict,
  settleSlotStartupPreflightSkip,
  startupPreflightVerdictPath,
  writeStartupPreflightVerdict
} from './orcad-startup-preflight-verdict'

vi.mock('./orcad-artifact-identity', () => ({
  listOrcadArtifactFiles: async () => ['orcad-server.js', 'daemon-entry.js']
}))

let slot: string
let node: string
const runtime = () => ({
  execPath: node,
  nodeVersion: '24.21.0',
  platform: 'darwin' as const,
  arch: 'x64'
})

beforeEach(() => {
  slot = mkdtempSync(join(tmpdir(), 'orcad-preflight-verdict-'))
  for (const file of [
    'orcad-server.js',
    'daemon-entry.js',
    ORCAD_VERSION_FILENAME,
    ORCAD_SERVER_TARGET_FILENAME,
    ORCAD_MOBILE_WEB_MANIFEST
  ]) {
    mkdirSync(dirname(join(slot, file)), { recursive: true })
    writeFileSync(join(slot, file), file)
  }
  node = join(slot, 'node')
  writeFileSync(node, 'node')
})

afterEach(() => {
  rmSync(slot, { recursive: true, force: true })
})

describe('startup preflight verdict', () => {
  it('only lives in a client-managed slot', () => {
    expect(startupPreflightVerdictPath(slot, {})).toBeNull()
    expect(
      startupPreflightVerdictPath(slot, { [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/root' })
    ).toBe(join(slot, '.orcad-startup-preflight.json'))
  })

  it('is stable for an unchanged install and runtime', async () => {
    const first = await computeStartupPreflightFingerprint(slot, runtime())
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(await computeStartupPreflightFingerprint(slot, runtime())).toBe(first)
  })

  it.each([
    ['an artifact is rewritten', () => writeFileSync(join(slot, 'daemon-entry.js'), 'changed!')],
    [
      'an artifact is touched',
      () => utimesSync(join(slot, 'orcad-server.js'), new Date(1), new Date(1))
    ],
    ['the version file changes', () => writeFileSync(join(slot, ORCAD_VERSION_FILENAME), 'next')],
    ['the Node executable is replaced', () => writeFileSync(node, 'another node')]
  ])('changes when %s', async (_label, change) => {
    const before = await computeStartupPreflightFingerprint(slot, runtime())
    change()
    expect(await computeStartupPreflightFingerprint(slot, runtime())).not.toBe(before)
  })

  it('changes with the Node version or architecture', async () => {
    const before = await computeStartupPreflightFingerprint(slot, runtime())
    expect(
      await computeStartupPreflightFingerprint(slot, { ...runtime(), nodeVersion: '24.22.0' })
    ).not.toBe(before)
    expect(
      await computeStartupPreflightFingerprint(slot, { ...runtime(), arch: 'arm64' })
    ).not.toBe(before)
  })

  it('is null, so the probe runs, when an artifact is missing', async () => {
    rmSync(join(slot, 'daemon-entry.js'))
    expect(await computeStartupPreflightFingerprint(slot, runtime())).toBeNull()
  })

  it('round-trips atomically and rejects anything malformed', async () => {
    const path = join(slot, '.orcad-startup-preflight.json')
    const verdict = {
      fingerprint: 'a'.repeat(64),
      artifactVersion: '0.1.0+aaaaaaaaaaaa',
      runtimeVersion: '24.21.0'
    }
    await writeStartupPreflightVerdict(path, verdict)
    expect(await readStartupPreflightVerdict(path)).toEqual({ format: 1, ...verdict })
    expect(readdirSync(slot).filter((name) => name.endsWith('.tmp'))).toEqual([])
    writeFileSync(path, '{"format":1,"fingerprint":"x"}')
    expect(await readStartupPreflightVerdict(path)).toBeNull()
    writeFileSync(path, 'not json')
    expect(await readStartupPreflightVerdict(path)).toBeNull()
  })

  it('forgets the verdict, and tolerates it already being gone', async () => {
    const path = join(slot, '.orcad-startup-preflight.json')
    writeFileSync(path, '{}')
    await forgetStartupPreflightVerdict(path)
    expect(await readStartupPreflightVerdict(path)).toBeNull()
    await expect(forgetStartupPreflightVerdict(path)).resolves.toBeUndefined()
  })

  it('forgets the running slot verdict on a failed start, only when managed', () => {
    const path = join(slot, '.orcad-startup-preflight.json')
    writeFileSync(path, '{}')
    const previous = process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
    try {
      delete process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
      forgetSlotStartupPreflightVerdict(() => slot)
      expect(readdirSync(slot)).toContain('.orcad-startup-preflight.json')
      process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV] = '/root'
      forgetSlotStartupPreflightVerdict(() => slot)
      expect(readdirSync(slot)).not.toContain('.orcad-startup-preflight.json')
      expect(() =>
        forgetSlotStartupPreflightVerdict(() => {
          throw new Error('no slot')
        })
      ).not.toThrow()
    } finally {
      if (previous === undefined) {
        delete process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
      } else {
        process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV] = previous
      }
    }
  })
  it('lets one skipped start through until it reaches readiness', async () => {
    const path = join(slot, '.orcad-startup-preflight.json')
    expect(await claimStartupPreflightSkip(path)).toBe(true)
    // A crash before readiness leaves the claim: the next start must probe.
    expect(await claimStartupPreflightSkip(path)).toBe(false)
    const previous = process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
    try {
      process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV] = '/root'
      settleSlotStartupPreflightSkip(() => slot)
    } finally {
      if (previous === undefined) {
        delete process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV]
      } else {
        process.env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV] = previous
      }
    }
    expect(await claimStartupPreflightSkip(path)).toBe(true)
  })

  it('clears an unfinished claim with the verdict', async () => {
    const path = join(slot, '.orcad-startup-preflight.json')
    writeFileSync(path, '{}')
    await claimStartupPreflightSkip(path)
    await forgetStartupPreflightVerdict(path)
    expect(readdirSync(slot).filter((name) => name.startsWith('.orcad-startup'))).toEqual([])
  })
})
