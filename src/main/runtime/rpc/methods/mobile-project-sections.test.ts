import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../../shared/mobile-project-sections-contract'
import { PROJECT_SECTION_PARITY_SERVED } from '../../../../shared/project-section-parity.test-fixture'
import { publishMobileProjectSections } from '../../mobile-project-sections-snapshot'
import { MOBILE_PROJECT_SECTIONS_METHODS } from './mobile-project-sections'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads no runtime member; the dispatcher only stamps the runtime id.
const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService

function sectionsDispatcher(): RpcDispatcher {
  return new RpcDispatcher({ runtime, methods: MOBILE_PROJECT_SECTIONS_METHODS })
}

describe(MOBILE_PROJECT_SECTIONS_METHOD, () => {
  // Ordered: the snapshot is process state, as it is in the app.
  it('answers no catalog before a desktop window has published one', async () => {
    const response = await sectionsDispatcher().dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: MOBILE_PROJECT_SECTIONS_METHOD
    })

    expect(response).toMatchObject({ ok: true, result: { catalog: null } })
  })

  it("answers the window's last published catalog", async () => {
    publishMobileProjectSections(PROJECT_SECTION_PARITY_SERVED)

    const response = await sectionsDispatcher().dispatch({
      id: 'req-2',
      authToken: 'tok',
      method: MOBILE_PROJECT_SECTIONS_METHOD
    })

    expect(response).toMatchObject({ ok: true, result: { catalog: PROJECT_SECTION_PARITY_SERVED } })
  })
})
