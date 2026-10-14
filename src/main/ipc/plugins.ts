import { registerPluginRendererHandler } from './plugin-renderer-ipc'
import { z } from 'zod'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import { getUserPluginsDir, getPluginsDataDir } from '../plugins/plugin-discovery'
import {
  installPluginFromGit,
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from '../plugins/plugin-install'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import type { PluginService } from '../plugins/plugin-service'
import { bindPluginPanelOwnerLifecycle } from '../plugins/plugin-panel-owner-lifecycle'
import { applyBundledDataEnablement } from '../plugins/plugin-bundled-data-enablement'
import { bundledDataPluginKeySchema } from '../../shared/plugins/plugin-bundled-data-state'
import {
  projectLegacyPluginSyntaxMetadata,
  projectLegacyPluginSyntaxPayload
} from '../plugins/plugin-syntax-client-projection'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { pluginConsentRequestSchema } from '../../shared/plugins/plugin-consent-request'
import { normalizePluginIdList } from '../../shared/plugins/plugin-consent-state'
import { registerPluginEnvironmentProviderHandlers } from './plugin-environment-providers'
import { registerPluginEnvironmentProviderSessionHandlers } from './plugin-environment-provider-sessions'
import { bindPluginSettingsDiscovery } from './plugin-settings-discovery'
import { registerPluginViewerGuestHandlers } from './plugin-viewer-guests'
import { registerPluginViewerTabHandlers } from './plugin-viewer-tabs'
import {
  isAllowedPluginGitUrl,
  type PluginLockfile
} from '../../shared/plugins/plugin-install-lockfile'
import {
  registerPluginMarketplaceHandlers,
  type PluginMarketplaceHandlerServices
} from './plugin-marketplaces'

export function parsePluginConsentArgs(args: unknown): z.infer<typeof pluginConsentRequestSchema> {
  return pluginConsentRequestSchema.parse(args)
}

const setEnabledArgsSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean()
})

const readPanelEntryArgsSchema = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1)
})

const invokeCommandArgsSchema = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

const installArgsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-path'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('git'),
    url: z.string().trim().min(1).refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH'),
    // Why: installs must stay reproducible even when callers bypass renderer validation.
    ref: z.string().trim().min(1)
  })
])

export function parsePluginInstallArgs(args: unknown): z.infer<typeof installArgsSchema> {
  return installArgsSchema.parse(args)
}

const removeArgsSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
const logsArgsSchema = z.object({ pluginKey: z.string().min(1) })

// Why re-exported: moved to ../plugins/plugin-client-list so the runtime RPC can reach
// it without ipcMain. Existing importers of this path keep working.
export { listPluginsForClients } from '../plugins/plugin-client-list'
import { listPluginsForClients } from '../plugins/plugin-client-list'

export function canRemoveInstalledPlugin(
  pluginService: Pick<PluginService, 'getDiscovered' | 'isBundledDataPlugin'>,
  pluginKey: string,
  lock?: PluginLockfile
): boolean {
  return (
    lock?.plugins[pluginKey]?.source.kind !== 'bundled' &&
    pluginService
      .getDiscovered()
      .some(
        (plugin) =>
          plugin.pluginKey === pluginKey &&
          !plugin.isDev &&
          !pluginService.isBundledDataPlugin(plugin)
      )
  )
}

