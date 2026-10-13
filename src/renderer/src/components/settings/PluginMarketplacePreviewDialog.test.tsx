// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PluginMarketplacePreviewDialog } from './PluginMarketplacePreviewDialog'
import { pluginManifestSchema } from '../../../../shared/plugins/plugin-manifest'
import type { PluginMarketplaceHostInstallPreview } from '../../../../preload/api-types'
afterEach(cleanup)
function preview(): PluginMarketplaceHostInstallPreview {
  return {
    marketplaceSourceId: 'source',
    marketplaceName: 'Company',
    marketplaceOwner: 'company',
    marketplaceCommit: 'a'.repeat(40),
    pluginKey: 'company.platform',
    source: { kind: 'git', url: 'https://example.com/plugin.git', ref: 'v1' },
    resolvedCommit: 'b'.repeat(40),
    contentHash: 'c'.repeat(64),
    consentFingerprint: 'reviewed',
    reviewRevision: 'current',
    official: false,
    bundled: false,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'instructional',
      publisher: 'company',
      id: 'platform',
      name: 'Company environments',
      version: '1.1.0',
      pluginApi: 1,
      engines: { orca: '>=1.4.0' },
      contributes: { environmentRecipes: [{ path: 'pods.json' }] }
    }),
    environmentRecipeReviewDigest: 'd'.repeat(64),
    environmentRecipes: [
      {
        providerId: 'company.platform/pods',
        id: 'pods',
        name: 'Development pods',
        description: 'Machines',
        lifetime: 'both',
        commands: [
          {
            action: 'list',
            program: 'company-cli',
            args: ['--account', 'company-account'],
            timeoutSeconds: 30
          }
        ]
      }
    ]
  }
}
it('shows literal provider commands before update approval with header and footer outside the scroll region', () => {
  const data = preview()
  render(
    <PluginMarketplacePreviewDialog
      preview={data}
      mode="update"
      installedVersion="1.0.0"
      busy={false}
      currentVersion={false}
      error={null}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
  const content = screen.getByRole('region', { name: 'Plugin content and access' })
  expect(content.textContent).toContain('company-cli')
  expect(content.textContent).toContain('["--account","company-account"]')
  expect(content.textContent).toContain('create, stop and delete machines')
  expect(content.contains(screen.getByRole('heading', { name: 'Company environments' }))).toBe(
    false
  )
  expect(content.contains(screen.getByRole('button', { name: 'Approve and update' }))).toBe(false)
  expect(screen.getByRole('button', { name: 'Approve and update' }).hasAttribute('disabled')).toBe(
    false
  )
})
it('cannot approve provider commands that an older host did not supply for review', () => {
  const data = preview()
  delete data.environmentRecipes
  render(
    <PluginMarketplacePreviewDialog
      preview={data}
      mode="update"
      installedVersion="1.0.0"
      busy={false}
      currentVersion={false}
      error={null}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
  expect(screen.getByRole('alert').textContent).toContain('did not provide all provider commands')
  expect(screen.getByRole('button', { name: 'Approve and update' }).hasAttribute('disabled')).toBe(
    true
  )
})
