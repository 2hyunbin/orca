import { describe, expect, it } from 'vitest'
import { parseMoveLogin } from './database-move-connections.js'
import { MoveRefusal } from './database-move-events.js'

const PASSWORD = 'pa:ss/w@rd'

describe('database move login parsing', () => {
  it('takes the instance from a Cloud SQL socket URL and refuses without echoing', () => {
    const url = `postgresql://orca_relay_move:${encodeURIComponent(PASSWORD)}@/orca_relay?host=/cloudsql/p:us-central1:relay-db`
    expect(parseMoveLogin(url)).toEqual({
      user: 'orca_relay_move',
      password: PASSWORD,
      database: 'orca_relay',
      instanceConnectionName: 'p:us-central1:relay-db'
    })
    const error = (() => {
      try {
        return parseMoveLogin(`postgresql://u@/db?host=/x ${PASSWORD}`)
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(MoveRefusal)
    expect(String(error instanceof Error ? error.message : '')).not.toContain(PASSWORD)
  })
})
