import {selfId, sign, verify, sha256HexBytes} from './identity'
import {Nostr, peerTopic, rootTopic} from './nostr'
import {Peer, type Signal} from './peer'
import {BlobReceiver, decodeSamples, encodeSamples} from './blob'
import type {Params, Points} from '../types'

// ---------------------------------------------------------------------------
// Shared state. Everyone sees the same figure: the parameter selections, the
// region, and the samples. Only the CENTRAL peer (oldest in the room) runs the
// numbl engine; commands from any viewer are forwarded to it, it computes, and
// it broadcasts the result.
//
// The state travels in two parts:
//   - the "view" (params/region/status/movie): a small JSON message, broadcast
//     on every change;
//   - the samples: a Float32 blob (up to ~800 KB at n=100k), streamed in
//     chunks and announced by a signed header carrying its SHA-256. The view
//     references the blob by `samplesId`.
// Per-connection sends are serialized (a promise chain), so on the ordered
// data channel a peer always receives a blob before the view that points at
// it.
// ---------------------------------------------------------------------------

export type EngineStatus = 'none' | 'starting' | 'ready' | 'error'

export interface ViewState {
  params: Params
  region: Points | null
  /** The central peer is computing new samples. */
  busy: boolean
  /** Status of the numbl engine on the central peer. */
  engine: EngineStatus
  engineError: string | null
  /** Shared sampling movie: index of the point being sampled, null = off. */
  movieStep: number | null
  /** Identifies the sample blob this view belongs to. */
  samplesId: number
  samplesN: number
}

export type Command =
  | {op: 'resample'; n: number; local: boolean}
  | {op: 'newRegion'; n: number; convex: boolean; local: boolean}
  | {op: 'movie'; play: boolean}

const initialView = (): ViewState => ({
  params: {n: 10000, convex: true, local: false},
  region: null,
  busy: false,
  engine: 'none',
  engineError: null,
  movieStep: null,
  samplesId: 0,
  samplesN: 0
})

/** What the network needs from the numbl engine (implemented in ../engine).
 *  Kept abstract so this layer stays independent of the runtime. */
export interface EngineLike {
  start(): Promise<{region: Points; samples: Points; n: number; convex: boolean}>
  resample(req: {params: Params; region: Points}): Promise<{samples: Points; n: number}>
  newRegion(req: {params: Params}): Promise<{region: Points; samples: Points; n: number; convex: boolean}>
  dispose(): void
}

// ---------------------------------------------------------------------------
// Wire protocol (over the WebRTC data channel). Every JSON message is a signed
// envelope; binary frames are the chunks of the blob most recently announced
// by a 'blob' header on the same channel (integrity via the header's SHA-256).
// ---------------------------------------------------------------------------

type Message =
  | {t: 'hello'; connectedAt: number; engineFailed: boolean}
  | {t: 'command'; cmd: Command; forwarded?: boolean}
  | {t: 'view'; view: ViewState; version: number}
  | {t: 'blob'; id: number; bytes: number; hash: string}

interface Envelope {
  data: string
  from: string
  sig: string
}

// ---------------------------------------------------------------------------

export interface RosterEntry {
  peerId: string
  connectedAt: number
  isSelf: boolean
  isCentral: boolean
  engineFailed: boolean
}

export interface Snapshot {
  selfId: string
  connectedAt: number
  centralId: string | null
  amCentral: boolean
  roster: RosterEntry[]
  view: ViewState
  version: number
  samples: Points | null
  /** True when `samples` is the set the current view refers to. */
  samplesSynced: boolean
}

const ANNOUNCE_INTERVAL_MS = 5000
const ROOM_ID = 'default'
// A connection attempt that hasn't opened after this long is torn down and
// retried on the peer's next announcement. Signaling events are ephemeral, so
// an offer published before the other side was listening is simply lost —
// without a retry the pair would deadlock forever.
const CONNECT_RETRY_MS = 15000
// Wait for discovery before assuming we're the first (and therefore central)
// peer, to avoid booting an engine just to resign seconds later.
const INITIAL_ELECTION_DELAY_MS = 4000

// Shared sampling movie (mirrors the original figure's constants).
const MOVIE_STEP_MS = 750
const MOVIE_LAST_INDEX = 41

