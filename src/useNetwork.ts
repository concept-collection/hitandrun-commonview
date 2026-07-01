import {useSyncExternalStore} from 'react'
import {Network, type Command, type Snapshot} from './p2p/network'
import {Engine} from './engine/engine'

// A single Network instance for the whole app (module-level so React StrictMode
// double-mounting doesn't create two peer networks). The engine factory is only
// invoked if/when this peer becomes central.
const network = new Network(() => new Engine())

export const useNetwork = (): {
  snapshot: Snapshot
  dispatch: (cmd: Command) => void
} => {
  const snapshot = useSyncExternalStore(network.subscribe, network.getSnapshot)
  return {snapshot, dispatch: cmd => network.dispatch(cmd)}
}
