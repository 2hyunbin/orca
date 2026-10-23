import { runProcess } from '@orca/process-host'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import type { OrcadMigrationBlobDescriptor } from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { stageOrcadMigrationBlobChunk } from './orcad-migration-blob-staging'
import {
  encodeOrcadMigrationShellHistoryHeader,
  orcadMigrationShellHistoryKey
} from './orcad-migration-shell-history-format'

it('verifies and commits a 256 MiB migration without retaining whole blobs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orcad-migration-memory-'))
  try {
    const manifest: OrcadMigrationManifest = {
      version: ORCAD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'memory-check',
      manifestSha256: 'a'.repeat(64),
      createdAt: '2026-10-23T00:00:00.000Z',
      source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel: 'Source' },
      payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
    }
    const chunk = Buffer.alloc(128 * 1024, 0x78)
    chunk[0] = 0x23
    chunk[chunk.length - 1] = 0x0a
    const descriptors: OrcadMigrationBlobDescriptor[] = []
    for (let index = 0; index < 4; index++) {
      const worktreeId = `repo::${join(root, `workspace-${index}`)}`
      const header = encodeOrcadMigrationShellHistoryHeader(worktreeId)
      const firstChunk = Buffer.from(chunk)
      header.copy(firstChunk)
      firstChunk[header.length] = 0x23
      const hash = createHash('sha256').update(firstChunk)
      for (let chunkIndex = 1; chunkIndex < 512; chunkIndex++) {
        hash.update(chunk)
      }
      const blob: OrcadMigrationBlobDescriptor = {
        blobKind: 'shell-history',
        key: orcadMigrationShellHistoryKey(worktreeId, 'bash'),
        byteLength: 64 * 1024 * 1024,
        sha256: hash.digest('hex')
      }
      descriptors.push(blob)
      for (let offset = 0; offset < blob.byteLength; offset += chunk.length) {
        stageOrcadMigrationBlobChunk({
          root,
          stagedManifest: manifest,
          request: {
            migrationId: manifest.migrationId,
            manifestSha256: manifest.manifestSha256,
            blob,
            offset,
            bytesBase64: (offset === 0 ? firstChunk : chunk).toString('base64')
          }
        })
      }
    }
    const child = join(root, 'verify.cjs')
    const launcher = join(root, 'launch.cjs')
    await build({
      stdin: {
        contents: `
          import { statSync } from 'node:fs';
          import {
            assertOrcadMigrationBlobSetMatches, assertOrcadMigrationBlobsReady,
            commitOrcadMigrationBlobs, getOrcadMigrationReceivedBlobPath
          } from './src/main/persistence/migrating-orcad-catalog/orcad-migration-blob-staging';
          const root = ${JSON.stringify(root)}, manifest = ${JSON.stringify(manifest)};
          const descriptors = ${JSON.stringify(descriptors)};
          assertOrcadMigrationBlobSetMatches(manifest, root, descriptors);
          assertOrcadMigrationBlobsReady(manifest, root);
          commitOrcadMigrationBlobs(manifest, root);
          assertOrcadMigrationBlobSetMatches(manifest, root, descriptors);
          console.log(JSON.stringify({
            bytes: descriptors.reduce((sum, blob) => sum + statSync(
              getOrcadMigrationReceivedBlobPath(root, manifest, blob)).size, 0),
            peakRssKiB: process.resourceUsage().maxRSS
          }));
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    // Start from a small parent so the verifier does not inherit the test runner's peak RSS.
    await build({
      stdin: {
        contents: `
          import { runProcess } from '@orca/process-host';
          runProcess({program: process.execPath, args: [${JSON.stringify(child)}],
            env: process.env, timeoutMs: 15000, maxOutputBytes: 4096
          }).then(result => {
            process.stdout.write(result.stdout);
            process.stderr.write(result.stderr);
            process.exitCode = result.code ?? 1;
          });
        `,
        resolveDir: process.cwd()
      },
      outfile: launcher,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    const result = await runProcess({
      program: process.execPath,
      args: [launcher],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: { bytes: number; peakRssKiB: number } = JSON.parse(result.stdout)
    expect(output.bytes).toBe(256 * 1024 * 1024)
    expect(output.peakRssKiB).toBeLessThan(160 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
