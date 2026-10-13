import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  pluginViewerChromeSchema,
  type PluginViewerChrome
} from '../../shared/plugins/plugin-viewer-frame-protocol'

type ViewerAssets = { parent: string; frame: string; css: string }
let assets: Promise<ViewerAssets> | null = null

export function resolvePluginViewerAssetsDirectory(
  appPath: string,
  isPackaged: boolean,
  pathExists: (path: string) => boolean = existsSync
): string {
  const adjacent = join(appPath, 'plugin-viewer-assets')
  return !isPackaged && pathExists(join(adjacent, 'parent.js'))
    ? adjacent
    : join(appPath, 'out', 'main', 'plugin-viewer-assets')
}

export function renderPluginViewerBootstrap(
  chrome: PluginViewerChrome,
  source: ViewerAssets
): string {
  const script = (value: string): string => value.replaceAll(/<\/script/gi, '<\\/script')
  const css = source.css.replaceAll(/<\/style/gi, '<\\/style')
  const frame = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
    <style>${css}</style></head><body><script>${script(source.frame)}</script></body></html>`
  const configuration = JSON.stringify({
    frame,
    chrome: pluginViewerChromeSchema.parse(chrome)
  }).replaceAll('<', '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html,body{height:100%;margin:0;overflow:hidden}</style></head><body>
    <script type="application/json" id="viewer-configuration">${configuration}</script>
    <script>${script(source.parent)}</script></body></html>`
}

export async function createPluginViewerBootstrap(chrome: PluginViewerChrome): Promise<string> {
  assets ??= (async () => {
    const appPath = app.getAppPath()
    const directory = resolvePluginViewerAssetsDirectory(appPath, app.isPackaged)
    const [parent, frame, css] = await Promise.all([
      readFile(join(directory, 'parent.js'), 'utf8'),
      readFile(join(directory, 'frame.js'), 'utf8'),
      readFile(join(directory, 'frame.css'), 'utf8')
    ])
    return { parent, frame, css }
  })().catch((error: unknown) => {
    assets = null
    throw error
  })
  return renderPluginViewerBootstrap(chrome, await assets)
}
