import { runProcess } from '@orca/process-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('opens a 4 MiB encrypted v2 text reply within a 32 MiB heap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-web-e2ee-memory-'))
  try {
    const child = join(root, 'reply.cjs')
    await build({
      stdin: {
        contents: `
          import { WEB_PAIRED_E2EE_PRIMITIVES } from './src/renderer/src/web/web-paired-e2ee-primitives';
          import { createPairedE2EEClientHandshake } from './src/shared/paired-e2ee-client-handshake';
          import { createMobileE2EEV2Fixture, MOBILE_E2EE_V2_VECTOR } from './src/shared/mobile-e2ee-v2-fixtures';
          import { sealMobileE2EEV2Frame } from './src/shared/mobile-e2ee-v2-framing';
          globalThis.window = globalThis;
          const fixture = createMobileE2EEV2Fixture();
          const handshake = createPairedE2EEClientHandshake({
            primitives: {
              ...WEB_PAIRED_E2EE_PRIMITIVES,
              deriveSharedKey: () => fixture.sharedSecret
            },
            hostPublicKeyB64: fixture.ready.desktopPublicKeyB64,
            framing: 'v2',
            transport: 'relay',
            relayHostId: fixture.hello.context.relayHostId,
            clientKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32) },
            clientNonce: new Uint8Array(32).fill(2)
          });
          if (handshake.acceptReadyText(JSON.stringify(fixture.ready)) !== 'accepted') {
            throw new Error('Ready rejected');
          }
          const payload = 'x'.repeat(4 * 1024 * 1024 - 3) + '界';
          const frame = sealMobileE2EEV2Frame({
            payload: new TextEncoder().encode(payload),
            key: Buffer.from(MOBILE_E2EE_V2_VECTOR.desktopToMobileKeyHex, 'hex'),
            sessionId: Buffer.from(MOBILE_E2EE_V2_VECTOR.sessionIdHex, 'hex'),
            direction: 'desktop-to-mobile',
            payloadKind: 'text',
            counter: 0n
          });
          const encoded = Buffer.from(frame).toString('base64');
          const decoded = handshake.channel.openText(encoded);
          if (decoded !== payload) throw new Error('Reply changed');
          if (handshake.channel.openText(encoded) !== null) throw new Error('Replay accepted');
          console.log(JSON.stringify({ bytes: Buffer.byteLength(decoded) }));
        `,
        resolveDir: process.cwd()
      },
      tsconfig: join(process.cwd(), 'config/tsconfig.web.json'),
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    const result = await runProcess({
      program: process.execPath,
      args: ['--max-old-space-size=32', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ bytes: 4 * 1024 * 1024 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
