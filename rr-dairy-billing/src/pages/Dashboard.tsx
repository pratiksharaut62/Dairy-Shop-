import { variantLabel } from '../lib/variantLabel'
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { inr, inrShort } from '../lib/money'
import { fmtDateTime, fmtDayShort } from '../lib/dates'
import { loadDashboard, type DashRange } from '../lib/dashboardData'
import { Card, Stat, StockBadge, Empty, Segmented, type StatDelta } from '../components/ui'
import { TrendChart } from '../components/charts'
import { DairyPanel } from '../components/DairyPanel'
import {
  AlertIcon, ArrowRight, BillingIcon, BillsIcon, BoxesIcon, CheckCircle, ExpensesIcon, InventoryIcon,
  PercentIcon, Plus, ReceiveIcon, ReportsIcon, RupeeIcon, StockIcon, TrendUp,
} from '../components/icons'
import { useApp } from '../state'
import type { Permission } from '../state'

const RANGES: Array<{ value: DashRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
]
const RANGE_WORD: Record<DashRange, string> = { today: 'today', '7d': 'last 7 days', '30d': 'last 30 days' }
const VS_WORD: Record<DashRange, string> = { today: 'vs same time yesterday', '7d': 'vs previous 7 days', '30d': 'vs previous 30 days' }

const MODE_COLOR: Record<string, string> = {
  cash: 'var(--ok)', upi: 'var(--brand)', card: 'var(--accent)', credit: 'var(--warn)',
}

/** Percentage change, guarding the divide-by-zero a first trading day produces. */
function delta(current: number, previous: number, label: string, invert = false): StatDelta | null {
  if (!previous) return null
  return { pct: ((current - previous) / Math.abs(previous)) * 100, label, invert }
}

