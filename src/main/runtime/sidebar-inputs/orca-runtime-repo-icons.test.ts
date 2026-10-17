// Runs on plain Node, as orcad does: no encoder, so small images pass through.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { ALL_RPC_METHODS } from '../rpc/methods'
import type { RuntimeStore } from '../runtime-store-contract'
import { repoIconId } from './repo-icon-data-urls'
import { pngHeader } from './repo-icon-image-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const upload = {
  type: 'image' as const,
  src: `data:image/png;base64,${Buffer.from(pngHeader(32, 32)).toString('base64')}`,
  source: 'upload' as const
}

describe('sidebarInputs.repoIcons', () => {
  it('answers each id from the repos this host shows', async () => {
    const repo = { id: 'r', path: '/r', displayName: 'r', badgeColor: 'blue', addedAt: 1 }
    const store: Pick<RuntimeStore, 'getRepos'> = {
      getRepos: () => [{ ...repo, repoIcon: upload }]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read touches only repos.
    const runtime = new OrcaRuntimeService(store as RuntimeStore)
    const method = ALL_RPC_METHODS.find((entry) => entry.name === 'sidebarInputs.repoIcons')
    const id = repoIconId(upload)!

    expect(method).toBeDefined()
    expect(await runtime.repoIconDataUrls?.read([id, 'unknown'])).toEqual({
      icons: [
        { id, dataUrl: upload.src },
        { id: 'unknown', dataUrl: null }
      ]
    })
  })
})
