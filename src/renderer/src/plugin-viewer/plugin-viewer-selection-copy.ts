import { toast } from 'sonner'
import type { PluginViewerChrome } from '../../../shared/plugins/plugin-viewer-frame-protocol'

let copying = false

export async function copyPluginViewerCellValue(
  value: string,
  command: () => Promise<boolean>,
  labels: PluginViewerChrome['labels']
): Promise<void> {
  if (copying) {
    return
  }
  copying = true
  const previous = document.activeElement
  const selected = document.createElement('textarea')
  selected.readOnly = true
  selected.tabIndex = -1
  selected.setAttribute('aria-label', labels.cellValue ?? 'Cell value')
  selected.className = 'sr-only'
  selected.value = value
  document.body.append(selected)
  selected.focus({ preventScroll: true })
  selected.select()
  let complete: (copied: boolean) => void = () => {}
  const observed = new Promise<boolean>((resolve) => {
    complete = resolve
  })
  const receive = (event: ClipboardEvent): void => {
    if (event.isTrusted && document.activeElement === selected) {
      complete(true)
    }
  }
  const timeout = setTimeout(() => complete(false), 2000)
  document.addEventListener('copy', receive)
  try {
    const copied = (await command()) && (await observed)
    if (copied) {
      toast.success(labels.copied ?? 'Copied')
    } else {
      toast.error(
        labels.copyFailed ?? 'Could not copy. Select the value and copy with your keyboard.'
      )
    }
  } catch {
    toast.error(
      labels.copyFailed ?? 'Could not copy. Select the value and copy with your keyboard.'
    )
  } finally {
    clearTimeout(timeout)
    document.removeEventListener('copy', receive)
    if (
      document.activeElement === selected &&
      previous instanceof HTMLElement &&
      previous.isConnected
    ) {
      previous.focus({ preventScroll: true })
    }
    selected.remove()
    copying = false
  }
}
