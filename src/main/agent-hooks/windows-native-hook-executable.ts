import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isPermissionError } from '../win32-utils'

/** The packaged binary (native/windows-agent-hook); copies take each agent's managed script name. */
export const WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME = 'orca-hook.exe'

const PE_SECURITY_DIRECTORY_INDEX = 4
const PE_HEADER_READ_BYTES = 4096
const RETIRED_COPY_SUFFIX = '.retired'

/**
 * The signed hook binary this packaged app ships, or null when this build cannot provide one
 * (dev checkouts, orcad, unsigned dev-channel builds), so callers keep the `.cmd` hook.
 */
export function resolveBundledWindowsNativeHookExecutable(): string | null {
  // Narrowed rather than typed: the CLI build compiles this without Electron's Process type.
  const resourcesPath = 'resourcesPath' in process ? process.resourcesPath : undefined
  if (process.platform !== 'win32' || typeof resourcesPath !== 'string' || !resourcesPath) {
    return null
  }
  const path = join(resourcesPath, 'bin', WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME)
  return hasEmbeddedAuthenticodeSignature(path) ? path : null
}

/**
 * Whether the PE carries an Authenticode certificate table. Presence, not trust: the source sits
 * in the install directory the signed installer wrote, and verifying the chain would need
 * WinVerifyTrust or PowerShell, neither of which this path may load or spawn.
 */
export function hasEmbeddedAuthenticodeSignature(path: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(PE_HEADER_READ_BYTES)
    const read = readSync(fd, header, 0, header.length, 0)
    if (read < 0x40 || header.toString('latin1', 0, 2) !== 'MZ') {
      return false
    }
    const peOffset = header.readUInt32LE(0x3c)
    const optionalHeader = peOffset + 24
    if (
      optionalHeader + 2 > read ||
      header.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0'
    ) {
      return false
    }
    const isPe32Plus = header.readUInt16LE(optionalHeader) === 0x20b
    const directoryCount = header.readUInt32LE(optionalHeader + (isPe32Plus ? 108 : 92))
    const entry = optionalHeader + (isPe32Plus ? 112 : 96) + PE_SECURITY_DIRECTORY_INDEX * 8
    if (directoryCount <= PE_SECURITY_DIRECTORY_INDEX || entry + 8 > read) {
      return false
    }
    // The security directory holds a file offset, not an RVA.
    const offset = header.readUInt32LE(entry)
    const size = header.readUInt32LE(entry + 4)
    return offset > 0 && size > 0 && offset + size <= statSync(path).size
  } catch {
    return false
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

/**
 * Copies the bundled hook to `destinationPath` unless an identical copy is already there.
 * Returns false when the destination cannot be made current, so the caller registers the
 * `.cmd` hook instead. Same verbatim-copy rule as the daemon-host relocation
 * (src/main/daemon/daemon-host-relocation.ts): byte-for-byte keeps the Authenticode signature.
 */
export function installWindowsNativeHookExecutable(
  sourcePath: string,
  destinationPath: string
): boolean {
  try {
    const source = readFileSync(sourcePath)
    const directory = dirname(destinationPath)
    mkdirSync(directory, { recursive: true })
    sweepRetiredCopies(directory, basename(destinationPath))
    if (hasContent(destinationPath, source)) {
      return true
    }
    const tmpPath = tmpCopyPath(destinationPath)
    try {
      writeFileSync(tmpPath, source, { flag: 'wx' })
      replaceExecutable(tmpPath, destinationPath)
    } finally {
      rmSync(tmpPath, { force: true })
    }
    return hasContent(destinationPath, source)
  } catch {
    return false
  }
}

function hasContent(path: string, expected: Buffer): boolean {
  try {
    return statSync(path).size === expected.length && readFileSync(path).equals(expected)
  } catch {
    return false
  }
}

function replaceExecutable(tmpPath: string, destinationPath: string): void {
  try {
    renameSync(tmpPath, destinationPath)
  } catch (error) {
    if (!isPermissionError(error)) {
      throw error
    }
    // Why: a hook still running maps the old image, which Windows lets us rename but not
    // replace. Move it aside; the next install deletes it once that process has exited.
    renameSync(destinationPath, retiredCopyPath(destinationPath))
    renameSync(tmpPath, destinationPath)
  }
}

/**
 * Brings a surviving copy up to this build's binary after an app update. Async because
 * startup refresh must not block the main thread; never creates a copy that install() did not.
 */
export async function refreshWindowsNativeHookExecutable(
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const tmpPath = tmpCopyPath(destinationPath)
  try {
    const [source, current] = await Promise.all([readFile(sourcePath), readFile(destinationPath)])
    const directory = dirname(destinationPath)
    for (const entry of await readdir(directory)) {
      if (isRetiredCopy(entry, basename(destinationPath))) {
        await rm(join(directory, entry), { force: true }).catch(() => {})
      }
    }
    if (current.equals(source)) {
      return
    }
    await writeFile(tmpPath, source, { flag: 'wx' })
    await rename(tmpPath, destinationPath).catch(async (error: unknown) => {
      if (!isPermissionError(error)) {
        throw error
      }
      // Same running-image case as replaceExecutable().
      await rename(destinationPath, retiredCopyPath(destinationPath))
      await rename(tmpPath, destinationPath)
    })
  } catch {
    // A copy that cannot be refreshed keeps running the previous build's hook.
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {})
  }
}

function tmpCopyPath(destinationPath: string): string {
  return join(dirname(destinationPath), `.${basename(destinationPath)}.${randomUUID()}.tmp`)
}

function retiredCopyPath(destinationPath: string): string {
  return `${destinationPath}.${randomUUID()}${RETIRED_COPY_SUFFIX}`
}

function isRetiredCopy(entry: string, fileName: string): boolean {
  return entry.startsWith(`${fileName}.`) && entry.endsWith(RETIRED_COPY_SUFFIX)
}

function sweepRetiredCopies(directory: string, fileName: string): void {
  for (const entry of readdirSync(directory)) {
    if (isRetiredCopy(entry, fileName)) {
      try {
        rmSync(join(directory, entry), { force: true })
      } catch {
        // A copy whose hook is still running stays until a later install.
      }
    }
  }
}
