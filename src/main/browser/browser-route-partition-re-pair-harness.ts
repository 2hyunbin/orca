import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  browserAuthorityExecutionHostStorageIdentity,
  legacyBrowserNativeExecutionHostStorageIdentity
} from './browser-execution-host-storage-identity'
import {
  deriveBrowserRoutePartition,
  deriveBrowserRoutePartitionStorageScope,
  type BrowserRoutePartitionIdentity
} from './browser-route-identity'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import { supersededBrowserRoutePartitionIdentities } from './browser-route-partition-migration'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import type { BrowserRouteElectronSession } from './browser-route-session-policy'
import { derivePairedRuntimeBrowserAuthorityIdentities } from './paired-runtime-browser-authority-identity'
import { preW1AuthorityConnectionIdentity } from './paired-runtime-browser-host-environment-fixture'

export const orcaProfileId = 'orca-profile-a'
const browserProfileId = 'default'

/**
 * One desktop's persisted binding file plus the cookie jar Chromium keeps per partition. A
 * cookie is only reachable through the session the registry opened for that partition.
 */
export type Desktop = {
  bindingsPath: string
  cookies: Map<string, string[]>
}

/** A page the registry opened: its partition, and that partition's session cookie jar. */
export type OpenedPage = {
  partition: string
  setCookie(cookie: string): void
  readCookies(): readonly string[]
}

export function createDesktop(): Desktop {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'orca-browser-re-pair-migration-'))
  )
  return { bindingsPath: join(directory, 'bindings.json'), cookies: new Map() }
}

export function storageScopeOf(environment: KnownRuntimeEnvironment): string {
  return deriveBrowserRoutePartitionStorageScope({ orcaProfileId, environmentId: environment.id })
}

function bindingStoreAdapter(store: BrowserRoutePartitionBindingStore) {
  return {
    get: (partition: string) => store.get(partition),
    set: (partition: string, fingerprint: string, scope: string) =>
      store.set(partition, fingerprint, scope),
    touch: (partition: string) => store.touch(partition),
    findPartitionByFingerprint: (fingerprint: string) =>
      store.findPartitionByFingerprint(fingerprint),
    holds: (partition: string, fingerprint: string) => store.holds(partition, fingerprint),
    alias: (partition: string, fingerprint: string, scope: string) =>
      store.alias(partition, fingerprint, scope)
  }
}

/** Opens a page on the server's own machine the way an app launch does, persisting the binding. */
export async function openPage(
  desktop: Desktop,
  environment: KnownRuntimeEnvironment,
  authorityRuntimeId: string
): Promise<OpenedPage> {
  const storageScope = storageScopeOf(environment)
  const authority = derivePairedRuntimeBrowserAuthorityIdentities({
    orcaProfileId,
    environment,
    connection: getPreferredPairedRuntimeConnection(environment),
    authorityRuntimeId
  })
  const executionHostIdentity = browserAuthorityExecutionHostStorageIdentity(storageScope)
  const store = new BrowserRoutePartitionBindingStore({ filePath: desktop.bindingsPath })
  const sessions = new Map<string, BrowserRouteElectronSession>()
  const registry = new BrowserRouteSessionRegistry({
    validateProfile: vi.fn(),
    getSession: (partition) => {
      const session: BrowserRouteElectronSession = {
        setProxy: vi.fn(async () => {}),
        closeAllConnections: vi.fn(async () => {}),
        resolveProxy: vi.fn(async () => 'SOCKS5 127.0.0.1:43123')
      }
      sessions.set(partition, session)
      return session
    },
    setupPolicies: vi.fn(),
    clearPolicies: vi.fn(),
    retirePageAuthority: vi.fn(() => true),
    bindingStore: bindingStoreAdapter(store)
  })
  const handle = await registry.preparePage({
    identity: {
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: authority.authorityConnectionIdentity,
      executionHostIdentity
    },
    legacyIdentities: supersededBrowserRoutePartitionIdentities({
      ...authority,
      orcaProfileId,
      browserProfileId,
      executionHostIdentity,
      legacyExecutionHostIdentity:
        legacyBrowserNativeExecutionHostStorageIdentity(authorityRuntimeId)
    }),
    storageScope,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    rendererWebContentsId: 11,
    proxyEndpoint: { host: '127.0.0.1', port: 43123 }
  })
  handle.release()
  const partition = handle.partition
  if (!sessions.has(partition)) {
    throw new Error('page opened without a session for its partition')
  }
  return {
    partition,
    setCookie: (cookie) => desktop.cookies.set(partition, [...readJar(desktop, partition), cookie]),
    readCookies: () => readJar(desktop, partition)
  }
}

