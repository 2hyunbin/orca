import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { orcadAgentBrowserNativeName } from '../../shared/orcad-agent-browser-name'

/** The installed app's agent-browser driver, for orcad's Chromium provider (#33846). Packaged apps ship it in `resources`; a dev checkout keeps it in node_modules. */
export function findAppAgentBrowserDriver(
  appRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | undefined {
  const name = orcadAgentBrowserNativeName(platform, arch)
  return [
    join(dirname(appRoot), name),
    join(appRoot, 'node_modules', 'agent-browser', 'bin', name)
  ].find((path) => existsSync(path))
}

/** Windows locks a running image, so orcad's long-lived daemon runs a profile copy that app updates never replace. */
export async function stageAppAgentBrowserDriver(
  appRoot: string,
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): Promise<string | undefined> {
  const driver = findAppAgentBrowserDriver(appRoot, platform, arch)
  if (!driver || platform !== 'win32') {
    return driver
  }
  const root = join(userDataPath, 'orcad-agent-browser')
  try {
    const { size, mtimeMs } = await stat(driver)
    const id = `${size}-${Math.trunc(mtimeMs)}`
    const staged = join(root, id, basename(driver))
    if (!existsSync(staged)) {
      const temporary = join(root, `.tmp-${process.pid}-${id}`)
      await mkdir(temporary, { recursive: true })
      await copyFile(driver, join(temporary, basename(driver)))
      await rename(temporary, join(root, id)).catch(async (error: unknown) => {
        await rm(temporary, { recursive: true, force: true })
        if (!existsSync(staged)) {
          throw error
        }
      })
    }
    // A copy still running for another serve stays locked and survives until a later pass.
    for (const name of await readdir(root)) {
      if (name !== id) {
        await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return staged
  } catch {
    return driver
  }
}
