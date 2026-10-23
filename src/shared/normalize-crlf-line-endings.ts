export function normalizeCrlfLineEndings(text: string): string {
  // Retain sparse spans; flatten dense replacements before they accumulate large ropes.
  let carriageReturn = text.indexOf('\r\n')
  if (carriageReturn === -1) {
    return text
  }
  const sparseReplacementLimit = Math.max(4096, text.length / 64)
  let count = 0
  let prefix = ''
  let copiedThrough = 0
  while (carriageReturn !== -1 && count < sparseReplacementLimit) {
    prefix += `${text.slice(copiedThrough, carriageReturn)}\n`
    copiedThrough = carriageReturn + 2
    count += 1
    carriageReturn = text.indexOf('\r\n', copiedThrough)
  }
  if (carriageReturn === -1) {
    return prefix + text.slice(copiedThrough)
  }
  const chunks: string[] = [prefix]
  for (let start = copiedThrough; start < text.length;) {
    let end = Math.min(start + 64 * 1024, text.length)
    if (text.charCodeAt(end - 1) === 13 && text.charCodeAt(end) === 10) {
      end += 1
    }
    chunks.push(text.slice(start, end).split('\r\n').join('\n'))
    start = end
  }
  return chunks.join('')
}
