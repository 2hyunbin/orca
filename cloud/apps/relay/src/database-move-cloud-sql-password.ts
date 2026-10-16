import { MoveRefusal, sleep } from './database-move-events.js'
import type { GoogleMetadataAccess } from './google-metadata-access-token.js'

const SQL_ADMIN_ROOT = 'https://sqladmin.googleapis.com/v1'
const REQUEST_TIMEOUT_MS = 10_000
const OPERATION_POLL_MS = 1_000
const OPERATION_DEADLINE_MS = 120_000

// Needs cloudsql.users.update. The fallback when the held session that fenced a target is gone:
// sets the role's password back to the one in that target's app secret. Errors carry the HTTP
// status only; the request body (the password) is never echoed.
export async function restorePasswordWithCloudSqlAdmin(input: {
  instanceConnectionName: string
  user: string
  password: string
  google: GoogleMetadataAccess
  fetchImpl?: typeof fetch
  pollMs?: number
}): Promise<{ operation: string }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const [project, , instance] = input.instanceConnectionName.split(':')
  if (!project || !instance) throw new MoveRefusal('instance_connection_name_invalid')
  const call = async (url: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${await input.google.accessToken()}`,
        'content-type': 'application/json'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }).catch(() => {
      throw new MoveRefusal('cloud_sql_admin_unreachable')
    })
    if (response.status === 401) input.google.forgetAccessToken()
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new MoveRefusal('cloud_sql_admin_refused', { status: response.status })
    }
    return await response.json().catch(() => null)
  }
  const base = `${SQL_ADMIN_ROOT}/projects/${encodeURIComponent(project)}`
  const started = await call(
    `${base}/instances/${encodeURIComponent(instance)}/users?name=${encodeURIComponent(input.user)}`,
    { method: 'PUT', body: JSON.stringify({ name: input.user, password: input.password }) }
  )
  const operation = operationName(started)
  const deadline = Date.now() + OPERATION_DEADLINE_MS
  for (let state = started; ;) {
    if (isDone(state)) {
      if (hasError(state)) throw new MoveRefusal('cloud_sql_admin_operation_failed', { operation })
      return { operation }
    }
    if (Date.now() > deadline)
      throw new MoveRefusal('cloud_sql_admin_operation_timeout', { operation })
    await sleep(input.pollMs ?? OPERATION_POLL_MS)
    state = await call(`${base}/operations/${encodeURIComponent(operation)}`)
  }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return found
}

function operationName(value: unknown): string {
  const name = field(value, 'name')
  if (typeof name !== 'string' || name.length === 0) {
    throw new MoveRefusal('cloud_sql_admin_operation_missing')
  }
  return name
}

function isDone(value: unknown): boolean {
  return field(value, 'status') === 'DONE'
}

function hasError(value: unknown): boolean {
  return field(value, 'error') !== undefined
}
