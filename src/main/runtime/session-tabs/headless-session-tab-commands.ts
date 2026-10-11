import {
  RuntimeHeadlessTabProperties,
  type RuntimeHeadlessTabPropertiesHost
} from './headless-tab-properties'
import {
  RuntimeHeadlessTabGroups,
  type RuntimeHeadlessTabGroupsHost
} from './headless-tab-group-moves'

export function createHeadlessSessionTabCommands(
  host: RuntimeHeadlessTabPropertiesHost & RuntimeHeadlessTabGroupsHost
): { properties: RuntimeHeadlessTabProperties; groups: RuntimeHeadlessTabGroups } {
  return {
    properties: new RuntimeHeadlessTabProperties(host),
    groups: new RuntimeHeadlessTabGroups(host)
  }
}
