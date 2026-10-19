import { describe, expect, it } from 'vitest'
import { minidumpSignatureDetails, parseMinidumpCrashSignature } from './minidump-crash-signature'

const STREAM_TYPE_MEMORY_LIST = 5
const STREAM_TYPE_EXCEPTION = 6
const CONTEXT_SIZE = 0x4d0
// Bytes Electron 43.7.8 x64 ships at electron.exe+0x23d3f88: movb %dil, 0x88(%r12) twice.
const CODE = Buffer.from('4188bc24880000004188bc2490000000', 'hex')

type FaultDump = {
  code: number
  rip: bigint
  params?: bigint[]
  rsp?: bigint
  contextFlags?: number
  memory?: { start: bigint; bytes: Buffer }[]
}

/** Exception stream, x64 CONTEXT and MemoryList laid out as Crashpad writes them. */
function buildFaultDump(options: FaultDump): Buffer {
  const streamCount = options.memory ? 2 : 1
  let cursor = 32 + streamCount * 12
  const regions: Buffer[] = []
  const append = (buf: Buffer): number => {
    const rva = cursor
    regions.push(buf)
    cursor += buf.length
    return rva
  }

  const context = Buffer.alloc(CONTEXT_SIZE)
  context.writeUInt32LE(options.contextFlags ?? 0x0010001f, 0x30)
  context.writeBigUInt64LE(options.rsp ?? 0n, 0x98)
  const contextRva = append(context)

  const exception = Buffer.alloc(168)
  exception.writeUInt32LE(7, 0)
  exception.writeUInt32LE(options.code, 8)
  exception.writeBigUInt64LE(options.rip, 24)
  const params = options.params ?? []
  exception.writeUInt32LE(params.length, 32)
  params.forEach((value, index) => exception.writeBigUInt64LE(value, 40 + index * 8))
  exception.writeUInt32LE(CONTEXT_SIZE, 160)
  exception.writeUInt32LE(contextRva, 164)
  const streams = [{ type: STREAM_TYPE_EXCEPTION, size: 168, rva: append(exception) }]

  if (options.memory) {
    const dataRvas = options.memory.map((range) => append(range.bytes))
    const list = Buffer.alloc(4 + options.memory.length * 16)
    list.writeUInt32LE(options.memory.length, 0)
    options.memory.forEach((range, index) => {
      list.writeBigUInt64LE(range.start, 4 + index * 16)
      list.writeUInt32LE(range.bytes.length, 12 + index * 16)
      list.writeUInt32LE(dataRvas[index], 16 + index * 16)
    })
    streams.push({ type: STREAM_TYPE_MEMORY_LIST, size: list.length, rva: append(list) })
  }

  const header = Buffer.alloc(32 + streamCount * 12)
  header.writeUInt32LE(0x504d444d, 0)
  header.writeUInt32LE(streamCount, 8)
  header.writeUInt32LE(32, 12)
  streams.forEach((stream, index) => {
    header.writeUInt32LE(stream.type, 32 + index * 12)
    header.writeUInt32LE(stream.size, 36 + index * 12)
    header.writeUInt32LE(stream.rva, 40 + index * 12)
  })
  return Buffer.concat([header, ...regions])
}

describe('minidump fault context', () => {
  it('reports a write AV into the faulting frame and the executed bytes', async () => {
    const rip = 0x7ff6_3941_3f88n
    const rsp = 0x8a_3a03_d000n
    const dump = buildFaultDump({
      code: 0xc0000005,
      rip,
      rsp,
      params: [1n, rsp + 0x3c8n],
      memory: [
        { start: rip - 1n, bytes: Buffer.concat([Buffer.from([0x80]), CODE, Buffer.from([0x4c])]) }
      ]
    })

    const signature = await parseMinidumpCrashSignature(dump)
    const details = minidumpSignatureDetails(signature!)

    expect(details).toMatchObject({
      minidumpExceptionCode: '0xc0000005',
      minidumpExceptionAccess: 'write',
      minidumpFaultAddress: '0x8a3a03d3c8',
      minidumpFaultStackPointerDelta: 0x3c8,
      minidumpCodeBytes: CODE.toString('hex')
    })
  })

  it('omits the stack delta for a fault far from the stack and for non-x64 contexts', async () => {
    const far = await parseMinidumpCrashSignature(
      buildFaultDump({ code: 0xc0000005, rip: 0x1000n, rsp: 0x10_0000_0000n, params: [0n, 0x20n] })
    )
    expect(far?.fault).toEqual({ access: 'read', faultAddress: '0x20' })

    const arm = await parseMinidumpCrashSignature(
      buildFaultDump({
        code: 0xc0000005,
        rip: 0x1000n,
        rsp: 0x30n,
        contextFlags: 0x00400000,
        params: [8n, 0x20n]
      })
    )
    expect(arm?.fault).toEqual({ access: 'execute', faultAddress: '0x20' })
  })

  it('keeps only code bytes for non-AV exceptions and truncates at the captured range', async () => {
    const signature = await parseMinidumpCrashSignature(
      buildFaultDump({
        code: 0x80000003,
        rip: 0x5000n,
        params: [1n, 0x20n],
        memory: [
          { start: 0x100n, bytes: Buffer.from('aa', 'hex') },
          { start: 0x4ffen, bytes: Buffer.from('9090cc0f0b', 'hex') }
        ]
      })
    )
    expect(signature?.fault).toEqual({ codeBytes: 'cc0f0b' })
  })

  it('degrades to nothing when the AV parameters or memory list are missing', async () => {
    const signature = await parseMinidumpCrashSignature(
      buildFaultDump({ code: 0xc0000005, rip: 0x5000n })
    )
    expect(signature?.exceptionAddress).toBe('0x5000')
    expect(signature?.fault).toEqual({})
  })
})
