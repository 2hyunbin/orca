import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build as buildScript } from 'esbuild'
import { pluginDirectoryDesignTokens } from './config/scripts/plugin-directory-design-tokens'
import { readPluginDirectoryInput } from './config/scripts/plugin-directory-build-input'
import {
  DIRECTORY_CATALOG_BYTE_LIMIT,
  DIRECTORY_CATALOG_FILENAME,
  directoryCatalogSchema
} from './src/plugin-directory/directory-catalog'

const workspace = import.meta.dirname

export default defineConfig(async () => {
  const filename = process.env.ORCA_PLUGIN_DIRECTORY_CATALOG
  const url = process.env.ORCA_PLUGIN_DIRECTORY_SOURCE_URL
  const ref = process.env.ORCA_PLUGIN_DIRECTORY_SOURCE_REF
  if (!filename || !url || !ref) {
    throw new Error('Build the directory with --catalog FILE --source-url GIT_URL --source-ref REF')
  }
  const bytes = await readPluginDirectoryInput(filename, DIRECTORY_CATALOG_BYTE_LIMIT)
  const directory = directoryCatalogSchema.parse({
    formatVersion: 1,
    source: { kind: 'git', url, ref },
    catalog: JSON.parse(bytes.toString('utf8'))
  })
  const payload = JSON.stringify(directory, null, 2)
  if (Buffer.byteLength(payload) > DIRECTORY_CATALOG_BYTE_LIMIT) {
    throw new Error('Directory payload exceeds 16 MiB')
  }
  const theme = await buildScript({
    entryPoints: [resolve(workspace, 'src/plugin-directory/directory-theme-startup.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    minify: true,
    write: false
  })
  const themeScript = theme.outputFiles[0]?.text
  if (!themeScript) {
    throw new Error('Directory startup theme script missing')
  }
  return {
    root: resolve(workspace, 'src/plugin-directory'),
    base: './',
    publicDir: false,
    plugins: [
      pluginDirectoryDesignTokens(resolve(workspace, 'src/renderer/src/assets/main.css')),
      react(),
      tailwindcss(),
      {
        name: 'orca-pinned-plugin-directory-catalog',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.split('?')[0] === '/theme-init.js') {
              response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
              response.end(themeScript)
              return
            }
            if (request.url?.split('?')[0] !== `/${DIRECTORY_CATALOG_FILENAME}`) {
              return next()
            }
            response.setHeader('Content-Type', 'application/json; charset=utf-8')
            response.end(payload)
          })
        },
        transformIndexHtml: {
          order: 'post',
          handler: () => [{ tag: 'script', attrs: { src: './theme-init.js' }, injectTo: 'head' }]
        },
        generateBundle() {
          for (const id of this.getModuleIds()) {
            if (
              /\/src\/(main|preload)\//.test(id) ||
              id.startsWith('node:') ||
              id.includes('__vite-browser-external')
            ) {
              throw new Error('The public directory must not bundle desktop or Node modules')
            }
          }
          this.emitFile({ type: 'asset', fileName: DIRECTORY_CATALOG_FILENAME, source: payload })
          this.emitFile({
            type: 'asset',
            fileName: 'theme-init.js',
            source: themeScript
          })
          this.emitFile({
            type: 'asset',
            fileName: 'orca-marketplace.json',
            source: JSON.stringify(directory.catalog, null, 2)
          })
        }
      }
    ],
    resolve: {
      alias: [
        {
          find: '@/i18n/i18n',
          replacement: resolve(workspace, 'src/plugin-directory/public-ui-copy.ts')
        },
        { find: '@', replacement: resolve(workspace, 'src/renderer/src') }
      ]
    },
    build: { outDir: resolve(workspace, 'out/plugin-directory'), emptyOutDir: true },
    server: { host: '127.0.0.1' }
  }
})
