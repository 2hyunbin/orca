import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readContainedPluginArtifactText,
  resolveContainedPluginArtifact
} from './plugin-artifact-file-reader'
import { openAuthorizedRegularFile } from '../../shared/authorized-regular-file'
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-artifact-'))
  roots.push(root)
  const plugin = join(root, 'plugin')
  await mkdir(plugin)
  await writeFile(join(root, 'outside.json'), 'outside-owner')
  await writeFile(join(plugin, 'recipe.json'), '{"version":1}')
  return { root, plugin }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('plugin artifacts are bounded regular UTF-8 files inside the current package', () => {
  it('returns complete declared bytes, rejects oversized text, and refuses directory entries', async () => {
    const f = await fixture()
    expect(await readContainedPluginArtifactText(f.plugin, 'recipe.json', 13)).toBe('{"version":1}')
    await expect(readContainedPluginArtifactText(f.plugin, 'recipe.json', 12)).rejects.toThrow(
      'limit'
    )
    await mkdir(join(f.plugin, 'directory'))
    await expect(resolveContainedPluginArtifact(f.plugin, 'directory')).rejects.toThrow(
      'regular file'
    )
    await expect(
      readContainedPluginArtifactText(f.plugin, '../outside.json', 1024)
    ).rejects.toThrow('outside')
  })
  it('refuses malformed UTF-8 instead of substituting bytes into a reviewed artifact', async () => {
    const f = await fixture()
    await writeFile(join(f.plugin, 'malformed.json'), Buffer.from([0x7b, 0xff, 0x7d]))
    await expect(
      readContainedPluginArtifactText(f.plugin, 'malformed.json', 1024)
    ).rejects.toThrow()
  })
  it('permits an internal symlink but refuses one that escapes the package', async (context) => {
    const f = await fixture()
    try {
      await symlink(join(f.plugin, 'recipe.json'), join(f.plugin, 'inside-link.json'))
      await symlink(join(f.root, 'outside.json'), join(f.plugin, 'outside-link.json'))
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        context.skip('Windows account cannot create the symlink fixture')
        return
      }
      throw error
    }
    expect(await readContainedPluginArtifactText(f.plugin, 'inside-link.json', 1024)).toBe(
      '{"version":1}'
    )
    await expect(
      readContainedPluginArtifactText(f.plugin, 'outside-link.json', 1024)
    ).rejects.toThrow('outside')
  })
  it('keeps authorized bytes on their opened descriptor after the pathname is replaced', async () => {
    const f = await fixture()
    const path = join(f.plugin, 'recipe.json')
    const opened = await openAuthorizedRegularFile({
      boundaryPath: f.plugin,
      entryPath: path,
      targetPath: path,
      implicitRootPath: null,
      authorizedRootPaths: []
    })
    try {
      await rm(path)
      await writeFile(path, 'replacement-owner')
      expect((await opened.handle.readFile()).toString('utf8')).toBe('{"version":1}')
    } finally {
      await opened.handle.close()
    }
  })
})
