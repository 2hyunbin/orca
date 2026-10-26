import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextConnectorHelloRev } from './connector-hello-rev'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-hello-rev-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('nextConnectorHelloRev', () => {
  it('follows the clock, and keeps rising when the clock is set back', () => {
    expect(nextConnectorHelloRev(userDataPath, 1_000)).toBe(1_000)
    expect(nextConnectorHelloRev(userDataPath, 1_000)).toBe(1_001)
    expect(nextConnectorHelloRev(userDataPath, 400)).toBe(1_002)
    expect(nextConnectorHelloRev(userDataPath, 5_000)).toBe(5_000)
  })
})
