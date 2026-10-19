// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

// Every dialog that asks the user to trust, approve, run or remove code. A new one belongs here.
const TRUST_DIALOGS = [
  'sidebar/OrcaYamlTrustDialog.tsx',
  'editor/IpynbViewer.tsx',
  'settings/PluginConsentDialog.tsx',
  'settings/PluginInstallDialog.tsx',
  'settings/PluginMarketplacePreviewDialog.tsx',
  'settings/PluginMarketplaceSourceDialog.tsx',
  'settings/PluginRemoveDialog.tsx',
  'settings/PluginRollbackDialog.tsx'
]

afterEach(cleanup)

describe('security dialog surface', () => {
  it('applies the host-owned token set', () => {
    render(
      <Dialog open>
        <DialogContent surface="security">
          <DialogTitle>Trust</DialogTitle>
          <DialogDescription>Review</DialogDescription>
        </DialogContent>
      </Dialog>
    )
    expect(document.querySelector('[role="dialog"]')?.classList).toContain('plugin-security-chrome')
  })

  it.each(TRUST_DIALOGS)('%s renders on the security surface', (file) => {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
    expect(source).toMatch(/<DialogContent\s[^>]*surface="security"/)
    expect(source).not.toContain('plugin-security-chrome')
  })
})
