/** Page routes drawn over the screen that opened them: every layer above them stays transparent. */
export function isTransparentPageRoute(pathname: string): boolean {
  return /^\/h\/[^/]+\/new-workspace$/.test(pathname)
}
