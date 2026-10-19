/** RenderFrameHost's last committed URL excludes pending destinations and page titles. */
export function popupCommittedDocumentUrl(contents: Electron.WebContents): string {
  try {
    return contents.mainFrame.url || 'about:blank'
  } catch {
    return 'about:blank'
  }
}
