const AMBIENT_GH_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO'
] as const

/** Removes ambient credentials before reading a specific stored account. */
export function stripAmbientGhTokenEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of AMBIENT_GH_ENV_KEYS) {
    delete next[key]
  }
  return next
}
