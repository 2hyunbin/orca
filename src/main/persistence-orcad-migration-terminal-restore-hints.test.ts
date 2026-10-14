import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcadMigrationBlobDescriptor } from '../shared/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../shared/orcad-migration-manifest'
import { getOrcadMigrationReceivedBlobPath } from './persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import { buildWslMoveRestoreHintsBlob } from './persistence/moving-wsl-projects/wsl-move-restore-hints-blob'
import { commitStagedOrcadMigrationCatalogDurably } from './runtime/orcad-migration-catalog-import'
import { manifest } from './persistence-orcad-migration-catalog-fixture'
import { createStore, testState } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'

type Store = ReturnType<typeof createStore>

function encodedHints(): { descriptor: OrcadMigrationBlobDescriptor; bytes: Buffer } {
  const blob = buildWslMoveRestoreHintsBlob([
    { paneKey: PANE, cwd: '/home/me/src' },
    { paneKey: OTHER_PANE, cwd: '/srv/app' }
  ])
  if (!blob) {
    throw new Error('expected a hints blob')
  }
  return blob
}

function rawBlob(bytes: Buffer): { descriptor: OrcadMigrationBlobDescriptor; bytes: Buffer } {
  return {
    bytes,
    descriptor: {
      blobKind: 'terminal-restore-hints',
      key: 'migration',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    }
  }
}

function stageBlob(
  store: Store,
  input: OrcadMigrationManifest,
  blob: { descriptor: OrcadMigrationBlobDescriptor; bytes: Buffer }
): void {
  store.stageOrcadMigrationCatalog(input)
  store.stageOrcadMigrationBlobChunk({
    migrationId: input.migrationId,
    manifestSha256: input.manifestSha256,
    blob: blob.descriptor,
    offset: 0,
    bytesBase64: blob.bytes.toString('base64')
  })
}

function receivedPath(input: OrcadMigrationManifest): string {
  return getOrcadMigrationReceivedBlobPath(join(testState.dir, 'orcad-migration-blobs'), input, {
    blobKind: 'terminal-restore-hints',
    key: 'migration'
  })
}

async function commitDurably(store: Store, input: OrcadMigrationManifest): Promise<string> {
  const result = await commitStagedOrcadMigrationCatalogDurably({
    store,
    manifest: input,
    onDurableCommit: () => {}
  })
  return result.state
}

describe('orcad migration terminal restore hints through the store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-migration-restore-hints-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('installs hints after the durable commit, deletes the blob, and survives a restart', async () => {
    const input = manifest()
    const store = createStore()
    const blob = encodedHints()
    stageBlob(store, input, blob)

    expect(await commitDurably(store, input)).toBe('committed')
    expect(existsSync(receivedPath(input))).toBe(false)

    const restarted = createStore()
    expect(restarted.takeOrcadMigrationTerminalRestoreHint(PANE)).toBe('/home/me/src')
    expect(restarted.takeOrcadMigrationTerminalRestoreHint(PANE)).toBeNull()
    expect(createStore().takeOrcadMigrationTerminalRestoreHint(PANE)).toBeNull()
    expect(createStore().takeOrcadMigrationTerminalRestoreHint(OTHER_PANE)).toBe('/srv/app')
  })

  it('is idempotent across commit retries and never revives a taken hint', async () => {
    const input = manifest()
    const store = createStore()
    const blob = encodedHints()
    stageBlob(store, input, blob)
    store.commitStagedOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    // A crash after install but before the blob was deleted leaves it in place.
    store.installOrcadMigrationReceivedBlobs(input)
    expect(store.takeOrcadMigrationTerminalRestoreHint(PANE)).toBe('/home/me/src')
    writeFileSync(receivedPath(input), blob.bytes)

    expect(await commitDurably(createStore(), input)).toBe('committed')
    expect(existsSync(receivedPath(input))).toBe(false)
    const restarted = createStore()
    expect(restarted.takeOrcadMigrationTerminalRestoreHint(PANE)).toBeNull()
    expect(restarted.takeOrcadMigrationTerminalRestoreHint(OTHER_PANE)).toBe('/srv/app')
  })

  it('installs nothing for a catalog that is only staged', () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, encodedHints())
    store.installOrcadMigrationReceivedBlobs(input)
    expect(store.takeOrcadMigrationTerminalRestoreHint(PANE)).toBeNull()
  })

  it('refuses to commit a digest-exact blob that is not a hints document', () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, rawBlob(Buffer.from('{"version":1,"hints":[{"paneKey":"x"}]}')))

    expect(() => store.commitStagedOrcadMigrationCatalog(input)).toThrow(
      /^orcad_migration_blob_content_invalid:terminal-restore-hints:/
    )
    expect(store.getOrcadMigrationCatalogState(input).state).toBe('staged')
  })

  it('drops a received file damaged after commit without failing the committed catalog', async () => {
    const input = manifest()
    const store = createStore()
    stageBlob(store, input, encodedHints())
    store.commitStagedOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()
    writeFileSync(receivedPath(input), 'not json')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await commitDurably(createStore(), input)).toBe('committed')
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('dropped unreadable terminal restore hints'),
      expect.any(Error)
    )
    expect(existsSync(receivedPath(input))).toBe(false)
    expect(createStore().takeOrcadMigrationTerminalRestoreHint(PANE)).toBeNull()
    error.mockRestore()
  })
})
