import { createOutputSink } from '@orca/process-host/bounded-output-sink'

export function createProviderStderrTail(maxBytes: number) {
  const output = createOutputSink(maxBytes, 'tail')
  return {
    write: output.write,
    text: (): string => {
      const text = output.text()
      if (!output.truncated()) {
        return text
      }
      // A truncated line may have lost the label needed to redact a secret.
      const newline = text.indexOf('\n')
      return newline === -1 ? '' : text.slice(newline + 1)
    }
  }
}
