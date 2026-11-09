import { ApiError } from '../api/http'
import type { TopItem } from '../api/data'

const dateTime = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const yen = new Intl.NumberFormat('ja-JP')

/** epoch ms or ISO string -> "YYYY/MM/DD HH:MM" in JST; null -> "-". */
export function formatDateTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return dateTime.format(d)
}

/** TASK-167 D-3: the derived representative items as the sub line's text
 * —「品目A・品目B」. Empty (item-less receipts / rest rows) renders ''. */
export function topItemsText(items: TopItem[] | null | undefined): string {
  return (items ?? []).map((i) => i.name).join('・')
}

export function formatYen(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return `${yen.format(value)}円`
}

/** Character count as the backend counts it (Unicode scalar values). */
export function charCount(value: string): number {
  return Array.from(value).length
}

const MESSAGES: Record<string, string> = {
  unauthorized: 'ログインが必要です。',
  reauth_required: '本人確認がキャンセルされたため、操作を中止しました。',
  origin_mismatch: '不正なリクエストとして拒否されました。ページを再読み込みしてください。',
  json_only: '不正なリクエストとして拒否されました。ページを再読み込みしてください。',
  invalid_token: '登録用 URL が無効か、期限切れか、使用済みです。発行した人に新しい URL を依頼してください。',
  display_name_required: '表示名を入力してください。',
  display_name_not_allowed: 'この登録では表示名を変更できません。',
  ceremony_invalid: '手続きの有効期限が切れました。もう一度やり直してください。',
  registration_failed: 'パスキーを登録できませんでした。もう一度やり直してください。',
  invalid_label: '名前は1〜100文字で入力してください。',
  last_passkey: '最後のパスキーは削除できません。別のパスキーを追加してから削除してください。',
  no_passkeys: '本人確認に使えるパスキーがありません。',
  owner_required: '家計簿のオーナーのみ共有できます。',
  no_default_ledger: '共有先の家計簿が決まっていません。',
  inviter_note_too_long: 'メモは200文字以内で入力してください。',
  inviter_note_required: 'メモを入力してください。',
  register_open_limit: '発行できる登録招待 URL は同時に5件までです。古いものが使用・期限切れになるのを待つか、運用者に失効を依頼してください。',
  invalid_role: '権限の指定が正しくありません。',
  ledger_not_selectable: 'この家計簿は選択できません（所属していない可能性があります）。',
  not_found: '対象が見つかりません。',
  invalid_request: 'この要求は無効か期限切れです。',
  stale_revision: '他の画面や会話で更新されたため保存しませんでした。最新の内容を表示しています。',
  deleted: '削除済みのため変更できません。',
  parent_not_found: '親カテゴリ（大分類）が見つかりません。先に大分類を作成してください。',
  invalid_path: 'カテゴリは「大分類」または「大分類/小分類」の形で入力してください。',
  invalid_name: '名前を正しく入力してください（「/」は使えません）。',
  name_conflict: '同じ名前のカテゴリが既にあります。',
  invalid_depth: '小分類を持つカテゴリや、それ自身の下へは移動できません。',
  same_store: '統合元と統合先に同じ店は選べません。',
  unknown_category: '存在しないカテゴリです。',
  viewer_only: 'この家計簿は閲覧のみです。',
  item_name_amount_required: '追加する明細には品名と金額が必要です。',
  revision_required: '確認情報が不足しています。もう一度やり直してください。',
  internal: '一時的なエラーが発生しました。時間をおいてもう一度お試しください。',
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return MESSAGES[e.code] ?? `エラーが発生しました（${e.status} ${e.code}）。`
  }
  return 'エラーが発生しました。通信状態を確認してもう一度お試しください。'
}

export function errorCodeOf(e: unknown): string | null {
  return e instanceof ApiError ? e.code : null
}
