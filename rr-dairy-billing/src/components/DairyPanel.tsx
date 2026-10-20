import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { loadDairyDashboard } from '../lib/dairyData'
import { inr, inrShort } from '../lib/money'
import { fmtDayShort, fmtDateTime, type RangeKey } from '../lib/dates'
import { Card, Empty, Stat } from './ui'
import { TrendChart } from './charts'
import { AlertIcon, ArrowRight, BoxesIcon, CheckCircle, InventoryIcon, TrendUp, UserIcon } from './icons'
import { useApp } from '../state'

type Shift = { litres: number; amount: number; avgFat: number; avgSnf: number; farmers: number }

function ShiftCard({ title, s, active, total }: { title: string; s: Shift; active: boolean; total: number }) {
  return (
    <div className="shift-card">
      <div className="head">
        <span className="bold">{title}</span>
        {active && <span className="badge badge-brand"><i className="dot" />Current shift</span>}
      </div>
      <div className="big">{s.litres} <span className="muted small">litres</span></div>
      <div className="small muted">{s.farmers} of {total} farmers · {s.litres ? `Fat ${s.avgFat} · SNF ${s.avgSnf}` : 'No milk yet'} · {inr(s.amount)}</div>
    </div>
  )
}

/** The dairy half of the dashboard: today by shift, milk coming in, top suppliers, what is owed and what needs attention. */
export function DairyPanel({ range }: { range: RangeKey }) {
  const { can } = useApp()
  const d = useLiveQuery(() => loadDairyDashboard(range), [range])
  if (!d) return <div className="stat-grid" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="card skeleton" style={{ height: 124 }} />)}</div>
  const word = range === 'today' ? 'today' : range === '7d' ? 'last 7 days' : 'last 30 days'
  const attention = d.pending + d.expired.length + d.pendingWastage
  const morningNow = new Date().getHours() < 14
  const items: Array<{ to: string; label: string; n: number; tone: string; show: boolean }> = [
    { to: '/collection', label: 'Milk entries awaiting approval', n: d.pending, tone: 'warn', show: can('quality') },
    { to: '/lots', label: 'Expired lots to write off', n: d.expired.length, tone: 'danger', show: can('wastage') },
    { to: '/lots', label: 'Write-offs awaiting approval', n: d.pendingWastage, tone: 'warn', show: can('approveWastage') },
    { to: '/production', label: 'Production batches in progress', n: d.batchesInProgress, tone: 'brand', show: can('production') },
    { to: '/delivery', label: 'Deliveries still to complete', n: d.openDeliveries, tone: 'brand', show: can('delivery') },
  ]
  const topMax = d.topFarmers[0]?.litres || 1
  return (
    <>
      <div className="stat-grid">
        <Stat label={`Milk collected · ${word}`} value={`${d.totals.litres.toLocaleString('en-IN')} L`} icon={<InventoryIcon />} tone="brand"
          spark={d.series.map((s) => s.litres)} foot={`${d.totals.count} entries · ${inr(d.totals.amount)} paid for`} />
        <Stat label="Average Fat / SNF" value={d.totals.litres ? `${d.totals.avgFat} / ${d.totals.avgSnf}` : '—'} foot={d.totals.litres ? `Average ₹${d.totals.avgRate}/L` : 'No milk in this period'} />
        <Stat label="Today's collection" value={`${d.todayLitres} L`} foot="Morning + evening shifts" />
        <Stat label="Owed to farmers" value={inrShort(d.payable)} tone={d.payable ? 'warn' : 'ok'} foot={`${d.activeFarmers} active farmers`} />
      </div>

      <div className="grid grid-2">
        <ShiftCard title="Morning shift · today" s={d.morningShift} active={morningNow} total={d.activeFarmers} />
        <ShiftCard title="Evening shift · today" s={d.eveningShift} active={!morningNow} total={d.activeFarmers} />
      </div>

      <div className="grid split-2-1">
        <Card title={<span className="head-ico"><TrendUp size={16} /><h2>Milk collection trend</h2></span>} action={<span className="small muted">Litres per day</span>}>
          {d.series.length < 2 ? <Empty icon={<InventoryIcon size={24} />} title={d.hasFarmers ? 'Not enough collection yet' : 'No farmers yet'} hint={d.hasFarmers ? 'The trend appears after two days of approved collections.' : 'Add farmers, set a rate chart, then record collections.'} />
            : <TrendChart points={d.series.map((s) => ({ label: fmtDayShort(s.start), value: s.litres, note: 'litres' }))} format={(n) => `${n} L`} axisFormat={(n) => `${Math.round(n)}`} />}
        </Card>
        <Card title={<span className="head-ico"><AlertIcon size={16} /><h2>Needs attention</h2>{attention > 0 && <span className="badge badge-warn">{attention}</span>}</span>}>
          <div className="col gap-8">
            {items.filter((i) => i.show).map((i) => (
              <Link key={i.label} to={i.to} className="row between" style={{ gap: 8, textDecoration: 'none', color: 'inherit' }}>
                <span className="small">{i.label}</span>
                <span className={`badge ${i.n === 0 ? 'badge-ok' : i.tone === 'danger' ? 'badge-danger' : i.tone === 'warn' ? 'badge-warn' : 'badge-brand'}`}>{i.n}</span>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title={<span className="head-ico"><UserIcon size={16} /><h2>Top suppliers · {word}</h2></span>} action={can('collection') && <Link to="/farmers" className="btn btn-sm btn-ghost">Farmers <ArrowRight size={13} /></Link>}>
          {!d.topFarmers.length ? <div className="small muted">No approved milk in this period.</div> : (
            <div className="col gap-12">
              {d.topFarmers.map((f, i) => (
                <div key={f.farmerId}>
                  <div className="row between"><span className="small"><b>{i + 1}. {f.name}</b> <span className="muted">{f.code}{f.village ? ` · ${f.village}` : ''}</span></span><b className="num small">{f.litres} L</b></div>
                  <div className="bar" style={{ marginTop: 4 }}><i className="a" style={{ width: `${(f.litres / topMax) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {(d.expired.length > 0 || d.soon.length > 0) ? (
          <Card title={<span className="head-ico"><BoxesIcon size={16} /><h2>Expiry watch</h2></span>} action={can('stock') && <Link to="/lots" className="btn btn-sm btn-ghost">All lots <ArrowRight size={13} /></Link>} tight>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Item</th><th>Lot</th><th className="num">Qty</th><th>Expires</th></tr></thead>
                <tbody>{[...d.expired, ...d.soon].slice(0, 6).map((r) => (
                  <tr key={r.lot.id}><td className="bold">{r.name}</td><td className="mono small">{r.lot.lotNo}</td><td className="num">{r.lot.available}</td>
                    <td>{r.days <= 0 ? <span className="badge badge-danger"><i className="dot" />Expired</span> : <span className="badge badge-warn"><i className="dot" />{r.lot.expiresAt ? fmtDateTime(r.lot.expiresAt) : ''}</span>}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
        ) : (
          <Card title={<span className="head-ico"><BoxesIcon size={16} /><h2>Expiry watch</h2></span>}>
            <div className="small muted row gap-6"><CheckCircle size={15} /> No stock is expired or close to expiry.</div>
          </Card>
        )}
      </div>
    </>
  )
}
