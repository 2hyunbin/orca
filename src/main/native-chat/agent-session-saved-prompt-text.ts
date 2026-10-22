import type {
  AgentJournalPromptOption,
  AgentJournalRenderItem,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import { isPlanApprovalSubject } from '../../shared/agent-session-approval-subject'
import { agentJournalItemRowOrigin } from '../../shared/agent-session-journal-position'
import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import {
  agentSessionPromptQuestions,
  legacyAgentSessionQuestionAnswers
} from '../../shared/agent-session-question-answer'
import { nativeChatReceiptAnswers } from '../../shared/native-chat-resolution-receipt'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../shared/structured-agent-session-projection'

function offeredChoices(options: readonly AgentJournalPromptOption[]): string[] {
  return options.map(
    (option) =>
      `Offered choice: ${option.label}${option.description ? ` — ${option.description}` : ''}`
  )
}

function questionText(body: AgentJournalQuestionItem): string[] {
  const selected = body.resolution.selectedOptionId
  const answers =
    body.resolution.answers ?? (selected ? legacyAgentSessionQuestionAnswers(body, selected) : null)
  return [
    body.question,
    ...agentSessionPromptQuestions(body).flatMap((question) => {
      const lines = [
        ...(question.header ? [question.header] : []),
        ...(body.questions ? [question.question] : []),
        ...offeredChoices(question.options)
      ]
      if (body.resolution.state !== 'resolved') {
        return lines
      }
      const answer = answers?.find((entry) => entry.questionId === question.id)
      if (!answer || (answer.optionIds.length === 0 && answer.other === undefined)) {
        return [...lines, 'Submitted answer: unavailable']
      }
      return [
        ...lines,
        ...answer.optionIds.map((id) => {
          const option = question.options.find((choice) => choice.id === id)
          return option ? `Selected choice: ${option.label}` : 'Selected choice: unavailable'
        }),
        ...(answer.other !== undefined ? [`Free text: ${JSON.stringify(answer.other)}`] : [])
      ]
    })
  ]
}

/** Saved prompts are conversation content even while pending; display projection omits them. */
export function projectSavedChatContextItems(
  items: readonly AgentJournalRenderItem[]
): NativeChatMessage[] {
  return items.flatMap((item): NativeChatMessage[] => {
    const body = item.body
    if (body.kind !== 'question' && body.kind !== 'approval') {
      const message = projectStructuredItemToNativeChat(item)
      return message ? [message] : []
    }
    const lines =
      body.kind === 'question'
        ? questionText(body)
        : [
            body.title,
            ...(body.displayName ? [body.displayName] : []),
            ...(body.description ? [body.description] : []),
            ...(body.decisionReason ? [`Reason: ${body.decisionReason}`] : []),
            ...(body.blockedPath ? [`Path: ${body.blockedPath}`] : []),
            ...(body.detail !== null ? [body.detail] : []),
            ...(isPlanApprovalSubject(body.subject)
              ? [
                  body.subject.text,
                  ...(body.subject.filePath ? [`Plan file: ${body.subject.filePath}`] : [])
                ]
              : []),
            ...offeredChoices(body.options),
            ...(body.resolution.state === 'resolved'
              ? [`Selected choice: ${nativeChatReceiptAnswers(body)[0]?.answer ?? 'unavailable'}`]
              : [])
          ]
    return [
      {
        ...agentJournalItemRowOrigin(item),
        ...agentJournalLinkageFields(item),
        role: 'system',
        blocks: [
          { type: 'text', text: [`Prompt state: ${body.resolution.state}`, ...lines].join('\n') }
        ]
      }
    ]
  })
}
