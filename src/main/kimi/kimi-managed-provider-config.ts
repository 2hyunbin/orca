import { parse as parseToml } from 'smol-toml'
import { isPlainObject } from '../agent-hooks/hooks-json-read'

const DEFAULT_TOKEN_NAME = 'kimi-code'

export type KimiManagedProvider = {
  /** File stem under `<kimi home>/credentials/`. */
  tokenName: string
  baseUrl: string | undefined
}

// Mirrors Kimi Code's resolveKimiTokenStorageName + FileTokenStorage.pathFor:
// `oauth/<name>` → `<name>`, and the name must be a plain, non-hidden file name.
function tokenNameFromOAuthKey(key: unknown): string {
  const name = typeof key === 'string' ? key.replace(/^oauth\//, '') : ''
  return /^[^./\\][^/\\]*$/.test(name) ? name : DEFAULT_TOKEN_NAME
}

/**
 * Kimi Code 2.x scopes the managed OAuth slot per environment (e.g. auth.kimi.ai
 * logs in to `kimi-code-env-<hash>`) and records it, with the matching API base,
 * under `[providers."managed:kimi-code"]` in config.toml.
 */
export function readKimiManagedProvider(configToml: string): KimiManagedProvider {
  let provider: unknown
  try {
    const providers = parseToml(configToml).providers
    provider = isPlainObject(providers) ? providers['managed:kimi-code'] : undefined
  } catch {
    provider = undefined
  }
  if (!isPlainObject(provider)) {
    return { tokenName: DEFAULT_TOKEN_NAME, baseUrl: undefined }
  }
  const oauth = provider.oauth
  return {
    tokenName: tokenNameFromOAuthKey(isPlainObject(oauth) ? oauth.key : undefined),
    baseUrl: typeof provider.base_url === 'string' ? provider.base_url : undefined
  }
}
