import {
  environmentRecipeDeclaredActions,
  environmentRecipeProviderId,
  type PluginEnvironmentRecipe
} from './plugin-environment-recipe-artifact'
import type { EnvironmentRecipeAction } from '../environment-recipe-protocol'

export type PluginEnvironmentRecipePreview = {
  providerId: string
  id: string
  name: string
  description: string
  lifetime: PluginEnvironmentRecipe['lifetime']
  commands: {
    action: EnvironmentRecipeAction | 'inspect-operation'
    program: string
    args: string[]
    timeoutSeconds: number
  }[]
}

export function pluginEnvironmentRecipePreview(
  pluginKey: string,
  recipe: PluginEnvironmentRecipe
): PluginEnvironmentRecipePreview {
  return {
    providerId: environmentRecipeProviderId(pluginKey, recipe),
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    lifetime: recipe.lifetime,
    commands: [
      ...environmentRecipeDeclaredActions(recipe).flatMap((action) => {
        const command = recipe.commands[action]
        return command
          ? [
              {
                action,
                program: command.program,
                args: [...command.args],
                timeoutSeconds: command.timeoutSeconds
              }
            ]
          : []
      }),
      ...(recipe.recovery
        ? [
            {
              action: 'inspect-operation' as const,
              ...recipe.recovery.command,
              args: [...recipe.recovery.command.args]
            }
          ]
        : [])
    ]
  }
}
