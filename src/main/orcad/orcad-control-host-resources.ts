import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  orcadTemplateCommonFilenames,
  orcadTemplateTargetFilenames
} from '../../shared/orcad-artifacts'
import { isNodeRuntimeTarget, type NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { verifyFileSha256 } from '../node-runtime/pinned-runtime-materializer'
import {
  readOrcadTemplateManifest,
  verifyOrcadTemplateTarget,
  type OrcadTemplateManifest
} from './orcad-deployment-template'

export type OrcadControlHostResources = {
  suffix: string
  sources: { filename: string; path: string; executable?: boolean }[]
  verify(slot: string): Promise<void>
}

/** The server marker identifies executable bytes; the suffix also pins its outgoing resources. */
export async function collectOrcadControlHostResources(
  templateDir: string,
  manifest: OrcadTemplateManifest,
  hostTarget: NodeRuntimeTarget
): Promise<OrcadControlHostResources> {
  const targets = Object.keys(manifest.targets)
  const filenames = [...orcadTemplateCommonFilenames(), ORCAD_TEMPLATE_MANIFEST_FILENAME]
  for (const target of targets) {
    if (!isNodeRuntimeTarget(target)) {
      throw new Error(`Unsupported deployment template target: ${target}`)
    }
    await verifyOrcadTemplateTarget(templateDir, target, manifest)
    const declared = [...orcadTemplateTargetFilenames(target)]
    const browser = manifest.targets[target]?.browserName
    if (browser) {
      declared.push(browser)
    }
    for (const filename of declared) {
      filenames.push(join(ORCAD_TEMPLATE_TARGETS_DIR, target, filename))
    }
  }
  const identity = JSON.stringify(manifest)
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  return {
    suffix: `-control-${digest}`,
    sources: filenames.map((filename) => ({
      filename: join('resources', 'orcad-template', filename),
      path: join(templateDir, filename)
    })),
    verify: async (slot) => {
      const copied = join(slot, 'resources', 'orcad-template')
      if (JSON.stringify(await readOrcadTemplateManifest(copied)) !== identity) {
        throw new Error('The control host deployment manifest changed')
      }
      for (const target of targets) {
        if (!isNodeRuntimeTarget(target)) {
          throw new Error(`Unsupported deployment template target: ${target}`)
        }
        await verifyOrcadTemplateTarget(copied, target, manifest)
      }
      const targetFiles = new Set(orcadTemplateTargetFilenames(hostTarget))
      for (const filename of [...orcadTemplateCommonFilenames(), ...targetFiles]) {
        const hash = targetFiles.has(filename)
          ? manifest.targets[hostTarget]?.files[filename]
          : manifest.commonSha256[filename]
        if (!hash) {
          throw new Error(`The control host manifest omits ${filename}`)
        }
        await verifyFileSha256(join(slot, filename), hash, `control host ${filename}`)
      }
      const browser = manifest.targets[hostTarget]
      if (browser?.browserName && browser.browserSha256) {
        await verifyFileSha256(
          join(slot, browser.browserName),
          browser.browserSha256,
          'control host browser'
        )
      }
    }
  }
}

export function orcadCacheExecutableVersion(slotName: string): string {
  return slotName.replace(/\.repair-\d+$/u, '').replace(/-control-[a-f0-9]{12}$/u, '')
}
