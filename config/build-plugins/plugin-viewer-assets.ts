import { resolve } from 'node:path'
import { build, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export function createPluginViewerAssetsPlugin(): Plugin {
  return {
    name: 'plugin-viewer-assets',
    async generateBundle() {
      for (const entry of ['parent', 'frame'] as const) {
        const result = await build({
          configFile: false,
          logLevel: 'error',
          plugins: entry === 'frame' ? [react(), tailwindcss()] : [],
          resolve: { alias: { '@': resolve('src/renderer/src') } },
          define: { 'process.env.NODE_ENV': JSON.stringify('production') },
          build: {
            write: false,
            sourcemap: false,
            minify: 'oxc',
            assetsInlineLimit: Infinity,
            cssCodeSplit: false,
            lib: {
              entry: resolve(
                `src/renderer/src/plugin-viewer/plugin-viewer-${entry}.${entry === 'frame' ? 'tsx' : 'ts'}`
              ),
              name: `OrcaPluginViewer${entry}`,
              formats: ['iife']
            },
            rollupOptions: { output: { inlineDynamicImports: true } }
          }
        })
        for (const output of Array.isArray(result) ? result : [result]) {
          if (!('output' in output)) {
            throw new Error('plugin viewer asset build produced a watcher')
          }
          for (const asset of output.output) {
            if (asset.type === 'chunk') {
              if (asset.imports.length || asset.dynamicImports.length) {
                throw new Error('plugin viewer asset must be standalone')
              }
              this.emitFile({
                type: 'asset',
                fileName: `plugin-viewer-assets/${entry}.js`,
                source: asset.code
              })
            } else if (asset.fileName.endsWith('.css')) {
              this.emitFile({
                type: 'asset',
                fileName: `plugin-viewer-assets/${entry}.css`,
                source: asset.source
              })
            } else {
              throw new Error(`unexpected external plugin viewer asset: ${asset.fileName}`)
            }
          }
        }
      }
    }
  }
}
