import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readPluginDirectoryInput } from './plugin-directory-build-input'

it('bounds build input before allocating and requires a regular file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-directory-input-'))
  try {
    const filename = join(root, 'catalog.json')
    await writeFile(filename, '{}')
    expect((await readPluginDirectoryInput(filename, 128)).toString('utf8')).toBe('{}')
    const large = await open(filename, 'w')
    await large.truncate(1024 * 1024 * 1024)
    await large.close()
    await expect(readPluginDirectoryInput(filename, 128)).rejects.toThrow('regular file within')
    await expect(readPluginDirectoryInput(root, 128)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
