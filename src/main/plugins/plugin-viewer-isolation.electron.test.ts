import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runProcess } from '@orca/process-host'

const resultSchema = z.strictObject({
  hosts: z.strictObject({
    control: z.string(),
    protectedTop: z.string(),
    protectedChild: z.string(),
    workerNetwork: z.string(),
    neverRequested: z.string()
  }),
  resolvedProxy: z.string(),
  hostPid: z.number(),
  guestPid: z.number(),
  hostReplies: z.number(),
  hostText: z.string(),
  reason: z.string(),
  elapsedMs: z.number(),
  workerProof: z.strictObject({
    documentType: z.literal('undefined'),
    workerType: z.literal('undefined'),
    fetchType: z.literal('undefined'),
    webSocketType: z.literal('undefined'),
    importScriptsType: z.literal('undefined'),
    nestedDenied: z.literal(true),
    restoreDenied: z.literal(true),
    xhrDenied: z.literal(true)
  }),
  workerTerminated: z.literal(true),
  workerError: z.null(),
  runtimeProof: z.strictObject({
    idleRecovery: z.literal('unresponsive'),
    networkElements: z.literal(0),
    surfaces: z.tuple([
      z.strictObject({
        kind: z.literal('text'),
        text: z.literal('First line\n<img src="https://example.invalid">\nLast line')
      }),
      z.strictObject({
        kind: z.literal('table'),
        text: z.literal('<img src="https://example.invalid">42'),
        cachedFormula: z.literal('42')
      }),
      z.strictObject({
        kind: z.literal('canvas'),
        pixels: z.array(z.number().int().min(0).max(255)).length(16)
      })
    ])
  }),
  runtimeReads: z.literal(3),
  forgedRead: z.strictObject({ ok: z.literal(false), error: z.literal('unauthorized') }),
  sessionPoolProof: z.strictObject({
    admitted: z.literal(true),
    wrongHostDenied: z.literal(true),
    duplicateDenied: z.literal(true),
    firstText: z.literal('First private viewer'),
    secondText: z.literal('Second private viewer'),
    preloadKeys: z.tuple([
      z.literal('copySelection'),
      z.literal('initialize'),
      z.literal('notify'),
      z.literal('read')
    ]),
    privilegedBridgeAbsent: z.literal(true),
    seededCookie: z.literal(true),
    destroyedBeforeReuse: z.literal(true),
    privateAfterRetirement: z.literal(true),
    sameSession: z.literal(true),
    changedLease: z.literal(true),
    clearedCookies: z.literal(true),
    staleRetirementIgnored: z.literal(true),
    oldUrlDenied: z.literal(true),
    nonpersistent: z.literal(true),
    beforeInitialization: z.strictObject({
      ok: z.literal(false),
      error: z.literal('unauthorized')
    }),
    initializationProof: z.strictObject({
      initialized: z.literal(true),
      sourceAdmitted: z.literal(true),
      byte: z.literal(42),
      metadataKeys: z.tuple([
        z.literal('documentHandle'),
        z.literal('features'),
        z.literal('name'),
        z.literal('revision'),
        z.literal('size')
      ])
    }),
    forgedProductionRead: z.strictObject({
      ok: z.literal(false),
      error: z.literal('unauthorized')
    }),
    subframeDenied: z.strictObject({ ok: z.literal(false), error: z.literal('unauthorized') }),
    revokedRead: z.strictObject({ ok: z.literal(false), error: z.literal('unauthorized') }),
    destroyedOnRevocation: z.literal(true)
  })
})
const netlogSchema = z.object({
  constants: z.object({ logEventTypes: z.record(z.string(), z.number()) }),
  events: z.array(
    z.object({
      type: z.number(),
      source: z.object({ id: z.number() }),
      params: z.unknown().optional()
    })
  )
})

function resolverEvents(netlog: z.infer<typeof netlogSchema>, host: string): string[] {
  const sources = new Set(
    netlog.events
      .filter((event) => JSON.stringify(event.params ?? null).includes(host))
      .map((event) => event.source.id)
  )
  const types = new Map(
    Object.entries(netlog.constants.logEventTypes).map(([name, id]) => [id, name])
  )
  return Array.from(
    new Set(
      netlog.events
        .filter((event) => sources.has(event.source.id))
        .map((event) => types.get(event.type))
        .filter(
          (name): name is string => typeof name === 'string' && name.startsWith('HOST_RESOLVER')
        )
    )
  )
}

