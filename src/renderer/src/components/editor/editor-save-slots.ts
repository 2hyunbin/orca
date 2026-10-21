import type { EditorSaveResult, EditorSaveTrigger } from './editor-save-disk-precondition'

export type EditorSaveRequest = {
  fileId: string
  fallbackContent: string
  trigger: EditorSaveTrigger
  /** It waited behind a running save, which may have left nothing to write. */
  queued: boolean
}

type SaveSlot = {
  running: Promise<void>
  queued?: { request: EditorSaveRequest; promise: Promise<EditorSaveResult> }
}

const TRIGGER_RANK: Record<EditorSaveTrigger, number> = {
  autosave: 0,
  user: 1,
  restart: 1,
  overwrite: 2
}

const ignore = (): void => undefined

/** Per record: one running save, plus at most one queued save that later requests join. */
export function createEditorSaveSlots(
  run: (request: EditorSaveRequest) => Promise<EditorSaveResult>
): {
  enqueue: (key: string, request: Omit<EditorSaveRequest, 'queued'>) => Promise<EditorSaveResult>
  /** Waits for the running and queued saves; cancels neither. */
  settle: (key: string) => Promise<void>
  clear: () => void
} {
  const slots = new Map<string, SaveSlot>()

  const enqueue = (
    key: string,
    { fileId, fallbackContent, trigger }: Omit<EditorSaveRequest, 'queued'>
  ): Promise<EditorSaveResult> => {
    const slot = slots.get(key)
    if (slot?.queued) {
      // Why: the queued save reads the latest text when it runs, so a later request joins it.
      const { request } = slot.queued
      request.fallbackContent = fallbackContent
      if (TRIGGER_RANK[trigger] > TRIGGER_RANK[request.trigger]) {
        request.trigger = trigger
      }
      return slot.queued.promise
    }
    const request: EditorSaveRequest = { fileId, fallbackContent, trigger, queued: !!slot }
    const promise = (slot?.running ?? Promise.resolve()).then(() => {
      const current = slots.get(key)
      if (current?.queued?.request === request) {
        current.running = running
        current.queued = undefined
      }
      return run(request)
    })
    const running = promise.then(ignore, ignore)
    if (slot) {
      slot.queued = { request, promise }
    } else {
      slots.set(key, { running })
    }
    void running.then(() => {
      const current = slots.get(key)
      if (current?.running === running && !current.queued) {
        slots.delete(key)
      }
    })
    return promise
  }

  const settle = async (key: string): Promise<void> => {
    const slot = slots.get(key)
    await (slot?.queued?.promise.then(ignore, ignore) ?? slot?.running)
  }

  return { enqueue, settle, clear: () => slots.clear() }
}
