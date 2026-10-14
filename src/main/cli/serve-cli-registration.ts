import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'
import { prepareAppImageCopyForServe } from './appimage-serve-preparation'
import { CliInstaller } from './cli-installer'
import { installLinuxBareOrcaDispatcher } from './linux-bare-orca-dispatcher'

export type ServeCliRegistrationContext = {
  platform: NodeJS.Platform
  isPackaged: boolean
  userDataPath: string
  resourcesPath: string
  execPath: string
  appPath: string
  homePath?: string
  log?: (line: string) => void
}

/** Both serve runtimes register through the same ownership-safe installer. */
export async function registerCliForServe(context: ServeCliRegistrationContext): Promise<void> {
  const log = context.log ?? console.log
  // Windows-excluded: install() only mutates registry PATH, not child terminals.
  if (context.platform !== 'darwin' && context.platform !== 'linux') {
    return
  }
  const appImagePath =
    context.platform === 'linux'
      ? (resolveAppImageRuntimeIdentity(context)?.appImagePath ?? null)
      : null
  let appImageDeadlineAt: number | undefined
  if (appImagePath) {
    // Why first: CLI install and the bare dispatcher would otherwise each wait out their own
    // extraction timeout; this gives the whole AppImage wait one deadline and visible progress.
    const preparation = await prepareAppImageCopyForServe({ appImagePath, log })
    if (preparation.status === 'unavailable') {
      log(`[serve] orca CLI install skipped: ${preparation.reason}`)
      return
    }
    appImageDeadlineAt = preparation.deadlineAt
  }
  try {
    // Why: serve is headless — a fallback osascript admin prompt would hang it; skip elevation since ~/.local/bin needs none.
    const cliStatus = await new CliInstaller({
      ...context,
      privilegedRunner: async () => {
        throw new Error('serve CLI auto-install must not request administrator privileges')
      },
      ...(appImageDeadlineAt === undefined ? {} : { appImageDeadlineAt })
    }).install()
    log(
      `[serve] orca CLI install: ${cliStatus.state}${cliStatus.commandPath ? ` (${cliStatus.commandPath})` : ''}`
    )
  } catch (error) {
    log(
      `[serve] orca CLI install skipped: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  // Why: Linux CLI installs as `orca-ide`, but the Claude Team launcher invokes bare `orca`; drop a ~/.local/bin dispatcher (ahead of /usr/bin) so it resolves. Best-effort.
  if (context.platform === 'linux' && context.isPackaged && context.resourcesPath) {
    try {
      const dispatcher = await installLinuxBareOrcaDispatcher({
        resourcesPath: context.resourcesPath,
        ...(context.homePath ? { homePath: context.homePath } : {}),
        ...(appImageDeadlineAt === undefined ? {} : { appImageDeadlineAt })
      })
      log(
        `[serve] bare orca dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
          `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}`
      )
    } catch (error) {
      log(
        `[serve] bare orca dispatcher install skipped: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