describe('native viewer isolation spike', () => {
  it('recovers a busy guest and records the subframe DNS gap that blocks DOM viewer release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-viewer-isolation-'))
    try {
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: join(root, 'build'),
          lib: {
            entry: resolve('src/main/plugins/plugin-viewer-isolation-probe-main.ts'),
            formats: ['cjs'],
            fileName: () => 'probe.cjs'
          },
          rollupOptions: { external: ['electron', /^node:/] }
        }
      })
      const runtimeScriptPath = join(root, 'renderer', 'runtime.js')
      const runtimePreloadPath = join(root, 'preload', 'runtime.cjs')
      const viewerPreloadPath = join(root, 'viewer-preload', 'viewer.cjs')
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: join(root, 'viewer-preload'),
          lib: {
            entry: resolve('src/preload/plugin-viewer.ts'),
            formats: ['cjs'],
            fileName: () => 'viewer.cjs'
          },
          rollupOptions: { external: ['electron'] }
        }
      })
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: join(root, 'renderer'),
          lib: {
            entry: resolve('src/main/plugins/plugin-viewer-runtime-probe-renderer.ts'),
            formats: ['iife'],
            name: 'ViewerRuntimeProbe',
            fileName: () => 'runtime.js'
          }
        }
      })
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          outDir: join(root, 'preload'),
          lib: {
            entry: resolve('src/main/plugins/plugin-viewer-runtime-probe-preload.ts'),
            formats: ['cjs'],
            fileName: () => 'runtime.cjs'
          },
          rollupOptions: { external: ['electron'] }
        }
      })
      const pixels = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]
      const documentPath = join(root, 'sample.viewer')
      await writeFile(
        documentPath,
        Buffer.concat([
          Buffer.from([42]),
          Buffer.from(
            JSON.stringify({
              lines: ['First line', '<img src="https://example.invalid">', 'Last line'],
              cells: [
                { row: 0, column: 0, text: '<img src="https://example.invalid">', kind: 'value' },
                { row: 0, column: 1, text: '42', kind: 'cached-formula' }
              ],
              pixels
            })
          )
        ])
      )
      const resultPath = join(root, 'result.json')
      const netLogPath = join(root, 'netlog.json')
      const configPath = join(root, 'config.json')
      await writeFile(
        configPath,
        JSON.stringify({
          resultPath,
          netLogPath,
          runtimeScriptPath,
          runtimePreloadPath,
          viewerPreloadPath,
          documentPath
        })
      )
      const electronBinary: unknown = createRequire(import.meta.url)('electron')
      if (typeof electronBinary !== 'string') {
        throw new Error('Electron binary unavailable')
      }
      const electronArgs = [
        join(root, 'build', 'probe.cjs'),
        configPath,
        `--user-data-dir=${join(root, 'profile')}`
      ]
      const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
      const needsDisplay = process.platform === 'linux' && !env.DISPLAY
      const launched = await runProcess({
        program: needsDisplay ? 'xvfb-run' : electronBinary,
        args: needsDisplay ? ['--auto-servernum', electronBinary, ...electronArgs] : electronArgs,
        env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 40_000,
        maxOutputBytes: 256 * 1024,
        detached: true,
        terminationBarrier: true
      })
      expect(launched.timedOut, launched.stderr).toBe(false)
      expect(launched.code, launched.stderr).toBe(0)
      const result = resultSchema.parse(JSON.parse(await readFile(resultPath, 'utf8')))
      const netlog = netlogSchema.parse(JSON.parse(await readFile(netLogPath, 'utf8')))
      const evidence = {
        distinctProcesses: result.guestPid !== result.hostPid,
        hostReplies: result.hostReplies,
        reason: result.reason,
        elapsedMs: result.elapsedMs,
        workerTerminated: result.workerTerminated,
        workerProof: result.workerProof,
        runtimeProof: result.runtimeProof,
        runtimeReads: result.runtimeReads,
        forgedRead: result.forgedRead,
        sessionPoolProof: result.sessionPoolProof,
        controlDns: resolverEvents(netlog, result.hosts.control),
        protectedTopDns: resolverEvents(netlog, result.hosts.protectedTop),
        protectedChildDns: resolverEvents(netlog, result.hosts.protectedChild),
        workerNetworkDns: resolverEvents(netlog, result.hosts.workerNetwork)
      }
      const evidenceDirectory = process.env.ORCA_PLUGIN_EVIDENCE_DIR
      if (evidenceDirectory) {
        await mkdir(evidenceDirectory, { recursive: true })
        await writeFile(
          join(evidenceDirectory, 'viewer-isolation-probe.json'),
          JSON.stringify(evidence)
        )
      }
      expect(result.resolvedProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/)
      expect(resolverEvents(netlog, result.hosts.control)).toContain(
        'HOST_RESOLVER_MANAGER_CREATE_JOB'
      )
      expect(resolverEvents(netlog, result.hosts.neverRequested)).toEqual([])
      expect(resolverEvents(netlog, result.hosts.workerNetwork)).toEqual([])
      expect(resolverEvents(netlog, result.hosts.protectedTop)).toEqual([])
      // This candidate stays unexposed: a child can still resolve names outside the offline session policy.
      expect(resolverEvents(netlog, result.hosts.protectedChild)).toContain(
        'HOST_RESOLVER_MANAGER_CREATE_JOB'
      )
      expect(result.guestPid).toBeGreaterThan(0)
      expect(result.guestPid).not.toBe(result.hostPid)
      expect(result.hostReplies).toBe(4)
      expect(result.runtimeProof.surfaces[2].pixels).toEqual(pixels)
      expect(result.hostText).toContain('Viewer isolation probe')
      expect(result.reason).toBe('unresponsive')
      expect(result.elapsedMs).toBeLessThan(5_000)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 60_000)
})
