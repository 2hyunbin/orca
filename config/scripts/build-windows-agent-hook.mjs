#!/usr/bin/env node

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileWindowsRustExecutable } from './windows-rust-executable-build.mjs'

export function windowsAgentHookDefaultOutputPath(repoRoot) {
  return join(repoRoot, 'native', 'windows-agent-hook', '.build', 'orca-hook.exe')
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = resolve(import.meta.dirname, '../..')
  const iconPath = join(repoRoot, 'resources', 'build', 'icon.ico')
  compileWindowsRustExecutable({
    repoRoot,
    crateRoot: join(repoRoot, 'native', 'windows-agent-hook'),
    binName: 'orca-hook',
    label: 'Windows agent hook',
    fingerprintInputs: [iconPath, join(repoRoot, 'config/scripts/build-windows-agent-hook.mjs')],
    arch: readArg('--arch'),
    outputPath: readArg('--output') ?? windowsAgentHookDefaultOutputPath(repoRoot),
    buildEnv: (version) => ({
      ORCA_HOOK_BUILD_VERSION: version,
      ORCA_HOOK_BUILD_ICON: iconPath
    })
  })
}
