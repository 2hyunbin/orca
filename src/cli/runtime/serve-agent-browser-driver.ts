import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
