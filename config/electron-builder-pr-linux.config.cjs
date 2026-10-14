const release = require('./electron-builder.config.cjs')
const { Arch } = require('electron-builder')

// CI discards these packages after smoke tests; keep release compression unchanged.
module.exports = {
  ...release,
  publish: null,
  extraMetadata: { ...release.extraMetadata, orcaQualificationBuild: true },
  afterPack: async (context) => {
    if (
      context.electronPlatformName !== 'linux' ||
      context.arch !== Arch.x64 ||
      context.packager.info.options.publish !== 'never'
    ) {
      throw new Error('The qualification package requires Linux x64 and --publish never')
    }
    await release.afterPack(context, { templateTargets: ['linux-x64-glibc'] })
  },
  deb: { ...release.deb, fpm: [...(release.deb.fpm ?? []), '--deb-compression-level=1'] },
  rpm: { ...release.rpm, fpm: [...(release.rpm.fpm ?? []), '--rpm-compression-level=1'] }
}
