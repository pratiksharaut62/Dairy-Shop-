import { variantLabel } from '../lib/variantLabel'
import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { loadVariantViews, type VariantView } from '../db/ops'
import { hsnSummary } from '../lib/gst'
import { billFigures } from '../lib/billFigures'
import { GST_PAYMENT_CATEGORY } from '../lib/dashboardData'
import { id } from '../lib/id'
import { inr, inrShort, round2 } from '../lib/money'
import { DAY, fmtDate, fmtDayShort, rangeBounds, RANGE_OPTIONS, startOfDay, type RangeKey } from '../lib/dates'
import { toCSV, downloadFile } from '../lib/csv'
import { useDebounced } from '../lib/useDebounced'
import { Empty, Segmented, Stat, Confirm } from '../components/ui'
import { TrendChart } from '../components/charts'
import {
  BillsIcon, BoxesIcon, CardIcon, CashIcon, RupeeIcon, Download, PercentIcon, Printer, RotateIcon, Search, TrendUp,
} from '../components/icons'
import { useApp } from '../state'
import { usePrint } from '../print/PrintProvider'
import { ReportPrint, type ReportCol } from '../print/ReportPrint'
import type { Bill, Expense, User } from '../db/types'

type Tab = 'sales' | 'gst' | 'profit' | 'items' | 'staff' | 'dayclose'
type Row = Record<string, string | number>
interface TableData { title: string; cols: ReportCol[]; rows: Row[]; footer?: string }

const MODE_COLOR: Record<string, string> = { cash: 'var(--ok)', upi: 'var(--brand)', card: 'var(--accent)', credit: 'var(--warn)' }
const MAX_CHART_DAYS = 90

