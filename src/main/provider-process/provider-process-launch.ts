export type ProviderProcessLaunch = {
  command: string
  args: string[]
  /** Workspace directory used by the provider process itself. */
  cwd?: string
  /** Overlay on the inherited environment. */
  env?: Record<string, string>
  /** Keys stripped after the overlay. */
  envToDelete?: readonly string[]
}

/** The one env rule for provider children: inherit, overlay, then strip (so a delete beats an overlay). */
export function resolveProviderChildEnv(
  launch: Pick<ProviderProcessLaunch, 'env' | 'envToDelete'>,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...launch.env }
  deleteProviderChildEnvKeys(childEnv, launch.envToDelete ?? [])
  return childEnv
}

/** Deletes `keys` from a plain env object; on Windows in any casing, since the child reads its
 *  environment case-insensitively and an `orca_pane_key` would still name a pane there. */
export function deleteProviderChildEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[],
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') {
    for (const key of keys) {
      delete env[key]
    }
    return
  }
  const doomed = new Set(keys.map((key) => key.toUpperCase()))
  for (const key of Object.keys(env)) {
    if (doomed.has(key.toUpperCase())) {
      delete env[key]
    }
  }
}
