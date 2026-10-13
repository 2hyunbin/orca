import { open } from 'node:fs/promises'
import { constants } from 'node:fs'

export async function readPluginDirectoryInput(filename: string, limit: number): Promise<Buffer> {
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
  const file = await open(filename, flags)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) {
      throw new Error('Directory catalog must be a regular file within 16 MiB')
    }
    const bytes = Buffer.alloc(stat.size + 1)
    let read = 0
    while (read < bytes.byteLength) {
      const chunk = await file.read(bytes, read, bytes.byteLength - read, null)
      if (chunk.bytesRead === 0) {
        break
      }
      read += chunk.bytesRead
    }
    if (read !== stat.size) {
      throw new Error('Directory catalog changed during the build')
    }
    return bytes.subarray(0, read)
  } finally {
    await file.close()
  }
}
