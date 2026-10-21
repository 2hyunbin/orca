import { Duplex } from 'node:stream'
import { SearchSubprocessLineAccumulator } from '../../shared/search-subprocess-lines'

/** Each private endpoint has one outstanding reply; provider data never enters this channel. */
export function providerExecChannel(stream: unknown, onFailure: (error: Error) => void) {
  const endpoint = stream instanceof Duplex ? stream : null
  const lines = new SearchSubprocessLineAccumulator(256)
  let buffered: string | undefined
  let failed: Error | undefined
  let finalReply: string | undefined
  let completed = false
  let waiting: ReturnType<typeof Promise.withResolvers<string>> | undefined
  const fail = (error: Error): void => {
    if (failed || completed) {
      return
    }
    failed = error
    waiting?.reject(error)
    waiting = undefined
    onFailure(error)
  }
  endpoint?.on('data', (chunk: Buffer) => {
    if (
      !lines.push(chunk, (line) => {
        if (line === finalReply) {
          completed = true
        }
        if (waiting) {
          waiting.resolve(line)
          waiting = undefined
        } else if (buffered === undefined) {
          buffered = line
        } else {
          fail(new Error('Unexpected provider control reply'))
        }
      })
    ) {
      fail(new Error('Provider control reply exceeded its bound'))
    }
  })
  endpoint?.once('end', () => fail(new Error('Provider control endpoint closed')))
  endpoint?.once('close', () => fail(new Error('Provider control endpoint closed')))
  endpoint?.on('error', fail)
  if (!endpoint) {
    fail(new Error('Provider control endpoint is unavailable'))
  }
  return {
    async next(): Promise<string> {
      if (failed) {
        throw failed
      }
      if (buffered !== undefined) {
        const line = buffered
        buffered = undefined
        return line
      }
      if (waiting) {
        throw new Error('Concurrent provider control replies')
      }
      const pending = Promise.withResolvers<string>()
      waiting = pending
      const timer = setTimeout(() => fail(new Error('Provider control reply timed out')), 5_000)
      try {
        return await pending.promise
      } finally {
        clearTimeout(timer)
      }
    },
    send(line: string, expectedFinalReply?: string): void {
      if (failed) {
        throw failed
      }
      finalReply = expectedFinalReply
      endpoint?.write(`${line}\n`)
    },
    stop() {
      endpoint?.destroy()
    }
  }
}