interface Connection {
  peer: Peer
  /** When this connection attempt started (local clock), for retry pacing. */
  createdAt: number
  connectedAt: number | null // self-reported timestamp from the remote peer
  engineFailed: boolean
  /** Serializes everything we send on this channel (JSON + blob chunks). */
  sendChain: Promise<void>
  /** Serializes inbound processing too: envelope verification is async, and a
   *  blob header must finish verifying (arming `recv`) before the binary
   *  chunks right behind it are handled. */
  recvChain: Promise<void>
  /** Blob transfer in progress from this peer, if any. */
  recv: BlobReceiver | null
}

export class Network {
  private nostr = new Nostr()
  private root = ''
  private connections = new Map<string, Connection>()

  private connectedAt = Date.now()
  private view: ViewState = initialView()
  private version = 0

  // The current sample set (kept by every peer, so any of them can serve it
  // if it becomes central).
  private samples: Points | null = null
  private samplesBuf: ArrayBuffer | null = null
  private samplesHash: string | null = null
  private samplesLocalId = 0

  // Engine (central peer only).
  private engine: EngineLike | null = null
  private selfEngineFailed = false
  private pendingCmd: Command | null = null
  private computing = false
  private movieTimer: ReturnType<typeof setInterval> | null = null
  private electionArmed = false

  private snapshot!: Snapshot
  private listeners = new Set<() => void>()

  constructor(private engineFactory: () => EngineLike) {
    this.rebuildSnapshot()
    void this.start()

    setTimeout(() => {
      this.electionArmed = true
      this.recompute()
    }, INITIAL_ELECTION_DELAY_MS)

    window.addEventListener('online', () => {
      // Regaining a connection counts as a reconnect: new timestamp.
      this.connectedAt = Date.now()
      this.broadcast({
        t: 'hello',
        connectedAt: this.connectedAt,
        engineFailed: this.selfEngineFailed
      })
      this.recompute()
    })
  }

  private async start() {
    this.root = await rootTopic(ROOM_ID)

    // Receive WebRTC signaling addressed to us.
    const selfSignalTopic = await peerTopic(this.root, selfId)
    this.nostr.subscribe(selfSignalTopic, (content, from) => {
      if (from === selfId) return
      let signal: Signal
      try {
        signal = JSON.parse(content)
      } catch {
        return
      }
      this.handleSignal(from, signal)
    })

    // Discover peers via announcements on the root topic.
    this.nostr.subscribe(this.root, (content, from) => {
      if (from === selfId) return
      let ann: {peerId?: string}
      try {
        ann = JSON.parse(content)
      } catch {
        return
      }
      if (ann.peerId && ann.peerId === from) this.maybeConnect(from)
    })

    const announce = () =>
      void this.nostr.publish(this.root, JSON.stringify({peerId: selfId}))
    announce()
    setInterval(announce, ANNOUNCE_INTERVAL_MS)
  }

  // ---- connection setup -------------------------------------------------

  private maybeConnect(peerId: string) {
    if (peerId === selfId) return
    const existing = this.connections.get(peerId)
    if (existing) {
      const stalled =
        !existing.peer.isConnected &&
        Date.now() - existing.createdAt > CONNECT_RETRY_MS
      if (!stalled) return
      // destroy() fires the close handler, which removes it from the map.
      existing.peer.destroy()
      this.connections.delete(peerId)
    }
    // Deterministic initiator: the peer with the smaller ID makes the offer.
    const initiator = selfId < peerId
    this.createPeer(peerId, initiator)
  }

  private createPeer(peerId: string, initiator: boolean): Connection {
    const peer = new Peer(initiator)
    const conn: Connection = {
      peer,
      createdAt: Date.now(),
      connectedAt: null,
      engineFailed: false,
      sendChain: Promise.resolve(),
      recvChain: Promise.resolve(),
      recv: null
    }
    this.connections.set(peerId, conn)

    peer.setHandlers({
      signal: signal => {
        void this.sendSignal(peerId, signal)
      },
      connect: () => {
        // Tell the new peer our self-reported connect time; if we're central,
        // sync it immediately (blob first, then the view that references it —
        // the chain keeps that order on the wire).
        this.sendTo(peerId, {
          t: 'hello',
          connectedAt: this.connectedAt,
          engineFailed: this.selfEngineFailed
        })
        if (this.snapshot.amCentral) {
          this.sendBlobTo(conn)
          this.sendViewTo(conn)
        }
        this.recompute()
      },
      data: raw => {
        conn.recvChain = conn.recvChain
          .then(() => this.handleData(peerId, raw))
          .catch(() => {})
      },
      binary: chunk => {
        conn.recvChain = conn.recvChain
          .then(() => this.handleBinary(peerId, chunk))
          .catch(() => {})
      },
      close: () => {
        if (this.connections.get(peerId)?.peer === peer) {
          this.connections.delete(peerId)
          this.recompute()
        }
      }
    })

    return conn
  }

