// Binary codec for the sample sets. The samples are the big part of the
// shared state (up to 100k points), so instead of riding in the JSON view
// message they travel as a Float32 blob, streamed in chunks over the data
// channel (see Peer.sendBinary) and verified with the SHA-256 announced in the
// signed 'blob' header.

import type {Points} from '../types'

/** Points -> [x0..xn-1, y0..yn-1] as Float32 (plenty for display). */
export const encodeSamples = (p: Points): ArrayBuffer => {
  const n = Math.min(p.x.length, p.y.length)
  const f = new Float32Array(2 * n)
  for (let i = 0; i < n; i++) {
    f[i] = p.x[i]
    f[n + i] = p.y[i]
  }
  return f.buffer
}

export const decodeSamples = (buf: ArrayBuffer): Points => {
  const f = new Float32Array(buf)
  const n = f.length >> 1
  const x = new Array<number>(n)
  const y = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    x[i] = f[i]
    y[i] = f[n + i]
  }
  return {x, y}
}

/** Accumulates the chunks of one announced blob on one connection. The data
 *  channel is ordered, so chunks simply arrive in sequence after the header. */
export class BlobReceiver {
  private parts: Uint8Array[] = []
  private received = 0

  constructor(
    readonly id: number,
    readonly bytes: number,
    readonly hash: string
  ) {}

  /** Append a chunk; returns the assembled buffer once complete, else null. */
  append(chunk: ArrayBuffer): ArrayBuffer | null {
    this.parts.push(new Uint8Array(chunk))
    this.received += chunk.byteLength
    if (this.received < this.bytes) return null
    const out = new Uint8Array(this.bytes)
    let off = 0
    for (const part of this.parts) {
      // Tolerate a final chunk that would overrun (corrupt stream): truncate;
      // the hash check will reject it.
      const take = Math.min(part.length, this.bytes - off)
      out.set(take === part.length ? part : part.subarray(0, take), off)
      off += take
    }
    return out.buffer
  }
}
