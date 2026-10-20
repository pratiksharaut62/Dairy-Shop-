import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { loadExpiry, milkTotals } from '../lib/dairyData'
import { MILK_LABEL } from '../lib/milkRate'
import { inr, round2 } from '../lib/money'
import { RANGE_OPTIONS, endOfDay, fmtDate, fmtDateTime, fromInputDate, rangeBounds, startOfDay, toInputDate, type RangeKey } from '../lib/dates'
import { toCSV, downloadFile } from '../lib/csv'
import { Card, Empty, Segmented, Stat } from '../components/ui'
import { Download, Printer } from '../components/icons'
import { ReportPrint } from '../print/ReportPrint'
import { usePrint } from '../print/PrintProvider'
import { useApp } from '../state'
import type { Collection, Farmer, LedgerEntry, Product, ProductionBatch, Variant, Wastage } from '../db/types'

type Tab = 'register' | 'collection' | 'production' | 'expiry' | 'payable' | 'wastage'
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'register', label: 'Shift register' }, { value: 'collection', label: 'Collection' }, { value: 'production', label: 'Production' }, { value: 'expiry', label: 'Expiry' },
  { value: 'payable', label: 'Farmer dues' }, { value: 'wastage', label: 'Wastage' },
]

function Table({ head, rows, empty }: { head: string[]; rows: Array<Array<string | number>>; empty: string }) {
  if (!rows.length) return <Empty title={empty} />
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>{head.map((h, i) => <th key={h} className={i > 0 && typeof rows[0][i] === 'number' ? 'num' : ''}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === 'number' ? 'num' : j === 0 ? 'bold' : ''}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

export default function DairyReports() {
  const { settings } = useApp()
  const { print } = usePrint()
  const [tab, setTab] = useState<Tab>('register')
  const [regDate, setRegDate] = useState(toInputDate(Date.now()))
  const [regShift, setRegShift] = useState<'morning' | 'evening'>(new Date().getHours() < 14 ? 'morning' : 'evening')
  const [range, setRange] = useState<RangeKey>('30d')
  const [group, setGroup] = useState<'day' | 'farmer' | 'session'>('day')
  const [from, to] = useMemo(() => rangeBounds(range), [range])

  const regDay = useMemo(() => fromInputDate(regDate), [regDate])
  const regCols = useLiveQuery(() => db.collections.where('date').between(startOfDay(regDay), endOfDay(regDay), true, true).toArray(), [regDay], [] as Collection[]) ?? []
  const farmers = useLiveQuery(() => db.farmers.toArray(), [], [] as Farmer[]) ?? []
  const cols = useLiveQuery(() => db.collections.where('date').between(from, to, true, true).toArray(), [from, to], [] as Collection[]) ?? []
  const batches = useLiveQuery(() => db.batches.where('startedAt').between(from, to, true, true).toArray(), [from, to], [] as ProductionBatch[]) ?? []
  const wastage = useLiveQuery(() => db.wastage.where('at').between(from, to, true, true).toArray(), [from, to], [] as Wastage[]) ?? []
  const ledger = useLiveQuery(() => db.ledger.toArray(), [], [] as LedgerEntry[]) ?? []
  const expiry = useLiveQuery(() => loadExpiry(7), [], { expired: [], soon: [] }) ?? { expired: [], soon: [] }
  const variants = useLiveQuery(() => db.variants.toArray(), [], [] as Variant[]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]) ?? []
  const fname = (id: string) => farmers.find((f) => f.id === id)
  const vname = (id: string) => { const v = variants.find((x) => x.id === id); const p = products.find((x) => x.id === v?.productId); return `${p?.name ?? 'Item'}${v?.size ? ' ' + v.size : ''}` }

  const approved = cols.filter((c) => c.status === 'approved')
  const t = milkTotals(cols)

  const collectionRows = useMemo(() => {
    const m = new Map<string, Collection[]>()
    for (const c of approved) {
      const key = group === 'day' ? fmtDate(startOfDay(c.date)) : group === 'farmer' ? `${fname(c.farmerId)?.code ?? ''} ${fname(c.farmerId)?.name ?? 'Unknown'}`.trim() : `${c.session[0].toUpperCase()}${c.session.slice(1)} · ${MILK_LABEL[c.milkType]}`
      m.set(key, [...(m.get(key) ?? []), c])
    }
    return [...m.entries()].map(([k, list]) => { const x = milkTotals(list); return [k, x.litres, x.avgFat, x.avgSnf, x.avgRate, x.amount] as Array<string | number> })
  }, [approved, group, farmers]) // eslint-disable-line react-hooks/exhaustive-deps

  const productionRows = batches.map((b) => {
    const inL = round2(b.inputs.reduce((s, i) => s + i.qty, 0))
    return [b.no, fmtDate(b.startedAt), b.status, inL, b.outputs.map((o) => `${o.qty} × ${o.label}`).join('; ') || '—', b.qcNote || ''] as Array<string | number>
  })

  const expiryRows = [...expiry.expired.map((r) => ({ ...r, state: 'Expired' })), ...expiry.soon.map((r) => ({ ...r, state: 'Expiring' }))]
    .map((r) => [r.lot.lotNo, r.name, r.lot.available, r.lot.expiresAt ? fmtDateTime(r.lot.expiresAt) : '—', r.state] as Array<string | number>)

  const dues = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of ledger) m.set(e.farmerId, round2((m.get(e.farmerId) ?? 0) + e.amount))
    return [...m.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1])
      .map(([id, v]) => [fname(id)?.code ?? '', fname(id)?.name ?? 'Unknown', fname(id)?.village ?? '', v] as Array<string | number>)
  }, [ledger, farmers]) // eslint-disable-line react-hooks/exhaustive-deps

  const regList = regCols.filter((c) => c.session === regShift && c.status !== 'rejected').sort((a, b) => a.date - b.date)
  const regRows = regList.map((c, i) => [i + 1, fname(c.farmerId)?.code ?? '', fname(c.farmerId)?.name ?? 'Unknown', c.qtyL, c.fat, c.snf, c.rate, c.amount, c.status === 'pending' ? 'Pending' : ''] as Array<string | number>)
  const regTotals = milkTotals(regList.map((c) => ({ ...c, status: 'approved' as const })))

  const wasteRows = wastage.filter((w) => w.status === 'approved').map((w) => [w.no, fmtDate(w.at), vname(w.variantId), w.qty, w.reason, w.value] as Array<string | number>)

  const sets: Record<Tab, { head: string[]; rows: Array<Array<string | number>>; empty: string }> = {
    register: { head: ['#', 'Code', 'Farmer', 'Litres', 'Fat', 'SNF', 'Rate ₹', 'Amount ₹', 'Note'], rows: regRows, empty: 'No milk received in this shift' },
    collection: { head: [group === 'day' ? 'Date' : group === 'farmer' ? 'Farmer' : 'Session', 'Litres', 'Avg Fat', 'Avg SNF', 'Avg ₹/L', 'Amount ₹'], rows: collectionRows, empty: 'No approved collections in this period' },
    production: { head: ['Batch', 'Started', 'Status', 'Units used', 'Produced', 'QC note'], rows: productionRows, empty: 'No batches in this period' },
    expiry: { head: ['Lot', 'Item', 'Available', 'Expires', 'State'], rows: expiryRows, empty: 'Nothing expired or expiring in the next 7 days' },
    payable: { head: ['Code', 'Farmer', 'Village', 'Balance ₹'], rows: dues, empty: 'No farmer balances' },
    wastage: { head: ['Record', 'Date', 'Item', 'Qty', 'Reason', 'Cost ₹'], rows: wasteRows, empty: 'No approved write-offs in this period' },
  }
  const cur = sets[tab]
  const showRange = tab !== 'expiry' && tab !== 'payable' && tab !== 'register'
  const periodLabel = tab === 'register' ? `${new Date(regDay).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · ${regShift === 'morning' ? 'Morning' : 'Evening'} shift` : tab === 'expiry' || tab === 'payable' ? 'As of today' : (RANGE_OPTIONS.find((o) => o.value === range)?.label ?? '')
  const footer = tab === 'register' ? `Farmers: ${regList.length} · Litres: ${regTotals.litres} · Avg Fat: ${regTotals.avgFat} · Avg SNF: ${regTotals.avgSnf} · Amount: ${inr(regTotals.amount)}` : undefined

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Dairy reports</h1>
        <div className="grow" />
        {showRange && <Segmented value={range} options={RANGE_OPTIONS} onChange={setRange} />}
        <button className="btn" disabled={!cur.rows.length || !settings} onClick={() => settings && print(<ReportPrint store={settings.name} title={TABS.find((t) => t.value === tab)!.label} period={periodLabel}
          cols={cur.head.map((h, i) => ({ key: String(i), label: h, num: typeof cur.rows[0]?.[i] === 'number' }))}
          rows={cur.rows.map((r) => Object.fromEntries(r.map((v, i) => [String(i), v])))} footer={footer} />)}><Printer size={15} /> Print</button>
        <button className="btn" disabled={!cur.rows.length} onClick={() => downloadFile(`dairy-${tab}-${range}.csv`, toCSV(cur.rows.map((r) => Object.fromEntries(cur.head.map((h, i) => [h, r[i]])))))}><Download size={15} /> Export</button>
      </header>
      <div className="page"><div className="page-narrow col gap-16">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Segmented value={tab} options={TABS} onChange={setTab} />
          {tab === 'register' && <>
            <input type="date" className="input" style={{ width: 150 }} value={regDate} max={toInputDate(Date.now())} onChange={(e) => e.target.value && setRegDate(e.target.value)} aria-label="Register date" />
            <Segmented value={regShift} options={[{ value: 'morning', label: 'Morning' }, { value: 'evening', label: 'Evening' }]} onChange={setRegShift} />
          </>}
          {tab === 'collection' && <Segmented value={group} options={[{ value: 'day', label: 'By day' }, { value: 'farmer', label: 'By farmer' }, { value: 'session', label: 'By session' }]} onChange={setGroup} />}
        </div>
        {tab === 'register' && (
          <div className="stat-grid">
            <Stat label="Litres" value={`${regTotals.litres} L`} tone="brand" foot={`${regList.length} farmers`} />
            <Stat label="Avg Fat / SNF" value={regTotals.litres ? `${regTotals.avgFat} / ${regTotals.avgSnf}` : '—'} />
            <Stat label="Milk value" value={inr(regTotals.amount)} foot={regTotals.litres ? `₹${regTotals.avgRate}/L average` : ''} />
          </div>
        )}
        {tab === 'collection' && (
          <div className="stat-grid">
            <Stat label="Litres" value={`${t.litres.toLocaleString('en-IN')} L`} tone="brand" foot={`${t.count} entries`} />
            <Stat label="Avg Fat / SNF" value={t.litres ? `${t.avgFat} / ${t.avgSnf}` : '—'} />
            <Stat label="Milk cost" value={inr(t.amount)} foot={t.litres ? `₹${t.avgRate}/L average` : ''} />
            <Stat label="Rejected / pending" value={`${cols.filter((c) => c.status === 'rejected').length} / ${cols.filter((c) => c.status === 'pending').length}`} />
          </div>
        )}
        <Card tight><Table {...cur} /></Card>
      </div></div>
    </div>
  )
}
