import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'

const traceSchema = z.object({
  traceEvents: z.array(
    z.object({
      name: z.string(),
      pid: z.number(),
      tid: z.number().optional(),
      args: z.object({ name: z.string().optional() }).optional()
    })
  )
})

export async function capturePluginViewerProcessEvidence(
  app: ElectronApplication,
  testInfo: TestInfo,
  exerciseWorker: () => Promise<void>,
  evidenceName = 'viewer-process-ownership'
) {
  await app.evaluate(async ({ contentTracing }) => {
    await contentTracing.startRecording({
      included_categories: ['__metadata', 'v8', 'devtools.timeline'],
      recording_mode: 'record-until-full'
    })
  })
  let snapshot
  const tracePath = testInfo.outputPath(`${evidenceName}-thread-trace.json`)
  try {
    await exerciseWorker()
    snapshot = await app.evaluate(({ app, webContents }) => ({
      processes: app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        creationTime: metric.creationTime,
        type: metric.type,
        memoryKB: metric.memory.workingSetSize,
        cumulativeCPUSeconds: metric.cpu.cumulativeCPUUsage
      })),
      contents: webContents.getAllWebContents().map((contents) => ({
        id: contents.id,
        viewer: contents.getURL().startsWith('orca-plugin-viewer://'),
        pid: contents.getOSProcessId(),
        frames: contents.mainFrame.framesInSubtree.map((frame) => ({
          pid: frame.osProcessId,
          processId: frame.processId,
          routingId: frame.routingId,
          ownerId: webContents.fromFrame(frame)?.id,
          top: frame === contents.mainFrame
        }))
      }))
    }))
  } finally {
    await app.evaluate(async ({ contentTracing }, path) => {
      await contentTracing.stopRecording(path)
    }, tracePath)
  }
  const trace = traceSchema.parse(JSON.parse(await readFile(tracePath, 'utf8')))
  const proof = {
    ...snapshot,
    workerThreads: trace.traceEvents
      .filter((event) => event.name === 'thread_name' && /worker/i.test(event.args?.name ?? ''))
      .map((event) => ({ pid: event.pid, tid: event.tid, name: event.args?.name }))
  }
  const path = testInfo.outputPath(`${evidenceName}.json`)
  await writeFile(path, `${JSON.stringify(proof, null, 2)}\n`)
  await testInfo.attach(evidenceName, { path, contentType: 'application/json' })
  const evidence = join(process.cwd(), '.tmp', 'phase-o-1', 'evidence')
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, `${evidenceName}.json`), `${JSON.stringify(proof, null, 2)}\n`)
  return proof
}
