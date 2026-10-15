// Older clients print `messageCount` as exact; only a client advertising this gets rows built
// from a transcript's first and last bytes (`AiVaultSession.contentCoverage`).
export const AI_VAULT_PARTIAL_ROWS_CLIENT_CAPABILITY = 'aiVault.list.partial-rows.v1' as const
