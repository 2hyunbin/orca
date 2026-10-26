// What the agent reads: mentions of the bot (<@id>, or the older <@!id>) dropped.
export function discordPromptText(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim()
}

// Inputs we interpolate (machine and project names, reasons) can't format text or forge a masked
// link; agent text is posted as written, and allowed_mentions keeps it from pinging anyone.
export function escapeDiscordText(text: string): string {
  return text.replace(/[\\*_~`|>[\]()#<]/g, '\\$&')
}
