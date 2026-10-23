import { createHash } from 'node:crypto'
import { applyPatch } from 'diff'
import { expect, it } from 'vitest'
import { AcpToolTimeline } from './acp-tool-timeline'

const longLine = 'source'.repeat(50_000)
const boundaryText = `${'x'.repeat(65_535)}😀\ud800\n\r\n${longLine}`

it.each([
  { oldText: '', newText: `${longLine}\n`, range: '-0,0 +1,1', markers: 0 },
  { oldText: `${longLine}\n`, newText: '', range: '-1,1 +0,0', markers: 0 },
  {
    oldText: `${longLine}\n\n`,
    newText: `changed\n${longLine}\n\n\n`,
    range: '-1,2 +1,4',
    markers: 0
  },
  { oldText: longLine, newText: `${longLine}\n`, range: '-1,1 +1,1', markers: 1 },
  { oldText: boundaryText, newText: `\n${boundaryText}!`, range: '-1,3 +1,4', markers: 2 },
  { oldText: '\n', newText: `\n${longLine}\n`, range: '-1,1 +1,2', markers: 0 }
])('round-trips a whole-file patch with range $range', ({ oldText, newText, range, markers }) => {
  const events = new AcpToolTimeline().translate(
    {
      toolCallId: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'source.txt', oldText, newText }]
    },
    {},
    {}
  )
  const event = events.find((event) => event.type === 'item.update' && event.body.kind === 'diff')
  if (event?.type !== 'item.update' || event.body.kind !== 'diff') {
    throw new Error('Missing diff')
  }
  const patch = event.body.patch
  expect(patch.head).toContain(`@@ ${range} @@\n`)
  expect(patch.head.split('\\ No newline at end of file\n').length - 1).toBe(markers)
  expect(applyPatch(oldText, patch.head)).toBe(newText)
  expect(patch.truncated).toBe(false)
  expect(patch.byteLength).toBe(Buffer.byteLength(patch.head))
  expect(patch.digest).toBe(createHash('sha256').update(patch.head).digest('hex'))
})
