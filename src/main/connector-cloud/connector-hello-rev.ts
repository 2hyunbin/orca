// The cloud keeps only the newest hello per machine, so revisions must rise across clients and restarts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'

const HELLO_REV_FILE = 'connector-hello-rev.json'
const StoredHelloRev = z.object({ helloRev: z.number().int().nonnegative() })

/** max(last + 1, now), recorded before the hello goes out, so even a clock set back never reuses one. */
export function nextConnectorHelloRev(userDataPath: string, now = Date.now()): number {
  const filePath = join(userDataPath, HELLO_REV_FILE)
  let last = 0
  try {
    last = StoredHelloRev.parse(JSON.parse(readFileSync(filePath, 'utf8'))).helloRev
  } catch {
    // Missing or unreadable: the clock alone still rises past any earlier run's revision.
  }
  const helloRev = Math.max(last + 1, now)
  writeDurableSecureJsonFile(filePath, { helloRev })
  return helloRev
}
