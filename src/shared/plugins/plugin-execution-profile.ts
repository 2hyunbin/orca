import { z } from 'zod'
import type { RefinementCtx } from 'zod'

export const PLUGIN_EXECUTION_PROFILES = [
  'data',
  'sandboxed-ui',
  'instructional',
  'trusted-worker'
] as const

export const pluginExecutionProfileSchema = z.enum(PLUGIN_EXECUTION_PROFILES)
export type PluginExecutionProfile = z.infer<typeof pluginExecutionProfileSchema>

export function pluginExecutionAllowsContribution(
  profile: PluginExecutionProfile,
  contribution: 'worker' | 'ui' | 'instructions'
): boolean {
  if (profile === 'trusted-worker') {
    return true
  }
  return (
    (contribution === 'ui' && profile === 'sandboxed-ui') ||
    (contribution === 'instructions' && profile === 'instructional')
  )
}

type ExecutionSubject = {
  main?: string
  capabilities: readonly { kind: string }[]
  contributes: {
    panels: readonly unknown[]
    commands: readonly { action?: string }[]
    events: readonly unknown[]
    keybindings: readonly unknown[]
    vmRecipes: readonly unknown[]
    environmentRecipes?: readonly unknown[]
    agents: readonly unknown[]
    fileViewers?: readonly unknown[]
  }
}

export function derivePluginExecutionProfile(manifest: ExecutionSubject): PluginExecutionProfile {
  if (manifest.main !== undefined) {
    return 'trusted-worker'
  }
  const c = manifest.contributes
  if (c.panels.length || c.fileViewers?.length) {
    return 'sandboxed-ui'
  }
  if (
    c.commands.length ||
    c.keybindings.length ||
    c.vmRecipes.length ||
    c.agents.length ||
    c.environmentRecipes?.length
  ) {
    return 'instructional'
  }
  return 'data'
}

export function validatePluginExecutionProfile(
  manifest: ExecutionSubject & { execution: PluginExecutionProfile },
  ctx: RefinementCtx
): void {
  const { execution, contributes: c } = manifest
  const fail = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path, message })
  }
  if (execution === 'trusted-worker') {
    if (!manifest.main) {
      fail(['main'], 'trusted-worker requires a Node entry')
    }
    return
  }
  if (manifest.main !== undefined && !pluginExecutionAllowsContribution(execution, 'worker')) {
    fail(['main'], `${execution} cannot execute a Node worker`)
  }
  if (execution === 'data' && manifest.capabilities.length) {
    fail(['capabilities'], 'data packages cannot request host capabilities')
  }
  if (!pluginExecutionAllowsContribution(execution, 'ui')) {
    for (const field of ['panels', 'fileViewers'] as const) {
      if (c[field]?.length) {
        fail(['contributes', field], `${execution} cannot execute plugin UI`)
      }
    }
  }
  if (!pluginExecutionAllowsContribution(execution, 'instructions')) {
    for (const field of [
      'commands',
      'keybindings',
      'vmRecipes',
      'agents',
      'environmentRecipes'
    ] as const) {
      if (c[field]?.length) {
        fail(['contributes', field], `${execution} cannot add instructions`)
      }
    }
  }
  if (c.events.length) {
    fail(['contributes', 'events'], 'events require a trusted-worker')
  }
}
