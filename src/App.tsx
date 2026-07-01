import {useEffect, useState, type CSSProperties} from 'react'
import {RegionView, type Segment, type Pt} from './render/RegionView'
import {useNetwork} from './useNetwork'
import {runIceTest, type IceTestResult} from './p2p/iceTest'
import type {Points} from './types'

// Discrete sample-count choices; the slider indexes into the active array.
// Capped at 100k: every resample fans the samples out from the central peer to
// every viewer over WebRTC (~800 KB as Float32 at 100k).
const SAMPLE_CHOICES = [10, 100, 1000, 10000, 100000]
// Non-convex sampling runs in the interpreter (no JIT), so cap it lower.
const SAMPLE_CHOICES_NONCONVEX = [10, 100, 1000, 10000]

/** The in-region segment(s) hit-and-run samples along: the line through
 *  (px,py) with direction (dx,dy), intersected with the polygon. One segment
 *  for a convex region, possibly several for a non-convex one. With `localOnly`
 *  it keeps just the segment containing the current point (t = 0) — matching the
 *  sampler's local-segment mode. Mirrors the sampler's geometry, so it
 *  reproduces each step exactly. */
function regionSegments(
  region: Points,
  px: number,
  py: number,
  dx: number,
  dy: number,
  localOnly: boolean
): Segment[] {
  if (Math.hypot(dx, dy) < 1e-12) return []
  const m = region.x.length
  const ts: number[] = []
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m
    const ex = region.x[j] - region.x[i]
    const ey = region.y[j] - region.y[i]
    const denom = dy * ex - dx * ey
    if (Math.abs(denom) < 1e-12) continue
    const wx = region.x[i] - px
    const wy = region.y[i] - py
    const s = (dx * wy - dy * wx) / denom // position along the edge
    if (s >= 0 && s < 1) ts.push((wy * ex - wx * ey) / denom)
  }
  ts.sort((a, b) => a - b)
  const segs: Segment[] = []
  for (let k = 0; k < ts.length - 1; k++) {
    const tm = (ts[k] + ts[k + 1]) / 2
    if (!pointInPolygon(region, px + tm * dx, py + tm * dy)) continue
    // Local mode: keep only the in-region interval straddling t = 0.
    if (localOnly && !(ts[k] <= 0 && ts[k + 1] >= 0)) continue
    segs.push({
      x0: px + ts[k] * dx,
      y0: py + ts[k] * dy,
      x1: px + ts[k + 1] * dx,
      y1: py + ts[k + 1] * dy
    })
  }
  return segs
}

