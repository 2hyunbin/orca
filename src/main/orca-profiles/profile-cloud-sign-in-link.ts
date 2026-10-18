type SignInLinkListener = (link: string | null) => void

// Why: Orca cannot see whether the browser showed the page, so the open wait's link stays copyable.
let pending: { attempt: number; link: string } | null = null
const listeners = new Set<SignInLinkListener>()

function setPending(next: { attempt: number; link: string } | null): void {
  if (pending?.link === next?.link) {
    return
  }
  pending = next
  for (const listener of listeners) {
    try {
      listener(next?.link ?? null)
    } catch (error) {
      console.warn('[orca-profiles] Sign-in link listener failed:', error)
    }
  }
}

export function getOrcaCloudSignInLink(): string | null {
  return pending?.link ?? null
}

export function onOrcaCloudSignInLinkChanged(listener: SignInLinkListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishOrcaCloudSignInLink(attempt: number, link: string): void {
  setPending({ attempt, link })
}

/** Clears the link when `attempt` owns it, or unconditionally without one. */
export function releaseOrcaCloudSignInLink(attempt?: number): void {
  if (attempt === undefined || pending?.attempt === attempt) {
    setPending(null)
  }
}
