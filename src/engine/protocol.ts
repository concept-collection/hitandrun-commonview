// Messages between the engine host (main thread) and the numbl worker.

import type {ProjectFile} from './project'

export type ToWorker =
  | {type: 'run'; files: ProjectFile[]; mainFileName: string}
  // An HTML→MATLAB event: fires the script's HTMLEventReceivedFcn.
  | {type: 'event'; compId: string; name: string; data: unknown}

export type FromWorker =
  // A uihtml component was created (or re-shown): its id and initial Data.
  | {type: 'uihtml'; compId: string; dataJson: string | undefined}
  // The script called sendEventToHTMLSource(src, name, data).
  | {type: 'hostEvent'; compId: string; name: string; dataJson: string}
  | {type: 'output'; text: string}
  | {type: 'runDone'; hasSession: boolean}
  | {type: 'runError'; message: string}
  | {type: 'eventError'; message: string}
