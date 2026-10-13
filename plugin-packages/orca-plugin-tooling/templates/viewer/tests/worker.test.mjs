import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

async function viewer() {
  let adapter
  const reads = []
  runInNewContext(
    await readFile(new URL('../dist/example.worker.js', import.meta.url), 'utf8'),
    {
      orcaViewer: {
        register(value) {
          adapter = value
        },
        async readBytes(position, length) {
          reads.push([position, length])
          return new Uint8Array(length).fill(0xff)
        }
      },
      Uint8Array
    },
    { timeout: 1000 }
  )
  return { adapter, reads }
}

test('prebuilt example requests only a bounded prefix and renders metadata', async () => {
  const { adapter, reads } = await viewer()
  const surface = await adapter.open({
    name: 'example.example-binary',
    size: 100_000,
    revision: 'test',
    features: { rangeRead: true, watch: false }
  })
  assert.equal(surface.kind, 'text')
  assert.deepEqual(reads, [[0, 64]])
  const rendered = adapter.render({ kind: 'text', startLine: 1, lineCount: 1 })
  assert.equal(rendered.lines.length, 1)
  assert.equal(rendered.lines[0], '100000 bytes')
  assert.throws(() => adapter.render({ kind: 'canvas' }), /Unsupported viewport/)
})

test('empty file makes no invalid zero-length read', async () => {
  const { adapter, reads } = await viewer()
  await adapter.open({ name: 'empty', size: 0 })
  assert.equal(reads.length, 0)
  assert.equal(adapter.render({ kind: 'text', startLine: 2, lineCount: 1 }).lines[0], '')
})
