import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { addFarmerEntry, createFarmer, createSettlement, nextFarmerCode, previewSettlement, type SettlementPreview } from '../db/dairy'
import { MILK_LABEL } from '../lib/milkRate'
import { inr, round2 } from '../lib/money'
import { billingPeriods } from '../lib/dairyData'
import { FarmerStatement } from '../print/FarmerStatement'
import { usePrint } from '../print/PrintProvider'
import { fmtDate, fromInputDate, toInputDate } from '../lib/dates'
import { toCSV, downloadFile } from '../lib/csv'
import { useDebounced } from '../lib/useDebounced'
import { Card, Empty, Field, Modal, Segmented } from '../components/ui'
import { CustomersIcon, Download, Plus, Printer, Search } from '../components/icons'
import { useApp } from '../state'
import type { Collection, Farmer, LedgerEntry, MilkType, Settlement } from '../db/types'

const MILK: Array<{ value: MilkType; label: string }> = [{ value: 'cow', label: 'Cow' }, { value: 'buffalo', label: 'Buffalo' }, { value: 'mixed', label: 'Mixed' }]
const amt = (s: string) => s.replace(/[^\d.]/g, '')

export default function Farmers() {
  const { can } = useApp()
  const money = can('settlement') // balances and the account view are for managers; the counter just needs codes and names
  const [q, setQ] = useState('')
  const needle = useDebounced(q.trim().toLowerCase(), 120)
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const farmers = useLiveQuery(() => db.farmers.toArray(), [], [] as Farmer[]) ?? []
  const ledger = useLiveQuery(() => db.ledger.toArray(), [], [] as LedgerEntry[]) ?? []
  const month = useLiveQuery(async () => {
    const d = new Date(); const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    const m = new Map<string, number>()
    await db.collections.where('date').aboveOrEqual(from).each((c) => { if (c.status === 'approved') m.set(c.farmerId, round2((m.get(c.farmerId) ?? 0) + c.qtyL)) })
    return m
  }, [], new Map<string, number>()) ?? new Map<string, number>()

  const balance = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of ledger) m.set(e.farmerId, round2((m.get(e.farmerId) ?? 0) + e.amount))
    return m
  }, [ledger])

  const rows = useMemo(() => farmers
    .filter((f) => !needle || f.name.toLowerCase().includes(needle) || f.code.toLowerCase().includes(needle) || f.phone.includes(needle) || f.village.toLowerCase().includes(needle))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })), [farmers, needle])
  const owed = round2([...balance.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0))
  const open = farmers.find((f) => f.id === openId) ?? null

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Farmers</h1>
        <div className="grow" />
        <button className="btn" disabled={!rows.length} onClick={() => downloadFile('farmers.csv', toCSV(rows.map((f) => ({
          code: f.code, name: f.name, phone: f.phone, village: f.village, milk: f.milkType, balance: balance.get(f.id) ?? 0,
        }))))}><Download size={15} /> Export</button>
        {can('collection') && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> Add farmer</button>}
      </header>
      <div className="page">
        <div className="page-narrow col gap-16">
          <div className="bills-filters">
            <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
              <span className="ico"><Search /></span>
              <input className="input" placeholder="Search code, name, village or phone" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="grow" />
            <span className="small muted"><b className="num">{farmers.length}</b> farmers{money && <> · We owe them <b className="num">{inr(owed)}</b></>}</span>
          </div>

          <Card tight>
            {!rows.length ? (
              <Empty icon={<CustomersIcon size={24} />} title={farmers.length ? 'No farmer matches' : 'No farmers yet'} hint={farmers.length ? 'Try a different search.' : 'Add the people who bring you milk — each gets a code for quick entry at the collection counter.'} />
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Farmer</th><th>Village</th><th>Milk</th><th className="num">This month</th>{money && <th className="num">We owe</th>}</tr></thead>
                  <tbody>
                    {rows.map((f) => {
                      const b = balance.get(f.id) ?? 0
                      return (
                        <tr key={f.id} style={{ cursor: money ? 'pointer' : 'default', opacity: f.active ? 1 : 0.55 }} onClick={() => money && setOpenId(f.id)}>
                          <td><div className="bold">{f.name}</div><div className="small muted mono">{f.code}{f.phone ? ` · ${f.phone}` : ''}</div></td>
                          <td>{f.village || '—'}</td>
                          <td>{MILK_LABEL[f.milkType]}</td>
                          <td className="num">{(month.get(f.id) ?? 0).toLocaleString('en-IN')} L</td>
                          {money && <td className="num bold" style={{ color: b < 0 ? 'var(--danger)' : undefined }}>{inr(b)}</td>}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
      {adding && <FarmerForm onClose={() => setAdding(false)} />}
      {open && <FarmerDetail farmer={open} balance={balance.get(open.id) ?? 0} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function FarmerForm({ onClose }: { onClose: () => void }) {
  const { user, toast } = useApp()
  const [f, setF] = useState({ code: '', name: '', phone: '', village: '', address: '', milkType: 'cow' as MilkType, payoutDetails: '', opening: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { void nextFarmerCode().then((code) => setF((p) => ({ ...p, code }))) }, [])

  async function save() {
    if (!user || busy) return
    setBusy(true)
    try {
      await createFarmer({ code: f.code, name: f.name, phone: f.phone.trim(), village: f.village.trim(), address: f.address.trim(), milkType: f.milkType, payoutDetails: f.payoutDetails.trim(), openingBalance: Number(f.opening) || 0 }, user.id)
      toast(`${f.name.trim()} added`, 'ok')
      onClose()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal open title="Add farmer" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" disabled={busy || !f.name.trim()} onClick={() => void save()}>Save farmer</button></>}>
      <div className="grid grid-2">
        <Field label="Code *"><input className="input input-lg mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Name *"><input className="input input-lg" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Village"><input className="input" value={f.village} onChange={(e) => setF({ ...f, village: e.target.value })} /></Field>
      </div>
      <div className="form-section"><h3>Usual milk</h3><Segmented value={f.milkType} options={MILK} onChange={(v) => setF({ ...f, milkType: v })} /></div>
      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <Field label="Payment details" hint="UPI id or bank details used at settlement"><input className="input" value={f.payoutDetails} onChange={(e) => setF({ ...f, payoutDetails: e.target.value })} /></Field>
        <Field label="Opening balance (₹)" hint="Already owed to the farmer (negative if they owe you)"><input className="input num" inputMode="decimal" value={f.opening} onChange={(e) => setF({ ...f, opening: e.target.value.replace(/[^\d.-]/g, '') })} /></Field>
      </div>
      <Field label="Address"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
    </Modal>
  )
}

function FarmerDetail({ farmer, balance, onClose }: { farmer: Farmer; balance: number; onClose: () => void }) {
  const { user, toast, can } = useApp()
  const entries = useLiveQuery(() => db.ledger.where('farmerId').equals(farmer.id).toArray(), [farmer.id], [] as LedgerEntry[]) ?? []
  const settlements = useLiveQuery(() => db.settlements.where('farmerId').equals(farmer.id).reverse().sortBy('paidAt'), [farmer.id], [] as Settlement[]) ?? []
  const [tab, setTab] = useState<'ledger' | 'statement' | 'entry' | 'settle'>('ledger')
  const sorted = useMemo(() => [...entries].sort((a, b) => b.at - a.at), [entries])
  const [kind, setKind] = useState<'advance' | 'deduction'>('advance')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  async function addEntry() {
    if (!user) return
    try {
      await addFarmerEntry(farmer.id, kind, Number(amount), note, user.id)
      toast(`${kind === 'advance' ? 'Advance' : 'Deduction'} of ${inr(Number(amount))} recorded`, 'ok')
      setAmount(''); setNote(''); setTab('ledger')
    } catch (e) { toast((e as Error).message, 'err') }
  }

  return (
    <Modal open width="wide" title={<div><h2>{farmer.name}</h2><div className="small muted">{farmer.code} · {farmer.village || 'No village'} · {farmer.phone || 'No phone'}</div></div>} onClose={onClose}>
      <div className="row between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div><div className="small muted">We owe {farmer.name.split(' ')[0]}</div><div className="num bold" style={{ fontSize: 24, color: balance < 0 ? 'var(--danger)' : undefined }}>{inr(balance)}</div></div>
        <Segmented value={tab} options={[{ value: 'ledger', label: 'Account' }, { value: 'statement', label: 'Passbook' }, ...(can('settlement') ? [{ value: 'entry' as const, label: 'Advance / deduction' }, { value: 'settle' as const, label: 'Pay settlement' }] : [])]} onChange={setTab} />
      </div>

      {tab === 'ledger' && (
        <>
          {!sorted.length ? <Empty title="No activity yet" hint="Milk collected, advances and payments all appear here." /> : (
            <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
              <table className="tbl">
                <thead><tr><th>Date</th><th>Entry</th><th className="num">Amount</th></tr></thead>
                <tbody>{sorted.map((e) => (
                  <tr key={e.id}><td className="muted nowrap">{fmtDate(e.at)}</td><td><span className="bold" style={{ textTransform: 'capitalize' }}>{e.type}</span> <span className="small muted">{e.ref}{e.note ? ` · ${e.note}` : ''}</span></td>
                    <td className="num" style={{ color: e.amount < 0 ? 'var(--danger)' : 'var(--ok)' }}>{e.amount < 0 ? '−' : '+'}{inr(Math.abs(e.amount))}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {settlements.length > 0 && <div className="small muted" style={{ marginTop: 10 }}>Last paid {fmtDate(settlements[0].paidAt)} — {inr(settlements[0].paid)} by {settlements[0].mode} ({settlements[0].no})</div>}
        </>
      )}

      {tab === 'statement' && <StatementTab farmer={farmer} />}

      {tab === 'entry' && (
        <div className="col gap-12">
          <Segmented value={kind} options={[{ value: 'advance', label: 'Advance given' }, { value: 'deduction', label: 'Deduction (feed, vet…)' }]} onChange={setKind} />
          <div className="grid grid-2">
            <Field label="Amount (₹) *"><input className="input input-lg num" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(amt(e.target.value))} /></Field>
            <Field label="Note"><input className="input input-lg" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <div><button className="btn btn-primary btn-lg" disabled={!(Number(amount) > 0)} onClick={() => void addEntry()}>Record {kind}</button></div>
        </div>
      )}

      {tab === 'settle' && <SettleForm farmer={farmer} onDone={() => setTab('ledger')} />}
    </Modal>
  )
}

function SettleForm({ farmer, onDone }: { farmer: Farmer; onDone: () => void }) {
  const { user, toast } = useApp()
  const first = new Date(); first.setDate(1)
  const [from, setFrom] = useState(toInputDate(first.getTime()))
  const [to, setTo] = useState(toInputDate(Date.now()))
  const [paid, setPaid] = useState('')
  const [mode, setMode] = useState<Settlement['mode']>('cash')
  const [ref, setRef] = useState('')
  const [notes, setNotes] = useState('')
  const [pv, setPv] = useState<SettlementPreview | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void previewSettlement(farmer.id, fromInputDate(from), fromInputDate(to) + 12 * 3_600_000).then((p) => { setPv(p); setPaid((cur) => cur || (p.payable > 0 ? String(p.payable) : '')) })
  }, [farmer.id, from, to])

  async function pay() {
    if (!user || busy) return
    setBusy(true)
    try {
      const s = await createSettlement({ farmerId: farmer.id, from: fromInputDate(from), to: fromInputDate(to) + 12 * 3_600_000, paid: Number(paid), mode, ref, notes }, user.id)
      toast(`${s.no} · paid ${inr(s.paid)} to ${farmer.name}`, 'ok')
      onDone()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }

  return (
    <div className="col gap-12">
      <div className="grid grid-2">
        <Field label="Period from"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Period to"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {pv && (
        <div className="card" style={{ padding: 12 }}>
          <div className="row between"><span>Milk in period</span><b className="num">{pv.litres} L · {inr(pv.collectionAmount)}</b></div>
          <div className="row between"><span>Advances in period</span><b className="num">−{inr(pv.advances)}</b></div>
          <div className="row between"><span>Deductions in period</span><b className="num">−{inr(pv.deductions)}</b></div>
          <div className="row between" style={{ borderTop: '1px solid var(--line)', marginTop: 6, paddingTop: 6 }}><span className="bold">Total owed right now</span><b className="num">{inr(pv.payable)}</b></div>
          {pv.lastSettledTo > 0 && <div className="tiny muted" style={{ marginTop: 4 }}>Last settled up to {fmtDate(pv.lastSettledTo)}</div>}
        </div>
      )}
      <div className="grid grid-2">
        <Field label="Pay now (₹) *"><input className="input input-lg num" inputMode="decimal" value={paid} onChange={(e) => setPaid(amt(e.target.value))} /></Field>
        <Field label="Paid by"><Segmented value={mode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }]} onChange={setMode} /></Field>
        <Field label="Reference"><input className="input" placeholder="UTR / cheque no." value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="Note"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
      {farmer.payoutDetails && <div className="small muted">Pay to: {farmer.payoutDetails}</div>}
      <div><button className="btn btn-primary btn-lg" disabled={busy || !(Number(paid) > 0)} onClick={() => void pay()}>Record payment</button></div>
    </div>
  )
}


function StatementTab({ farmer }: { farmer: Farmer }) {
  const { settings, toast } = useApp()
  const { print } = usePrint()
  const periods = useMemo(() => billingPeriods(), [])
  const [key, setKey] = useState('c1')
  const p = periods.find((x) => x.key === key) ?? periods[0]
  const cols = useLiveQuery(() => db.collections.where('farmerId').equals(farmer.id).toArray(), [farmer.id], [] as Collection[]) ?? []
  const ledger = useLiveQuery(() => db.ledger.where('farmerId').equals(farmer.id).toArray(), [farmer.id], [] as LedgerEntry[]) ?? []

  const inRange = cols.filter((c) => c.date >= p.from && c.date <= p.to)
  const milk = inRange.filter((c) => c.status === 'approved')
  const entries = ledger.filter((e) => e.at >= p.from && e.at <= p.to)
  const opening = round2(ledger.filter((e) => e.at < p.from).reduce((s, e) => s + e.amount, 0))
  const closing = round2(opening + entries.reduce((s, e) => s + e.amount, 0))
  const litres = round2(milk.reduce((s, c) => s + c.qtyL, 0))
  const amount = round2(milk.reduce((s, c) => s + c.amount, 0))
  const avg = (f: (c: Collection) => number) => (litres ? round2(milk.reduce((s, c) => s + f(c) * c.qtyL, 0) / litres) : 0)
  const paid = round2(entries.filter((e) => e.type === 'settlement').reduce((s, e) => s + Math.abs(e.amount), 0))
  const advances = round2(entries.filter((e) => e.type === 'advance' || e.type === 'deduction').reduce((s, e) => s + Math.abs(e.amount), 0))

  const message = `${settings?.name ?? 'Dairy'} — ${farmer.name} (${farmer.code})\n${p.label}\nMilk: ${litres} L, avg Fat ${avg((c) => c.fat)}, SNF ${avg((c) => c.snf)}\nMilk value: ${inr(amount)}\nAdvances/deductions: ${inr(advances)}\nPaid: ${inr(paid)}\nBalance payable: ${inr(closing)}`

  return (
    <div className="col gap-12">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="select" style={{ width: 200 }} value={key} onChange={(e) => setKey(e.target.value)} aria-label="Period">
          {periods.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        <div className="row gap-6">
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(message).then(() => toast('Summary copied — paste it into WhatsApp or SMS', 'ok'), () => toast('Could not copy', 'err')) }}>Copy summary</button>
          <button className="btn btn-primary" disabled={!settings} onClick={() => settings && print(<FarmerStatement settings={settings} farmer={farmer} from={p.from} to={p.to} collections={inRange} entries={entries} openingBalance={opening} />)}><Printer size={15} /> Print statement</button>
        </div>
      </div>
      <div className="mini-stats" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <div className="mini-stat"><div className="v">{litres}</div><div className="l">Litres</div></div>
        <div className="mini-stat"><div className="v">{litres ? `${avg((c) => c.fat)} / ${avg((c) => c.snf)}` : '—'}</div><div className="l">Avg Fat / SNF</div></div>
        <div className="mini-stat"><div className="v">{inr(amount)}</div><div className="l">Milk value</div></div>
        <div className="mini-stat"><div className="v">{inr(closing)}</div><div className="l">Balance</div></div>
      </div>
      {!milk.length ? <Empty title="No approved milk in this period" /> : (
        <div className="table-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Date</th><th>Shift</th><th className="num">Litres</th><th className="num">Fat</th><th className="num">SNF</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
            <tbody>{[...milk].sort((a, b) => a.date - b.date).map((c) => (
              <tr key={c.id}><td className="nowrap">{fmtDate(c.date)}</td><td style={{ textTransform: 'capitalize' }}>{c.session}</td><td className="num">{c.qtyL}</td><td className="num">{c.fat}</td><td className="num">{c.snf}</td><td className="num">₹{c.rate}</td><td className="num bold">{inr(c.amount)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
