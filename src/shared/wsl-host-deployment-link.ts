import { z } from 'zod'

/** The characters `wsl --import` accepts; the name is what `wsl.exe -d` takes. */
export const WslDistroNameSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9._-]+$/)

/**
 * The distro's registration GUID (the key under HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss),
 * lowercase and unbraced. Names are case-insensitive and can be reused by a different install;
 * the GUID lasts as long as the registration (an unregister or export/import mints a new one).
 */
export const WslDistroIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

const PortSchema = z.number().int().min(1).max(65_535)

/** A managed orcad Orca deployed into a WSL distro and reaches through a `wsl.exe` stdio bridge. */
export const OrcadWslDeploymentLinkSchema = z.object({
  kind: z.literal('wsl'),
  distro: WslDistroNameSchema,
  distroId: WslDistroIdSchema.optional(),
  /**
   * The GUID last read from the registry when it was absent from or differs from `distroId`
   * (a backfill or a re-import). Older builds strip it, falling back to `distroId`.
   */
  observedDistroId: WslDistroIdSchema.optional().catch(undefined),
  /** The desktop loopback port the bridge listens on; the pairing endpoint points here. */
  localPort: PortSchema,
  /** orcad's listen port inside the distro, which each bridge connection dials. */
  remotePort: PortSchema
})

export type OrcadWslDeploymentLink = z.infer<typeof OrcadWslDeploymentLinkSchema>

export type WslHostRegistration = {
  /** The registration the host runs now; absent when it was never read. */
  current?: string
  /** What a pairing with no recorded GUID was made under; absent when that is unknown. */
  unrecordedPairing?: string
}

/**
 * Only a GUID captured when the host was added vouches for pairings that recorded none: one
 * backfilled or changed later may name a registration those pairings never saw.
 */
export function wslHostRegistration(
  link: Pick<OrcadWslDeploymentLink, 'distroId' | 'observedDistroId'>
): WslHostRegistration {
  const current = link.observedDistroId ?? link.distroId
  const addedUnchanged =
    link.observedDistroId === undefined || link.observedDistroId === link.distroId
  return {
    ...(current ? { current } : {}),
    ...(addedUnchanged && link.distroId ? { unrecordedPairing: link.distroId } : {})
  }
}
