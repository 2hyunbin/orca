import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { inspectMacProcessCodeIdentity } from '../daemon/daemon-mac-code-identity'
import { appBundleForMainExecutable, readCodesignField } from '../daemon/macos-daemon-bundle'
import { fileSha256 } from '../node-runtime/pinned-runtime-materializer'
import type { ProviderExecSource } from './provider-exec-code'

/** Resolve once before admitting launches; later uses execute only the owner's pinned copy. */
export async function resolveProviderExecSource(signal: AbortSignal): Promise<ProviderExecSource> {
  const app = getAppEnvironment()
  const desktop = Boolean(process.versions.electron)
  const development = desktop && !app.isPackaged()
  let root = app.getAppPath()
  let requirement: string | undefined
  if (desktop && app.isPackaged()) {
    if (process.platform === 'darwin') {
      // The image's parked bundle can differ from process.execPath after an update.
      const running = await inspectMacProcessCodeIdentity(process.pid)
      if (!running.executablePath) {
        throw new Error('Could not locate the running app provider helper')
      }
      const bundle = appBundleForMainExecutable(running.executablePath)
      root = join(bundle, 'Contents', 'Resources')
      requirement = await readCodesignField(['--display', '-r-', bundle], 'designated => ', signal)
    } else {
      root = dirname(root)
    }
  }
  const bundle = join(root, 'provider-exec', 'Orca Provider Host.app')
  const executable = development
    ? join(
        root,
        'native',
        'provider-exec',
        '.build',
        `${process.platform}-${process.arch}`,
        'orca-provider-exec'
      )
    : process.platform === 'darwin'
      ? join(bundle, 'Contents', 'MacOS', 'orca-provider-exec')
      : join(root, 'bin', 'orca-provider-exec')
  const sha256 = await fileSha256(executable, signal)
  signal.throwIfAborted()
  if (!sha256) {
    throw new Error('Could not read the provider helper shipped with this host')
  }
  return {
    executable,
    sha256,
    ...(!development && process.platform === 'darwin'
      ? {
          macBundle: {
            path: bundle,
            requirement:
              requirement ??
              (await readCodesignField(['--display', '-r-', bundle], 'designated => ', signal))
          }
        }
      : {})
  }
}
