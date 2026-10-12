#!/usr/bin/env node

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  compileWindowsRustExecutable,
  shouldReuseCompiledWindowsRustExecutable,
  windowsRustExecutableFileVersion,
  windowsRustExecutableFingerprint,
  windowsRustExecutableTarget
} from './windows-rust-executable-build.mjs'

const LABEL = 'Windows CLI launcher'

export const windowsCliLauncherFingerprint = windowsRustExecutableFingerprint
export const shouldReuseCompiledWindowsCliLauncher = shouldReuseCompiledWindowsRustExecutable

export function windowsCliLauncherFileVersion(version) {
  return windowsRustExecutableFileVersion(version, LABEL)
}

export function windowsCliLauncherRustTarget(arch) {
  return windowsRustExecutableTarget(arch, LABEL)
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = resolve(import.meta.dirname, '../..')
  const crateRoot = join(repoRoot, 'native', 'windows-cli-launcher')
  const iconPath = join(repoRoot, 'resources', 'build', 'icon.ico')
  compileWindowsRustExecutable({
    repoRoot,
    crateRoot,
    binName: 'orca',
    label: LABEL,
    fingerprintInputs: [iconPath, join(repoRoot, 'config/scripts/build-windows-cli-launcher.mjs')],
    arch: readArg('--arch'),
    outputPath: readArg('--output') ?? join(crateRoot, '.build', 'orca.exe'),
    buildEnv: (version) => ({
      ORCA_LAUNCHER_VERSION: version,
      ORCA_LAUNCHER_ICON: iconPath
    })
  })
}
