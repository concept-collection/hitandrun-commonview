# CLAUDE.md

Tips for future agents working in this repo. It combines the sibling projects
`commonview` (p2p shared state; central-peer authority) and
`hitandrun-interactive` (the figure + MATLAB sampler), so read those first —
this file only covers what is different here.

## Architecture

```
src/p2p/       identity, nostr discovery, WebRTC peer  — ported from commonview
  network.ts   the heart: shared ViewState + sample blobs + central election
  blob.ts      Float32 codec + chunk reassembly for the sample sets
src/engine/    the numbl runtime, run ONLY by the central peer
  numbl.worker.ts  executeCode against an in-memory VFS; uihtml intercepted
  engine.ts        host wrapper: start/resample/newRegion with timeouts
  project.ts       ?raw imports of matlab/*.m (verbatim from hitandrun-interactive)
src/App.tsx    the figure UI (controls dispatch p2p commands, not sendToMATLAB)
src/render/    RegionView canvas — verbatim from hitandrun-interactive
matlab/        the .m files — DO NOT EDIT here; they are copies (see below)
```

## Key design decisions

- **Two-part state.** The small JSON "view" (params, region, busy/engine
  status, movie step, `samplesId`) is broadcast on every change. The samples
  are a Float32 blob announced by a signed header (`{t:'blob', id, bytes,
  hash}`) followed by raw 64 KB binary chunks. All sends to a given peer go
  through a per-connection promise chain, so on the ordered data channel a
  blob always lands before the view that references it.
- **Engine only on central.** `Network` takes an engine factory; it boots one
  when it becomes central (after a 4 s discovery grace period at startup) and
  disposes it on resignation. The initial run's region/samples are adopted
  only if the room has no state yet — a failover central keeps the inherited
  region (the script is stateless; resample requests carry the region).
- **Engine failure = step-down.** Boot errors, callback errors, and timeouts
  (60 s compute / 120 s start) mark the peer `engineFailed`; hellos carry the
  flag and the election skips failed peers (falling back to oldest-overall so
  the room never loses its state authority). The flag clears only on a
  successful later boot or a reload.
- **Shared movie.** The central peer ticks `movieStep` every 750 ms and
  broadcasts; the chord geometry is recomputed per-viewer from the same
  Float32 samples, so every frame is identical everywhere.
- **numbl comes from npm** (`>= 0.4.8`, which added the browser-embedding
  exports: `VirtualFileSystem`, `BrowserFileIOAdapter`, `BrowserSystemAdapter`,
  `UihtmlSession`). No COOP/COEP / SharedArrayBuffer needed: the script never
  calls `input()`, and no qhull/convhull (make_region avoids convhull
  deliberately).

## The matlab/ copies

`matlab/**/*.m` are verbatim copies from `hitandrun-interactive` (plus a
placeholder served as `app/dist/index.html`, which the sampler `fileread`s for
its uihtml HTMLSource — never rendered). If the upstream figure protocol
changes (`resample`/`newRegion` events, payload shapes), re-copy the files and
revisit `src/engine/engine.ts`.

## Testing

- Headless engine check (no browser): run the script + uihtml round-trip in
  Node against the installed numbl — see the "engine-test" pattern in git
  history / ask the user. `executeCode` is platform-agnostic.
- Full check: `npm run dev`, open in two different browser **profiles** (same
  profile = same localStorage key = same peer). Kill the central tab to test
  failover.
- `npm run build` type-checks (`tsc -b`) and bundles; the numbl worker chunk
  is ~1.5 MB.
