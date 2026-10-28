import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, configureHttp, request, requestBlob } from '@/web/api/http'
import { cleanup, mockFetch } from './helpers'

afterEach(() => {
  configureHttp({})
  cleanup()
})

describe('web/api/http request', () => {
  it('[covers:web-http.same-origin-json-request] 相対パス・same-origin・JSON で送る', async () => {
    const f = mockFetch({ 'POST /api/auth/logout-all': { status: 204 } })
    await request('POST', '/api/auth/logout-all', { a: 1 })
    const [path, init] = f.fn.mock.calls[0]!
    expect(path).toBe('/api/auth/logout-all')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init?.body).toBe('{"a":1}')
  })

  it('[covers:web-http.unauthorized-hook] 401 で onUnauthorized を呼び ApiError', async () => {
    mockFetch({ 'GET /api/x': { status: 401, body: { error: 'unauthorized' } } })
    const onUnauthorized = vi.fn()
    configureHttp({ onUnauthorized })
    await expect(request('GET', '/api/x')).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('[covers:web-http.auth-optional-skips-hook] authOptional は 401 でも hook を呼ばない', async () => {
    mockFetch({ 'POST /api/x': { status: 401, body: { error: 'unauthorized' } } })
    const onUnauthorized = vi.fn()
    configureHttp({ onUnauthorized })
    await expect(request('POST', '/api/x', {}, { authOptional: true })).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('[covers:web-http.reauth-retries-once] reauth_required は step-up 後に1回だけ再送', async () => {
    const f = mockFetch({
      'DELETE /api/passkeys/1': [{ status: 401, body: { error: 'reauth_required' } }, { status: 204 }],
    })
    const onReauthRequired = vi.fn(async () => {})
    configureHttp({ onReauthRequired })
    await expect(request('DELETE', '/api/passkeys/1')).resolves.toBeUndefined()
    expect(onReauthRequired).toHaveBeenCalledTimes(1)
    expect(f.fn).toHaveBeenCalledTimes(2)
  })

  it('[covers:web-http.reauth-cancel-throws] step-up 失敗なら再送しない', async () => {
    const f = mockFetch({ 'DELETE /api/passkeys/1': { status: 401, body: { error: 'reauth_required' } } })
    configureHttp({ onReauthRequired: () => Promise.reject(new Error('cancel')) })
    await expect(request('DELETE', '/api/passkeys/1')).rejects.toMatchObject({ code: 'reauth_required' })
    expect(f.fn).toHaveBeenCalledTimes(1)
  })

  it('[covers:web-http.forbidden-error-code] 403 はコード付き ApiError でログインへ送らない', async () => {
    mockFetch({ 'POST /api/x': { status: 403, body: { error: 'origin_mismatch' } } })
    const onUnauthorized = vi.fn()
    configureHttp({ onUnauthorized })
    await expect(request('POST', '/api/x', {})).rejects.toMatchObject({ status: 403, code: 'origin_mismatch' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('[covers:web-http.no-content] 204 は undefined', async () => {
    mockFetch({ 'POST /api/auth/logout': { status: 204 } })
    await expect(request('POST', '/api/auth/logout')).resolves.toBeUndefined()
  })
})

describe('web/api/http requestBlob', () => {
  // TASK-58: the blob download path shares request's error handling exactly
  // (401 step-up retry once, unauthorized hook, ApiError with the JSON error
  // code) — only the success body is a Blob.
  it('[covers:web-settings.data-export-import] 成功時は応答本文を Blob で返す', async () => {
    const f = mockFetch({ 'POST /api/ledgers/3/export': { body: { format: 'kakeiboot-ledger-export' } } })
    const blob = await requestBlob('POST', '/api/ledgers/3/export')
    // mockFetch's Response is Node's (undici), whose blob() builds a
    // node:buffer Blob — a different realm from this environment's global
    // (jsdom) `Blob`, so strict instanceof cannot hold. Assert the Blob
    // surface the export flow consumes (type / size / text) instead.
    expect(blob.type).toBe('application/json')
    const raw = await blob.text()
    expect(blob.size).toBe(raw.length)
    expect(JSON.parse(raw)).toEqual({ format: 'kakeiboot-ledger-export' })
    expect(f.calls[0]!.body).toBeUndefined()
  })

  it('[covers:web-settings.data-export-import] 401 reauth_required は step-up 後に1回だけ再送する', async () => {
    const f = mockFetch({
      'POST /api/ledgers/3/export': [
        { status: 401, body: { error: 'reauth_required' } },
        { body: { format: 'x' } },
      ],
    })
    const onReauthRequired = vi.fn(async () => {})
    configureHttp({ onReauthRequired })
    // same cross-realm note as above: verify the retried response's body
    // via the Blob surface, not instanceof
    const blob = await requestBlob('POST', '/api/ledgers/3/export')
    expect(JSON.parse(await blob.text())).toEqual({ format: 'x' })
    expect(onReauthRequired).toHaveBeenCalledTimes(1)
    expect(f.fn).toHaveBeenCalledTimes(2)
  })

  it('[covers:web-settings.data-export-import] 失敗応答も JSON error code を読み ApiError に載せる', async () => {
    mockFetch({ 'POST /api/ledgers/3/export': { status: 400, body: { error: 'export_too_large' } } })
    await expect(requestBlob('POST', '/api/ledgers/3/export')).rejects.toMatchObject({
      status: 400,
      code: 'export_too_large',
    })
  })
})
