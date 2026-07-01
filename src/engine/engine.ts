// Host-side wrapper around the numbl worker. Only the CENTRAL peer creates
// one; everyone else just receives the results through the p2p network.
//
// The wrapper runs hitandrun_demo.m once (which opens the uihtml "figure" —
// intercepted here, never rendered) and then serves compute requests by
// speaking the figure's own event protocol to the script:
//   resample  {n, x, y, convex, local} -> 'samples' event {x, y, n}
//   newRegion {n, convex, local}       -> 'data' event {region, samples, n, convex}
// Timeouts surface as EngineError so the network layer can step down and let
// another peer take over.

import type {Points, Params} from '../types'
import {PROJECT_FILES, MAIN_FILE} from './project'
import type {ToWorker, FromWorker} from './protocol'

const START_TIMEOUT_MS = 120_000
const COMPUTE_TIMEOUT_MS = 60_000

export class EngineError extends Error {}

export interface EngineInit {
  region: Points
  samples: Points
  n: number
  convex: boolean
}

interface HitAndRunData {
  type: string
  region: Points
  samples: Points
  n: number
  convex?: boolean
}

interface SamplesEvent {
  x: number[]
  y: number[]
  n: number
}

// jsonencode collapses 1-element vectors to scalars; normalize.
const asArray = (v: unknown): number[] =>
  Array.isArray(v) ? (v as number[]) : typeof v === 'number' ? [v] : []

const asPoints = (p: {x?: unknown; y?: unknown} | undefined): Points => ({
  x: asArray(p?.x),
  y: asArray(p?.y)
})

export class Engine {
  private worker: Worker | null = null
  private compId: string | null = null
  private initialData: HitAndRunData | null = null
  private runDone = false
  private disposed = false

  // One request at a time; the network layer serializes computes.
  private waiter: {
    event: string
    resolve: (data: unknown) => void
    reject: (err: Error) => void
  } | null = null
  private startWaiter: {
    resolve: (init: EngineInit) => void
    reject: (err: Error) => void
  } | null = null

  /** Boot the worker, run the script, resolve with the initial region+samples. */
  start(): Promise<EngineInit> {
    if (this.worker) throw new EngineError('engine already started')
    this.worker = new Worker(new URL('./numbl.worker.ts', import.meta.url), {
      type: 'module'
    })
    this.worker.onmessage = (e: MessageEvent<FromWorker>) =>
      this.handleMessage(e.data)
    this.worker.onerror = e => {
      this.fail(new EngineError(`worker error: ${e.message || 'unknown'}`))
    }
    this.post({type: 'run', files: PROJECT_FILES, mainFileName: MAIN_FILE})

    return new Promise<EngineInit>((resolve, reject) => {
      this.startWaiter = {resolve, reject}
      this.armTimeout(START_TIMEOUT_MS, 'engine start timed out')
    })
  }

  /** Draw n fresh samples in the given (current) region. */
  async resample(req: {
    params: Params
    region: Points
  }): Promise<{samples: Points; n: number}> {
    const {params, region} = req
    const data = await this.request(
      'resample',
      {n: params.n, x: region.x, y: region.y, convex: params.convex, local: params.local},
      'samples'
    )
    const s = data as SamplesEvent
    return {
      samples: {x: asArray(s.x), y: asArray(s.y)},
      n: typeof s.n === 'number' ? s.n : params.n
    }
  }

  /** Build a brand-new region (convex or not) and sample it. */
  async newRegion(req: {params: Params}): Promise<EngineInit> {
    const {params} = req
    const data = await this.request(
      'newRegion',
      {n: params.n, convex: params.convex, local: params.local},
      'data'
    )
    const d = data as HitAndRunData
    return {
      region: asPoints(d.region),
      samples: asPoints(d.samples),
      n: typeof d.n === 'number' ? d.n : params.n,
      convex: d.convex !== false
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fail(new EngineError('engine disposed'))
  }

  // ---- internals ---------------------------------------------------------

  private timeoutId: ReturnType<typeof setTimeout> | null = null

  private armTimeout(ms: number, message: string) {
    this.clearTimeout()
    this.timeoutId = setTimeout(() => this.fail(new EngineError(message)), ms)
  }

  private clearTimeout() {
    if (this.timeoutId !== null) clearTimeout(this.timeoutId)
    this.timeoutId = null
  }

  private post(msg: ToWorker) {
    this.worker?.postMessage(msg)
  }

  private request(
    name: 'resample' | 'newRegion',
    payload: unknown,
    expectEvent: 'samples' | 'data'
  ): Promise<unknown> {
    if (!this.worker || !this.runDone || !this.compId) {
      return Promise.reject(new EngineError('engine not ready'))
    }
    if (this.waiter) {
      return Promise.reject(new EngineError('engine busy'))
    }
    this.post({type: 'event', compId: this.compId, name, data: payload})
    return new Promise<unknown>((resolve, reject) => {
      this.waiter = {event: expectEvent, resolve, reject}
      this.armTimeout(COMPUTE_TIMEOUT_MS, `'${name}' timed out`)
    })
  }

  /** A hard failure: everything pending rejects and the worker is torn down. */
  private fail(err: EngineError) {
    this.clearTimeout()
    this.worker?.terminate()
    this.worker = null
    this.runDone = false
    const sw = this.startWaiter
    const w = this.waiter
    this.startWaiter = null
    this.waiter = null
    sw?.reject(err)
    w?.reject(err)
  }

  private handleMessage(msg: FromWorker) {
    switch (msg.type) {
      case 'output':
        console.log(`[numbl] ${msg.text.replace(/\n$/, '')}`)
        break

      case 'uihtml': {
        // Track the most recent component; its Data is the initial payload.
        this.compId = msg.compId
        if (msg.dataJson) {
          try {
            this.initialData = JSON.parse(msg.dataJson) as HitAndRunData
          } catch {
            /* ignore malformed */
          }
        }
        this.maybeResolveStart()
        break
      }

      case 'runDone': {
        this.runDone = true
        if (!msg.hasSession || !this.compId) {
          this.fail(new EngineError('script finished without a uihtml session'))
          return
        }
        this.maybeResolveStart()
        break
      }

      case 'runError':
        this.fail(new EngineError(`script error: ${msg.message}`))
        break

      case 'eventError':
        this.fail(new EngineError(`callback error: ${msg.message}`))
        break

      case 'hostEvent': {
        if (!this.waiter || msg.name !== this.waiter.event) break
        const w = this.waiter
        this.waiter = null
        this.clearTimeout()
        try {
          w.resolve(JSON.parse(msg.dataJson))
        } catch (err) {
          w.reject(new EngineError(`bad event payload: ${String(err)}`))
        }
        break
      }
    }
  }

  private maybeResolveStart() {
    if (!this.startWaiter || !this.runDone) return
    if (!this.initialData || this.initialData.type !== 'hitandrun') return
    const d = this.initialData
    const w = this.startWaiter
    this.startWaiter = null
    this.clearTimeout()
    w.resolve({
      region: asPoints(d.region),
      samples: asPoints(d.samples),
      n: typeof d.n === 'number' ? d.n : 10000,
      convex: d.convex !== false
    })
  }
}