  private async sendSignal(peerId: string, signal: Signal) {
    const topic = await peerTopic(this.root, peerId)
    void this.nostr.publish(topic, JSON.stringify(signal))
  }

  private handleSignal(from: string, signal: Signal) {
    let conn = this.connections.get(from)
    if (!conn) {
      if (signal.type !== 'offer') return // nothing to attach it to yet
      conn = this.createPeer(from, false)
    }
    void conn.peer.signal(signal)
  }

  // ---- sending ------------------------------------------------------------

  private async envelope(msg: Message): Promise<string> {
    const data = JSON.stringify(msg)
    const sig = await sign(data)
    const env: Envelope = {data, from: selfId, sig}
    return JSON.stringify(env)
  }

  /** Queue a send task on a connection; tasks run strictly in order. */
  private chain(conn: Connection, task: () => Promise<void> | void) {
    conn.sendChain = conn.sendChain.then(task).catch(() => {})
  }

  private sendTo(peerId: string, msg: Message) {
    const conn = this.connections.get(peerId)
    if (!conn) return
    const payload = this.envelope(msg)
    this.chain(conn, async () => conn.peer.send(await payload))
  }

  private broadcast(msg: Message) {
    const payload = this.envelope(msg) // sign once, share across connections
    for (const conn of this.connections.values()) {
      this.chain(conn, async () => conn.peer.send(await payload))
    }
  }

  private broadcastView() {
    this.version++
    this.broadcast({t: 'view', view: this.view, version: this.version})
    this.rebuildSnapshot()
  }

  private sendViewTo(conn: Connection) {
    const payload = this.envelope({t: 'view', view: this.view, version: this.version})
    this.chain(conn, async () => conn.peer.send(await payload))
  }

  /** Stream the current sample blob to one connection: signed header, then the
   *  raw chunks. */
  private sendBlobTo(conn: Connection) {
    const buf = this.samplesBuf
    const hash = this.samplesHash
    const id = this.samplesLocalId
    if (!buf || !hash) return
    const header = this.envelope({t: 'blob', id, bytes: buf.byteLength, hash})
    this.chain(conn, async () => {
      conn.peer.send(await header)
      await conn.peer.sendBinary(buf)
    })
  }

  /** Adopt a fresh sample set (central only) and stream it to everyone. The
   *  caller broadcasts the updated view afterwards. */
  private async setSamples(samples: Points) {
    this.samples = samples
    this.samplesBuf = encodeSamples(samples)
    this.samplesHash = await sha256HexBytes(this.samplesBuf)
    this.samplesLocalId = ++this.view.samplesId
    this.view.samplesN = Math.min(samples.x.length, samples.y.length)
    for (const conn of this.connections.values()) this.sendBlobTo(conn)
  }

  // ---- receiving ----------------------------------------------------------

  private async handleData(from: string, raw: string) {
    let env: Envelope
    try {
      env = JSON.parse(raw)
    } catch {
      return
    }
    // The envelope must be signed by the peer we received it from.
    if (env.from !== from) return
    if (!(await verify(env.data, env.sig, env.from))) return

    let msg: Message
    try {
      msg = JSON.parse(env.data)
    } catch {
      return
    }

    switch (msg.t) {
      case 'hello': {
        const conn = this.connections.get(from)
        if (conn) {
          conn.connectedAt = msg.connectedAt
          conn.engineFailed = !!msg.engineFailed
          this.recompute()
        }
        break
      }
      case 'command': {
        if (this.snapshot.amCentral) {
          this.acceptCommand(msg.cmd)
        } else if (!msg.forwarded) {
          // Not central; forward once toward the central peer.
          const central = this.snapshot.centralId
          if (central && this.connections.has(central)) {
            this.sendTo(central, {...msg, forwarded: true})
          }
        }
        break
      }
      case 'view': {
        // Only trust state from the current central peer.
        if (from === this.snapshot.centralId && !this.snapshot.amCentral) {
          this.view = msg.view
          this.version = msg.version
          this.rebuildSnapshot()
        }
        break
      }
      case 'blob': {
        if (from !== this.snapshot.centralId || this.snapshot.amCentral) break
        const conn = this.connections.get(from)
        if (conn) conn.recv = new BlobReceiver(msg.id, msg.bytes, msg.hash)
        break
      }
    }
  }

