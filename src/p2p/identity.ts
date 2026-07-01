import * as secp from '@noble/secp256k1'

// The peer's identity is a secp256k1 / BIP340 (schnorr) keypair.
// - The x-only public key (hex) IS the peer ID.
// - The private key is persisted in localStorage so the identity survives reloads.
// - The same key signs both nostr events (for relay discovery/signaling) and
//   every application-level message sent over WebRTC.

const STORAGE_KEY = 'hitandrun-commonview:privkey'

const toHex = (bytes: Uint8Array): string =>
  bytes.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const loadOrCreateSecretKey = (): Uint8Array => {
  const existing = localStorage.getItem(STORAGE_KEY)
  if (existing && existing.length === 64) {
    return fromHex(existing)
  }
  const {secretKey} = secp.schnorr.keygen()
  localStorage.setItem(STORAGE_KEY, toHex(secretKey))
  return secretKey
}

const secretKey = loadOrCreateSecretKey()
const publicKey = secp.schnorr.getPublicKey(secretKey)

/** This peer's ID = its x-only public key, as hex. */
export const selfId: string = toHex(publicKey)

const sha256 = async (str: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  )

/** SHA-256 of raw bytes, as hex (used to authenticate binary blobs). */
export const sha256HexBytes = async (bytes: ArrayBuffer): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))

/** Sign an arbitrary string payload; returns hex signature. */
export const sign = async (payload: string): Promise<string> =>
  toHex(await secp.schnorr.signAsync(await sha256(payload), secretKey))

/** Verify a hex signature over a string payload against a peer's ID (pubkey hex). */
export const verify = async (
  payload: string,
  sigHex: string,
  pubkeyHex: string
): Promise<boolean> => {
  try {
    return await secp.schnorr.verifyAsync(
      fromHex(sigHex),
      await sha256(payload),
      fromHex(pubkeyHex)
    )
  } catch {
    return false
  }
}

// ---- nostr event signing (schnorr over the nostr event id) ----

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/** Build and sign a nostr event with this peer's key. */
export const makeNostrEvent = async (
  kind: number,
  tags: string[][],
  content: string
): Promise<NostrEvent> => {
  const created_at = Math.floor(Date.now() / 1000)
  const serialized = JSON.stringify([
    0,
    selfId,
    created_at,
    kind,
    tags,
    content
  ])
  const id = toHex(await sha256(serialized))
  const sig = toHex(await secp.schnorr.signAsync(fromHex(id), secretKey))
  return {id, pubkey: selfId, created_at, kind, tags, content, sig}
}

export {toHex, fromHex}
