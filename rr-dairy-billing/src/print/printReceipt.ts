import type { ReactNode } from 'react'
import { createElement } from 'react'
import type { Bill, Customer, StoreSettings, User } from '../db/types'
import { buildReceiptEscPos } from '../lib/escpos'
import { isDesktop, printRaw } from '../lib/tauri'
import { Receipt } from './Receipt'

/**
 * Single place that decides how a receipt actually gets to paper: straight
 * to a configured hardware printer if one's set up in the desktop shell,
 * otherwise the existing browser print dialog — every screen that prints a
 * receipt (POS, Bills reprint, a credit note after a return) goes through
 * this instead of repeating the same branch.
 */
export async function printReceiptSmart(
  print: (node: ReactNode, opts?: { silent?: boolean }) => void,
  bill: Bill,
  settings: StoreSettings,
  customer: Customer | null | undefined,
  cashier: User | null | undefined,
  onError?: (message: string) => void,
) {
  if (isDesktop() && settings.printerMode !== 'browser') {
    const target = settings.printerMode === 'usbSerial'
      ? (settings.printerSerialPath ? { kind: 'usbSerial' as const, path: settings.printerSerialPath, baud: settings.printerBaud } : null)
      : (settings.printerHost ? { kind: 'network' as const, host: settings.printerHost, port: settings.printerPort } : null)
    if (target) {
      try {
        await printRaw(target, buildReceiptEscPos(bill, settings, customer, cashier))
        return
      } catch (e) {
        onError?.(`Printer error, falling back to print dialog: ${String(e).replace(/^.*Error:\s*/, '')}`)
      }
    }
  }
  print(createElement(Receipt, { bill, settings, customer, cashier }), { silent: true })
}