function readJar(desktop: Desktop, partition: string): string[] {
  return desktop.cookies.get(partition) ?? []
}

/** Partition an app launch places a page in. */
export async function launchAndOpenPage(
  desktop: Desktop,
  environment: KnownRuntimeEnvironment,
  authorityRuntimeId: string
): Promise<string> {
  return (await openPage(desktop, environment, authorityRuntimeId)).partition
}

/** The route identity a build before W1 derived for `environment`. */
export function preW1RouteIdentity(
  environment: KnownRuntimeEnvironment
): BrowserRoutePartitionIdentity {
  return {
    orcaProfileId,
    browserProfileId,
    authorityConnectionIdentity: preW1AuthorityConnectionIdentity(
      orcaProfileId,
      environment,
      getPreferredPairedRuntimeConnection(environment)
    ),
    executionHostIdentity: browserAuthorityExecutionHostStorageIdentity(storageScopeOf(environment))
  }
}

/** What a build before W1 persisted for `environment`, with the user signed in to a site. */
export function seedPreW1Login(desktop: Desktop, environment: KnownRuntimeEnvironment): string {
  return seedLogin(desktop, storageScopeOf(environment), preW1RouteIdentity(environment))
}

export function seedLogin(
  desktop: Desktop,
  storageScope: string,
  identity: BrowserRoutePartitionIdentity
): string {
  const derived = deriveBrowserRoutePartition(identity)
  new BrowserRoutePartitionBindingStore({ filePath: desktop.bindingsPath }).set(
    derived.partition,
    derived.bindingFingerprint,
    storageScope
  )
  desktop.cookies.set(derived.partition, ['session=signed-in'])
  return derived.partition
}

/**
 * The partition a build before W1 opens for `environment`, reading the binding file the way
 * that build's store and migration do: a binding resolves only by its own `fingerprint`, any
 * other holder of the derived name is a conflict, and a rewrite keeps only the fields it knows.
 */
export function openPageLikePreW1Build(
  desktop: Desktop,
  environment: KnownRuntimeEnvironment
): string {
  const derived = deriveBrowserRoutePartition(preW1RouteIdentity(environment))
  const file = readBindingFileLikePreW1Build(desktop.bindingsPath)
  const bound = Object.entries(file.bindings).find(
    ([, binding]) => binding.fingerprint === derived.bindingFingerprint
  )?.[0]
  const partition = bound ?? derived.partition
  const persisted = file.bindings[partition]?.fingerprint ?? null
  if (persisted !== null && persisted !== derived.bindingFingerprint) {
    throw new Error('browser_route_partition_binding_conflict')
  }
  const bindings = Object.fromEntries(
    Object.entries(file.bindings).map(([name, binding]) => [
      name,
      {
        fingerprint: binding.fingerprint,
        storageScope: binding.storageScope,
        lastUsedAt: binding.lastUsedAt
      }
    ])
  )
  if (persisted === null) {
    bindings[partition] = {
      fingerprint: derived.bindingFingerprint,
      storageScope: storageScopeOf(environment),
      lastUsedAt: Date.now()
    }
  }
  writeFileLikePreW1Build(desktop.bindingsPath, bindings)
  return partition
}

type PreW1Binding = { fingerprint: string; storageScope: string | null; lastUsedAt: number }

function readBindingFileLikePreW1Build(path: string): {
  bindings: Record<string, PreW1Binding>
} {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    !('bindings' in parsed) ||
    !parsed.bindings ||
    typeof parsed.bindings !== 'object'
  ) {
    throw new Error('browser_route_partition_binding_store_invalid')
  }
  const bindings: Record<string, PreW1Binding> = {}
  for (const [partition, entry] of Object.entries(parsed.bindings)) {
    if (!entry || typeof entry !== 'object' || !('fingerprint' in entry)) {
      throw new Error('browser_route_partition_binding_store_invalid')
    }
    const fingerprint = entry.fingerprint
    const storageScope = 'storageScope' in entry ? entry.storageScope : null
    const lastUsedAt = 'lastUsedAt' in entry ? entry.lastUsedAt : 0
    if (
      typeof fingerprint !== 'string' ||
      (storageScope !== null && typeof storageScope !== 'string') ||
      typeof lastUsedAt !== 'number'
    ) {
      throw new Error('browser_route_partition_binding_store_invalid')
    }
    bindings[partition] = { fingerprint, storageScope, lastUsedAt }
  }
  return { bindings }
}

function writeFileLikePreW1Build(path: string, bindings: Record<string, PreW1Binding>): void {
  writeFileSync(path, `${JSON.stringify({ version: 2, bindings })}\n`)
}
