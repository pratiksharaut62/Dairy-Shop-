import { inr } from '../lib/money'
import { MILK_LABEL } from '../lib/milkRate'
import type { Collection, Farmer, LedgerEntry, StoreSettings } from '../db/types'

const d = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
const TYPE: Record<string, string> = { opening: 'Opening balance', collection: 'Milk', advance: 'Advance given', deduction: 'Deduction', settlement: 'Payment made' }

/** A4 passbook for one farmer: every milk delivery and payment in the period, with opening and closing balance. */
export function FarmerStatement({ settings, farmer, from, to, collections, entries, openingBalance }: {
  settings: StoreSettings; farmer: Farmer; from: number; to: number
  collections: Collection[]; entries: LedgerEntry[]; openingBalance: number
}) {
  const milk = collections.filter((c) => c.status === 'approved').sort((a, b) => a.date - b.date)
  const litres = milk.reduce((s, c) => s + c.qtyL, 0)
  const amount = milk.reduce((s, c) => s + c.amount, 0)
  const w = (f: (c: Collection) => number) => (litres ? milk.reduce((s, c) => s + f(c) * c.qtyL, 0) / litres : 0)
  const money = entries.filter((e) => e.type !== 'collection' && e.type !== 'opening').sort((a, b) => a.at - b.at)
  const closing = openingBalance + entries.reduce((s, e) => s + e.amount, 0)

  return (
    <div className="invoice">
      <div className="stmt-head">
        <div><h2>{settings.name}</h2><div>{[settings.address, settings.city].filter(Boolean).join(', ')}{settings.phone ? ` · Ph: ${settings.phone}` : ''}</div></div>
        <div style={{ textAlign: 'right' }}><h2>FARMER STATEMENT</h2><div>{d(from)} – {d(to)}</div></div>
      </div>
      <div className="stmt-box">
        <b>{farmer.code} · {farmer.name}</b>{farmer.village ? ` · ${farmer.village}` : ''}{farmer.phone ? ` · ${farmer.phone}` : ''}
        <div>Opening balance: <b>{inr(openingBalance)}</b> &nbsp;|&nbsp; Milk: <b>{litres.toFixed(2)} L</b> (avg Fat {w((c) => c.fat).toFixed(1)}, SNF {w((c) => c.snf).toFixed(1)}) &nbsp;|&nbsp; Milk value: <b>{inr(amount)}</b></div>
      </div>

      <div style={{ fontWeight: 700, margin: '8px 0 4px' }}>Milk delivered</div>
      <table>
        <thead><tr><th>Date</th><th>Shift</th><th>Milk</th><th className="num">Litres</th><th className="num">Fat</th><th className="num">SNF</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {milk.map((c) => (
            <tr key={c.id}><td>{d(c.date)}</td><td>{c.session === 'morning' ? 'Morning' : 'Evening'}</td><td>{MILK_LABEL[c.milkType]}</td>
              <td className="num">{c.qtyL.toFixed(2)}</td><td className="num">{c.fat.toFixed(1)}</td><td className="num">{c.snf.toFixed(1)}</td>
              <td className="num">{c.rate.toFixed(2)}</td><td className="num">{c.amount.toFixed(2)}</td></tr>
          ))}
          {!milk.length && <tr><td colSpan={8}>No milk delivered in this period.</td></tr>}
        </tbody>
        {milk.length > 0 && <tfoot><tr><th colSpan={3}>Total</th><th className="num">{litres.toFixed(2)}</th><th /><th /><th /><th className="num">{amount.toFixed(2)}</th></tr></tfoot>}
      </table>

      {money.length > 0 && (
        <>
          <div style={{ fontWeight: 700, margin: '12px 0 4px' }}>Advances, deductions and payments</div>
          <table>
            <thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th className="num">Amount</th></tr></thead>
            <tbody>{money.map((e) => <tr key={e.id}><td>{d(e.at)}</td><td>{TYPE[e.type] ?? e.type}</td><td>{e.ref}{e.note ? ` · ${e.note}` : ''}</td><td className="num">{e.amount < 0 ? '−' : ''}{Math.abs(e.amount).toFixed(2)}</td></tr>)}</tbody>
          </table>
        </>
      )}

      <div className="stmt-box" style={{ marginTop: 12, textAlign: 'right', fontSize: 15 }}>
        Closing balance (payable to farmer): <b>{inr(closing)}</b>
      </div>
      <div style={{ fontSize: 10.5, marginTop: 6 }}>Printed {new Date().toLocaleString('en-IN')}</div>
    </div>
  )
}
