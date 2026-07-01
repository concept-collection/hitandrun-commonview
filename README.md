# hitandrun-commonview

One interactive figure, one shared view. This app shows the
[hitandrun-interactive](https://github.com/concept-collection/hitandrun-interactive)
hit-and-run sampling figure — just the figure, no source code — and keeps it
**identical for everyone who has the page open**, in the style of
[commonview](https://github.com/concept-collection/commonview): peers discover
each other over nostr relays and form a WebRTC full mesh; the oldest peer is
the **central** peer and owns the authoritative state.

The twist over commonview's counter: the shared state is a live MATLAB
computation. The central peer — and only the central peer — runs
[numbl](https://numbl.org) (a MATLAB-compatible runtime) in a web worker,
executing the *unmodified* `hitandrun_demo.m` from hitandrun-interactive. The
figure's uihtml bridge is intercepted host-side (no iframe): control changes
from **any** viewer are forwarded to the central peer, which feeds them to the
script and broadcasts the results — parameter selections, the region, and the
samples — to every viewer.

## What is shared

- **Parameters**: sample count, convex/non-convex region, local-segment mode.
- **The region and the samples**: samples travel as a Float32 blob (up to
  100,000 points ≈ 800 KB), streamed in 64 KB chunks over the data channel and
  authenticated by a SHA-256 in a signed header. The JSON "view" message that
  follows it references the blob by id.
- **The sampling movie**: the central peer drives the animation clock, so every
  viewer watches the same step at the same time.

## Graceful failover

- Every message is a signed envelope (schnorr over the peer's key, which *is*
  its ID); state is only trusted from the current central peer.
- Every peer keeps the latest sample blob, so whichever peer becomes central
  can serve it to late joiners.
- If the **central peer leaves**, the next-oldest peer becomes central, boots
  its own engine (viewers see "starting engine…"), and continues from the
  last-known state — the script is stateless (the region rides along with each
  resample request), so any peer's engine can pick up where the last one left
  off.
- If the central peer's **engine fails to boot or to compute** (a timeout
  counts), it announces the failure and steps down; the election skips
  engine-failed peers, and the next-oldest healthy peer takes over.
- State is never persisted: once all peers leave, the room resets.

## Run

```
npm install        # requires numbl >= 0.4.8 on npm (browser-embedding exports)
npm run dev
```

Open the printed URL in **two different browsers or profiles** (two tabs in the
same profile share the same localStorage key, so they'd be the *same* peer).
Drag the samples slider or press "New region" in either window and watch both
update; close the central window and watch the other take over.

## How the engine embedding works

`src/engine/numbl.worker.ts` runs `executeCode` from the `numbl` npm package
against an in-memory filesystem holding the `.m` files (verbatim copies from
hitandrun-interactive, under [matlab/](matlab/)). The script's
`uihtml(...)` call surfaces as a plot instruction carrying the component id and
initial Data; `sendEventToHTMLSource` calls surface via the `onHtmlSourceEvent`
hook; and events from the app re-enter the still-live interpreter through the
`UihtmlSession` returned by `executeCode` — firing the script's
`HTMLEventReceivedFcn` exactly as if the figure page had sent them. The HTML
the script loads for the figure is replaced by a one-line placeholder; nothing
is ever rendered from the worker.
