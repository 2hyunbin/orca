import { describe, expect, it } from 'vitest'
import { isUsableSkillsCliAgentKey } from './skills-cli-agent-keys'

describe('skills CLI agent keys', () => {
  it('rejects values the skills CLI would drop, and allows the explicit wildcard', () => {
    for (const bad of ['-y', '--copy', '', ' ', 'a b', 'a,b']) {
      expect(isUsableSkillsCliAgentKey(bad), bad).toBe(false)
    }
    for (const good of ['claude-code', 'universal', 'trae-cn', 'inference-sh', '*']) {
      expect(isUsableSkillsCliAgentKey(good), good).toBe(true)
    }
  })
})
