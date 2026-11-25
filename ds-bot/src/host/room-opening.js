// Resolve mentions lazily so special openings never consult the message text.
export function selectRoomOpening({ members, adminId, mode, opener }, resolveMentions) {
  const eligible = members.filter(bot => bot.id !== opener.botId)
  const admin = eligible.find(bot => bot.id === adminId)
  const immediate = speakers => ({ speakers, ordered: false })
  if (opener.kickoff) return immediate(admin ? [admin] : [])
  if (opener.quiet) return immediate([])
  if (opener.done) return immediate(eligible.filter(bot => bot.id === opener.askedBy))
  if (opener.goal !== undefined) return immediate(admin ? [admin] : [])

  const { all, found: named } = resolveMentions()
  const found = named.filter(bot => bot.id !== opener.botId)
  if (opener.progress) return immediate(found)
  if (opener.late) return immediate(found.length > 0 ? found : eligible.filter(bot => bot.id === opener.askedBy))
  if (opener.member) return immediate(found)
  if (found.length > 0 && !all) return immediate(found)
  if (!all && mode === 'admin' && admin) return immediate([admin])

  const speakers = admin ? [admin, ...eligible.filter(bot => bot !== admin)] : eligible
  return { speakers, ordered: !all && speakers.length > 1 }
}
