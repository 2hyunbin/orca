export class TerminalPromptSubmissions {
  private readonly agentPromptSubmissionTailByPtyId = new Map<string, Promise<void>>()
  async serializeAgentPromptSubmission<T>(
    ptyId: string,
    generation: number,
    submit: () => Promise<T>
  ): Promise<T> {
    const queueKey = `${ptyId}\u0000${generation}`
    const previous = this.agentPromptSubmissionTailByPtyId.get(queueKey) ?? Promise.resolve()
    const submission = previous.catch(() => undefined).then(submit)
    const tail = submission.then(
      () => undefined,
      () => undefined
    )
    this.agentPromptSubmissionTailByPtyId.set(queueKey, tail)
    try {
      return await submission
    } finally {
      if (this.agentPromptSubmissionTailByPtyId.get(queueKey) === tail) {
        this.agentPromptSubmissionTailByPtyId.delete(queueKey)
      }
    }
  }
}
