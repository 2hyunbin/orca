import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve, relative, extname } from 'node:path'
import { createPluginCatalogFixture } from '../e2e/helpers/plugin-catalog-fixture'
import {
  directoryCatalogSchema,
  type DirectoryCatalog
} from '../../src/plugin-directory/directory-catalog'

export async function createDirectoryFixtureServer(
  providedFixture?: Awaited<ReturnType<typeof createPluginCatalogFixture>>
): Promise<{
  url: string
  directory: DirectoryCatalog
  close: () => Promise<void>
}> {
  const fixture =
    providedFixture ??
    (await createPluginCatalogFixture({
      generatedTemplates: true,
      formatViewers: true,
      syntaxPacks: true,
      environmentRecipes: true
    }))
  try {
    await promisify(execFile)(
      process.execPath,
      [
        'config/scripts/run-plugin-directory-build.mjs',
        '--catalog',
        join(fixture.root, 'repositories', 'orca-plugins.git', 'orca-marketplace.json'),
        '--source-url',
        'https://github.com/stablyai/orca-plugins.git',
        '--source-ref',
        'main'
      ],
      { cwd: resolve('.'), timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    )
    const root = resolve('out/plugin-directory')
    const directory = directoryCatalogSchema.parse(
      JSON.parse(await readFile(join(root, 'directory-catalog.json'), 'utf8'))
    )
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.json': 'application/json',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.woff2': 'font/woff2'
    }
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const pathname = decodeURIComponent(
            new URL(request.url ?? '/', 'http://localhost').pathname
          )
          if (!pathname.startsWith('/plugins/')) {
            response.writeHead(404).end()
            return
          }
          const filename = resolve(root, pathname.slice('/plugins/'.length) || 'index.html')
          const within = relative(root, filename)
          if (within.startsWith('..') || within === '') {
            response.writeHead(404).end()
            return
          }
          const bytes = await readFile(filename)
          response.setHeader(
            'Content-Type',
            `${mime[extname(filename)] ?? 'application/octet-stream'}; charset=utf-8`
          )
          response.setHeader('Cache-Control', 'no-store')
          response.setHeader('X-Content-Type-Options', 'nosniff')
          response.end(bytes)
        } catch {
          response.writeHead(404).end()
        }
      })()
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Directory fixture server has no TCP address')
    }
    await mkdir(resolve('.tmp/phase-o-1/evidence'), { recursive: true })
    return {
      url: `http://127.0.0.1:${address.port}/plugins/`,
      directory,
      close: async () => {
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
        if (!providedFixture) {
          await rm(fixture.root, { recursive: true, force: true })
        }
      }
    }
  } catch (error) {
    if (!providedFixture) {
      await rm(fixture.root, { recursive: true, force: true })
    }
    throw error
  }
}
