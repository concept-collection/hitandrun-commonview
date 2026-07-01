import {makeNostrEvent, type NostrEvent} from './identity'

// Minimal nostr client, modeled on trystero's nostr strategy but trimmed to
// only what we need: publish to a topic, and subscribe to a topic. Topics are
// carried in an 'x' tag; each topic maps to an ephemeral event kind (20000+)
// so relays don't store the messages.

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.mostr.pub',
  'wss://purplerelay.com'
]

const TAG = 'x'

const strToNum = (str: string, limit: number): number => {
  let sum = 0
  for (let i = 0; i < str.length; i++) sum += str.charCodeAt(i)
  return sum % limit
}

const kindForTopic = (topic: string): number => strToNum(topic, 10000) + 20000

const nowSec = (): number => Math.floor(Date.now() / 1000)

const genSubId = (): string =>
  Array.from({length: 16}, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')

type TopicHandler = (content: string, fromPubkey: string) => void

export class Nostr {
  private sockets: WebSocket[] = []
  private subs = new Map<string, {topic: string; handler: TopicHandler}>()

  constructor() {
    for (const url of RELAYS) this.connect(url)
  }

  private connect(url: string) {
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      return
    }
    this.sockets.push(ws)

    ws.onopen = () => {
      // (re)send all active subscriptions on this socket
      for (const [subId, {topic}] of this.subs) this.sendReq(ws, subId, topic)
    }

    ws.onmessage = ev => {
      let msg: unknown
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (!Array.isArray(msg) || msg[0] !== 'EVENT') return
      const subId = msg[1] as string
      const event = msg[2] as NostrEvent
      const sub = this.subs.get(subId)
      if (sub && event && typeof event.content === 'string') {
        sub.handler(event.content, event.pubkey)
      }
    }

    ws.onclose = () => {
      this.sockets = this.sockets.filter(s => s !== ws)
      // reconnect after a short delay
      setTimeout(() => this.connect(url), 3000)
    }

    ws.onerror = () => ws.close()
  }

  private sendReq(ws: WebSocket, subId: string, topic: string) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(
      JSON.stringify([
        'REQ',
        subId,
        {kinds: [kindForTopic(topic)], since: nowSec(), ['#' + TAG]: [topic]}
      ])
    )
  }

  /** Subscribe to a topic. Handler fires for each incoming event. */
  subscribe(topic: string, handler: TopicHandler): () => void {
    const subId = genSubId()
    this.subs.set(subId, {topic, handler})
    for (const ws of this.sockets) this.sendReq(ws, subId, topic)
    return () => {
      this.subs.delete(subId)
      for (const ws of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(['CLOSE', subId]))
        }
      }
    }
  }

  /** Publish a signed event to a topic. */
  async publish(topic: string, content: string): Promise<void> {
    const event = await makeNostrEvent(
      kindForTopic(topic),
      [[TAG, topic]],
      content
    )
    const payload = JSON.stringify(['EVENT', event])
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }
}

const sha256Hex = async (str: string): Promise<string> => {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str)
  )
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Topic everyone in a room announces on / listens to for discovery. */
export const rootTopic = (roomId: string): Promise<string> =>
  sha256Hex(`hitandrun-commonview:${roomId}`)

/** Per-peer topic used to deliver WebRTC signaling to a specific peer. */
export const peerTopic = (root: string, peerId: string): Promise<string> =>
  sha256Hex(`${root}:${peerId}`)
