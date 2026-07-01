// The numbl engine: runs the MATLAB project in this worker and speaks the
// uihtml protocol with the host, with no iframe involved. The script's
// uihtml(...) call surfaces here as a "uihtml" plot instruction (component id +
// initial Data); sendEventToHTMLSource(...) surfaces via onHtmlSourceEvent; and
// host "event" messages re-enter the still-live interpreter through the
// UihtmlSession, firing the script's HTMLEventReceivedFcn.
//
// This mirrors what numbl's own site-viewer worker does, trimmed to a single
// persistent script run.

import {
  executeCode,
  VirtualFileSystem,
  BrowserFileIOAdapter,
  BrowserSystemAdapter,
  type UihtmlSession,
  type PlotInstruction
} from 'numbl'
import type {ToWorker, FromWorker} from './protocol'

const post = (msg: FromWorker) => self.postMessage(msg)

let session: UihtmlSession | null = null

const reportUihtml = (instructions: PlotInstruction[]) => {
  for (const pi of instructions) {
    if (pi.type === 'uihtml') {
      post({type: 'uihtml', compId: pi.id, dataJson: pi.data})
    }
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data

  if (msg.type === 'run') {
    session?.dispose()
    session = null

    const vfs = new VirtualFileSystem()
    const enc = new TextEncoder()
    for (const f of msg.files) vfs.writeFile(f.path, enc.encode(f.text))
    vfs.clearChangeTracking()

    // chdir to the script's directory (project root here) so addpath('helpers')
    // and relative fileread() resolve, mirroring numbl's own worker.
    const mainAbs = vfs.normalizePath(msg.mainFileName)
    const lastSlash = mainAbs.lastIndexOf('/')
    vfs.setCwd(lastSlash > 0 ? mainAbs.slice(0, lastSlash) : '/')

    const workspaceFiles = msg.files
      .filter(f => f.path.endsWith('.m'))
      .map(f => ({name: f.path, source: f.text}))

    try {
      const result = executeCode(
        msg.files.find(f => f.path === msg.mainFileName)?.text ?? '',
        {
          onOutput: text => post({type: 'output', text}),
          onDrawnow: instructions => reportUihtml(instructions),
          displayResults: true,
          maxIterations: 10000000,
          optimization: '1',
          fileIO: new BrowserFileIOAdapter(vfs),
          system: new BrowserSystemAdapter(vfs),
          onHtmlSourceEvent: (compId, name, dataJson) =>
            post({type: 'hostEvent', compId, name, dataJson})
        },
        workspaceFiles,
        mainAbs
      )
      session = result.uihtmlSession ?? null
      reportUihtml(result.plotInstructions)
      post({type: 'runDone', hasSession: session !== null})
    } catch (err) {
      post({
        type: 'runError',
        message: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  if (msg.type === 'event') {
    if (!session) {
      post({type: 'eventError', message: 'no live uihtml session'})
      return
    }
    try {
      session.dispatchEvent(msg.compId, 'HTMLEventReceived', {
        name: msg.name,
        data: msg.data
      })
    } catch (err) {
      post({
        type: 'eventError',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
