import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findAppAgentBrowserDriver } from './serve-agent-browser-driver'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("finding the app's agent-browser driver (#33846)", () => {
  it.each([
    ['linux', 'x64', 'agent-browser-linux-x64'],
    ['darwin', 'arm64', 'agent-browser-darwin-arm64'],
    ['win32', 'x64', 'agent-browser-win32-x64.exe']
  ] as const)('finds the copy a packaged %s app ships in resources', (platform, arch, name) => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-serve-agent-browser-'))
    roots.push(resources)
    mkdirSync(join(resources, 'app.asar.unpacked'))
    writeFileSync(join(resources, name), '')
    expect(findAppAgentBrowserDriver(join(resources, 'app.asar.unpacked'), platform, arch)).toBe(
      join(resources, name)
    )
    expect(findAppAgentBrowserDriver(join(resources, 'app.asar.unpacked'), platform, 'ia32')).toBe(
      undefined
    )
  })
})