const greeting = () => {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const QUICK: Array<{ to: string; label: string; icon: JSX.Element; perm: Permission; primary?: boolean; hint?: string }> = [
  { to: '/pos', label: 'New bill', icon: <Plus size={16} />, perm: 'pos', primary: true, hint: 'F1' },
  { to: '/collection', label: 'Milk collection', icon: <InventoryIcon />, perm: 'collection' },
  { to: '/inventory', label: 'Add product', icon: <InventoryIcon />, perm: 'inventory' },
  { to: '/purchases', label: 'Receive stock', icon: <ReceiveIcon />, perm: 'purchases' },
  { to: '/expenses', label: 'Add expense', icon: <ExpensesIcon />, perm: 'expenses' },
  { to: '/reports', label: 'Reports', icon: <ReportsIcon />, perm: 'reports' },
]

function DashboardSkeleton() {
  return (
    <div className="col gap-16" aria-busy="true" aria-label="Loading dashboard">
      <div className="stat-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="card skeleton" style={{ height: 124 }} />)}</div>
      <div className="grid split-2-1">
        <div className="card skeleton" style={{ height: 300 }} />
        <div className="card skeleton" style={{ height: 300 }} />
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { settings, user, can } = useApp()
  const [range, setRange] = useState<DashRange>('today')
  // undefined until the first result lands → skeleton, not a flash of zeros.
  const data = useLiveQuery(() => loadDashboard(range), [range])

  const firstName = (user?.name ?? '').split(' ')[0]
  const quick = QUICK.filter((q) => can(q.perm))

  return (
    <>
      <header className="topbar dash-head">
        <div style={{ minWidth: 0 }}>
          <h1>{greeting()}{firstName ? `, ${firstName}` : ''}</h1>
          <div className="small muted">
            {settings?.name} · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
        </div>
        <div className="grow" />
        <Segmented value={range} options={RANGES} onChange={setRange} />
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          {quick.length > 0 && (
            <div className="quick-actions" role="group" aria-label="Quick actions">
              {quick.map((q) => (
                <Link key={q.to} to={q.to} className={`btn ${q.primary ? 'btn-primary btn-lg' : ''}`}>
                  {q.icon} {q.label}
                  {q.hint && <span className="kbd" style={{ background: 'rgba(255,255,255,.18)', borderColor: 'transparent', color: '#fff' }}>{q.hint}</span>}
                </Link>
              ))}
            </div>
          )}

          {!data ? <DashboardSkeleton /> : (
            <>
              <DairyPanel range={range} />

              <div className="stat-grid">
                <Stat
                  label={`Sales · ${RANGE_WORD[range]}`}
                  value={inr(data.cur.sales)}
                  icon={<RupeeIcon />}
                  tone="brand"
                  spark={data.series.map((s) => s.total)}
                  delta={delta(data.cur.sales, data.prev.sales, VS_WORD[range])}
                  foot={`${data.cur.bills} bills`}
                />
                <Stat
                  label="Average bill"
                  value={inr(data.cur.bills ? data.cur.sales / data.cur.bills : 0)}
                  icon={<BillsIcon />}
                  delta={delta(
                    data.cur.bills ? data.cur.sales / data.cur.bills : 0,
                    data.prev.bills ? data.prev.sales / data.prev.bills : 0,
                    VS_WORD[range],
                  )}
                  foot="Per customer"
                />
                {can('viewProfit') ? (
                  <Stat
                    label={`Profit · ${RANGE_WORD[range]}`}
                    value={inr(data.cur.profit)}
                    icon={<PercentIcon />}
                    tone={data.cur.profit >= 0 ? 'ok' : 'danger'}
                    delta={delta(data.cur.profit, data.prev.profit, VS_WORD[range])}
                    foot={`After ${inrShort(data.cur.cost)} cost and ${inrShort(data.cur.expenses)} expenses`}
                  />
                ) : (
                  <Stat
                    label="Reorder alerts"
                    value={data.stock.lowCount}
                    icon={<AlertIcon />}
                    tone={data.stock.lowCount ? 'warn' : 'ok'}
                    foot={`${data.stock.outOfStock} are out of stock`}
                  />
                )}
                <Stat
                  label="Stock on hand"
                  value={inrShort(data.stock.value)}
                  icon={<BoxesIcon />}
                  tone={data.stock.outOfStock ? 'warn' : 'neutral'}
                  foot={`${data.stock.units.toLocaleString('en-IN')} units at cost · ${data.stock.outOfStock} packs out`}
                />
              </div>

              <div className="grid split-2-1">
                <Card
                  title={<span className="head-ico"><TrendUp size={16} /><h2>Sales trend</h2></span>}
                  action={<span className="small muted">Last {data.series.length} days</span>}
                >
                  {!data.hasAnyBills ? (
                    <Empty icon={<BillingIcon size={24} />} title="No sales yet"
                      hint="Your first bill will start the trend line." />
                  ) : (
                    <TrendChart
                      points={data.series.map((s) => ({ label: fmtDayShort(s.start), value: s.total, note: `${s.bills} bill${s.bills === 1 ? '' : 's'}` }))}
                      format={inr}
                      axisFormat={inrShort}
                    />
                  )}
                </Card>

                <Card title={<span className="head-ico"><RupeeIcon size={16} /><h2>How customers paid</h2></span>}
                  action={<span className="small muted">{RANGE_WORD[range]}</span>}>
                  {!data.byMode.length
                    ? <div className="small muted">No payments collected {range === 'today' ? 'yet today' : 'in this period'}.</div>
                    : (() => {
                      const total = data.byMode.reduce((s, [, v]) => s + Math.max(0, v), 0) || 1
                      return (
                        <>
                          <div className="split-bar" role="img" aria-label="Payment mix">
                            {data.byMode.map(([m, v]) => (
                              <i key={m} style={{ width: `${(Math.max(0, v) / total) * 100}%`, background: MODE_COLOR[m] ?? 'var(--ink-400)' }} />
                            ))}
                          </div>
                          <ul className="legend">
                            {data.byMode.map(([m, v]) => (
                              <li key={m}>
                                <i style={{ background: MODE_COLOR[m] ?? 'var(--ink-400)' }} />
                                <span className="bold" style={{ textTransform: 'capitalize' }}>{m}</span>
                                <span className="grow" />
                                <span className="num">{inr(v)}</span>
                                <span className="muted small num" style={{ width: 38, textAlign: 'right' }}>{Math.round((Math.max(0, v) / total) * 100)}%</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )
                    })()}
                </Card>
              </div>

              <div className="grid grid-2">
                <Card
                  title={<span className="head-ico"><StockIcon size={16} /><h2>Needs attention</h2>{data.stock.lowCount > 0 && <span className="badge badge-warn">{data.stock.lowCount}</span>}</span>}
                  action={can('stock') && <Link to="/stock" className="btn btn-sm btn-ghost">Stock control <ArrowRight size={13} /></Link>}
                  tight
                >
                  {!data.stock.low.length
                    ? <Empty icon={<CheckCircle size={24} />} title="Everything is well stocked" />
                    : (
                      <div className="table-wrap">
                        <table className="tbl">
                          <thead><tr><th>Item</th><th>Pack</th><th className="num">Status</th></tr></thead>
                          <tbody>
                            {data.stock.low.map((v) => (
                              <tr key={v.id}>
                                <td><div className="bold">{v.name}</div><div className="small muted mono">{v.sku}</div></td>
                                <td>{variantLabel(v.size, v.color)}</td>
                                <td className="right"><StockBadge stock={v.stock} reorder={v.reorderLevel} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {data.stock.lowCount > data.stock.low.length && (
                          <div className="small muted center" style={{ padding: '10px 0' }}>
                            {data.stock.lowCount - data.stock.low.length} more packs below their reorder level.
                          </div>
                        )}
                      </div>
                    )}
                </Card>

                <Card title={<span className="head-ico"><BoxesIcon size={16} /><h2>Top sellers</h2></span>}
                  action={<span className="small muted">{RANGE_WORD[range]}</span>}>
                  {!data.topItems.length ? <Empty title="No sales in this period" /> : (
                    <ol className="rank">
                      {data.topItems.map((t, i) => (
                        <li key={t.name}>
                          <span className="rank-n">{i + 1}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="row between">
                              <span className="bold rank-name">{t.name}</span>
                              <span className="num small muted nowrap">{t.qty} units · {inr(t.value)}</span>
                            </div>
                            <div className="bar-track" style={{ marginTop: 6 }}>
                              <div className="bar-fill accent" style={{ width: `${(t.qty / data.topItems[0].qty) * 100}%` }} />
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>
              </div>

              <Card
                title={<span className="head-ico"><BillingIcon size={16} /><h2>Recent bills</h2></span>}
                action={<Link to="/bills" className="btn btn-sm btn-ghost">All bills <ArrowRight size={13} /></Link>}
                tight
              >
                {!data.recent.length ? <Empty title="No bills yet" hint="Press F1 to start billing." /> : (
                  <div className="table-wrap">
                    <table className="tbl">
                      <thead><tr><th>Bill</th><th>Date &amp; time</th><th className="num">Items</th><th>Payment</th><th className="num">Amount</th></tr></thead>
                      <tbody>
                        {data.recent.map((b) => (
                          <tr key={b.id}>
                            <td className="mono bold">{b.no}</td>
                            <td className="muted">{fmtDateTime(b.date)}</td>
                            <td className="num">{b.items.reduce((s, i) => s + i.qty, 0)}</td>
                            <td><span className="badge">{b.payments.map((p) => p.mode).join(' + ') || '—'}</span></td>
                            <td className="num bold" style={{ color: b.total < 0 ? 'var(--danger)' : undefined }}>{inr(b.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  )
}
