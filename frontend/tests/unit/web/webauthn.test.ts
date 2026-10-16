import { describe, expect, it } from 'vitest'
import {
  bytesToB64url,
  encodeAssertion,
  encodeAttestation,
  toCreationOptions,
  toRequestOptions,
} from '@/web/api/webauthn'

const bytes = (v: BufferSource | undefined) =>
  Array.from(v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array((v as ArrayBufferView).buffer))

const buf = (...n: number[]) => new Uint8Array(n).buffer

describe('web/api/webauthn', () => {
  it('[covers:web-webauthn.creation-options-decoded] base64url の各項目を ArrayBuffer にする', () => {
    const opts = toCreationOptions({
      publicKey: {
        challenge: 'AQID',
        rp: { id: 'localhost', name: 'kakeiboot' },
        user: { id: 'BAUG', name: 'n', displayName: 'd' },
        excludeCredentials: [{ id: 'BwgJ', type: 'public-key' }],
      },
    })
    expect(bytes(opts.challenge)).toEqual([1, 2, 3])
    expect(bytes(opts.user.id)).toEqual([4, 5, 6])
    expect(bytes(opts.excludeCredentials![0]!.id)).toEqual([7, 8, 9])
    expect(opts.user.name).toBe('n')
    expect(opts.rp).toEqual({ id: 'localhost', name: 'kakeiboot' })
  })

  it('[covers:web-webauthn.request-options-decoded] challenge と allowCredentials を変換', () => {
    const opts = toRequestOptions({
      publicKey: { challenge: 'AQID', allowCredentials: [{ id: 'BwgJ', type: 'public-key' }] },
    })
    expect(bytes(opts.challenge)).toEqual([1, 2, 3])
    expect(bytes(opts.allowCredentials![0]!.id)).toEqual([7, 8, 9])
  })

  it('[covers:web-webauthn.credential-encoded] 作成・認証結果を base64url の JSON にする', () => {
    const att = encodeAttestation({
      id: 'x',
      rawId: buf(1, 2, 3),
      type: 'public-key',
      response: { attestationObject: buf(255, 254), clientDataJSON: buf(4) },
      getClientExtensionResults: () => ({}),
    })
    expect(att).toEqual({
      id: 'x',
      rawId: 'AQID',
      type: 'public-key',
      response: { attestationObject: '__4', clientDataJSON: 'BA' },
      extensions: {},
    })
    const asr = encodeAssertion({
      id: 'x',
      rawId: buf(1, 2, 3),
      type: 'public-key',
      response: { authenticatorData: buf(1), clientDataJSON: buf(2), signature: buf(3), userHandle: null },
    })
    expect(asr.response).toEqual({ authenticatorData: 'AQ', clientDataJSON: 'Ag', signature: 'Aw', userHandle: null })
    expect(bytesToB64url(new Uint8Array([251, 255]))).toBe('-_8')
  })
})
