import { z } from 'zod'
import type { SkillInstallResult } from './skill-install-contract'

export const BundledOrcaSkillInstallRequestSchema = z
  .object({
    names: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
      .min(1)
      .max(32),
    // Why distro optional: the "WSL default" runtime names no distro; the host resolves it.
    wsl: z
      .object({ distro: z.string().min(1).optional() })
      .strict()
      .optional()
  })
  .strict()

export type BundledOrcaSkillInstallRequest = z.infer<typeof BundledOrcaSkillInstallRequestSchema>

export type BundledOrcaSkillInstallResult = SkillInstallResult[]
