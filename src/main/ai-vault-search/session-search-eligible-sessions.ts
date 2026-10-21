import type SyncDatabase from '../sqlite/sync-database'
import { AiVaultSearchEligibleSessionsSchema } from '../../shared/ai-vault-search-eligible-sessions'
import {
  normalizeSessionPrompt,
  sessionPromptsMatch
} from '../../shared/ai-vault-session-prompt-match'

/** SQL keeps provider identities native; only legacy prompt fallback calls into JS. */
export function registerSessionSearchPromptEligibility(db: SyncDatabase): void {
  let previous: string | undefined
  let byAgent = new Map<string, string[][]>()
  db.function('orca_session_prompt_eligible', (agent, title, encoded) => {
    if (typeof agent !== 'string' || typeof title !== 'string' || typeof encoded !== 'string') {
      return 0
    }
    if (previous !== encoded) {
      const eligible = AiVaultSearchEligibleSessionsSchema.parse(JSON.parse(encoded))
      byAgent = new Map()
      for (const entry of eligible.prompts) {
        const targets = byAgent.get(entry.agent) ?? []
        targets.push(entry.prompts.map(normalizeSessionPrompt))
        byAgent.set(entry.agent, targets)
      }
      previous = encoded
    }
    const prompt = normalizeSessionPrompt(title)
    let matches = 0
    for (const candidates of byAgent.get(agent) ?? []) {
      if (candidates.some((candidate) => sessionPromptsMatch(prompt, candidate)) && ++matches > 1) {
        return 0
      }
    }
    return matches === 1 ? 1 : 0
  })
}
