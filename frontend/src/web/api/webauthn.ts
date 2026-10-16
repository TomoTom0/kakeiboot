// Browser WebAuthn glue between webauthn-rs JSON (base64url binary fields)
// and navigator.credentials (ArrayBuffer fields). spec_auth.md 2-3, 2-4, 2-6.

export function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface JsonDescriptor {
  id: string
  type: string
  transports?: string[]
}

/** webauthn-rs CreationChallengeResponse (only the fields we transform). */
export interface CreationChallengeJson {
  publicKey: Record<string, unknown> & {
    challenge: string
    user: { id: string; name: string; displayName: string }
    excludeCredentials?: JsonDescriptor[]
  }
}

/** webauthn-rs RequestChallengeResponse (only the fields we transform). */
export interface RequestChallengeJson {
  publicKey: Record<string, unknown> & {
    challenge: string
    allowCredentials?: JsonDescriptor[]
  }
  mediation?: string
}

function descriptors(list: JsonDescriptor[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((d) => ({
    ...d,
    type: 'public-key' as const,
    id: b64urlToBytes(d.id),
    transports: d.transports as AuthenticatorTransport[] | undefined,
  }))
}

export function toCreationOptions(ccr: CreationChallengeJson): PublicKeyCredentialCreationOptions {
  const pk = ccr.publicKey
  return {
    ...(pk as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64urlToBytes(pk.challenge),
    user: { ...pk.user, id: b64urlToBytes(pk.user.id) },
    excludeCredentials: descriptors(pk.excludeCredentials),
  }
}

export function toRequestOptions(rcr: RequestChallengeJson): PublicKeyCredentialRequestOptions {
  const pk = rcr.publicKey
  return {
    ...(pk as unknown as PublicKeyCredentialRequestOptions),
    challenge: b64urlToBytes(pk.challenge),
    allowCredentials: descriptors(pk.allowCredentials),
  }
}

/** Minimal shape of a PublicKeyCredential we read (eases testing). */
export interface CredentialLike {
  id: string
  rawId: ArrayBuffer
  type: string
  response: unknown
  getClientExtensionResults?: () => unknown
}

export interface AttestationJson {
  id: string
  rawId: string
  type: string
  response: { attestationObject: string; clientDataJSON: string }
  extensions: unknown
}

export interface AssertionJson {
  id: string
  rawId: string
  type: string
  response: {
    authenticatorData: string
    clientDataJSON: string
    signature: string
    userHandle: string | null
  }
  extensions: unknown
}

export function encodeAttestation(cred: CredentialLike): AttestationJson {
  const r = cred.response as { attestationObject: ArrayBuffer; clientDataJSON: ArrayBuffer }
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      attestationObject: bytesToB64url(r.attestationObject),
      clientDataJSON: bytesToB64url(r.clientDataJSON),
    },
    extensions: cred.getClientExtensionResults?.() ?? {},
  }
}

export function encodeAssertion(cred: CredentialLike): AssertionJson {
  const r = cred.response as {
    authenticatorData: ArrayBuffer
    clientDataJSON: ArrayBuffer
    signature: ArrayBuffer
    userHandle: ArrayBuffer | null
  }
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: bytesToB64url(r.authenticatorData),
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      signature: bytesToB64url(r.signature),
      userHandle: r.userHandle ? bytesToB64url(r.userHandle) : null,
    },
    extensions: cred.getClientExtensionResults?.() ?? {},
  }
}

export class PasskeyCancelledError extends Error {
  constructor() {
    super('passkey ceremony cancelled')
    this.name = 'PasskeyCancelledError'
  }
}

/** navigator.credentials.create for a passkey registration. */
export async function createPasskey(ccr: CreationChallengeJson): Promise<AttestationJson> {
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(ccr) })
  if (!cred) throw new PasskeyCancelledError()
  return encodeAttestation(cred as unknown as CredentialLike)
}

/** navigator.credentials.get (modal flow). */
export async function getPasskey(rcr: RequestChallengeJson): Promise<AssertionJson> {
  const cred = await navigator.credentials.get({ publicKey: toRequestOptions(rcr) })
  if (!cred) throw new PasskeyCancelledError()
  return encodeAssertion(cred as unknown as CredentialLike)
}

/** True for user cancel / abort (not worth an error message). */
export function isCancel(e: unknown): boolean {
  if (e instanceof PasskeyCancelledError) return true
  const name = (e as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'NotAllowedError'
}
