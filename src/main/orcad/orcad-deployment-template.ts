import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  orcadTemplateCommonFilenames,
  orcadTemplateTargetFilenames
} from '../../shared/orcad-artifacts'
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { verifyFileSha256 } from '../node-runtime/pinned-runtime-materializer'
import { OrcadHostUnsupportedError } from './orcad-host-unavailable'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const TemplateTargetSchema = z
  .object({
    files: z.record(z.string(), Sha256Schema),
    browserName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
      .optional(),
    browserSha256: Sha256Schema.optional()
  })
  .refine((target) => Boolean(target.browserName) === Boolean(target.browserSha256), {
    message: 'browserName and browserSha256 must either both be present or both be absent'
  })
const TemplateManifestSchema = z.object({
  schemaVersion: z.literal(3),
  commonSha256: z.record(z.string(), Sha256Schema),
  targets: z.record(z.string(), TemplateTargetSchema)
})

export type OrcadTemplateManifest = z.infer<typeof TemplateManifestSchema>

export async function readOrcadTemplateManifest(
  templateDir: string
): Promise<z.infer<typeof TemplateManifestSchema>> {
  return TemplateManifestSchema.parse(
    JSON.parse(await readFile(join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME), 'utf8'))
  )
}

export async function verifyOrcadTemplateTarget(
  templateDir: string,
  target: NodeRuntimeTarget,
  manifest: z.infer<typeof TemplateManifestSchema>
): Promise<void> {
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new OrcadHostUnsupportedError(`Packaged orcad template does not support ${target}`)
  }
  for (const filename of orcadTemplateCommonFilenames()) {
    const expected = manifest.commonSha256[filename]
    if (!expected) {
      throw new Error(`Packaged orcad template manifest omits ${filename}`)
    }
    await verifyFileSha256(join(templateDir, filename), expected, `orcad template ${filename}`)
  }
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  for (const filename of orcadTemplateTargetFilenames(target)) {
    const expected = targetManifest.files[filename]
    if (!expected) {
      throw new Error(`Packaged orcad template manifest omits ${target} ${filename}`)
    }
    await verifyFileSha256(join(targetDir, filename), expected, `${target} ${filename}`)
  }
  if ((await readFile(join(targetDir, ORCAD_SERVER_TARGET_FILENAME), 'utf8')).trim() !== target) {
    throw new Error(`Packaged orcad template target identity does not match ${target}`)
  }
  // Why against this client's pin: the slot must name the runtime this client will upload.
  const runtimeReference = await readFile(
    join(targetDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME),
    'utf8'
  )
  if (runtimeReference.trim() !== pinnedNodeRuntimeAsset(target).executableSha256) {
    throw new Error(`Packaged orcad template ${target} does not reference the pinned Node`)
  }
  if (targetManifest.browserName && targetManifest.browserSha256) {
    await verifyFileSha256(
      join(targetDir, targetManifest.browserName),
      targetManifest.browserSha256,
      `${target} browser`
    )
  }
}
