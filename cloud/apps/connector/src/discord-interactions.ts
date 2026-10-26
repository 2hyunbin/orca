import { z } from 'zod'

// https://docs.discord.com/developers/interactions/receiving-and-responding
const PING = 1
const APPLICATION_COMMAND = 2
const MESSAGE_COMPONENT = 3
const EPHEMERAL = 1 << 6

const UserSchema = z.looseObject({ id: z.string().min(1) })

const InteractionSchema = z.looseObject({
  id: z.string().min(1),
  application_id: z.string().min(1),
  type: z.number().int(),
  token: z.string().min(1),
  guild_id: z.string().min(1).optional(),
  channel_id: z.string().min(1).optional(),
  // A guild interaction names its user under member; a DM one under user.
  member: z.looseObject({ user: UserSchema }).optional(),
  user: UserSchema.optional(),
  data: z.looseObject({}).optional(),
  message: z.looseObject({ id: z.string().min(1) }).optional()
})

const ComponentDataSchema = z.looseObject({
  custom_id: z.string().min(1).max(100),
  component_type: z.number().int()
})

const OptionValueSchema = z.union([z.string(), z.number(), z.boolean()])
const CommandDataSchema = z.looseObject({
  name: z.string().min(1),
  options: z
    .array(z.looseObject({ name: z.string().min(1), value: OptionValueSchema.optional() }))
    .default([])
})

type InteractionBase = {
  interactionId: string
  token: string
  applicationId: string
  guildId?: string
  channelId: string
  userId: string
}

export type DiscordInteraction =
  | { kind: 'ping' }
  | (InteractionBase & { kind: 'component'; customId: string; messageId: string })
  // Top-level options only; subcommands are not used.
  | (InteractionBase & {
      kind: 'command'
      name: string
      options: Record<string, string | number | boolean>
    })
  | { kind: 'ignored' }
  | { kind: 'invalid' }

export function readDiscordInteraction(payload: unknown): DiscordInteraction {
  const parsed = InteractionSchema.safeParse(payload)
  if (!parsed.success) {
    return { kind: 'invalid' }
  }
  const interaction = parsed.data
  if (interaction.type === PING) {
    return { kind: 'ping' }
  }
  const userId = interaction.member?.user.id ?? interaction.user?.id
  if (userId === undefined || interaction.channel_id === undefined) {
    return { kind: 'ignored' }
  }
  const base: InteractionBase = {
    interactionId: interaction.id,
    token: interaction.token,
    applicationId: interaction.application_id,
    ...(interaction.guild_id === undefined ? {} : { guildId: interaction.guild_id }),
    channelId: interaction.channel_id,
    userId
  }
  if (interaction.type === MESSAGE_COMPONENT) {
    const data = ComponentDataSchema.safeParse(interaction.data)
    return data.success && interaction.message
      ? {
          ...base,
          kind: 'component',
          customId: data.data.custom_id,
          messageId: interaction.message.id
        }
      : { kind: 'invalid' }
  }
  if (interaction.type === APPLICATION_COMMAND) {
    const data = CommandDataSchema.safeParse(interaction.data)
    if (!data.success) {
      return { kind: 'invalid' }
    }
    const options = Object.fromEntries(
      data.data.options.flatMap((option) =>
        option.value === undefined ? [] : [[option.name, option.value] as const]
      )
    )
    return { ...base, kind: 'command', name: data.data.name, options }
  }
  return { kind: 'ignored' }
}

// Callback bodies returned as the HTTP response; our text never pings anyone.
export const discordInteractionResponse = {
  pong: () => ({ type: 1 }),
  ephemeral: (content: string) => ({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } }
  }),
  // Rewrites the clicked message, dropping its buttons.
  updateMessage: (content: string) => ({
    type: 7,
    data: { content, components: [], allowed_mentions: { parse: [] } }
  })
}
