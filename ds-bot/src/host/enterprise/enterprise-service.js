import { createEmployeeGroupChatHandler } from './group-chat-http.js'
import { employeeRoute } from './https-entry.js'
import { createEmployeePrivateChatHandler } from './private-chat-http.js'

export function createEmployeeServiceHandler({ origin, accounts, readRoster, resolveBot, limits, readHistory, enqueueGroup, transcriptStore, handleOwner }) {
  if (typeof readHistory !== 'function' || typeof enqueueGroup !== 'function') {
    throw new TypeError('Expected employee group runtime callbacks')
  }
  // The private handler already owns the auth handler and its rate limiter.
  const handlePrivate = createEmployeePrivateChatHandler({ origin, accounts, readRoster, resolveBot, limits, transcriptStore })
  const handleGroup = createEmployeeGroupChatHandler({ origin, accounts, readRoster, readHistory, enqueue: enqueueGroup })
  return (request, context) => {
    const route = employeeRoute(new URL(request.url).pathname)
    if (!route) return Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    if (route.owner) return handleOwner ? handleOwner(request, context?.owner)
      : Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    return route.group ? handleGroup(request) : handlePrivate(request, context)
  }
}
