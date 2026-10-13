import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { materializeVerifiedRuntimeFolder } from './pinned-runtime-materializer'

// tar names each member it extracts after `-C <dir>`; write exactly those.
vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(async ({ args }: { args: string[] }) => {
    const at = args.indexOf('-C')
    for (const member of args.slice(at + 2)) {
      await writeFile(join(args[at + 1]!, member), `${member} bytes`)
    }
    return { code: 0, stdout: '', stderr: '' }
  })
}))

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

it('publishes every verified member as one folder and leaves no staging behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-'))
  const folder = join(root, 'agent', '1.0')
  const runtime = {
    label: 'Agent',
    url: 'https://example.test/agent-1.0.tar.gz',
    archiveSha256: sha256('archive'),
    members: ['server', 'harness'].map((path) => ({ path, sha256: sha256(`${path} bytes`) }))
  }
  await materializeVerifiedRuntimeFolder(runtime, folder, {
    fetcher: async () => new Response('archive')
  })
  expect(await readFile(join(folder, 'server'), 'utf8')).toBe('server bytes')
  expect(await readFile(join(folder, 'harness'), 'utf8')).toBe('harness bytes')
  expect(await readdir(join(root, 'agent'))).toEqual(['1.0'])
  await rm(root, { recursive: true, force: true })
})
