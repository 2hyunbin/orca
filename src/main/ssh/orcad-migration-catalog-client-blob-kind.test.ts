import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadMigrationBlobChunkRequest } from '../../shared/orcad-migration-blob-transfer'
import {
  ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
} from '../../shared/orcad-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const sendRequest = vi.hoisted(() => vi.fn())
const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    pairing: unknown,
    method: string,
    params: unknown,
    _timeoutMs: number,
    validate: (response: unknown) => void
  ) => {
    validate({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: { capabilities: status.capabilities }
    })
    return sendRequest(pairing, method, params)
  }
}))

const { stageRemoteOrcadMigrationBlobChunk } = await import('./orcad-migration-catalog-client')

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

const request: OrcadMigrationBlobChunkRequest = {
  migrationId: 'migration-blob',
  manifestSha256: 'a'.repeat(64),
  blob: {
    blobKind: 'shell-history',
    key: `${'b'.repeat(16)}-zsh`,
    sha256: 'c'.repeat(64),
    byteLength: 3
  },
  offset: 0,
  bytesBase64: 'YWJj'
}

beforeEach(() => {
  vi.clearAllMocks()
  sendRequest.mockResolvedValue({
    ok: true,
    _meta: { runtimeId: 'runtime' },
    result: {
      migrationId: request.migrationId,
      manifestSha256: request.manifestSha256,
      blobKind: 'shell-history',
      key: request.blob.key,
      receivedBytes: 3
    }
  })
})

describe('orcad migration blob chunk capability gate', () => {
  it.each([
    ['an older destination', [ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY]],
    [
      'a destination with only the channel',
      [ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY, ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY]
    ]
  ])('never sends a blob to %s, and names the kind', async (_, capabilities) => {
    status.capabilities = capabilities
    await expect(stageRemoteOrcadMigrationBlobChunk(pairingCode, request)).rejects.toThrow(
      /^orcad_migration_destination_blob_kind_unsupported:shell-history:/
    )
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('sends through its own method once the destination installs the kind', async () => {
    status.capabilities = [
      ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
      'orcad.migration-blob.shell-history.v1'
    ]
    await expect(stageRemoteOrcadMigrationBlobChunk(pairingCode, request)).resolves.toMatchObject({
      receivedBytes: 3
    })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      'orcad.migration.stageBlobChunk',
      request
    )
  })
})
