import { blobToBase64, convertImageBlobToPng } from './image-blob-png'

export async function copyImageToClipboard(readImage: () => Promise<Blob>): Promise<void> {
  const png = await convertImageBlobToPng(await readImage())
  await window.api.ui.writeClipboardImage(`data:image/png;base64,${await blobToBase64(png)}`)
}