export function registerPluginHandlers(
  store: Store,
  pluginService: PluginService,
  runtime: OrcaRuntimeService | null,
  marketplaceServices?: PluginMarketplaceHandlerServices
): void {
  registerPluginEnvironmentProviderHandlers(pluginService.environmentProviders)
  registerPluginEnvironmentProviderSessionHandlers(pluginService.options.userDataPath)
  registerPluginViewerGuestHandlers(pluginService)
  registerPluginViewerTabHandlers(store)
  // The runtime IS the delegate: the structural PluginRuntimeDelegate type
  // keeps the facade electron-free while main binds the real service.
  if (runtime) {
    pluginService.setRuntimeDelegate(runtime)
  }

  bindPluginSettingsDiscovery(store, pluginService)

  // Why: startup discovery is fire-and-forget; every handler awaits it so an
  // early renderer fetch can't observe the empty pre-discovery list.
  registerPluginRendererHandler('plugins:list', async () => listPluginsForClients(pluginService))
  registerPluginRendererHandler('plugins:listThemes', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.themes.list()
  })
  registerPluginRendererHandler('plugins:listLanguagePacks', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.languagePacks.list()
  })
  registerPluginRendererHandler('plugins:getBundledDataAliases', () =>
    pluginService.getBundledDataAliases()
  )
  registerPluginRendererHandler('plugins:listBundledData', async () => {
    await pluginService.whenReady()
    return pluginService.listBundledData()
  })
  registerPluginRendererHandler('plugins:setBundledDataEnabled', async (event, args: unknown) => {
    const parsed = z
      .strictObject({ pluginKey: bundledDataPluginKeySchema, enabled: z.boolean() })
      .parse(args)
    await pluginService.whenReady()
    await applyBundledDataEnablement({
      store,
      pluginService,
      ...parsed,
      originWebContentsId: event.sender.id
    })
    return pluginService.listBundledData()
  })
  registerPluginRendererHandler('plugins:listSyntaxPacks', async (_event, args: unknown) => {
    const parsed = z
      .strictObject({ bundledDataAliases: z.literal(true).optional() })
      .optional()
      .parse(args)
    await pluginService.whenReady()
    const packs = pluginService.contentPacks.syntaxPacks.list()
    return parsed?.bundledDataAliases ? packs : packs.map(projectLegacyPluginSyntaxMetadata)
  })
  registerPluginRendererHandler('plugins:listFileViewers', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.fileViewers.list()
  })
  registerPluginRendererHandler('plugins:loadSyntaxPack', async (_event, args: unknown) => {
    const parsed = z
      .strictObject({
        pluginKey: z.string().refine(isQualifiedPluginKey),
        revision: z.string().min(1).max(128),
        bundledDataAliases: z.literal(true).optional()
      })
      .parse(args)
    await pluginService.whenReady()
    const pack = await pluginService.contentPacks.syntaxPacks.load(
      parsed.pluginKey,
      parsed.revision
    )
    return pack && !parsed.bundledDataAliases ? projectLegacyPluginSyntaxPayload(pack) : pack
  })
  registerPluginRendererHandler('plugins:listIconThemes', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.iconThemes.list()
  })
  registerPluginRendererHandler('plugins:loadIconTheme', async (_event, id: unknown) => {
    await pluginService.whenReady()
    return pluginService.contentPacks.iconThemes.load(
      z.string().startsWith('plugin:').max(256).parse(id)
    )
  })
  registerPluginRendererHandler('plugins:listTerminalThemes', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.terminalThemes.list()
  })
  registerPluginRendererHandler('plugins:consent', async (event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = parsePluginConsentArgs(args)
    await applyPluginConsent({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      reviewedFingerprint: parsed.reviewedFingerprint,
      reviewedRevision: parsed.reviewedRevision,
      decision: parsed.decision,
      originWebContentsId: event.sender.id
    })
    return listPluginsForClients(pluginService)
  })

  registerPluginRendererHandler('plugins:setEnabled', async (event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = setEnabledArgsSchema.parse(args)
    await applyPluginEnablement({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      enabled: parsed.enabled,
      originWebContentsId: event.sender.id
    })
    return listPluginsForClients(pluginService)
  })

  // Why: the renderer renders panel HTML via a sandboxed iframe srcdoc, so it
  // needs (CSP-wrapped) file contents — never a file:// path — across IPC.
  registerPluginRendererHandler(
    'plugins:readPanelEntry',
    async (event, args: unknown): Promise<PluginPanelEntry | null> => {
      const ownerKey = `renderer:${event.sender.id}`
      const ownerLease = bindPluginPanelOwnerLifecycle(event.sender, () =>
        pluginService.panels.revokeOwner(ownerKey)
      )
      await pluginService.whenReady()
      const parsed = readPanelEntryArgsSchema.parse(args)
      const entry = await pluginService.panels.open(ownerKey, parsed.pluginKey, parsed.panelId)
      if (!ownerLease.isCurrent()) {
        pluginService.panels.revokeOwner(ownerKey)
        return null
      }
      return entry
    }
  )

  // Panel-originated actions relayed by the renderer's postMessage bridge
  // host. Capability enforcement happens in main, never in the renderer.
  registerPluginRendererHandler(
    'plugins:panelAction',
    async (event, args: unknown): Promise<PluginPanelActionOutcome> => {
      await pluginService.whenReady()
      return pluginService.panels.execute(`renderer:${event.sender.id}`, args)
    }
  )

  registerPluginRendererHandler('plugins:invokeCommand', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = invokeCommandArgsSchema.parse(args)
    return pluginService.invokeCommand(parsed.pluginKey, parsed.commandId, parsed.args)
  })

  registerPluginRendererHandler('plugins:install', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = parsePluginInstallArgs(args)
    const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
    const hostVersion = pluginService.options.hostVersion
    const blockedPluginReason = (pluginKey: string): string | null =>
      pluginService.options.getPluginKillListEntry?.(pluginKey)?.reason ?? null
    const result =
      parsed.kind === 'local-path'
        ? await installPluginFromLocalPath({
            pluginsDir,
            sourcePath: parsed.path,
            hostVersion,
            blockedPluginReason
          })
        : await installPluginFromGit({
            pluginsDir,
            url: parsed.url,
            ref: parsed.ref,
            hostVersion,
            blockedPluginReason
          })
    if (result.ok) {
      await pluginService.refresh()
    }
    return result
  })

  registerPluginRendererHandler('plugins:remove', async (event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = removeArgsSchema.parse(args)
    const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
    const lock = await readPluginLockfile(pluginsDir)
    if (!canRemoveInstalledPlugin(pluginService, parsed.pluginKey, lock)) {
      throw new Error(`cannot remove protected or non-installed plugin ${parsed.pluginKey}`)
    }
    await pluginService.removePlugin(parsed.pluginKey, () =>
      removeInstalledPlugin({
        pluginsDir,
        pluginsDataDir: getPluginsDataDir(pluginService.options.userDataPath),
        pluginKey: parsed.pluginKey
      })
    )
    // Drop the stale consent so a later reinstall re-prompts from scratch.
    const settings = store.getSettings()
    const consents = { ...settings.pluginConsents }
    delete consents[parsed.pluginKey]
    const disabledPlugins = normalizePluginIdList(settings.disabledPlugins).filter(
      (pluginKey) => pluginKey !== parsed.pluginKey
    )
    store.updateSettings(
      { pluginConsents: consents, disabledPlugins },
      { notifyListeners: true, originWebContentsId: event.sender.id }
    )
    await pluginService.refresh()
    return listPluginsForClients(pluginService)
  })

  registerPluginRendererHandler('plugins:getLogs', async (_event, args: unknown) => {
    const parsed = logsArgsSchema.parse(args)
    return pluginService.getLogs(parsed.pluginKey)
  })

  // Re-discover after settings edits (feature flag, dev paths) — the
  // renderer calls this right after updating those settings.
  registerPluginRendererHandler('plugins:refresh', async () => {
    await pluginService.refresh()
    return listPluginsForClients(pluginService)
  })
  if (marketplaceServices) {
    registerPluginMarketplaceHandlers(pluginService, marketplaceServices, store)
  }
}
