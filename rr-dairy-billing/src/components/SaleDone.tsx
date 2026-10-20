import { useEffect, useState } from 'react'
import { Modal } from './ui'
import { Check, CheckCircle, Printer, FileTextIcon } from './icons'
import { Receipt } from '../print/Receipt'
import { inr, round2 } from '../lib/money'
import { fmtTime } from '../lib/dates'
import type { Bill, Customer, StoreSettings, User } from '../db/types'

const MODE_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', credit: 'Credit / points' }

type PrintState = 'idle' | 'busy' | 'done'

interface Props {
  bill: Bill | null
  settings: StoreSettings
  customer: Customer | null
  cashier: User | null
  onNewBill: () => void
  onPrintReceipt: (bill: Bill) => Promise<void> | void
  onPrintInvoice: (bill: Bill) => void
}

/**
 * Shown right after a sale is saved. The cashier's next move is almost always "hand back the
 * change, print, next customer", so that is what the dialog is built around: the change to return
 * is the biggest thing on screen, printing is one click (or P), and New Bill holds the focus so
 * Enter starts the next bill.
 */
export function SaleDone({ bill, settings, customer, cashier, onNewBill, onPrintReceipt, onPrintInvoice }: Props) {
  const [receipt, setReceipt] = useState<PrintState>('idle')

  useEffect(() => { setReceipt('idle') }, [bill?.id])

  async function printReceipt() {
    if (!bill || receipt === 'busy') return
    setReceipt('busy')
    try { await onPrintReceipt(bill) } finally { setReceipt('done') }
  }

  useEffect(() => {
    if (!bill) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); void printReceipt() }
      if (e.key === 'i' || e.key === 'I') { e.preventDefault(); onPrintInvoice(bill) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const pcs = bill ? bill.items.reduce((s, i) => s + i.qty, 0) : 0
  const received = bill ? round2(bill.paid + bill.changeDue) : 0

  return (
    <Modal
      open={!!bill}
      onClose={onNewBill}
      width="wide"
      title={
        <span className="done-title">
          <span className="done-check"><Check size={17} /></span>
          <span>
            <h2>Sale complete</h2>
            <span className="small muted">{bill?.no} · {bill ? fmtTime(bill.date) : ''}</span>
          </span>
        </span>
      }
      footer={<button className="btn btn-primary btn-lg" autoFocus onClick={onNewBill}>New Bill</button>}
    >
      {bill && (
        <div className="done-grid">
          <div className="col" style={{ gap: 14 }}>
            {bill.changeDue > 0 ? (
              <div className="done-hero change">
                <div className="small">Return to customer</div>
                <div className="num done-amt">{inr(bill.changeDue)}</div>
                <div className="small">Received {inr(received)} · Bill {inr(bill.total)}</div>
              </div>
            ) : (
              <div className="done-hero paid">
                <div className="small">Paid in full</div>
                <div className="num done-amt">{inr(bill.total)}</div>
                <div className="small">{pcs} pc{pcs === 1 ? '' : 's'} · {bill.items.length} item{bill.items.length === 1 ? '' : 's'}</div>
              </div>
            )}

            <div className="card" style={{ padding: '6px 16px' }}>
              {bill.payments.map((p, i) => (
                <div key={i} className="row between" style={{ padding: '9px 0', borderTop: i ? '1px solid var(--line)' : undefined }}>
                  <span className="badge">{MODE_LABEL[p.mode] ?? p.mode}</span>
                  <span className="grow small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.ref}</span>
                  <span className="num bold">{inr(p.amount)}</span>
                </div>
              ))}
              <div className="row between" style={{ padding: '9px 0', borderTop: '1px solid var(--line)' }}>
                <span className="small muted">Customer</span>
                <span className="bold" style={{ textAlign: 'right' }}>
                  {customer ? customer.name : 'Walk-in'}
                  {customer && bill.loyaltyEarned > 0 && <span className="badge badge-ok" style={{ marginLeft: 8 }}>+{bill.loyaltyEarned} pts</span>}
                </span>
              </div>
            </div>

            <div className="col" style={{ gap: 8 }}>
              <button type="button" className="btn btn-dark btn-lg btn-block" disabled={receipt === 'busy'} title="Print receipt (P)" onClick={() => void printReceipt()}>
                {receipt === 'done' ? <CheckCircle size={16} /> : <Printer size={16} />}
                {receipt === 'busy' ? 'Printing…' : receipt === 'done' ? 'Receipt sent · print again' : 'Print receipt'}
              </button>
              <button type="button" className="btn btn-block" title="Print A4 invoice (I)" onClick={() => onPrintInvoice(bill)}>
                <FileTextIcon size={15} /> A4 invoice
              </button>
            </div>
          </div>

          <div className="preview-frame done-preview">
            <div className="paper">
              <Receipt bill={bill} settings={settings} customer={customer} cashier={cashier} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
