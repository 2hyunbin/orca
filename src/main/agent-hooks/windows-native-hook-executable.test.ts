import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  hasEmbeddedAuthenticodeSignature,
  installWindowsNativeHookExecutable
} from './windows-native-hook-executable'
import {
  buildWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
} from './windows-native-hook-exe.test-fixture'

const roots: string[] = []

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-hook-install-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeTreeSync(root)
  }
})

/** A PE32+ header whose certificate-table entry points at `size` bytes past the headers. */
function peImage(certificateSize: number, directoryCount = 16): Buffer {
  const peOffset = 0x80
  const optionalHeader = peOffset + 24
  const image = Buffer.alloc(0x400 + certificateSize)
  image.write('MZ', 0, 'latin1')
  image.writeUInt32LE(peOffset, 0x3c)
  image.write('PE\0\0', peOffset, 'latin1')
  image.writeUInt16LE(0x20b, optionalHeader)
  image.writeUInt32LE(directoryCount, optionalHeader + 108)
  const securityEntry = optionalHeader + 112 + 4 * 8
  image.writeUInt32LE(certificateSize > 0 ? 0x400 : 0, securityEntry)
  image.writeUInt32LE(certificateSize, securityEntry + 4)
  return image
}

describe('hasEmbeddedAuthenticodeSignature', () => {
  it('requires a certificate table that lies inside the file', () => {
    const dir = tempDir()
    const cases: [string, Buffer, boolean][] = [
      ['signed.exe', peImage(64), true],
      ['unsigned.exe', peImage(0), false],
      ['no-security-directory.exe', peImage(64, 4), false],
      ['truncated.exe', peImage(64).subarray(0, 0x410), false],
      ['not-pe.exe', Buffer.from('#!/bin/sh\n'), false]
    ]
    for (const [name, image, expected] of cases) {
      writeFileSync(join(dir, name), image)
      expect(hasEmbeddedAuthenticodeSignature(join(dir, name)), name).toBe(expected)
    }
    expect(hasEmbeddedAuthenticodeSignature(join(dir, 'missing.exe'))).toBe(false)
  })
})

describe('installWindowsNativeHookExecutable', () => {
  it('copies byte-for-byte, then leaves an identical copy alone', () => {
    const dir = tempDir()
    const source = join(dir, 'orca-hook.exe')
    const destination = join(dir, 'hooks', 'claude-hook.exe')
    writeFileSync(source, peImage(64))

    expect(installWindowsNativeHookExecutable(source, destination)).toBe(true)
    expect(readFileSync(destination).equals(readFileSync(source))).toBe(true)
    const before = readdirSync(join(dir, 'hooks'))
    expect(installWindowsNativeHookExecutable(source, destination)).toBe(true)
    expect(readdirSync(join(dir, 'hooks'))).toEqual(before)
  })

  it('replaces a stale copy and leaves no temp file behind', () => {
    const dir = tempDir()
    const source = join(dir, 'orca-hook.exe')
    const destination = join(dir, 'claude-hook.exe')
    writeFileSync(source, peImage(64))
    writeFileSync(destination, 'previous build')

    expect(installWindowsNativeHookExecutable(source, destination)).toBe(true)
    expect(readFileSync(destination).equals(readFileSync(source))).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['claude-hook.exe', 'orca-hook.exe'])
  })

  it('reports failure when the bundled binary is missing, so the .cmd hook is registered', () => {
    const dir = tempDir()
    expect(installWindowsNativeHookExecutable(join(dir, 'absent.exe'), join(dir, 'x.exe'))).toBe(
      false
    )
    expect(existsSync(join(dir, 'x.exe'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'moves a running copy aside instead of failing the update',
    { timeout: WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS },
    async () => {
      const dir = tempDir()
      const destination = join(dir, 'claude-hook.exe')
      expect(
        installWindowsNativeHookExecutable(buildWindowsNativeHookExecutable(), destination)
      ).toBe(true)
      // In-pane env with stdin held open keeps the hook running and its image mapped.
      const running = spawn(destination, [], {
        env: {
          SystemRoot: process.env.SystemRoot,
          ORCA_AGENT_HOOK_PORT: '1',
          ORCA_AGENT_HOOK_TOKEN: 'token',
          ORCA_PANE_KEY: 'tab:leaf'
        },
        stdio: ['pipe', 'pipe', 'ignore']
      })
      try {
        await new Promise((resolve) => running.stdout.once('data', resolve))
        const next = join(dir, 'next-build.exe')
        writeFileSync(next, Buffer.concat([readFileSync(destination), Buffer.from('next')]))

        expect(installWindowsNativeHookExecutable(next, destination)).toBe(true)
        expect(readFileSync(destination).equals(readFileSync(next))).toBe(true)
        expect(readdirSync(dir).filter((name) => name.endsWith('.retired'))).toHaveLength(1)
      } finally {
        running.stdin.end()
        await new Promise((resolve) => running.once('close', resolve))
      }
      // The next install sweeps the retired copy once its process is gone.
      expect(installWindowsNativeHookExecutable(destination, destination)).toBe(true)
      expect(readdirSync(dir).filter((name) => name.endsWith('.retired'))).toHaveLength(0)
    }
  )
})
