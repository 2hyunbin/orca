import { runProcess, spawnProcess } from '@orca/process-host'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appendBuildOldSpaceOption } from './node-old-space-limit.mjs'
import { RENDERER_BUILD_DIR, verifyRendererBootGraph } from './renderer-boot-graph.mjs'

const require = createRequire(import.meta.url)
const electronVitePackageJson = require.resolve('electron-vite/package.json')
const electronViteCli = path.join(path.dirname(electronVitePackageJson), 'bin', 'electron-vite.js')
const target = process.env.ORCA_ELECTRON_VITE_TARGET
if (!target || target === 'main') {
  const snapshot = await runProcess({
    program: process.execPath,
    args: [path.join(import.meta.dirname, 'snapshot-bundled-data-plugins.mjs'), '--check'],
    stdio: 'inherit'
  })
  if (snapshot.code !== 0) {
    process.exit(snapshot.code ?? 1)
  }
}

// Release builds have started OOMing on GitHub's macOS runners during the
// renderer bundle. Reserve memory on smaller hosts so the OS does not kill Vite.
const nodeOptions = appendBuildOldSpaceOption(process.env.NODE_OPTIONS)

const child = spawnProcess({
  program: process.execPath,
  args: [electronViteCli, 'build', ...process.argv.slice(2)],
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions
  }
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  if (code !== 0) {
    process.exit(code ?? 1)
  }

  // Why here: this is the only place a real renderer bundle exists, and the
  // boot graph is exactly what a stray static import silently regresses. The
  // target gate keeps the parallel runner's concurrent main/preload builds from
  // reading out/renderer while the renderer target is still writing it.
  const builtRenderer =
    (!target || target === 'renderer') && fs.existsSync(path.join(RENDERER_BUILD_DIR, 'index.html'))
  process.exit(builtRenderer ? verifyRendererBootGraph() : 0)
})
