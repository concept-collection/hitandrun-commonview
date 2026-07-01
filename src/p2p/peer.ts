// A thin WebRTC wrapper, distilled from trystero's peer.ts. We only need a
// reliable ordered data channel plus offer/answer/ICE signaling. To keep things
// simple we avoid "perfect negotiation" glare handling by ensuring only ONE
// side (a deterministically chosen initiator) ever creates the offer.
//
// Unlike commonview's original, the channel carries two kinds of frames:
// strings (JSON control messages) and ArrayBuffers (chunks of large binary
// payloads, e.g. sample sets). The wrapper keeps them apart and applies
// backpressure when streaming binary data.

export type Signal =
  | {type: 'offer'; sdp: string}
  | {type: 'answer'; sdp: string}
  | {type: 'candidate'; candidate: RTCIceCandidateInit}

export interface PeerHandlers {
  signal: (signal: Signal) => void
  connect: () => void
  data: (data: string) => void
  binary: (data: ArrayBuffer) => void
  close: () => void
}

export const ICE_SERVERS: RTCIceServer[] = [
  {urls: 'stun:stun.l.google.com:19302'},
  {urls: 'stun:stun1.l.google.com:19302'},
  {urls: 'stun:stun.cloudflare.com:3478'},
  // Free TURN relay (openrelayproject) — needed when direct/STUN pairing
  // fails (symmetric NAT, hairpinning, host-candidate blocking).
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
]

// Keep binary frames well under the ~256 KB cross-browser SCTP message limit.
export const BINARY_CHUNK_BYTES = 64 * 1024

// While streaming a large payload, pause whenever this much is queued in the
// channel and resume once it drains below the low-water mark.
const HIGH_WATER = 1 << 20 // 1 MiB
const LOW_WATER = 1 << 18 // 256 KiB

export class Peer {
  private pc: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private handlers: Partial<PeerHandlers> = {}
  private pendingCandidates: RTCIceCandidateInit[] = []
  private closed = false

  constructor(private initiator: boolean) {
    this.pc = new RTCPeerConnection({iceServers: ICE_SERVERS})

    this.pc.onicecandidate = ({candidate}) => {
      if (candidate) {
        this.handlers.signal?.({type: 'candidate', candidate: candidate.toJSON()})
      }
    }

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        this.destroy()
      }
    }

    if (initiator) {
      this.setupChannel(this.pc.createDataChannel('data'))
      this.pc.onnegotiationneeded = () => void this.makeOffer()
    } else {
      this.pc.ondatachannel = ({channel}) => this.setupChannel(channel)
    }
  }

  setHandlers(handlers: Partial<PeerHandlers>) {
    Object.assign(this.handlers, handlers)
  }

  private setupChannel(channel: RTCDataChannel) {
    this.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = LOW_WATER
    channel.onopen = () => this.handlers.connect?.()
    channel.onclose = () => this.destroy()
    channel.onmessage = e => {
      if (typeof e.data === 'string') this.handlers.data?.(e.data)
      else this.handlers.binary?.(e.data as ArrayBuffer)
    }
  }

  private async makeOffer() {
    if (this.closed) return
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer())
      this.handlers.signal?.({
        type: 'offer',
        sdp: this.pc.localDescription!.sdp
      })
    } catch {
      /* ignore */
    }
  }

  async signal(signal: Signal) {
    if (this.closed) return
    try {
      if (signal.type === 'candidate') {
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(signal.candidate)
        } else {
          this.pendingCandidates.push(signal.candidate)
        }
        return
      }

      if (signal.type === 'offer') {
        if (this.initiator) return // initiators never accept remote offers
        await this.pc.setRemoteDescription({type: 'offer', sdp: signal.sdp})
        await this.flushCandidates()
        await this.pc.setLocalDescription(await this.pc.createAnswer())
        this.handlers.signal?.({
          type: 'answer',
          sdp: this.pc.localDescription!.sdp
        })
        return
      }

      if (signal.type === 'answer') {
        await this.pc.setRemoteDescription({type: 'answer', sdp: signal.sdp})
        await this.flushCandidates()
      }
    } catch {
      /* ignore transient signaling errors */
    }
  }

  private async flushCandidates() {
    const queued = this.pendingCandidates.splice(0)
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(c)
      } catch {
        /* ignore */
      }
    }
  }

  send(data: string) {
    if (this.channel?.readyState === 'open') this.channel.send(data)
  }

  /** Stream a large binary payload as sequential chunks, respecting channel
   *  backpressure. Resolves when everything is handed to the channel; resolves
   *  false if the channel closed part-way. */
  async sendBinary(payload: ArrayBuffer): Promise<boolean> {
    for (let off = 0; off < payload.byteLength; off += BINARY_CHUNK_BYTES) {
      const ch = this.channel
      if (!ch || ch.readyState !== 'open') return false
      if (ch.bufferedAmount > HIGH_WATER) {
        const ok = await this.drain(ch)
        if (!ok) return false
      }
      try {
        ch.send(payload.slice(off, off + BINARY_CHUNK_BYTES))
      } catch {
        return false
      }
    }
    return true
  }

  private drain(ch: RTCDataChannel): Promise<boolean> {
    return new Promise(resolve => {
      const done = (ok: boolean) => {
        ch.removeEventListener('bufferedamountlow', onLow)
        ch.removeEventListener('close', onClose)
        resolve(ok)
      }
      const onLow = () => done(true)
      const onClose = () => done(false)
      ch.addEventListener('bufferedamountlow', onLow)
      ch.addEventListener('close', onClose)
      if (ch.readyState !== 'open') done(false)
    })
  }

  get isConnected(): boolean {
    return this.channel?.readyState === 'open'
  }

  destroy() {
    if (this.closed) return
    this.closed = true
    try {
      this.channel?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc.close()
    } catch {
      /* ignore */
    }
    this.handlers.close?.()
  }
}
