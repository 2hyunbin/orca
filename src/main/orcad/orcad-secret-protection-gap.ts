/** What orcad tells a user about how its credentials are protected at rest. */

export const ORCAD_PLAINTEXT_SECRETS_ENV = 'ORCA_HEADLESS_SECRET_STORE'

function keychainName(platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? 'the macOS Keychain'
    : platform === 'win32'
      ? 'Windows credential protection'
      : 'a Secret Service keyring'
}

export function describeOrcadPlaintextOptOut(): string {
  return (
    `${ORCAD_PLAINTEXT_SECRETS_ENV}=plaintext is set, so Orca's headless server stores ` +
    'credentials unencrypted on this host.'
  )
}

/**
 * Why not null: a key kept beside the profile stops a copied credential file or backup from
 * being read elsewhere, but not someone who can already read this account's files here.
 */
export function describeOrcadHostKeyGap(platform: NodeJS.Platform, hostBound: boolean): string {
  const why =
    platform === 'win32'
      ? `does not use ${keychainName(platform)}`
      : `could not reach ${keychainName(platform)} when it created its key`
  const binding = hostBound
    ? 'bound to this machine, so copies taken to another machine stay sealed'
    : 'not bound to this machine (it has no stable machine ID), so a copy of the whole profile can be unsealed elsewhere'
  return (
    `Orca's headless server ${why}, so it seals credentials with a key in its private profile ` +
    `directory, ${binding}. Anyone who can read this account's files on this host can unseal them.`
  )
}

export function describeOrcadSealingUnavailable(reason: string, stateFile: string): string {
  return (
    `Orca's headless server cannot unseal its credentials: ${reason}. Saved credentials are kept ` +
    `as they are and new ones are refused until this is fixed and the server restarts. To start ` +
    `over and reconnect every integration, delete ${stateFile}.`
  )
}
