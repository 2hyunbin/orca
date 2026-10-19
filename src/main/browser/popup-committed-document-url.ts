/** RenderFrameHost's last committed URL excludes pending destinations and page titles. */
export function popupCommittedDocumentUrl(contents: Electron.WebContents): string {
  try {
    const frame = contents.mainFrame
    const url = frame.url || 'about:blank'
    // Error and sandboxed documents can retain a network URL with an opaque security origin.
    if (frame.origin === 'null' && URL.canParse(url) && new URL(url).origin !== 'null') {
      return 'unknown'
    }
    return url
  } catch {
    return 'about:blank'
  }
}
