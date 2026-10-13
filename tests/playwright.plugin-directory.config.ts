import { defineConfig } from '@stablyai/playwright-test'

export default defineConfig({
  testDir: './plugin-directory',
  outputDir: '../.tmp/phase-o-1/directory-test-results',
  reporter: [['list']],
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    headless: true,
    viewport: { width: 1280, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce'
  }
})
