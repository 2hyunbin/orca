import type { IRawGrammar } from 'shiki/textmate'
import {
  parsePluginGrammarArtifact,
  type PluginGrammarArtifact
} from '../../../../shared/plugins/plugin-syntax-artifact'

type InputRule = PluginGrammarArtifact['patterns'][number]
type EngineRule = IRawGrammar['patterns'][number]

function ruleMap(input?: Record<string, InputRule>): Record<string, EngineRule> | undefined {
  return input
    ? Object.fromEntries(Object.entries(input).map(([key, rule]) => [key, engineRule(rule)]))
    : undefined
}

function engineRule(rule: InputRule): EngineRule {
  return {
    ...rule,
    applyEndPatternLast:
      rule.applyEndPatternLast === undefined ? undefined : Boolean(rule.applyEndPatternLast),
    patterns: rule.patterns?.map(engineRule),
    repository: ruleMap(rule.repository),
    captures: ruleMap(rule.captures),
    beginCaptures: ruleMap(rule.beginCaptures),
    endCaptures: ruleMap(rule.endCaptures),
    whileCaptures: ruleMap(rule.whileCaptures)
  }
}

export function pluginGrammarEngineArtifact(content: string, scopeName: string): IRawGrammar {
  const grammar = parsePluginGrammarArtifact(content, scopeName)
  return {
    ...grammar,
    patterns: grammar.patterns.map(engineRule),
    repository: ruleMap(grammar.repository) ?? {}
  }
}