  private handleBinary(from: string, chunk: ArrayBuffer) {
    const conn = this.connections.get(from)
    if (!conn?.recv) return
    const buf = conn.recv.append(chunk)
    if (!buf) return
    const recv = conn.recv
    conn.recv = null
    void this.adoptBlob(recv, buf)
  }

  private async adoptBlob(recv: BlobReceiver, buf: ArrayBuffer) {
    if ((await sha256HexBytes(buf)) !== recv.hash) return
    if (this.samples && recv.id <= this.samplesLocalId) return // stale
    this.samples = decodeSamples(buf)
    this.samplesBuf = buf
    this.samplesHash = recv.hash
    this.samplesLocalId = recv.id
    this.rebuildSnapshot()
  }

  // ---- central-peer election -------------------------------------------

  /** All peers we know about, with a reported connect time, plus ourselves. */
  private participants(): {
    peerId: string
    connectedAt: number
    engineFailed: boolean
  }[] {
    const list = [
      {peerId: selfId, connectedAt: this.connectedAt, engineFailed: this.selfEngineFailed}
    ]
    for (const [peerId, conn] of this.connections) {
      if (conn.peer.isConnected && conn.connectedAt !== null) {
        list.push({
          peerId,
          connectedAt: conn.connectedAt,
          engineFailed: conn.engineFailed
        })
      }
    }
    return list
  }

  /** The oldest peer (smallest connect time; ties broken by peer ID) whose
   *  engine hasn't failed is central. If every engine failed, fall back to the
   *  oldest overall so the room still has an authority for its state. */
  private centralId(): string | null {
    const list = this.participants()
    if (list.length === 0) return null
    const healthy = list.filter(p => !p.engineFailed)
    const pool = healthy.length > 0 ? healthy : list
    return pool.reduce((oldest, p) =>
      p.connectedAt < oldest.connectedAt ||
      (p.connectedAt === oldest.connectedAt && p.peerId < oldest.peerId)
        ? p
        : oldest
    ).peerId
  }

  private recompute() {
    const wasCentral = this.snapshot?.amCentral ?? false
    this.rebuildSnapshot()
    if (!this.electionArmed) return
    const isCentral = this.snapshot.amCentral
    if (isCentral && !this.engine && !this.selfEngineFailed) {
      void this.becomeCentral()
    } else if (!isCentral && wasCentral) {
      this.resignCentral()
    }
  }

  // ---- central role: engine lifecycle ------------------------------------

  private async becomeCentral() {
    this.stopMovieTicker()
    this.view = {
      ...this.view,
      busy: false,
      movieStep: null,
      engine: 'starting',
      engineError: null
    }
    this.broadcastView()

    const engine = this.engineFactory()
    this.engine = engine
    try {
      const init = await engine.start()
      if (this.engine !== engine) return // resigned while booting
      const held = this.samples
      if (!held || !this.view.region) {
        // Fresh room — or we never received the previous central's samples
        // (it died mid-transfer), in which case the inherited region can't be
        // served. Adopt the script's initial region + samples.
        this.view.params = {n: init.n, convex: init.convex, local: false}
        this.view.region = init.region
        await this.setSamples(init.samples)
      } else {
        // Reconcile the inherited view with the blob we actually hold (they
        // can differ if the old central died between blob and view). Relabel
        // our blob as the view's current one — ids must never regress.
        this.samplesLocalId = this.view.samplesId
        this.view.samplesN = Math.min(held.x.length, held.y.length)
      }
      this.view = {...this.view, engine: 'ready', engineError: null}
      this.selfEngineFailed = false
      this.broadcastView()
      void this.processCompute()
    } catch (err) {
      if (this.engine !== engine) return
      this.engineFailure(err instanceof Error ? err.message : String(err))
    }
  }

  private resignCentral() {
    this.stopMovieTicker()
    this.engine?.dispose()
    this.engine = null
    this.pendingCmd = null
    this.computing = false
    // Our sample lineage is no longer authoritative; make sure the real
    // central's next blob is accepted even if its ids overlap ours (e.g. two
    // solo-started rooms merging). The samples stay visible until replaced.
    this.samplesLocalId = 0
  }

