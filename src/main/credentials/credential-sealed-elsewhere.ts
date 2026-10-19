/**
 * Why: the desktop app (safeStorage) and orcad (its own host key) share ~/.orca but cannot open
 * each other's sealed files, so a saved file this process cannot read belongs to the other one.
 */
export function credentialSealedElsewhere(has: () => boolean, read: () => unknown): boolean {
  if (!has()) {
    return false
  }
  try {
    read()
    return false
  } catch {
    return true
  }
}

/** A paired client must not overwrite or delete what the other Orca app on this machine reads. */
export function refuseCredentialSealedElsewhere(credentialName: string): never {
  throw new Error(
    `The ${credentialName} on this computer was saved by another Orca app here, which this one cannot read. Change it in that app.`
  )
}
