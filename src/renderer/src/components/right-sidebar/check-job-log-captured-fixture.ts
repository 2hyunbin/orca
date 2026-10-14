import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { sliceCheckLogTail } from '../../../../shared/check-job-log-tail-slice'

export const capturedCheckLogFailure = z
  .object({
    provenance: z.object({
      kind: z.string(),
      description: z.string(),
      jobUrl: z.string(),
      rawCaptureSha256: z.string()
    }),
    rawLog: z.string(),
    expectedDiagnostic: z.string(),
    expectedStackFrame: z.string(),
    benignMarker: z.string(),
    genericExitMarker: z.string()
  })
  .parse(
    JSON.parse(
      readFileSync(resolve('src/shared/__fixtures__/check-job-log-failure-output.json'), 'utf8')
    )
  )

export const capturedCheckLogExcerpt = sliceCheckLogTail(capturedCheckLogFailure.rawLog)
export const capturedCheckLogFrame = capturedCheckLogExcerpt
  .split('\n')
  .find((line) => line.includes(capturedCheckLogFailure.expectedStackFrame))

if (!capturedCheckLogFrame) {
  throw new Error('Captured check log is missing its expected complete frame')
}
