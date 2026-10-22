import type { MobileWebBundleReusableAssets } from '../transport/mobile-web-bundle-fetch'
import type { MobileWebBundleAssetRead } from '../transport/mobile-web-bundle-reply-schemas'
import { requireStorablePath } from './generation-asset-path'
import { joinUri } from './generation-cache-uri'
import type { ActiveGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'

/**
 * Copies, never reads: the active generation was hash-verified when it was written and is never
 * written again (only renamed into place and deleted), and the page opens it as is on every
 * launch, so a whole copy is the same bytes the page already trusts. Matched by content, so an
 * asset the next build renamed is still found.
 */
export function reusableAssetsOf(
  fs: GenerationFileSystem,
  active: ActiveGeneration | null,
  stagingDirectory: string
): MobileWebBundleReusableAssets {
  const byHash = new Map((active?.manifest.assets ?? []).map((asset) => [asset.sha256, asset]))
  const cachedOf = (asset: MobileWebBundleAssetRead) => {
    const cached = byHash.get(asset.sha256)
    return cached?.byteLength === asset.byteLength ? cached : undefined
  }
  return {
    has: (asset) => cachedOf(asset) !== undefined,
    // Outside the store's queue and never rejecting: a commit may delete this generation
    // mid-download, and a copy that fails or comes up short costs only a download.
    place: async (asset) => {
      const cached = cachedOf(asset)
      if (active === null || cached === undefined) {
        return false
      }
      try {
        const target = joinUri(stagingDirectory, requireStorablePath(asset.path))
        await fs.copyFile(joinUri(active.directory, requireStorablePath(cached.path)), target)
        return (await fs.fileSize(target)) === asset.byteLength
      } catch {
        return false
      }
    }
  }
}
