import type { PaymentMethod } from '../api/data'

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: '現金',
  credit_card: 'クレジットカード',
  debit_card: 'デビットカード',
  e_money: '電子マネー',
  qr_code: 'QRコード決済',
  point: 'ポイント',
  gift_card: 'ギフトカード',
  bank_transfer: '銀行振込',
  other: 'その他',
}

/** True when v is one of the nine payment-method keys (URL validation,
 *  TASK-65 — unknown values drop out of the context instead of a 400). */
export function isPaymentMethod(v: string | null | undefined): v is PaymentMethod {
  return v !== null && v !== undefined && Object.prototype.hasOwnProperty.call(PAYMENT_LABEL, v)
}