export default function Reports() {
  const { toast, can, settings } = useApp()
  const { print } = usePrint()
  const [tab, setTab] = useState<Tab>('sales')
  const [range, setRange] = useState<RangeKey>('30d')
  const [from, to] = useMemo(() => rangeBounds(range), [range])

  // Only the chosen period is read, straight off the date index.
  const bills = useLiveQuery(() => db.bills.where('date').between(from, to, true, true).toArray(), [from, to], [] as Bill[]) ?? []
  const expenses = useLiveQuery(() => db.expenses.where('date').between(from, to, true, true).toArray(), [from, to], [] as Expense[]) ?? []
  const users = useLiveQuery(() => db.users.toArray(), [], [] as User[]) ?? []
  const variants = useLiveQuery(() => loadVariantViews(), [], [] as VariantView[]) ?? []
  const costOf = useMemo(() => new Map(variants.map((v) => [v.id, v.cost])), [variants])

  // One pass over the period's bills builds everything the tabs need. Every figure comes from billFigures(), so a
  // return (credit note) subtracts consistently from sales, tax, pieces, cost and discount.
  const agg = useMemo(() => {
    const sales = bills.filter((b) => b.status !== 'held')
    const currentCost = (variantId: string) => costOf.get(variantId) ?? 0
    let revenue = 0, net = 0, gst = 0, qty = 0, discount = 0, cogs = 0, creditTotal = 0, positive = 0, credits = 0, positiveTotal = 0
    const modes = new Map<string, number>()
    const items = new Map<string, { name: string; sku: string; variant: string; qty: number; revenue: number; cost: number }>()
    const staff = new Map<string, { bills: number; qty: number; revenue: number; discount: number }>()
    const lines: Array<{ hsn: string; taxable: number; cgst: number; sgst: number; taxRate: number; qty: number }> = []

    const chartEnd = startOfDay(Math.min(to, Date.now()))
    const earliest = sales.reduce((m, b) => Math.min(m, b.date), Infinity)
    const chartStart = Math.max(startOfDay(Math.max(from, Number.isFinite(earliest) ? earliest : from)), chartEnd - (MAX_CHART_DAYS - 1) * DAY)
    const nDays = Math.max(1, Math.round((chartEnd - chartStart) / DAY) + 1)
    const daily = Array.from({ length: nDays }, (_, i) => ({ start: chartStart + i * DAY, total: 0, bills: 0, qty: 0 }))

    for (const b of sales) {
      const f = billFigures(b, currentCost)
      const isCredit = f.sign === -1
      revenue += f.total; net += f.net; gst += f.gst; qty += f.pieces; discount += f.discount; cogs += f.cost
      if (isCredit) { credits++; creditTotal += b.total } else { positive++; positiveTotal += b.total }

      for (const i of b.items) {
        const it = items.get(i.variantId) ?? { name: i.name, sku: i.sku, variant: variantLabel(i.size, i.color), qty: 0, revenue: 0, cost: 0 }
        it.qty += i.qty * f.sign
        it.revenue += i.taxable * f.sign // sales value excluding GST, so margin is a real margin
        it.cost += (i.cost ?? currentCost(i.variantId)) * i.qty * f.sign
        items.set(i.variantId, it)
        lines.push({ hsn: i.hsn, taxable: i.taxable * f.sign, cgst: i.cgst * f.sign, sgst: i.sgst * f.sign, taxRate: i.taxRate, qty: i.qty * f.sign })
      }
      for (const p of b.payments) modes.set(p.mode, (modes.get(p.mode) ?? 0) + p.amount)

      const st = staff.get(b.cashierId) ?? { bills: 0, qty: 0, revenue: 0, discount: 0 }
      st.revenue += f.total; st.qty += f.pieces; st.discount += f.discount; if (!isCredit) st.bills++
      staff.set(b.cashierId, st)

      const idx = Math.floor((startOfDay(b.date) - chartStart) / DAY)
      if (idx >= 0 && idx < nDays) { daily[idx].total += b.total; daily[idx].qty += f.pieces; if (!isCredit) daily[idx].bills++ }
    }
    return {
      revenue: round2(revenue), net: round2(net), gst: round2(gst), qty, discount: round2(discount), cogs: round2(cogs),
      positive, credits, creditTotal: round2(creditTotal), positiveTotal: round2(positiveTotal),
      modes: [...modes.entries()].map(([m, v]) => [m, round2(v)] as [string, number]).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]),
      items: [...items.values()].map((r) => ({ ...r, revenue: round2(r.revenue), cost: round2(r.cost) })).sort((a, b) => b.qty - a.qty),
      staff, lines,
      daily: daily.map((d) => ({ ...d, total: round2(d.total) })),
    }
  }, [bills, costOf, from, to])

  // GST paid to the government settles what the shop collected for it — it is not a running cost, so it stays out of profit.
  const periodExpenses = round2(expenses.filter((e) => e.category !== GST_PAYMENT_CATEGORY).reduce((s, e) => s + e.amount, 0))
  const gstPaid = round2(expenses.filter((e) => e.category === GST_PAYMENT_CATEGORY).reduce((s, e) => s + e.amount, 0))
  const grossProfit = round2(agg.net - agg.cogs)
  const netProfit = round2(grossProfit - periodExpenses)
  const gstRows = useMemo(() => hsnSummary(agg.lines), [agg.lines])
  // Includes people who have since been removed, so the staff rows always add up to the period's sales.
  const staffRows = useMemo(() => [...agg.staff.entries()].map(([uid, s]) => ({
    user: users.find((u) => u.id === uid) ?? ({ id: uid, name: 'Removed staff', role: 'cashier', pin: '', active: false } as User),
    bills: s.bills, qty: s.qty, revenue: round2(s.revenue), discount: round2(s.discount),
  })).filter((r) => r.bills > 0 || r.revenue !== 0).sort((a, b) => b.revenue - a.revenue), [users, agg.staff])

  const [itemQ, setItemQ] = useState('')
  const itemNeedle = useDebounced(itemQ.trim().toLowerCase(), 120)
  const [itemLimit, setItemLimit] = useState(100)
  useEffect(() => setItemLimit(100), [itemNeedle, range])
  const itemRows = useMemo(() => !itemNeedle ? agg.items
    : agg.items.filter((r) => r.name.toLowerCase().includes(itemNeedle) || r.sku.toLowerCase().includes(itemNeedle)), [agg.items, itemNeedle])

  const TABS: Array<{ value: Tab; label: string }> = [
    { value: 'sales', label: 'Sales' },
    { value: 'gst', label: 'GST / HSN' },
    ...(can('viewProfit') ? [{ value: 'profit' as Tab, label: 'Profit' }] : []),
    { value: 'items', label: 'Items' },
    { value: 'staff', label: 'Staff' },
    { value: 'dayclose', label: 'Day close' },
  ]
  useEffect(() => { if (!TABS.some((t) => t.value === tab)) setTab('sales') }) // eslint-disable-line react-hooks/exhaustive-deps

  const periodLabel = range === 'all' ? 'All time' : `${fmtDate(from)} – ${fmtDate(to)}`

  // The same table feeds the CSV export and the printed page, so they never disagree.
  const table: TableData | null = useMemo(() => {
    if (tab === 'sales') return {
      title: 'Sales report',
      cols: [{ key: 'date', label: 'Date' }, { key: 'bills', label: 'Bills', num: true }, { key: 'pieces', label: 'Pieces', num: true }, { key: 'sales', label: 'Sales', money: true }],
      rows: agg.daily.filter((d) => d.bills > 0 || d.total !== 0).map((d) => ({ date: fmtDate(d.start), bills: d.bills, pieces: d.qty, sales: d.total })),
      footer: `Net sales ${inr(agg.revenue)} (excluding GST ${inr(agg.net)}) across ${agg.positive} bills.`,
    }
    if (tab === 'gst') return {
      title: 'GST summary — HSN wise',
      cols: [{ key: 'hsn', label: 'HSN' }, { key: 'rate', label: 'GST rate', num: true }, { key: 'uqc', label: 'UQC' }, { key: 'qty', label: 'Qty', num: true }, { key: 'taxable', label: 'Taxable value', money: true }, { key: 'cgst', label: 'CGST', money: true }, { key: 'sgst', label: 'SGST', money: true }, { key: 'tax', label: 'Total tax', money: true }, { key: 'value', label: 'Total value', money: true }],
      rows: gstRows.map((r) => ({ hsn: r.hsn, rate: `${r.rate}%`, uqc: 'NOS', qty: r.qty, taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, tax: round2(r.cgst + r.sgst), value: round2(r.taxable + r.cgst + r.sgst) })),
      footer: settings?.gstin ? `GSTIN ${settings.gstin}` : undefined,
    }
    if (tab === 'items') return {
      title: 'Item performance',
      cols: [{ key: 'item', label: 'Item' }, { key: 'sku', label: 'SKU' }, { key: 'variant', label: 'Variant' }, { key: 'pieces', label: 'Pieces', num: true }, { key: 'revenue', label: 'Sales (excl. GST)', money: true },
        ...(can('viewProfit') ? [{ key: 'cost', label: 'Cost', money: true }, { key: 'margin', label: 'Margin', money: true }] : [])],
      rows: itemRows.map((r) => ({ item: r.name, sku: r.sku, variant: r.variant, pieces: r.qty, revenue: r.revenue, cost: r.cost, margin: round2(r.revenue - r.cost) })),
    }
    if (tab === 'staff') return {
      title: 'Staff performance',
      cols: [{ key: 'staff', label: 'Staff' }, { key: 'role', label: 'Role' }, { key: 'bills', label: 'Bills', num: true }, { key: 'pieces', label: 'Pieces', num: true }, { key: 'revenue', label: 'Sales', money: true }, { key: 'discount', label: 'Discount given', money: true }],
      rows: staffRows.map((r) => ({ staff: r.user.name, role: r.user.role, bills: r.bills, pieces: r.qty, revenue: r.revenue, discount: r.discount })),
    }
    if (tab === 'profit') return {
      title: 'Profit & loss',
      cols: [{ key: 'line', label: 'Particulars' }, { key: 'amount', label: 'Amount', money: true }],
      rows: [
        { line: 'Sales excluding GST (net of returns)', amount: agg.net }, { line: 'Less: cost of goods sold', amount: -agg.cogs },
        { line: 'Gross profit', amount: grossProfit }, { line: 'Less: operating expenses', amount: -periodExpenses }, { line: 'Net profit', amount: netProfit },
      ],
    }
    return null
  }, [tab, agg, gstRows, itemRows, staffRows, grossProfit, periodExpenses, netProfit, settings?.gstin, can])

  function exportCsv() {
    if (!table) return
    downloadFile(`${tab}-${range}.csv`, toCSV(table.rows.map((r) => Object.fromEntries(table.cols.map((c) => [c.label, r[c.key] ?? ''])))))
    toast('Report exported', 'ok')
  }
  function printReport() {
    if (!table) return
    print(<ReportPrint store={settings?.name ?? ''} title={table.title} period={periodLabel} cols={table.cols} rows={table.rows} footer={table.footer} />)
  }

  const modeTotal = agg.modes.reduce((s, [, v]) => s + Math.max(0, v), 0) || 1

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Reports</h1>
        <div className="grow" />
        <Segmented value={tab} options={TABS} onChange={setTab} />
        {tab !== 'dayclose' && (
          <>
            <Segmented value={range} options={RANGE_OPTIONS} onChange={setRange} />
            <button className="btn" onClick={exportCsv} disabled={!table?.rows.length}><Download size={15} /> Export CSV</button>
            <button className="btn btn-dark" onClick={printReport} disabled={!table?.rows.length}><Printer size={15} /> Print</button>
          </>
        )}
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          {tab === 'sales' && (
            <>
              <div className="stat-grid">
                <Stat label="Net sales" value={inr(agg.revenue)} icon={<RupeeIcon />} tone="brand" foot={`${agg.positive} bills · ${inr(agg.net)} excl. GST`} />
                <Stat label="Average bill" value={inr(agg.positive ? round2(agg.positiveTotal / agg.positive) : 0)} icon={<BillsIcon />} tone="ok" foot={`${agg.qty} pieces, net of returns`} />
                <Stat label="Discount given" value={inr(agg.discount)} icon={<PercentIcon />} tone="warn" foot={`${agg.revenue ? Math.round((agg.discount / (agg.revenue + agg.discount)) * 100) : 0}% of gross`} />
                <Stat label="Returns" value={inr(Math.abs(agg.creditTotal))} icon={<RotateIcon />} tone="danger" foot={`${agg.credits} credit notes`} />
              </div>

              <section className="card">
                <div className="card-head"><h2>Daily sales</h2><span className="small muted">{periodLabel}</span></div>
                <div className="card-body">
                  {!agg.positive ? <Empty icon={<TrendUp size={24} />} title="No sales in this period" /> : (
                    <TrendChart
                      points={agg.daily.map((d) => ({ label: fmtDayShort(d.start), value: d.total, note: `${d.bills} bill${d.bills === 1 ? '' : 's'}` }))}
                      format={inr} axisFormat={inrShort} height={240} />
                  )}
                </div>
              </section>

              <div className="grid grid-2">
                <section className="card">
                  <div className="card-head"><h2>How customers paid</h2></div>
                  <div className="card-body">
                    {!agg.modes.length ? <div className="small muted">No payments in this period.</div> : (
                      <>
                        <div className="split-bar" role="img" aria-label="Payment mix">
                          {agg.modes.map(([m, v]) => <i key={m} style={{ width: `${(Math.max(0, v) / modeTotal) * 100}%`, background: MODE_COLOR[m] ?? 'var(--ink-400)' }} />)}
                        </div>
                        <ul className="legend">
                          {agg.modes.map(([m, v]) => (
                            <li key={m}>
                              <i style={{ background: MODE_COLOR[m] ?? 'var(--ink-400)' }} />
                              <span className="bold" style={{ textTransform: 'capitalize' }}>{m}</span>
                              <span className="grow" />
                              <span className="num">{inr(v)}</span>
                              <span className="muted small num" style={{ width: 38, textAlign: 'right' }}>{Math.round((Math.max(0, v) / modeTotal) * 100)}%</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                </section>
                <section className="card">
                  <div className="card-head"><h2>Day by day</h2></div>
                  <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
                    <table className="tbl">
                      <thead><tr><th>Date</th><th className="num">Bills</th><th className="num">Pieces</th><th className="num">Sales</th></tr></thead>
                      <tbody>
                        {[...agg.daily].reverse().map((d) => (
                          <tr key={d.start}><td>{fmtDate(d.start)}</td><td className="num">{d.bills}</td><td className="num">{d.qty}</td><td className="num bold">{inr(d.total)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </>
          )}

          {tab === 'gst' && (
            <section className="card">
              <div className="card-head"><h2>GST summary — HSN wise</h2><span className="small muted">{settings?.gstin ? `GSTIN ${settings.gstin} · ` : ''}{periodLabel}</span></div>
              {!gstRows.length ? <Empty icon={<BillsIcon size={24} />} title="No taxable sales in this period" /> : (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead><tr><th>HSN</th><th className="num">GST rate</th><th className="num">Qty</th><th className="num">Taxable value</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">Total tax</th></tr></thead>
                    <tbody>
                      {gstRows.map((r, i) => (
                        <tr key={i}>
                          <td className="mono bold">{r.hsn}</td><td className="num">{r.rate}%</td><td className="num">{r.qty}</td>
                          <td className="num">{inr(r.taxable)}</td><td className="num">{inr(r.cgst)}</td><td className="num">{inr(r.sgst)}</td>
                          <td className="num bold">{inr(round2(r.cgst + r.sgst))}</td>
                        </tr>
                      ))}
                      <tr style={{ background: '#eaeef6' }}>
                        <td colSpan={3} className="bold">Total</td>
                        <td className="num bold">{inr(round2(gstRows.reduce((s, r) => s + r.taxable, 0)))}</td>
                        <td className="num bold">{inr(round2(gstRows.reduce((s, r) => s + r.cgst, 0)))}</td>
                        <td className="num bold">{inr(round2(gstRows.reduce((s, r) => s + r.sgst, 0)))}</td>
                        <td className="num bold">{inr(round2(gstRows.reduce((s, r) => s + r.cgst + r.sgst, 0)))}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="small muted" style={{ padding: 12 }}>
                    Apparel is taxed at {settings?.slabs.map((s) => `${s.rate}%`).join(' / ')} depending on the per-piece value. This is the summary your accountant needs for GSTR-1.
                  </div>
                </div>
              )}
            </section>
          )}

          {tab === 'profit' && can('viewProfit') && (
            <>
              <div className="stat-grid">
                <Stat label="Sales (excl. GST)" value={inr(agg.net)} icon={<RupeeIcon />} tone="ok" foot={`${inr(agg.gst)} GST collected on top`} />
                <Stat label="Cost of goods sold" value={inr(agg.cogs)} icon={<BoxesIcon />} tone="warn" foot="At purchase cost" />
                <Stat label="Gross profit" value={inr(grossProfit)} icon={<TrendUp />} tone="brand" foot={`${agg.net ? Math.round((grossProfit / agg.net) * 100) : 0}% margin`} />
                <Stat label="Net profit" value={inr(netProfit)} icon={<PercentIcon />} tone={netProfit >= 0 ? 'ok' : 'danger'} foot={`After ${inr(periodExpenses)} expenses`} />
              </div>
              <section className="card">
                <div className="card-head"><h2>Profit &amp; loss</h2><span className="small muted">{periodLabel}</span></div>
                <table className="tbl">
                  <tbody>
                    <tr><td>Sales excluding GST <span className="small muted">(net of returns)</span></td><td className="num bold">{inr(agg.net)}</td></tr>
                    <tr><td>Less: cost of goods sold</td><td className="num">− {inr(agg.cogs)}</td></tr>
                    <tr style={{ background: '#eaeef6' }}><td className="bold">Gross profit</td><td className="num bold">{inr(grossProfit)}</td></tr>
                    <tr><td>Less: operating expenses</td><td className="num">− {inr(periodExpenses)}</td></tr>
                    <tr style={{ background: netProfit >= 0 ? 'var(--ok-bg)' : 'var(--danger-bg)' }}>
                      <td className="bold">Net profit</td>
                      <td className="num bold" style={{ color: netProfit >= 0 ? 'var(--ok)' : 'var(--danger)', fontSize: 16 }}>{inr(netProfit)}</td>
                    </tr>
                    <tr><td className="muted">Discount given away</td><td className="num muted">{inr(agg.discount)}</td></tr>
                    <tr><td className="muted">Customers paid in total <span className="small">(includes {inr(agg.gst)} GST held for the government)</span></td><td className="num muted">{inr(agg.revenue)}</td></tr>
                    {gstPaid > 0 && <tr><td className="muted">GST paid to the government in this period <span className="small">(not an expense)</span></td><td className="num muted">{inr(gstPaid)}</td></tr>}
                  </tbody>
                </table>
              </section>
            </>
          )}

          {tab === 'items' && (
            <>
              <div className="bills-filters">
                <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
                  <span className="ico"><Search /></span>
                  <input className="input" placeholder="Search item or SKU" value={itemQ} onChange={(e) => setItemQ(e.target.value)} />
                </div>
                <div className="grow" />
                <span className="small muted"><b className="num">{itemRows.length}</b> SKUs sold · {periodLabel}</span>
              </div>
              <section className="card">
                {!itemRows.length ? <Empty icon={<TrendUp size={24} />} title={itemNeedle ? 'No items match' : 'Nothing sold in this period'} /> : (
                  <div className="table-wrap" style={{ maxHeight: '64vh', overflowY: 'auto' }}>
                    <table className="tbl">
                      <thead><tr><th>Item</th><th>Variant</th><th className="num">Pieces</th><th className="num">Sales (excl. GST)</th>{can('viewProfit') && <><th className="num">Cost</th><th className="num">Margin</th></>}<th>Share</th></tr></thead>
                      <tbody>
                        {itemRows.slice(0, itemLimit).map((r, i) => (
                          <tr key={i}>
                            <td><div className="bold">{r.name}</div><div className="small muted mono">{r.sku}</div></td>
                            <td>{r.variant}</td>
                            <td className="num bold">{r.qty}</td>
                            <td className="num">{inr(r.revenue)}</td>
                            {can('viewProfit') && <>
                              <td className="num muted">{inr(r.cost)}</td>
                              <td className="num" style={{ color: r.revenue - r.cost >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{inr(round2(r.revenue - r.cost))}</td>
                            </>}
                            <td style={{ width: 120 }}><div className="bar-track"><div className="bar-fill accent" style={{ width: `${(Math.max(0, r.qty) / Math.max(1, itemRows[0].qty)) * 100}%` }} /></div></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {itemRows.length > itemLimit && <div className="center" style={{ padding: 14 }}><button className="btn" onClick={() => setItemLimit((l) => l + 100)}>Show {Math.min(100, itemRows.length - itemLimit)} more</button></div>}
                  </div>
                )}
              </section>
            </>
          )}

          {tab === 'staff' && (
            <section className="card">
              <div className="card-head"><h2>Staff performance</h2><span className="small muted">{periodLabel}</span></div>
              {!staffRows.length ? <Empty title="No sales in this period" /> : (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead><tr><th>Staff</th><th>Role</th><th className="num">Bills</th><th className="num">Pieces</th><th className="num">Sales</th><th className="num">Avg bill</th><th className="num">Discount given</th></tr></thead>
                    <tbody>
                      {staffRows.map((r) => (
                        <tr key={r.user.id}>
                          <td className="bold">{r.user.name}</td>
                          <td style={{ textTransform: 'capitalize' }}>{r.user.role}</td>
                          <td className="num">{r.bills}</td><td className="num">{r.qty}</td>
                          <td className="num bold">{inr(r.revenue)}</td>
                          <td className="num">{inr(r.bills ? round2(r.revenue / r.bills) : 0)}</td>
                          <td className="num" style={{ color: 'var(--warn)' }}>{inr(r.discount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {tab === 'dayclose' && <DayClose />}
        </div>
      </div>
    </div>
  )
}

/**
 * Z-report: what should be in the cash drawer at close, versus what was counted.
 *
 * A "day" is a session: the owner counts the opening cash and opens it, sells, then counts again and closes it.
 * A closed session is frozen — only sales and expenses between its opening and closing are used, so its figures
 * never change after the fact.
 */
function DayClose() {
  const { toast, user, settings } = useApp()
  const { print } = usePrint()
  const session = useLiveQuery(() => db.sessions.orderBy('openedAt').reverse().first(), [], undefined)
  const isOpen = !!session && !session.closedAt
  const closed = !!session?.closedAt
  const dayStart = session?.openedAt ?? startOfDay()
  const dayEnd = session?.closedAt ?? Number.POSITIVE_INFINITY

  const today = useLiveQuery(
    () => db.bills.where('date').aboveOrEqual(dayStart).toArray().then((l) => l.filter((b) => b.status !== 'held' && b.date <= dayEnd)),
    [dayStart, dayEnd], [] as Bill[]) ?? []
  const cashExpenses = useLiveQuery(async () => {
    let s = 0
    await db.expenses.where('date').aboveOrEqual(dayStart).each((e) => { if (e.mode === 'cash' && e.date <= dayEnd) s += e.amount })
    return round2(s)
  }, [dayStart, dayEnd], 0) ?? 0

  const [counted, setCounted] = useState('')
  const [openingInput, setOpeningInput] = useState('')
  const [confirming, setConfirming] = useState(false)

  // Cash payments already net of change given back, and a cash refund on a return is a negative cash payment.
  const cashIn = round2(today.reduce((s, b) => s + b.payments.filter((p) => p.mode === 'cash').reduce((t, p) => t + p.amount, 0), 0))
  const digital = round2(today.reduce((s, b) => s + b.payments.filter((p) => p.mode === 'upi' || p.mode === 'card').reduce((t, p) => t + p.amount, 0), 0))
  const opening = session?.openingCash ?? 0
  const expected = round2(opening + cashIn - cashExpenses)
  const variance = round2((Number(counted) || 0) - expected)

  async function openDay() {
    const cash = Number(openingInput)
    if (openingInput === '' || !Number.isFinite(cash) || cash < 0) { toast('Enter the cash in the drawer to open the day (0 if empty)', 'err'); return }
    await db.sessions.add({ id: id('ses'), openedAt: Date.now(), openedBy: user?.id ?? '', openingCash: round2(cash) })
    setOpeningInput(''); setCounted('')
    toast('Day opened', 'ok')
  }

  async function close() {
    if (!session || !isOpen) { toast('No open day to close', 'err'); return }
    await db.sessions.update(session.id, { closedAt: Date.now(), closedBy: user?.id, countedCash: Number(counted) || 0, expectedCash: expected, variance })
    setCounted('')
    toast('Day closed — Z report saved', 'ok')
  }

  function printZ() {
    print(<ReportPrint store={settings?.name ?? ''} title="Day close (Z report)" period={new Date(dayStart).toLocaleString('en-IN')}
      cols={[{ key: 'line', label: 'Particulars' }, { key: 'amount', label: 'Amount', money: true }]}
      rows={[
        { line: 'Opening cash', amount: opening }, { line: '+ Cash received (net of cash refunds)', amount: cashIn }, { line: '− Cash expenses paid out', amount: -cashExpenses },
        { line: 'Expected in drawer', amount: expected },
        ...(closed || counted !== '' ? [{ line: 'Cash counted', amount: session?.countedCash ?? (Number(counted) || 0) }, { line: (session?.variance ?? variance) === 0 ? 'Drawer tallies' : (session?.variance ?? variance) > 0 ? 'Excess cash' : 'Short', amount: Math.abs(session?.variance ?? variance) }] : []),
        { line: 'Card + UPI collected', amount: digital },
      ]} />)
  }

  const openForm = (
    <>
      <div className="small muted" style={{ marginBottom: 10 }}>
        {closed ? 'This day is closed. To start the next one, count the cash in the drawer and enter it.' : 'No day is open yet. Count the cash in the drawer and enter it to start the day — the closing count is checked against it.'}
      </div>
      <label className="field">
        <span>Opening cash in drawer</span>
        <input className="input input-lg num" inputMode="decimal" value={openingInput} placeholder="0"
          onChange={(e) => setOpeningInput(e.target.value.replace(/[^\d.]/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') void openDay() }} />
      </label>
      <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 12 }} disabled={openingInput === ''} onClick={() => void openDay()}>Open the day</button>
    </>
  )

  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-head">
          <h2>Cash drawer</h2>
          {closed ? <span className="badge badge-ok">Closed {new Date(session!.closedAt!).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
            : isOpen ? <span className="badge badge-warn">Open</span> : <span className="badge">Not open</span>}
        </div>
        <div className="card-body">
          {session && (
            <table className="tbl">
              <tbody>
                <tr><td>Opening cash</td><td className="num">{inr(opening)}</td></tr>
                <tr><td>+ Cash received <span className="small muted">(net of cash refunds)</span></td><td className="num">{inr(cashIn)}</td></tr>
                <tr><td>− Cash expenses paid out</td><td className="num">− {inr(cashExpenses)}</td></tr>
                <tr style={{ background: '#eaeef6' }}><td className="bold">Expected in drawer</td><td className="num bold">{inr(expected)}</td></tr>
              </tbody>
            </table>
          )}

          {isOpen && (
            <>
              <div style={{ marginTop: 14 }}>
                <label className="field">
                  <span>Cash counted at close</span>
                  <input className="input input-lg num" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0"
                    onKeyDown={(e) => { if (e.key === 'Enter' && counted !== '') setConfirming(true) }} />
                </label>
              </div>
              <div className={`pay-banner ${counted === '' ? 'exact' : variance === 0 ? 'change' : 'short'}`} style={{ marginTop: 12 }} aria-live="polite">
                {counted === '' ? <span>Count the cash in the drawer and enter it above.</span> : variance === 0 ? <span>Drawer tallies</span>
                  : <><span>{variance > 0 ? 'Excess cash' : 'Short'}</span><b className="num">{inr(Math.abs(variance))}</b></>}
              </div>
              <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 14 }} disabled={counted === ''} onClick={() => setConfirming(true)}>Close the day</button>
              <div className="small muted" style={{ marginTop: 10 }}>
                Cash paid to suppliers or taken out of the drawer should be entered as a cash expense, otherwise the drawer will show short.
              </div>
            </>
          )}

          {closed && (
            <div className={`pay-banner ${(session!.variance ?? 0) === 0 ? 'change' : 'short'}`} style={{ marginTop: 14 }}>
              <span>Counted {inr(session!.countedCash ?? 0)} · {(session!.variance ?? 0) === 0 ? 'drawer tallied' : (session!.variance ?? 0) > 0 ? 'excess' : 'short by'}</span>
              {(session!.variance ?? 0) !== 0 && <b className="num">{inr(Math.abs(session!.variance ?? 0))}</b>}
            </div>
          )}

          {!isOpen && <div style={{ marginTop: session ? 18 : 0 }}>{openForm}</div>}

          {session && <button className="btn btn-block" style={{ marginTop: 10 }} onClick={printZ}><Printer size={15} /> Print Z report</button>}
        </div>
      </section>

      <section className="card" style={{ alignSelf: 'start' }}>
        <div className="card-head"><h2>{closed ? 'That day at a glance' : 'Today at a glance'}</h2></div>
        <div className="card-body">
          <div className="grid grid-2">
            <Stat label="Bills" value={today.filter((b) => b.total >= 0).length} icon={<BillsIcon />} />
            <Stat label="Total sales" value={inr(round2(today.reduce((s, b) => s + b.total, 0)))} icon={<RupeeIcon />} tone="ok" foot="net of returns" />
            <Stat label="Cash received" value={inr(cashIn)} icon={<CashIcon />} tone="warn" />
            <Stat label="Card + UPI" value={inr(digital)} icon={<CardIcon />} tone="brand" />
          </div>
          <div className="small muted" style={{ marginTop: 12 }}>
            {session ? <>Opened {new Date(dayStart).toLocaleString('en-IN')}</> : <>Showing sales since midnight</>}
            {session?.closedAt && <> · closed {new Date(session.closedAt).toLocaleString('en-IN')}</>}
          </div>
        </div>
      </section>

      <Confirm
        open={confirming}
        title="Close the day?"
        danger={variance !== 0}
        confirmLabel="Close the day"
        message={<>Expected <strong>{inr(expected)}</strong>, counted <strong>{inr(Number(counted) || 0)}</strong> — {variance === 0 ? 'the drawer tallies.' : <strong style={{ color: 'var(--danger)' }}>{variance > 0 ? `${inr(variance)} extra` : `${inr(Math.abs(variance))} short`}.</strong>} This saves the Z report and can't be undone.</>}
        onConfirm={() => void close()}
        onClose={() => setConfirming(false)}
      />
    </div>
  )
}
