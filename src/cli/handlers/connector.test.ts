import { describe, expect, it } from 'vitest'
import { RuntimeClientError } from '../runtime-client'
import { callConnector } from './connector'

function refusingClient(code: string) {
  return {
    call: async (): Promise<never> => {
      throw new RuntimeClientError(code, code)
    }
  }
}

describe('orca connector', () => {
  it('passes the host’s connectors_disabled refusal through, with no local flag check', async () => {
    await expect(
      callConnector(refusingClient('connectors_disabled'), 'connector.start', {})
    ).rejects.toMatchObject({ code: 'connectors_disabled' })
  })

  it('names the update instead of surfacing method_not_found from an older host', async () => {
    await expect(
      callConnector(refusingClient('method_not_found'), 'connector.start', {})
    ).rejects.toThrow('Update Orca on the host')
  })
})
