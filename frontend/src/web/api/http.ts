// fetch wrapper for the same-origin backend (spec_auth.md 1, 3-1).
//
// - Requests go to relative paths with credentials=same-origin. The browser
//   attaches the Origin header to same-origin POST/PUT/PATCH/DELETE by itself
//   (Origin is a forbidden header name and cannot be set from script), which
//   is what the backend CSRF guard checks.
// - Bodies are JSON (`/api/*` only accepts application/json).
// - 401 `reauth_required` triggers the step-up hook and the request is sent
//   again once (spec_auth.md 2-6). Any other 401 calls the unauthorized hook
//   (session expired -> login screen) unless the call is `authOptional`.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`api error ${status} ${code}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export interface HttpHooks {
  /** Session missing/expired: the app sends the user to the login screen. */
  onUnauthorized?: () => void
  /** Step-up required: resolves after a successful re-authentication. */
  onReauthRequired?: () => Promise<void>
}

const hooks: HttpHooks = {}

export function configureHttp(next: HttpHooks): void {
  hooks.onUnauthorized = next.onUnauthorized
  hooks.onReauthRequired = next.onReauthRequired
}

export interface RequestOptions {
  /** Pre-login calls (login/register): a 401 is the screen's own result. */
  authOptional?: boolean
  /** Do not run the step-up hook (used by the re-auth ceremony itself). */
  noStepUp?: boolean
}

async function errorCode(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (body && typeof body === 'object' && 'error' in body) {
      const code = (body as { error: unknown }).error
      if (typeof code === 'string') return code
    }
  } catch {
    // non-JSON error body
  }
  return `http_${res.status}`
}

async function send(method: HttpMethod, path: string, body: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  init.headers = headers
  return fetch(path, init)
}

export async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const res = await exchange(method, path, body, options)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * Blob variant for file downloads (the ledger export): send + error handling
 * are exactly `request`'s (401 step-up retry, unauthorized hook, ApiError
 * with the JSON `error` code of a failed response) — only the success body
 * is read as a Blob instead of parsed JSON.
 */
export async function requestBlob(
  method: HttpMethod,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<Blob> {
  const res = await exchange(method, path, body, options)
  return res.blob()
}

/** Shared send + response checking of `request` and `requestBlob`. */
async function exchange(
  method: HttpMethod,
  path: string,
  body: unknown,
  options: RequestOptions,
): Promise<Response> {
  let res = await send(method, path, body)
  if (res.status === 401) {
    const code = await errorCode(res)
    if (code === 'reauth_required' && !options.noStepUp && hooks.onReauthRequired) {
      try {
        await hooks.onReauthRequired()
      } catch {
        throw new ApiError(401, 'reauth_required')
      }
      res = await send(method, path, body)
      if (res.status === 401) {
        const again = await errorCode(res)
        if (again !== 'reauth_required' && !options.authOptional) hooks.onUnauthorized?.()
        throw new ApiError(401, again)
      }
    } else {
      if (code !== 'reauth_required' && !options.authOptional) hooks.onUnauthorized?.()
      throw new ApiError(401, code)
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, await errorCode(res))
  }
  return res
}
