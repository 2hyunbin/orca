export function stripHtmlComments(value: string, separator: '' | ' ' = ''): string {
  if (!value.includes('<!--')) {
    return value
  }
  const lastClose = value.lastIndexOf('-->')
  if (lastClose === -1) {
    return value
  }
  const end = lastClose + 3
  // An unclosed tail stays literal; searching it again for each opener can only fail.
  return value.slice(0, end).replace(/<!--[\s\S]*?-->/g, separator) + value.slice(end)
}
