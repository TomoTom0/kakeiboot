// Typed client for the web auth / OAuth APIs implemented in
// backend/src/auth/api.rs and backend/src/auth/oauth/{authorize,grants}.rs
// (spec_auth.md 3-2, 4-2). Timestamps are epoch milliseconds.

import { request } from './http'
import type {
  AssertionJson,
  AttestationJson,
  CreationChallengeJson,
  RequestChallengeJson,
} from './webauthn'

export type LedgerRole = 'owner' | 'editor' | 'viewer'

/** Ledger display color palette key (ledger_members.color, TASK-16 item 3). */
export type LedgerColor = 'teal' | 'orange' | 'pink' | 'brown' | 'slate' | 'graphite'

export interface MeLedger {
  id: number
  name: string
  role: LedgerRole
  color: LedgerColor
}

export interface Me {
  user_id: number
  account_number: string
  display_name: string
  /** The ledger the web screens select initially (null when a member of none). */
  default_ledger_id: number | null
  ledgers: MeLedger[]
  auth_at: number
}

export interface Passkey {
  id: number
  label: string | null
  created_at: number
  last_used_at: number | null
  backup_state: boolean | null
}

export interface RegisterInfo {
  kind: 'setup' | 'invite' | 'register' | 'recovery'
  needs_display_name: boolean
  ledger_name?: string | null
  role?: LedgerRole | null
  user_display_name?: string | null
}

export interface ConsentInfo {
  client_display: string
  client_id: string
  scopes: { name: string; description: string }[]
  ledger_name: string | null
  user_display_name: string
}

export interface Grant {
  id: number
  client_display: string
  client_id: string
  scope: string
  active_ledger_id: number | null
  active_ledger_name: string | null
  created_at: number
  last_used_at: number | null
}

export interface SwitchLedgerResult {
  ledger: { id: number; name: string; role: LedgerRole }
  previous: { id: number; name: string | null } | null
}

const pre = { authOptional: true }

export const authApi = {
  registerInfo: (token: string) =>
    request<RegisterInfo>('POST', '/api/webauthn/register/info', { token }, pre),
  registerStart: (token: string, displayName?: string) =>
    request<CreationChallengeJson>(
      'POST',
      '/api/webauthn/register/start',
      displayName === undefined ? { token } : { token, display_name: displayName },
      pre,
    ),
  registerFinish: (body: {
    credential: AttestationJson
    label?: string
    use_invited_ledger_as_default?: boolean
  }) => request<Record<string, never>>('POST', '/api/webauthn/register/finish', body, pre),
  loginStart: (req?: string) =>
    request<RequestChallengeJson>('POST', '/api/webauthn/login/start', req ? { req } : {}, pre),
  loginFinish: (credential: AssertionJson) =>
    request<{ next: string }>('POST', '/api/webauthn/login/finish', { credential }, pre),
  reauthStart: () =>
    request<RequestChallengeJson>('POST', '/api/webauthn/reauth/start', {}, { noStepUp: true }),
  reauthFinish: (credential: AssertionJson) =>
    request<Record<string, never>>('POST', '/api/webauthn/reauth/finish', { credential }, { noStepUp: true }),
  me: (options = {}) => request<Me>('GET', '/api/auth/me', undefined, options),
  logout: () => request<void>('POST', '/api/auth/logout'),
  logoutAll: () => request<void>('POST', '/api/auth/logout-all'),
  listPasskeys: () => request<Passkey[]>('GET', '/api/passkeys'),
  passkeyStart: () => request<CreationChallengeJson>('POST', '/api/passkeys/start', {}),
  passkeyFinish: (credential: AttestationJson, label?: string) =>
    request<Record<string, never>>(
      'POST',
      '/api/passkeys/finish',
      label ? { credential, label } : { credential },
    ),
  renamePasskey: (id: number, label: string) =>
    request<Record<string, never>>('PATCH', `/api/passkeys/${id}`, { label }),
  deletePasskey: (id: number) => request<void>('DELETE', `/api/passkeys/${id}`),
  createInvitation: (role: 'editor' | 'viewer', inviterNote?: string) =>
    request<{ url: string; expires_at: number }>(
      'POST',
      '/api/invitations',
      inviterNote ? { role, inviter_note: inviterNote } : { role },
    ),
  // Registration-only invitation (TASK-32): any active user, the note is
  // mandatory, no ledger join. Separate endpoint from /api/invitations.
  createRegisterInvitation: (inviterNote: string) =>
    request<{ url: string; expires_at: number }>(
      'POST',
      '/api/register-invitations',
      { inviter_note: inviterNote },
    ),
}

export const oauthApi = {
  consentInfo: (req: string) =>
    request<ConsentInfo>('GET', `/api/oauth/requests/${encodeURIComponent(req)}`, undefined, pre),
  decision: (req: string, decision: 'allow' | 'deny') =>
    request<{ redirect_to: string }>('POST', '/oauth/authorize/decision', { req, decision }, pre),
  listGrants: () => request<Grant[]>('GET', '/api/oauth/grants'),
  revokeGrant: (id: number) => request<void>('DELETE', `/api/oauth/grants/${id}`),
  switchActiveLedger: (id: number, ledgerId: number) =>
    request<SwitchLedgerResult>('PUT', `/api/oauth/grants/${id}/active-ledger`, {
      ledger_id: ledgerId,
    }),
}
