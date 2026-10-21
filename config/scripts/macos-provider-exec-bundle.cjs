const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { compileProviderExec } = require('./build-provider-exec.cjs')
const { MAC_USAGE_DESCRIPTIONS } = require('./macos-usage-descriptions.cjs')

async function buildMacProviderExecBundle(
  resourcesDir,
  arch,
  usageDescriptions = MAC_USAGE_DESCRIPTIONS,
  signCode = async (target) => {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', target])
  }
) {
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported provider host architecture: ${arch}`)
  }
  const bundle = join(resourcesDir, 'provider-exec', 'Orca Provider Host.app')
  const contents = join(bundle, 'Contents')
  const executable = join(contents, 'MacOS', 'orca-provider-exec')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  compileProviderExec(executable, arch)
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
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', bundle])
  execFileSync('/usr/bin/lipo', [executable, '-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64'])
  return bundle
}
module.exports = { buildMacProviderExecBundle }
