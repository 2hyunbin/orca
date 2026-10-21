const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

async function buildMacProviderExecBundle(resourcesDir, arch, usageDescriptions, signCode) {
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported provider host architecture: ${arch}`)
  }
  const bundle = join(resourcesDir, 'provider-exec', 'Orca Provider Host.app')
  const contents = join(bundle, 'Contents')
  const executable = join(contents, 'MacOS', 'orca-provider-exec')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  execFileSync(
    '/usr/bin/xcrun',
    [
      'clang',
      '-arch',
      arch === 'x64' ? 'x86_64' : 'arm64',
      '-mmacosx-version-min=12.0',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fstack-protector-strong',
      resolve(__dirname, '../../native/provider-exec/provider-exec.c'),
      '-o',
      executable
    ],
    { stdio: 'inherit' }
  )
  const info = {
    CFBundleIdentifier: 'com.stablyai.orca',
    CFBundleName: 'Orca Provider Host',
    CFBundleExecutable: 'orca-provider-exec',
    CFBundlePackageType: 'APPL',
    CFBundleVersion: '1',
    CFBundleShortVersionString: '1.0',
    LSUIElement: true,
    LSMinimumSystemVersion: '12.0',
    ...usageDescriptions
  }
  const plist = join(contents, 'Info.plist')
  writeFileSync(plist, JSON.stringify(info))
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', plist])
  await signCode(executable)
  await signCode(bundle)
  execFileSync('/usr/bin/lipo', [executable, '-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64'])
  return bundle
}
module.exports = { buildMacProviderExecBundle }
