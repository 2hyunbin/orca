const table = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return crc >>> 0
})

export function updateXlsxCrc32(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 255]
  }
  return crc >>> 0
}
