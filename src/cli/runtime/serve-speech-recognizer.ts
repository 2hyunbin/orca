import { cpSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { speechRecognizerPackageName } from '../../shared/speech-recognizer-package'

const RECOGNIZER_ADDON = 'sherpa-onnx.node'

/**
 * The installed app's on-device recognizer, for orcad's dictation (#31174). electron-builder puts
 * it in `resources/node_modules`, beside the app root; a dev checkout keeps it in node_modules.
 */
export function findAppSpeechRecognizerDir(
  appRoot: string,
  platform: string = process.platform,
  arch: string = process.arch
): string | undefined {
  const name = speechRecognizerPackageName(platform, arch)
  return [join(dirname(appRoot), 'node_modules', name), join(appRoot, 'node_modules', name)].find(
    (dir) => existsSync(join(dir, RECOGNIZER_ADDON))
  )
}

/**
 * The recognizer directory orcad should load. On Windows a loaded addon locks its files for the
 * process's life, which would make the next app update fail to replace them, so orcad gets a copy
 * in the profile, one per recognizer version. Undefined (cloud models only) when the copy fails.
 * Never pruned here: this runs before the profile lock, while another server may use a copy.
 */
export function stageSpeechRecognizerForOrcad(
  appRecognizerDir: string | undefined,
  userDataPath: string,
  platform: string = process.platform
): string | undefined {
  if (!appRecognizerDir || platform !== 'win32') {
    return appRecognizerDir
  }
  try {
    const target = join(
      userDataPath,
      'speech-recognizer',
      `${basename(appRecognizerDir)}-${recognizerVersion(appRecognizerDir)}`
    )
    if (existsSync(join(target, RECOGNIZER_ADDON))) {
      return target
    }
    // Copied aside then renamed, so a crash mid-copy never leaves a half recognizer in place.
    const staging = `${target}.staging-${process.pid}`
    try {
      // Dereferenced: a linked package (pnpm) would otherwise still lock the app's own files.
      cpSync(appRecognizerDir, staging, { recursive: true, dereference: true })
      renameSync(staging, target)
    } catch (error) {
      // Another serve staged the same version first.
      if (!existsSync(join(target, RECOGNIZER_ADDON))) {
        throw error
      }
    } finally {
      // A failed copy must not leave a partial one behind; after a rename this is a no-op.
      rmSync(staging, { recursive: true, force: true })
    }
    return target
  } catch (error) {
    process.stderr.write(
      `[serve] on-device dictation unavailable: could not stage the speech recognizer: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return undefined
  }
}

function recognizerVersion(dir: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const version =
    parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : undefined
  if (typeof version !== 'string' || !/^[\w.+-]+$/.test(version)) {
    throw new Error('the recognizer package names no version')
  }
  return version
}
