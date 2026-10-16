import { shell } from 'electron'
import { isClaudeLocalSignInLink } from '../claude-accounts/claude-sign-in-browser'
import { isCodexLoginAuthUrl } from '../codex-accounts/codex-login-auth-url'

export type AccountSignInProvider = 'claude' | 'codex'

/** A provider's own https sign-in page, the only thing a WSL login's link may open. */
export function isOpenableAccountSignInLink(
  provider: AccountSignInProvider,
  signInLink: string
): boolean {
  let url: URL
  try {
    url = new URL(signInLink)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return false
  }
  return provider === 'claude'
    ? isClaudeLocalSignInLink(signInLink)
    : isCodexLoginAuthUrl(signInLink)
}

/** Opens a WSL login's sign-in link in the user's browser; anything else is dropped. */
export function openAccountSignInLink(provider: AccountSignInProvider, signInLink: string): void {
  if (!isOpenableAccountSignInLink(provider, signInLink)) {
    console.warn(`[${provider}-accounts] Refused to open an unexpected sign-in link.`)
    return
  }
  void shell.openExternal(new URL(signInLink).toString()).catch((error: unknown) => {
    console.warn(`[${provider}-accounts] Could not open the sign-in link:`, error)
  })
}