  /** The engine could not boot or compute. Step down: announce the failure so
   *  the room elects the next-oldest healthy peer, whose last-known state
   *  becomes the source of truth. */
  private engineFailure(message: string) {
    this.engine?.dispose()
    this.engine = null
    this.pendingCmd = null
    this.computing = false
    this.stopMovieTicker()
    this.selfEngineFailed = true
    this.view = {
      ...this.view,
      busy: false,
      movieStep: null,
      engine: 'error',
      engineError: message
    }
    // Still central at this instant, so receivers accept this view; the hello
    // that follows triggers the re-election.
    this.broadcastView()
    this.broadcast({
      t: 'hello',
      connectedAt: this.connectedAt,
      engineFailed: true
    })
    this.recompute()
  }

  // ---- central role: commands --------------------------------------------

  private acceptCommand(cmd: Command) {
    if (cmd.op === 'movie') {
      this.handleMovie(cmd.play)
      return
    }
    if (!this.engine || this.view.engine !== 'ready') return
    // Latest wins: a newer request supersedes one still waiting its turn.
    this.pendingCmd = cmd
    void this.processCompute()
  }

  private async processCompute() {
    if (this.computing) return
    const cmd = this.pendingCmd
    const engine = this.engine
    if (!cmd || !engine || cmd.op === 'movie') return
    this.pendingCmd = null
    if (cmd.op === 'resample' && !this.view.region) return

    this.computing = true
    this.stopMovieTicker()
    this.view = {...this.view, busy: true, movieStep: null}
    this.broadcastView()

    try {
      if (cmd.op === 'resample') {
        const params: Params = {...this.view.params, n: cmd.n, local: cmd.local}
        const r = await engine.resample({params, region: this.view.region!})
        if (this.engine !== engine) return
        this.view.params = {...params, n: r.n}
        await this.setSamples(r.samples)
      } else {
        const params: Params = {n: cmd.n, convex: cmd.convex, local: cmd.local}
        const r = await engine.newRegion({params})
        if (this.engine !== engine) return
        this.view.params = {...params, n: r.n, convex: r.convex}
        this.view.region = r.region
        await this.setSamples(r.samples)
      }
      this.view = {...this.view, busy: false}
      this.broadcastView()
    } catch (err) {
      if (this.engine === engine) {
        this.engineFailure(err instanceof Error ? err.message : String(err))
      }
      return
    } finally {
      this.computing = false
    }
    if (this.pendingCmd) void this.processCompute()
  }

  // ---- central role: the shared movie --------------------------------------

  private handleMovie(play: boolean) {
    if (!play) {
      this.stopMovieTicker()
      if (this.view.movieStep !== null) {
        this.view = {...this.view, movieStep: null}
        this.broadcastView()
      }
      return
    }
    if (this.view.busy || this.view.movieStep !== null || this.view.samplesN < 3) {
      return
    }
    const lastIndex = Math.min(this.view.samplesN - 1, MOVIE_LAST_INDEX)
    this.view = {...this.view, movieStep: 2}
    this.broadcastView()
    this.movieTimer = setInterval(() => {
      const next = (this.view.movieStep ?? lastIndex) + 1
      if (next > lastIndex) {
        this.stopMovieTicker()
        this.view = {...this.view, movieStep: null}
      } else {
        this.view = {...this.view, movieStep: next}
      }
      this.broadcastView()
    }, MOVIE_STEP_MS)
  }

  private stopMovieTicker() {
    if (this.movieTimer !== null) clearInterval(this.movieTimer)
    this.movieTimer = null
  }

  // ---- public API -------------------------------------------------------

  dispatch(cmd: Command) {
    if (this.snapshot.amCentral) {
      this.acceptCommand(cmd)
    } else {
      const central = this.snapshot.centralId
      if (central && this.connections.has(central)) {
        this.sendTo(central, {t: 'command', cmd})
      }
    }
  }

  getSnapshot = (): Snapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private rebuildSnapshot() {
    const centralId = this.centralId()
    const roster: RosterEntry[] = this.participants()
      .map(p => ({
        peerId: p.peerId,
        connectedAt: p.connectedAt,
        isSelf: p.peerId === selfId,
        isCentral: p.peerId === centralId,
        engineFailed: p.engineFailed
      }))
      .sort((a, b) => a.connectedAt - b.connectedAt)

    this.snapshot = {
      selfId,
      connectedAt: this.connectedAt,
      centralId,
      amCentral: centralId === selfId,
      roster,
      view: this.view,
      version: this.version,
      samples: this.samples,
      samplesSynced: this.samples !== null && this.samplesLocalId === this.view.samplesId
    }
    for (const l of this.listeners) l()
  }
}
