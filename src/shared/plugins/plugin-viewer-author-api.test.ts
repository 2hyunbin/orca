import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('keeps the independently published SDK equal to the host contract', async () => {
  const [host, sdk] = await Promise.all([
    readFile(
      join(process.cwd(), 'src', 'shared', 'plugins', 'plugin-viewer-author-api.ts'),
      'utf8'
    ),
    readFile(join(process.cwd(), 'plugin-packages', 'orca-plugin-sdk', 'src', 'viewer.ts'), 'utf8')
  ])
  expect(sdk).toBe(host)
})
