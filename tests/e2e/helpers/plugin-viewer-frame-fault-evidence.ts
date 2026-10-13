import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'

export async function startPluginViewerChildFault(app: ElectronApplication, url: string | null) {
  return app.evaluate(({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((item) => item.getURL() === url)
    const frame = guest?.mainFrame.framesInSubtree.find((item) => item !== guest.mainFrame)
    if (!guest || !frame) {
      throw new Error('Child viewer frame unavailable')
    }
    const contents = webContents.getAllWebContents().map((item) => ({
      id: item.id,
      pid: item.getOSProcessId(),
      viewer: item.getURL().startsWith('orca-plugin-viewer://'),
      frames: item.mainFrame.framesInSubtree.map((child) => ({
        pid: child.osProcessId,
        ownerId: webContents.fromFrame(child)?.id,
        frameId: child.frameTreeNodeId
      }))
    }))
    const targetPids = [...new Set(guest.mainFrame.framesInSubtree.map((item) => item.osProcessId))]
    void frame.executeJavaScript('while (true) {}').catch(() => {})
    return { contents, targetPids }
  }, url)
}

export async function capturePluginViewerChildFaultEvidence(
  app: ElectronApplication,
  testInfo: TestInfo,
  before: Awaited<ReturnType<typeof startPluginViewerChildFault>>
): Promise<void> {
  const after = await app.evaluate(({ webContents, app }) => ({
    contents: webContents.getAllWebContents().map((item) => ({
      id: item.id,
      pid: item.getOSProcessId(),
      viewer: item.getURL().startsWith('orca-plugin-viewer://'),
      frames: item.mainFrame.framesInSubtree.map((child) => ({
        pid: child.osProcessId,
        ownerId: webContents.fromFrame(child)?.id,
        frameId: child.frameTreeNodeId
      }))
    })),
    metrics: app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type }))
  }))
  const data = `${JSON.stringify({ before, after }, null, 2)}\n`
  const path = testInfo.outputPath('viewer-child-fault-processes.json')
  await writeFile(path, data)
  await testInfo.attach('viewer-child-fault-processes', { path, contentType: 'application/json' })
  await writeFile(
    join(process.cwd(), '.tmp', 'phase-o-1', 'evidence', 'viewer-child-fault-processes.json'),
    data
  )
}