function pointInPolygon(region: Points, x: number, y: number): boolean {
  const n = region.x.length
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = region.x[i]
    const yi = region.y[i]
    const xj = region.x[j]
    const yj = region.y[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

const prefixPoints = (p: Points, k: number): Points => ({
  x: p.x.slice(0, k),
  y: p.y.slice(0, k)
})

const short = (id: string) => id.slice(0, 8) + '…'

export default function App() {
  const {snapshot, dispatch} = useNetwork()
  const {view, samples, samplesSynced, roster, amCentral, centralId, selfId} =
    snapshot
  const {params, region, busy, engine, engineError, movieStep} = view

  // Slider position: local while dragging, following the shared value
  // otherwise (a remote viewer may move it).
  const [n, setN] = useState(params.n)
  useEffect(() => setN(params.n), [params.n])

  // One-shot WebRTC self-test, so a browser that blocks ICE says so instead of
  // silently never finding peers.
  const [ice, setIce] = useState<IceTestResult | null>(null)
  useEffect(() => {
    let alive = true
    void runIceTest().then(r => {
      if (alive) setIce(r)
    })
    return () => {
      alive = false
    }
  }, [])

  const nonConvex = !params.convex
  const choices = nonConvex ? SAMPLE_CHOICES_NONCONVEX : SAMPLE_CHOICES
  const useLocal = nonConvex && params.local
  const moviePlaying = movieStep !== null

  const controlsDisabled = !region || busy || moviePlaying || engine !== 'ready'

  const resample = (count: number, localMode: boolean = params.local) => {
    dispatch({op: 'resample', n: count, local: localMode})
  }

  const newRegion = (count: number, convex: boolean) => {
    dispatch({op: 'newRegion', n: count, convex, local: params.local})
  }

  // Checkbox: switch region type. Clamp N to the active set's max first.
  const setNonConvex = (makeNonConvex: boolean) => {
    const c = makeNonConvex ? SAMPLE_CHOICES_NONCONVEX : SAMPLE_CHOICES
    const clamped = Math.min(n, c[c.length - 1])
    setN(clamped)
    newRegion(clamped, !makeNonConvex)
  }

  // Overlay for the current movie frame (settled points + segments + marks).
  // movieStep is shared state driven by the central peer's clock, so every
  // viewer sees the same frame; the geometry is recomputed locally from the
  // same samples, so it is identical everywhere.
  let cloud: Points = samples ?? {x: [], y: []}
  let segments: Segment[] | null = null
  let from: Pt | null = null
  let newPoint: Pt | null = null
  if (moviePlaying && samples && region && movieStep >= 2) {
    const i = Math.min(movieStep, samples.x.length - 1) // point being sampled
    const f = i - 1 // point the step starts from
    const {x, y} = samples
    cloud = prefixPoints(samples, i) // settled points 0..i-1
    from = {x: x[f], y: y[f]}
    segments = regionSegments(region, x[f], y[f], x[i] - x[f], y[i] - y[f], useLocal)
    newPoint = {x: x[i], y: y[i]}
  }

  const canPlay = !!samples && samples.x.length >= 3 && engine === 'ready'

  const status = busy
    ? 'sampling…'
    : moviePlaying
      ? `movie · point ${movieStep + 1}`
      : !samplesSynced && samples
        ? 'syncing samples…'
        : `${params.n.toLocaleString()} points`

  const engineLabel =
    engine === 'ready'
      ? amCentral
        ? 'engine running here'
        : 'engine on central peer'
      : engine === 'starting'
        ? 'starting engine…'
        : engine === 'error'
          ? 'engine failed'
          : 'waiting for a central peer…'

  const waitingMessage =
    engine === 'starting'
      ? 'The central peer is starting the sampling engine…'
      : engine === 'error'
        ? `Engine failed: ${engineError ?? 'unknown error'}`
        : 'Connecting to the room…'

  return (
    <div style={rootStyle}>
      {region && samples ? (
        <RegionView
          region={region}
          samples={cloud}
          segments={segments}
          from={from}
          newPoint={newPoint}
        />
      ) : (
        <div style={waitingStyle}>{waitingMessage}</div>
      )}

      <div style={panelStyle}>
        <label style={labelStyle}>
          Samples: <b>{n.toLocaleString()}</b>
          <input
            type="range"
            min={0}
            max={choices.length - 1}
            step={1}
            value={Math.max(0, choices.indexOf(n))}
            disabled={controlsDisabled}
            // Drag updates the label live; the round-trip to the central
            // peer's engine fires on release to avoid flooding it.
            onChange={e => setN(choices[Number(e.target.value)])}
            onPointerUp={e => resample(choices[Number(e.currentTarget.value)])}
            onKeyUp={e => {
              if (e.key.startsWith('Arrow')) {
                resample(choices[Number(e.currentTarget.value)])
              }
            }}
            style={sliderStyle}
          />
        </label>

        <div style={{display: 'flex', gap: 6, marginTop: 6}}>
          <button
            style={btnStyle}
            disabled={controlsDisabled}
            onClick={() => resample(n)}
            title="Draw a fresh set of samples in the same region (for everyone)"
          >
            Resample
          </button>
          <button
            style={btnStyle}
            disabled={busy || moviePlaying || engine !== 'ready'}
            onClick={() => newRegion(n, !nonConvex)}
            title="Generate a new region and sample it (for everyone)"
          >
            New region
          </button>
        </div>

        <label style={checkLabelStyle}>
          <input
            type="checkbox"
            checked={nonConvex}
            disabled={controlsDisabled}
            onChange={e => setNonConvex(e.target.checked)}
          />
          non-convex region
        </label>

        {nonConvex && (
          <label
            style={subCheckLabelStyle}
            title="Sample only the segment through the current point instead of every segment the line crosses"
          >
            <input
              type="checkbox"
              checked={params.local}
              disabled={controlsDisabled}
              onChange={e => resample(n, e.target.checked)}
            />
            local segment only
          </label>
        )}

        <button
          style={playBtnStyle}
          disabled={(!canPlay || busy) && !moviePlaying}
          onClick={() => dispatch({op: 'movie', play: !moviePlaying})}
          title="Animate the hit-and-run steps for every viewer at once"
        >
          {moviePlaying ? '■ Stop movie' : '▶ Play movie'}
        </button>

        <div style={{fontSize: 10, color: '#64748b', marginTop: 6}}>{status}</div>
      </div>

      <div style={presenceStyle}>
        <div style={{fontWeight: 600, marginBottom: 2}}>
          {roster.length} viewer{roster.length === 1 ? '' : 's'} · shared view
        </div>
        <div>
          you: <code>{short(selfId)}</code>
          {amCentral ? ' (central)' : ''}
        </div>
        <div>
          central: <code>{centralId ? short(centralId) : '(none)'}</code>
        </div>
        <div style={{color: engine === 'error' ? '#b91c1c' : '#475569'}}>
          {engineLabel}
        </div>
        {engine === 'error' && engineError && (
          <div style={{color: '#b91c1c', marginTop: 2}}>{engineError}</div>
        )}
        {ice &&
          (ice.total === 0 ? (
            <div style={{color: '#b91c1c', marginTop: 2}}>
              ⚠ this browser is blocking WebRTC (no ICE candidates) — check
              privacy extensions/settings
            </div>
          ) : (
            <div style={{color: '#94a3b8'}}>
              webrtc: {ice.total} candidate{ice.total === 1 ? '' : 's'} (
              {[
                ice.host && 'host',
                ice.srflx && 'srflx',
                ice.relay && 'relay'
              ]
                .filter(Boolean)
                .join(', ') || 'other'}
              )
            </div>
          ))}
      </div>
    </div>
  )
}

const rootStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  background: '#ffffff',
  fontFamily: 'system-ui, -apple-system, Arial, sans-serif'
}

const waitingStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#94a3b8',
  padding: '0 2rem',
  textAlign: 'center'
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  width: 150,
  padding: '7px 9px',
  background: 'rgba(255,255,255,0.9)',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  color: '#0f172a'
}

const presenceStyle: CSSProperties = {
  position: 'absolute',
  bottom: 8,
  left: 8,
  padding: '6px 9px',
  background: 'rgba(255,255,255,0.9)',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  color: '#0f172a',
  fontSize: 10,
  lineHeight: 1.5,
  maxWidth: 260
}

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 11
}

const checkLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 11,
  marginTop: 8,
  cursor: 'pointer'
}

const subCheckLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 10,
  marginTop: 4,
  marginLeft: 14,
  color: '#475569',
  cursor: 'pointer'
}

const sliderStyle: CSSProperties = {
  width: '100%',
  marginTop: 2
}

const btnStyle: CSSProperties = {
  flex: 1,
  padding: '3px 4px',
  fontSize: 10,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  background: '#f8fafc',
  border: '1px solid #cbd5e1',
  borderRadius: 5,
  color: '#0f172a'
}

const playBtnStyle: CSSProperties = {
  width: '100%',
  marginTop: 6,
  padding: '4px 6px',
  fontSize: 10,
  cursor: 'pointer',
  background: '#eff6ff',
  border: '1px solid #bfdbfe',
  borderRadius: 5,
  color: '#1e3a8a'
}
