import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { createSettlement } from '../db/dairy'
import { billingPeriods, currentPeriodKey } from '../lib/dairyData'
import { inr, round2 } from '../lib/money'
import { toCSV, downloadFile } from '../lib/csv'
import { Card, Confirm, Empty, Segmented, Stat } from '../components/ui'
import { CashIcon, Download, Printer } from '../components/icons'
import { ReportPrint } from '../print/ReportPrint'
import { usePrint } from '../print/PrintProvider'
import { useApp } from '../state'
import type { Collection, Farmer, LedgerEntry, Settlement } from '../db/types'

interface Row {
  farmer: Farmer; litres: number; fat: number; snf: number; milk: number; adjust: number; paidIn: number; balance: number
}

/** The 10-day / monthly milk bill run: what every farmer is owed for the cycle, paid in one go. */
export default function PaymentRegister() {
  const { user, toast, settings } = useApp()
  const { print } = usePrint()
  const periods = useMemo(() => billingPeriods(), [])
  const [key, setKey] = useState(currentPeriodKey())
  const p = periods.find((x) => x.key === key) ?? periods[0]
  const [mode, setMode] = useState<Settlement['mode']>('cash')
  const [pick, setPick] = useState<Record<string, boolean>>({})
  const [amount, setAmount] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const farmers = useLiveQuery(() => db.farmers.toArray(), [], [] as Farmer[]) ?? []
  const cols = useLiveQuery(() => db.collections.where('date').between(p.from, p.to, true, true).toArray(), [p.from, p.to], [] as Collection[]) ?? []
  const ledger = useLiveQuery(() => db.ledger.toArray(), [], [] as LedgerEntry[]) ?? []

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const f of farmers) {
      const mine = cols.filter((c) => c.farmerId === f.id && c.status === 'approved')
      const entries = ledger.filter((e) => e.farmerId === f.id)
      const inP = entries.filter((e) => e.at >= p.from && e.at <= p.to)
      const litres = round2(mine.reduce((s, c) => s + c.qtyL, 0))
      const w = (g: (c: Collection) => number) => (litres ? round2(mine.reduce((s, c) => s + g(c) * c.qtyL, 0) / litres) : 0)
      const balance = round2(entries.reduce((s, e) => s + e.amount, 0))
      if (!litres && balance === 0) continue
      out.push({
        farmer: f, litres, fat: w((c) => c.fat), snf: w((c) => c.snf), milk: round2(mine.reduce((s, c) => s + c.amount, 0)),
        adjust: round2(inP.filter((e) => e.type === 'advance' || e.type === 'deduction').reduce((s, e) => s + Math.abs(e.amount), 0)),
        paidIn: round2(inP.filter((e) => e.type === 'settlement').reduce((s, e) => s + Math.abs(e.amount), 0)),
        balance,
      })
    }
    return out.sort((a, b) => a.farmer.code.localeCompare(b.farmer.code, undefined, { numeric: true }))
  }, [farmers, cols, ledger, p.from, p.to])

  const payNow = (r: Row) => {
    const v = amount[r.farmer.id]
    return v !== undefined ? Number(v) || 0 : Math.max(0, r.balance)
  }
  const selected = rows.filter((r) => pick[r.farmer.id] && payNow(r) > 0)
  const total = round2(selected.reduce((s, r) => s + payNow(r), 0))
  const sum = (f: (r: Row) => number) => round2(rows.reduce((s, r) => s + f(r), 0))
  const owing = rows.filter((r) => r.balance > 0)
  const allOn = owing.length > 0 && owing.every((r) => pick[r.farmer.id])

  async function paySelected() {
    if (!user || busy) return
    setBusy(true)
    let done = 0, paid = 0
    const failed: string[] = []
    for (const r of selected) {
      try {
        await createSettlement({ farmerId: r.farmer.id, from: p.from, to: p.to, paid: payNow(r), mode, ref: `Register ${p.label}`, notes: '' }, user.id)
        done++; paid += payNow(r)
      } catch (e) { failed.push(`${r.farmer.code}: ${(e as Error).message}`) }
    }
    setBusy(false); setConfirm(false); setPick({}); setAmount({})
    if (done) toast(`Paid ${done} farmer${done === 1 ? '' : 's'} · ${inr(round2(paid))}`, 'ok')
    if (failed.length) toast(failed[0] + (failed.length > 1 ? ` (+${failed.length - 1} more)` : ''), 'err')
  }

  const reportRows = rows.map((r) => ({ code: r.farmer.code, name: r.farmer.name, litres: r.litres, fat: r.fat || '', snf: r.snf || '', milk: r.milk, adjust: r.adjust, paid: r.paidIn, balance: r.balance }))

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Payment register</h1>
        <div className="grow" />
        <select className="select" style={{ width: 170 }} value={key} onChange={(e) => { setKey(e.target.value); setPick({}); setAmount({}) }} aria-label="Billing period">
          {periods.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        <button className="btn" disabled={!rows.length} onClick={() => downloadFile(`payment-register-${p.key}.csv`, toCSV(reportRows))}><Download size={15} /> Export</button>
        <button className="btn" disabled={!rows.length || !settings} onClick={() => settings && print(<ReportPrint store={settings.name} title="Farmer payment register" period={p.label}
          cols={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Farmer' }, { key: 'litres', label: 'Litres', num: true }, { key: 'fat', label: 'Fat', num: true }, { key: 'snf', label: 'SNF', num: true },
            { key: 'milk', label: 'Milk ₹', money: true }, { key: 'adjust', label: 'Advance/Ded ₹', money: true }, { key: 'paid', label: 'Paid ₹', money: true }, { key: 'balance', label: 'Balance ₹', money: true }]}
          rows={reportRows} footer={`Farmers: ${rows.length} · Litres: ${sum((r) => r.litres)} · Milk value: ${inr(sum((r) => r.milk))} · Balance payable: ${inr(sum((r) => Math.max(0, r.balance)))}`} />)}><Printer size={15} /> Print</button>
      </header>

      <div className="page"><div className="page-narrow col gap-16">
        <div className="stat-grid">
          <Stat label="Farmers in this cycle" value={rows.length} />
          <Stat label="Milk collected" value={`${sum((r) => r.litres)} L`} tone="brand" foot={`Value ${inr(sum((r) => r.milk))}`} />
          <Stat label="Advances & deductions" value={inr(sum((r) => r.adjust))} />
          <Stat label="Balance payable" value={inr(sum((r) => Math.max(0, r.balance)))} tone="warn" foot={`${owing.length} farmers to pay`} />
        </div>

        <Card tight>
          {!rows.length ? <Empty icon={<CashIcon size={24} />} title="No milk or balances in this cycle" hint="Pick another period, or record collections first." /> : (
            <>
              <div className="table-wrap">
                <table className="tbl pay-table">
                  <thead><tr>
                    <th style={{ width: 36 }}><input type="checkbox" checked={allOn} aria-label="Select all farmers owed money" onChange={(e) => setPick(Object.fromEntries(owing.map((r) => [r.farmer.id, e.target.checked])))} /></th>
                    <th>Farmer</th><th className="num">Litres</th><th className="num">Fat</th><th className="num">SNF</th><th className="num">Milk ₹</th><th className="num">Adv / Ded ₹</th><th className="num">Paid ₹</th><th className="num">Balance ₹</th><th className="num">Pay now ₹</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const id = r.farmer.id
                      return (
                        <tr key={id}>
                          <td><input type="checkbox" disabled={r.balance <= 0} checked={!!pick[id]} onChange={(e) => setPick({ ...pick, [id]: e.target.checked })} aria-label={`Select ${r.farmer.name}`} /></td>
                          <td><div className="bold">{r.farmer.name}</div><div className="small muted mono">{r.farmer.code}{r.farmer.village ? ` · ${r.farmer.village}` : ''}</div></td>
                          <td className="num">{r.litres}</td><td className="num">{r.litres ? r.fat : '—'}</td><td className="num">{r.litres ? r.snf : '—'}</td>
                          <td className="num">{inr(r.milk)}</td><td className="num">{r.adjust ? inr(r.adjust) : '—'}</td><td className="num">{r.paidIn ? inr(r.paidIn) : '—'}</td>
                          <td className="num bold" style={{ color: r.balance < 0 ? 'var(--danger)' : undefined }}>{inr(r.balance)}</td>
                          <td className="num">{r.balance > 0
                            ? <input className="input num" inputMode="decimal" value={amount[id] ?? String(Math.max(0, r.balance))} onChange={(e) => setAmount({ ...amount, [id]: e.target.value.replace(/[^\d.]/g, '') })} aria-label={`Amount to pay ${r.farmer.name}`} />
                            : <span className="muted">—</span>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot><tr><td /><td>Total</td><td className="num">{sum((r) => r.litres)}</td><td /><td /><td className="num">{inr(sum((r) => r.milk))}</td><td className="num">{inr(sum((r) => r.adjust))}</td><td className="num">{inr(sum((r) => r.paidIn))}</td><td className="num">{inr(sum((r) => r.balance))}</td><td /></tr></tfoot>
                </table>
              </div>
              <div className="sticky-actions">
                <span className="small muted">Pay by</span>
                <Segmented value={mode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }]} onChange={setMode} />
                <div className="grow" />
                <span className="small"><b>{selected.length}</b> selected · <b className="num">{inr(total)}</b></span>
                <button className="btn btn-primary btn-lg" disabled={!selected.length || busy} onClick={() => setConfirm(true)}>Pay selected</button>
              </div>
            </>
          )}
        </Card>
      </div></div>

      <Confirm open={confirm} title="Record payments?" confirmLabel={busy ? 'Paying…' : `Pay ${inr(total)}`}
        message={<>Record <strong>{selected.length}</strong> payment{selected.length === 1 ? '' : 's'} totalling <strong>{inr(total)}</strong> by <strong>{mode}</strong> for <strong>{p.label}</strong>. Each one is entered in the farmer's account and cannot be undone.</>}
        onConfirm={() => void paySelected()} onClose={() => setConfirm(false)} />
    </div>
  )
}
