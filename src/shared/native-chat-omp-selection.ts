import type { AskAnswerSelection, AskPrompt } from './native-chat-ask'

export function isOmpAskSelectionValid(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): boolean {
  return prompt.questions.every((question, i) => {
    const indices = selections[i]?.indices ?? []
    return (
      indices.every(
        (index) => Number.isInteger(index) && index >= 0 && index < question.options.length
      ) &&
      new Set(indices).size === indices.length &&
      (question.multiSelect || indices.length <= 1)
    )
  })
}
