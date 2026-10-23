import { REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES } from '../../../shared/remote-runtime-memory-limits'

/** Refuses a save the host's frame cap would reject by dropping the whole connection. */
export function assertRemoteWriteFitsOneRequest(content: string): void {
  // One UTF-16 unit escapes to at most 6 bytes, so most saves skip encoding.
  if (content.length * 6 + 2 <= REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES) {
    return
  }
  const encoder = new TextEncoder()
  // Bound rejected saves' temporary copies; files within the cap still need only one encode.
  const chunkSize =
    content.length <= REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES ? content.length : 64 * 1024
  let bytes = 2
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + chunkSize, content.length)
    const lastUnit = content.charCodeAt(end - 1)
    // Keep surrogate pairs together so chunk boundaries cannot add JSON escapes.
    if (end < content.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      end -= 1
    }
    bytes += encoder.encode(JSON.stringify(content.slice(start, end))).length - 2
    start = end
  }
  if (bytes > REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES) {
    throw new Error(
      `File is too large to save to a remote Orca server (${Math.ceil(bytes / 1024)} KB; the limit is ${REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES / 1024} KB).`
    )
  }
}
