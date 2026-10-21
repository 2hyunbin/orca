const { execFileSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { dirname, resolve } = require('node:path')

function compileProviderExec(output, arch = process.arch) {
  if (!['x64', 'arm64'].includes(arch) || !['darwin', 'linux'].includes(process.platform)) {
    throw new Error(`Unsupported provider helper target: ${process.platform}/${arch}`)
  }
  if (process.platform === 'linux' && arch !== process.arch) {
    throw new Error('Provider server helpers must be built on their target architecture and libc')
  }
  mkdirSync(dirname(output), { recursive: true })
  const mac = process.platform === 'darwin'
  execFileSync(
    mac ? '/usr/bin/xcrun' : 'cc',
    [
      ...(mac
        ? ['clang', '-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-mmacosx-version-min=12.0']
        : []),
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fstack-protector-strong',
      resolve(__dirname, '../../native/provider-exec/provider-exec.c'),
      '-o',
      output
    ],
    { stdio: 'inherit' }
  )
}
module.exports = { compileProviderExec }
