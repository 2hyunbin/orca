type MainDaemonAttachmentDependencies = {
  isUnattachedLocalCandidate: (ptyId: string) => boolean
  attachProvider: (ptyId: string) => Promise<boolean> | null
}

// Why capped: 100 concurrent snapshot attaches delayed the visible terminal's first echo by ~0.7 s.
const MAX_CONCURRENT_ATTACHES = 4

/** Main holds the stream for every live local daemon session it adopts, so its records fill without a mounted pane. */
export class MainDaemonAttachments {
  // Sessions whose stream this run already holds: spawned, pane-attached or main-attached.
  private readonly attached = new Set<string>()
  private readonly attaching = new Map<string, Promise<boolean>>()
  private readonly queued: (() => void)[] = []
  private running = 0

  constructor(private readonly deps: MainDaemonAttachmentDependencies) {}

  markSpawnPublished(ptyId: string): void {
    this.attached.add(ptyId)
  }

  /** Exit or respawn ends the generation whose stream this described. */
  forget(ptyId: string): void {
    this.attached.delete(ptyId)
    this.attaching.delete(ptyId)
  }

  isKnownUnattachedLocal(ptyId: string): boolean {
    return !this.attached.has(ptyId) && this.deps.isUnattachedLocalCandidate(ptyId)
  }

  /** No stream and no attach in flight: nothing this session prints can reach main. */
  isUnreachable(ptyId: string): boolean {
    return !this.attaching.has(ptyId) && this.isKnownUnattachedLocal(ptyId)
  }

  /** Inventory proved the session live; attach it, or retry once an in-flight refusal settles. */
  reconcile(ptyId: string): void {
    const attempt = this.attaching.get(ptyId)
    if (!attempt) {
      this.ensure(ptyId)
      return
    }
    void attempt.then((attached) => {
      if (!attached) {
        this.ensure(ptyId)
      }
    })
  }

  ensure(ptyId: string): void {
    if (this.attaching.has(ptyId) || !this.isKnownUnattachedLocal(ptyId)) {
      return
    }
    const attempt = this.attach(ptyId)
    this.attaching.set(ptyId, attempt)
    void attempt.then((attached) => {
      if (this.attaching.get(ptyId) !== attempt) {
        return
      }
      this.attaching.delete(ptyId)
      if (attached) {
        this.attached.add(ptyId)
      }
    })
  }

  private async attach(ptyId: string): Promise<boolean> {
    if (this.running >= MAX_CONCURRENT_ATTACHES) {
      // The finishing attach hands its slot over without releasing it.
      await new Promise<void>((resolve) => this.queued.push(resolve))
    } else {
      this.running += 1
    }
    try {
      // A pane may have attached, or the session exited, while this waited.
      if (this.attached.has(ptyId) || !this.deps.isUnattachedLocalCandidate(ptyId)) {
        return false
      }
      return (await this.deps.attachProvider(ptyId)) ?? false
    } catch {
      return false
    } finally {
      const next = this.queued.shift()
      if (next) {
        next()
      } else {
        this.running -= 1
      }
    }
  }
}
