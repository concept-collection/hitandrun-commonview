// The MATLAB project the engine runs, bundled into the app as raw text. The
// .m files under matlab/ are verbatim copies from the hitandrun-interactive
// repo (see README). hitandrun_sampler.m does
// `fileread(fullfile('app','dist','index.html'))` for the uihtml HTMLSource;
// we never render that page (the bridge is intercepted host-side), so a
// placeholder satisfies it.

import demo from '../../matlab/hitandrun_demo.m?raw'
import sampler from '../../matlab/hitandrun_sampler.m?raw'
import makeRegion from '../../matlab/helpers/make_region.m?raw'
import hitAndRun from '../../matlab/helpers/hit_and_run.m?raw'
import hitAndRunGeneral from '../../matlab/helpers/hit_and_run_general.m?raw'

export interface ProjectFile {
  path: string
  text: string
}

export const PROJECT_FILES: ProjectFile[] = [
  {path: 'hitandrun_demo.m', text: demo},
  {path: 'hitandrun_sampler.m', text: sampler},
  {path: 'helpers/make_region.m', text: makeRegion},
  {path: 'helpers/hit_and_run.m', text: hitAndRun},
  {path: 'helpers/hit_and_run_general.m', text: hitAndRunGeneral},
  {path: 'app/dist/index.html', text: '<!-- headless: bridge intercepted host-side -->'}
]

export const MAIN_FILE = 'hitandrun_demo.m'
