import { transcriptId } from './transcript-store.js'

export function parseTranscriptFilter(input) {
  const { personId, botId, limit = 20, before } = input
  if (!Object.keys(input).every(key => ['operation', 'personId', 'botId', 'limit', 'before'].includes(key))
      || !transcriptId(personId) || !transcriptId(botId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) return undefined
  return { personId, botId, limit, before }
}

export async function readOwnerTranscript(store, context, filter) {
  const result = await store.readAudited({ ...filter, ownerRequestId: context.requestId, at: context.at, signal: context.signal })
  return { ...result, ownerRequestId: context.requestId }
}
