import type { TextGenerationOperation } from './source-control-text-generation-types'

type GenerationCancelToken = { cancel?: () => void; request?: LocalGenerationRequest }
const cancelTokensByLane = new Map<string, GenerationCancelToken>()

export type SourceControlGenerationRequestIdentity = { owner: string; generationId: string }
type GenerationRequestTarget = { cwd: string; wslDistro?: string }

function requestLaneKey(
  operation: TextGenerationOperation,
  identity: SourceControlGenerationRequestIdentity
): string {
  if (
    typeof identity.generationId !== 'string' ||
    !identity.generationId.trim() ||
    identity.generationId.length > 128
  ) {
    throw new Error('Invalid generation request ID.')
  }
  return JSON.stringify([operation, identity.owner, identity.generationId])
}

function requestTargetKey(target: GenerationRequestTarget): string {
  return JSON.stringify([target.cwd, target.wslDistro ?? null])
}

export class LocalGenerationRequest {
  private targetKey: string | undefined
  private readonly canceledTargetKeys = new Set<string>()
  private canceledByUser = false
  private cancelToken: (() => void) | undefined

  constructor(private readonly laneKey: string) {}

  get canceled(): boolean {
    return this.canceledByUser
  }

  bindTarget(target: GenerationRequestTarget): void {
    this.targetKey = requestTargetKey(target)
    if (this.canceledTargetKeys.has(this.targetKey)) {
      this.cancel()
    }
    this.canceledTargetKeys.clear()
  }

  cancelForTarget(target: GenerationRequestTarget): void {
    const targetKey = requestTargetKey(target)
    if (this.targetKey === undefined) {
      // Stop may finish authorization while Generate is still resolving its target.
      this.canceledTargetKeys.add(targetKey)
    } else if (targetKey === this.targetKey) {
      this.cancel()
    }
  }

  attachCancelToken(cancel: () => void): void {
    this.cancelToken = cancel
    if (this.canceled) {
      cancel()
    }
  }

  detachCancelToken(cancel: () => void): void {
    if (this.cancelToken === cancel) {
      this.cancelToken = undefined
    }
  }

  release(): void {
    if (cancelTokensByLane.get(this.laneKey)?.request === this) {
      cancelTokensByLane.delete(this.laneKey)
    }
  }

  private cancel(): void {
    if (!this.canceledByUser) {
      this.canceledByUser = true
      this.cancelToken?.()
    }
  }
}

export function beginLocalGenerationRequest(
  operation: TextGenerationOperation,
  identity?: SourceControlGenerationRequestIdentity
): LocalGenerationRequest | undefined {
  if (!identity) {
    return undefined
  }
  const laneKey = requestLaneKey(operation, identity)
  if (cancelTokensByLane.has(laneKey)) {
    throw new Error('This generation request is already running.')
  }
  const request = new LocalGenerationRequest(laneKey)
  cancelTokensByLane.set(laneKey, { request })
  return request
}

export function getLocalGenerationRequest(
  operation: TextGenerationOperation,
  identity: SourceControlGenerationRequestIdentity
): LocalGenerationRequest | undefined {
  return cancelTokensByLane.get(requestLaneKey(operation, identity))?.request
}

export function localGenerationCanceledResult(branchChangedByPreparation?: boolean) {
  return {
    success: false as const,
    error: 'Generation canceled.',
    canceled: true as const,
    ...(branchChangedByPreparation === undefined ? {} : { branchChangedByPreparation })
  }
}

export function localGenerationLaneKey(operation: TextGenerationOperation, cwd: string): string {
  return `${operation}:local:${cwd}`
}

export function cancelLocalGeneration(operation: TextGenerationOperation, cwd: string): void {
  cancelTokensByLane.get(localGenerationLaneKey(operation, cwd))?.cancel?.()
}

export function setLocalGenerationCancelToken(
  laneKey: string,
  cancel: () => void,
  request?: LocalGenerationRequest
): void {
  if (request) {
    request.attachCancelToken(cancel)
  } else {
    cancelTokensByLane.set(laneKey, { cancel })
  }
}

export function clearLocalGenerationCancelToken(
  laneKey: string,
  cancel: () => void,
  request?: LocalGenerationRequest
): void {
  if (request) {
    request.detachCancelToken(cancel)
  } else if (cancelTokensByLane.get(laneKey)?.cancel === cancel) {
    cancelTokensByLane.delete(laneKey)
  }
}
