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
