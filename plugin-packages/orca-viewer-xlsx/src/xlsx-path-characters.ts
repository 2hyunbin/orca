export function hasXlsxPathControl(value: string, includeSpace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < (includeSpace ? 33 : 32) || code === 127) {
      return true
    }
  }
  return false
}
