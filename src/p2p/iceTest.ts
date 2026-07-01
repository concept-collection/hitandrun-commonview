// A one-shot ICE self-test: gather candidates on a throwaway connection and
// report what this browser can produce. Zero candidates means WebRTC is being
// blocked (privacy extension / browser policy) and no peer connection can ever
// form — the UI surfaces that instead of failing silently.

import {ICE_SERVERS} from './peer'

export interface IceTestResult {
  total: number
  host: boolean
  srflx: boolean
  relay: boolean
}

export const runIceTest = (ms = 6000): Promise<IceTestResult> =>
  new Promise(resolve => {
    const res: IceTestResult = {total: 0, host: false, srflx: false, relay: false}
    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({iceServers: ICE_SERVERS})
    } catch {
      resolve(res)
      return
    }
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        pc.close()
      } catch {
        /* ignore */
      }
      resolve(res)
    }
    const timer = setTimeout(done, ms)
    pc.onicecandidate = e => {
      if (!e.candidate) {
        done()
        return
      }
      res.total++
      const c = e.candidate.candidate
      if (c.includes(' typ host')) res.host = true
      if (c.includes(' typ srflx')) res.srflx = true
      if (c.includes(' typ relay')) res.relay = true
    }
    pc.createDataChannel('icetest')
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .catch(done)
  })
