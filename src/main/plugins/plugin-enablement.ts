import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/plugin-consent-state'
import type { Store } from '../persistence'
import type { PluginService } from './plugin-service'
import type { PluginConsentRequest } from '../../shared/plugins/plugin-consent-request'
import { verifyInstructionalPluginContent } from './plugin-instructional-content-integrity'
import { verifyReviewedPluginRelease } from './plugin-reviewed-release'
import { getUserPluginsDir } from './plugin-discovery'
import { serializePluginMutation } from './plugin-install-mutation-queue'

export type PluginEnablementService = Pick<
  PluginService,
  'findValidPlugin' | 'reconcileActivationState' | 'isBundledDataPlugin'
> & { options: Pick<PluginService['options'], 'userDataPath'> }

/**
 * Single write path for consent + enablement. Consent is recorded as
 * (qualified key → consent fingerprint) — never a bare id — so a capability
 * expansion or addition of executable code requires re-consent. The desktop
 * IPC handlers and the headless RPC methods both route through here.
 */

/** Records the user's consent-dialog answer. Approving stores the CURRENT
 *  consent fingerprint and clears any disable; declining disables so the plugin
 *  never re-prompts on later launches. */
export async function applyPluginConsent(input: {
  store: Pick<Store, 'getSettings' | 'updateSettings'>
  pluginService: PluginEnablementService
  pluginKey: PluginConsentRequest['pluginKey']
  reviewedFingerprint: PluginConsentRequest['reviewedFingerprint']
  reviewedRevision?: PluginConsentRequest['reviewedRevision']
  decision: PluginConsentRequest['decision']
  originWebContentsId?: number
  assertCurrent?: () => void
}): Promise<void> {
  await (input.pluginService.findValidPlugin(input.pluginKey)?.manifest.manifestVersion === 2
    ? serializePluginMutation(getUserPluginsDir(input.pluginService.options.userDataPath), () =>
        recordPluginConsent(input)
      )
    : recordPluginConsent(input))
  await input.pluginService.reconcileActivationState()
}

async function recordPluginConsent(input: Parameters<typeof applyPluginConsent>[0]): Promise<void> {
  const { store, pluginService, pluginKey } = input
  input.assertCurrent?.()
  const plugin = pluginService.findValidPlugin(pluginKey)
  if (!plugin) {
    throw new Error(`cannot record consent for unknown plugin ${pluginKey}`)
  }
  // Why: a same-key install can change while the dialog is open; never apply a
  // decision to an execution tier or capabilities the user did not review.
  if (input.decision === 'approve' && plugin.consentFingerprint !== input.reviewedFingerprint) {
    throw new Error(`plugin ${pluginKey} changed since its permissions were reviewed`)
  }
  if (input.decision === 'approve') {
    // Why: IPC and serve callers can bypass the renderer dialog, so main must
    // prove every instructional byte is still reviewable before enabling it.
    await verifyInstructionalPluginContent(plugin)
    await verifyReviewedPluginRelease(plugin, input.reviewedRevision)
    const current = pluginService.findValidPlugin(pluginKey)
    if (
      current?.consentFingerprint !== plugin.consentFingerprint ||
      current?.reviewRevision !== plugin.reviewRevision
    ) {
      throw new Error(`plugin ${pluginKey} changed since its release was reviewed`)
    }
  }
  const settings = store.getSettings()
  input.assertCurrent?.()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  const consents = normalizePluginConsents(settings.pluginConsents)
  if (input.decision === 'approve') {
    consents[pluginKey] = plugin.consentFingerprint
    disabled.delete(pluginKey)
  } else {
    disabled.add(pluginKey)
  }
  store.updateSettings(
    { disabledPlugins: [...disabled], pluginConsents: consents },
    { notifyListeners: true, originWebContentsId: input.originWebContentsId }
  )
}

/** Enables/disables an already-consented plugin. Enabling never bypasses
 *  consent: with missing or stale consent the plugin stays pending and the
 *  caller must run the consent flow instead. */
export async function applyPluginEnablement(input: {
  store: Pick<Store, 'getSettings' | 'updateSettings'>
  pluginService: PluginEnablementService
  pluginKey: string
  enabled: boolean
  originWebContentsId?: number
}): Promise<void> {
  const { store, pluginService, pluginKey, enabled } = input
  const plugin = pluginService.findValidPlugin(pluginKey)
  if (!plugin) {
    throw new Error(`cannot change enablement for unknown plugin ${pluginKey}`)
  }
  if (pluginService.isBundledDataPlugin(plugin)) {
    throw new Error('app-owned language data stays available; choose the language to use instead')
  }
  const settings = store.getSettings()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  if (enabled) {
    disabled.delete(pluginKey)
  } else {
    disabled.add(pluginKey)
  }
  store.updateSettings(
    { disabledPlugins: [...disabled] },
    { notifyListeners: true, originWebContentsId: input.originWebContentsId }
  )
  await pluginService.reconcileActivationState()
}
