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
  /** Legacy invite only: ledger sharing has moved to share tickets
   * (/share), so an already-registered visitor is pointed at a fresh
   * share URL instead of this registration form. */
  share_migrated?: boolean
}

/** POST /api/share/info: what a share ticket joins, and who is asking.
 * `session` is the caller's own display name when logged in (null when
 * not); `already_member` says the caller already belongs to the ledger. */
export interface ShareInfo {
  ledger_name: string
  role: 'editor' | 'viewer'
  issuer_display_name: string
  expires_at: number
  session: { display_name: string } | null
  already_member: boolean
}

export interface ShareAcceptResult {
  ledger: { id: number; name: string; role: LedgerRole }
  outcome: 'joined' | 'already_member'
}

/** One open share ticket of the caller (GET /api/share-tickets). The plain
 * token is never in here — it was shown once at issue time. */
export interface ShareTicket {
  ticket_ref: string
  ledger_id: number
  ledger_name: string
  role: 'editor' | 'viewer'
  created_at: number
  expires_at: number
  inviter_note: string | null
}

export interface ConsentInfo {
  client_display: string
  client_id: string
  scopes: { name: string; description: string }[]
  ledger_name: string | null
  /** Display color of the first-connection ledger (null when unselected, TASK-20 6-2). */
  ledger_color: LedgerColor | null
  user_display_name: string
}

export interface Grant {
  id: number
  client_display: string
  client_id: string
  scope: string
  active_ledger_id: number | null
  active_ledger_name: string | null
  /** The grant user's display color for the active ledger (null when unselected / no longer a member, TASK-20 6-1). */
  active_ledger_color: LedgerColor | null
  created_at: number
  last_used_at: number | null
}

export interface SwitchLedgerResult {
  ledger: { id: number; name: string; role: LedgerRole }
  previous: { id: number; name: string | null } | null
}

/** An issued share / registration URL (201 {url, expires_at}); the plain
 * token comes back exactly once, so the row lives in browser memory only. */
export interface IssuedInvitation {
  url: string
  expires_at: number
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
  registerFinish: (body: { credential: AttestationJson; label?: string }) =>
    request<Record<string, never>>('POST', '/api/webauthn/register/finish', body, pre),
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
  // Ledger share tickets: the membership half of sharing, split from
  // registration. info is auth-optional (it reports the caller's session
  // when one exists); accept needs the session and is the only call that
  // consumes the ticket. Both take the plain token in the POST body only.
  shareInfo: (token: string) => request<ShareInfo>('POST', '/api/share/info', { token }, pre),
  shareAccept: (token: string) =>
    request<ShareAcceptResult>('POST', '/api/share/accept', { token }, pre),
  createShareTicket: (role: 'editor' | 'viewer', ledgerId: number, inviterNote?: string) =>
    request<IssuedInvitation>(
      'POST',
      '/api/share-tickets',
      inviterNote ? { role, ledger_id: ledgerId, inviter_note: inviterNote } : { role, ledger_id: ledgerId },
    ),
  listShareTickets: () => request<ShareTicket[]>('GET', '/api/share-tickets'),
  deleteShareTicket: (ticketRef: string) =>
    request<void>('DELETE', `/api/share-tickets/${encodeURIComponent(ticketRef)}`),
  // Registration-only invitation (TASK-32): any active user, the note is
  // mandatory, no ledger join. Separate endpoint from /api/invitations.
  createRegisterInvitation: (inviterNote: string) =>
    request<IssuedInvitation>('POST', '/api/register-invitations', { inviter_note: inviterNote }),
  // TASK-13: the user-level default ledger (web initial selection and the
  // initial active ledger of future grants; the per-grant selection has its
  // own endpoint in oauthApi.switchActiveLedger).
  setDefaultLedger: (ledgerId: number) =>
    request<{ ledger: { id: number; name: string; role: LedgerRole } }>(
      'PUT',
      '/api/auth/me/default-ledger',
      { ledger_id: ledgerId },
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
