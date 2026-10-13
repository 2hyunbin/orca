import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'

export function getPluginEvidenceDirectory(): string {
  return resolve(
    process.cwd(),
    process.env.ORCA_PLUGIN_EVIDENCE_DIR ?? 'reports/plugin-system/evidence'
  )
}

export async function capturePluginEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  app?: ElectronApplication
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  if (app) {
    await page.evaluate(async () => {
      const animations = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime)
        )
      await Promise.all(animations.map((animation) => animation.finished.catch(() => {})))
    })
    // Native capture preserves the guest compositor's actual embedded bounds.
    const window = await app.browserWindow(page)
    try {
      const png = await window.evaluate(async (window) =>
        (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }))
          .toPNG({ scaleFactor: 1 })
          .toString('base64')
      )
      await writeFile(path, Buffer.from(png, 'base64'))
    } finally {
      await window.dispose()
    }
  } else {
    await page.screenshot({ path, animations: 'disabled' })
  }
  await testInfo.attach(name, { path, contentType: 'image/png' })
  const evidence = getPluginEvidenceDirectory()
  await mkdir(evidence, { recursive: true })
  await cp(path, join(evidence, `${name}.png`))
}
