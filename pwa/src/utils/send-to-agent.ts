import {
  fetchTranscript,
  RequestError,
  sendAgentMessage,
} from '../hooks/use-mux-api'

// Sends text to the agent of paneId as one message, after its transcript's
// cursor; once more with a fresh cursor when the agent's session moved on
// meanwhile. queued: the agent was working and queued it (202). Throws
// RequestError when the server refuses.
export async function sendToAgent(
  paneId: string,
  text: string,
): Promise<{ queued: boolean }> {
  const page = await fetchTranscript(paneId)
  try {
    return await sendAgentMessage(paneId, text, page.cursor)
  } catch (err) {
    if (!(err instanceof RequestError && err.code === 'session_changed'))
      throw err
    const again = await fetchTranscript(paneId)
    return sendAgentMessage(paneId, text, again.cursor)
  }
}
