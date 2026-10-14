import { PluginCatalogHostLabel } from './PluginCatalogHostLabel'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { pluginMarketplaceContributionSummary } from './plugin-marketplace-contribution-summary'
import { PluginEnvironmentRecipeConsentPreview } from './PluginEnvironmentRecipeConsentPreview'
import { PluginCatalogAvatar } from '../plugin-catalog/PluginCatalogAvatar'
import { PluginConsentProvenance, type PluginConsentSource } from './PluginConsentProvenance'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { pluginCapabilityDescription } from './plugin-capability-presentation'

export type PluginMarketplacePreviewMode = 'install' | 'update'

type PluginMarketplacePreviewDialogProps = {
  preview: PluginMarketplaceHostInstallPreview | null
  mode: PluginMarketplacePreviewMode
  installedVersion?: string
  busy: boolean
  currentVersion: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}

export function PluginMarketplacePreviewDialog({
  preview,
  mode,
  installedVersion,
  busy,
  currentVersion,
  error,
  onClose,
  onConfirm
}: PluginMarketplacePreviewDialogProps): React.JSX.Element {
  const contributions = preview ? pluginMarketplaceContributionSummary(preview) : []
  const blocked = preview?.blockedByKillList
  const reviewedUpdate = mode === 'update' && preview?.manifest.manifestVersion === 2
  const providerCount =
    preview?.manifest.manifestVersion === 2
      ? (preview.manifest.contributes.environmentRecipes?.length ?? 0)
      : 0
  const missingCommands =
    providerCount !== (preview?.environmentRecipes?.length ?? 0) ||
    Boolean(providerCount && reviewedUpdate && !preview?.environmentRecipeReviewDigest)
  const provenanceSource: PluginConsentSource | undefined = preview
    ? {
        kind: preview.bundled ? 'bundled' : 'marketplace',
        reference: `${preview.source.url}#${preview.source.ref}`,
        resolvedCommit: preview.resolvedCommit,
        marketplace: {
          reference: preview.marketplaceName,
          resolvedCommit: preview.marketplaceCommit
        }
      }
    : undefined
  return (
    <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent surface="security" className="sm:max-w-xl">
        {preview ? (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3 pr-6">
                <PluginCatalogAvatar name={preview.manifest.name} className="mt-0.5" />
                <div className="min-w-0">
                  <DialogTitle className="truncate">{preview.manifest.name}</DialogTitle>
                  <DialogDescription className="mt-0.5 truncate">
                    {translate(
                      'auto.components.settings.PluginMarketplacePreviewDialog.versionLine',
                      'v{{value0}} · {{value1}}',
                      {
                        value0: preview.manifest.version,
                        value1: preview.marketplaceName
                      }
                    )}
                  </DialogDescription>
                  <div className="mt-1.5">
                    <PluginConsentProvenance
                      official={preview.official}
                      publisher={preview.manifest.publisher}
                      source={provenanceSource}
                    />
                  </div>
                </div>
              </div>
              <PluginCatalogHostLabel />
            </DialogHeader>
            <div
              role="region"
              aria-label="Plugin content and access"
              className="max-h-[50vh] space-y-4 overflow-y-auto scrollbar-sleek"
            >
              {reviewedUpdate ? (
                <p className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm leading-6">
                  {translate(
                    'auto.components.settings.PluginMarketplacePreviewDialog.retainCurrent',
                    'Your installed version ({{version}}) stays available while you review. Approving replaces it with this exact release and grants the access listed below. Your enabled or disabled choice is preserved.',
                    { version: installedVersion ?? '—' }
                  )}
                </p>
              ) : null}
              {preview.manifest.description ? (
                <p className="text-sm leading-6">{preview.manifest.description}</p>
              ) : null}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginMarketplacePreviewDialog.includes',
                    'Includes'
                  )}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {contributions.length > 0 ? (
                    contributions.map((entry) => (
                      <Badge key={entry.key} variant="secondary">
                        {entry.label}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {translate(
                        'auto.components.settings.PluginMarketplacePreviewDialog.noContributions',
                        'Manifest metadata only'
                      )}
                    </span>
                  )}
                </div>
              </div>
              {preview.manifest.capabilities.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                    {translate(
                      'auto.components.settings.PluginMarketplacePreviewDialog.capabilities',
                      'Requested access'
                    )}
                  </p>
                  {preview.manifest.capabilities.map((capability) => (
                    <div key={capability.kind} className="flex items-start gap-2 text-sm leading-6">
                      <Check className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                      <span>
                        {pluginCapabilityDescription(capability.kind, capability.kind)}{' '}
                        <span className="font-mono text-[11px] text-muted-foreground">
                          ({capability.kind})
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {preview.manifest.main ? (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm leading-6">
                  <AlertTriangle className="mt-1 size-4 shrink-0" />
                  <span>
                    {translate(
                      'auto.components.settings.PluginMarketplacePreviewDialog.workerWarning',
                      "Capabilities limit how this plugin uses Orca's API. Its worker still runs as a normal process on the selected host with full access to your files, network, and other processes."
                    )}
                  </span>
                </div>
              ) : null}
              {!preview.manifest.main &&
              preview.manifest.manifestVersion === 2 &&
              preview.manifest.contributes.fileViewers.length ? (
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm leading-6">
                  <AlertTriangle className="mt-1 size-4 shrink-0" />
                  <span>
                    {translate(
                      'auto.components.settings.PluginMarketplacePreviewDialog.viewerWarning',
                      'The viewer runs parsing code in an isolated worker. It can read only the file you open with it, and cannot save changes or access the network. Orca controls the viewer interface. Any additional panels and permissions are listed separately.'
                    )}
                  </span>
                </div>
              ) : null}
              {providerCount ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {translate(
                      'auto.components.settings.PluginMarketplacePreviewDialog.providerWarning',
                      'Environment provider commands run with your account on the selected execution host. They can create, stop and delete machines. Review the program and literal arguments before approving this release.'
                    )}
                  </p>
                  <PluginEnvironmentRecipeConsentPreview
                    recipes={preview.environmentRecipes ?? []}
                  />
                  {missingCommands ? (
                    <p role="alert" className="text-sm text-destructive">
                      {translate(
                        'auto.components.settings.PluginMarketplacePreviewDialog.providerPreviewMissing',
                        'This host did not provide all provider commands for review. Update Orca and review again; this release cannot be approved here.'
                      )}
                    </p>
                  ) : null}
                </>
              ) : null}
              {blocked ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-destructive">
                  {translate(
                    'auto.components.settings.PluginMarketplacePreviewDialog.blocked',
                    "Orca's safety list blocks this plugin: {{value0}}",
                    { value0: blocked.reason }
                  )}
                </p>
              ) : null}
              {currentVersion ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                  {translate(
                    'auto.components.settings.PluginMarketplacePreviewDialog.current',
                    'This exact plugin content is already installed.'
                  )}
                </p>
              ) : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <DialogFooter>
              {currentVersion ? (
                <Button onClick={onClose}>
                  {translate(
                    'auto.components.settings.PluginMarketplacePreviewDialog.close',
                    'Close'
                  )}
                </Button>
              ) : (
                <>
                  <Button variant="ghost" disabled={busy} onClick={onClose}>
                    {reviewedUpdate
                      ? translate(
                          'auto.components.settings.PluginMarketplacePreviewDialog.keepCurrent',
                          'Keep current version'
                        )
                      : translate(
                          'auto.components.settings.PluginMarketplacePreviewDialog.cancel',
                          'Cancel'
                        )}
                  </Button>
                  <Button
                    disabled={busy || Boolean(blocked) || missingCommands}
                    onClick={onConfirm}
                  >
                    {busy ? <Loader2 className="animate-spin" /> : null}
                    {reviewedUpdate
                      ? translate(
                          'auto.components.settings.PluginMarketplacePreviewDialog.approveUpdate',
                          'Approve and update'
                        )
                      : mode === 'update'
                        ? translate(
                            'auto.components.settings.PluginMarketplacePreviewDialog.update',
                            'Update plugin'
                          )
                        : translate(
                            'auto.components.settings.PluginMarketplacePreviewDialog.install',
                            'Install plugin'
                          )}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
