import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { createRateChart } from '../db/dairy'
import { MILK_LABEL, chartFor, generateGrid, slabFor } from '../lib/milkRate'
import { fmtDate, fromInputDate, toInputDate } from '../lib/dates'
import { Card, Empty, Field, Modal, Segmented } from '../components/ui'
import { Plus, ReportsIcon } from '../components/icons'
import { useApp } from '../state'
import type { MilkType, RateChart as Chart, RateSlab } from '../db/types'

const MILK: Array<{ value: MilkType; label: string }> = [{ value: 'cow', label: 'Cow' }, { value: 'buffalo', label: 'Buffalo' }, { value: 'mixed', label: 'Mixed' }]
const DEFAULTS: Record<MilkType, { fatFrom: string; snfFrom: string; base: string }> = {
  cow: { fatFrom: '3', snfFrom: '8', base: '28' },
  buffalo: { fatFrom: '5', snfFrom: '8.5', base: '40' },
  mixed: { fatFrom: '4', snfFrom: '8.2', base: '34' },
}

export default function RateChartPage() {
  const { can } = useApp()
  const charts = useLiveQuery(() => db.rateCharts.toArray(), [], [] as Chart[]) ?? []
  const [adding, setAdding] = useState(false)
  const [viewId, setViewId] = useState<string | null>(null)
  const sorted = useMemo(() => [...charts].sort((a, b) => b.effectiveFrom - a.effectiveFrom), [charts])
  const now = Date.now()
  const inForce = new Set((['cow', 'buffalo', 'mixed'] as MilkType[]).map((m) => chartFor(charts, m, now)?.id).filter(Boolean) as string[])
  const view = charts.find((c) => c.id === viewId) ?? null

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Rate chart</h1>
        <div className="grow" />
        {can('quality') && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> New chart</button>}
      </header>
      <div className="page">
        <div className="page-narrow col gap-16">
          <div className="small muted">Farmers are paid per litre by Fat % and SNF %. A chart takes effect from its start date and stays in force until a newer chart for the same milk replaces it. Old collections keep the rate they were paid at.</div>
          <Card tight>
            {!sorted.length ? <Empty icon={<ReportsIcon size={24} />} title="No rate chart yet" hint="Create one — you can generate a whole grid from a base rate and a rise per 0.1 % of Fat and SNF." /> : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Chart</th><th>Milk</th><th>From</th><th className="num">Cells</th><th>Status</th></tr></thead>
                  <tbody>{sorted.map((c) => (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setViewId(c.id)}>
                      <td className="bold">{c.name}</td><td>{MILK_LABEL[c.milkType]}</td><td>{fmtDate(c.effectiveFrom)}</td><td className="num">{c.slabs.length}</td>
                      <td>{inForce.has(c.id) ? <span className="badge badge-ok"><i className="dot" />In force</span> : c.effectiveFrom > now ? <span className="badge badge-warn"><i className="dot" />Scheduled</span> : <span className="badge"><i className="dot" />Replaced</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
      {adding && <ChartForm onClose={() => setAdding(false)} />}
      {view && <ChartView chart={view} onClose={() => setViewId(null)} />}
    </div>
  )
}

function ChartView({ chart, onClose }: { chart: Chart; onClose: () => void }) {
  const fats = [...new Set(chart.slabs.map((s) => s.fatMin))].sort((a, b) => a - b)
  const snfs = [...new Set(chart.slabs.map((s) => s.snfMin))].sort((a, b) => a - b)
  return (
    <Modal open width="xwide" title={<div><h2>{chart.name}</h2><div className="small muted">{MILK_LABEL[chart.milkType]} · from {fmtDate(chart.effectiveFrom)} · ₹ per litre</div></div>} onClose={onClose}>
      <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>Fat ↓ / SNF →</th>{snfs.map((s) => <th key={s} className="num">{s}</th>)}</tr></thead>
          <tbody>{fats.map((f) => (
            <tr key={f}><td className="bold">{f}</td>{snfs.map((s) => {
              const slab = slabFor(chart.slabs, f, s)
              return <td key={s} className="num">{slab ? slab.rate : '—'}</td>
            })}</tr>
          ))}</tbody>
        </table>
      </div>
    </Modal>
  )
}

function ChartForm({ onClose }: { onClose: () => void }) {
  const { user, toast } = useApp()
  const [name, setName] = useState('')
  const [milk, setMilk] = useState<MilkType>('cow')
  const [from, setFrom] = useState(toInputDate(Date.now()))
  const d = DEFAULTS[milk]
  const [g, setG] = useState({ fatFrom: d.fatFrom, fatTo: '', snfFrom: d.snfFrom, snfTo: '', step: '0.5', base: d.base, perFat: '0.5', perSnf: '0.3' })
  const [busy, setBusy] = useState(false)

  const n = (s: string) => Number(s) || 0
  const slabs: RateSlab[] = useMemo(() => {
    const fatFrom = n(g.fatFrom), snfFrom = n(g.snfFrom), step = n(g.step) || 0.5
    const fatTo = n(g.fatTo) || fatFrom + 3, snfTo = n(g.snfTo) || snfFrom + 1.5
    if (!(fatTo > fatFrom) || !(snfTo > snfFrom) || step <= 0) return []
    return generateGrid({ fatFrom, fatTo, fatStep: step, snfFrom, snfTo, snfStep: step, baseRate: n(g.base), perFatPoint: n(g.perFat), perSnfPoint: n(g.perSnf) })
  }, [g])

  function setMilkType(m: MilkType) {
    setMilk(m)
    const x = DEFAULTS[m]
    setG((p) => ({ ...p, fatFrom: x.fatFrom, snfFrom: x.snfFrom, base: x.base, fatTo: '', snfTo: '' }))
  }

  async function save() {
    if (!user || busy) return
    setBusy(true)
    try {
      await createRateChart({ name: name || `${MILK_LABEL[milk]} ${new Date(fromInputDate(from)).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`, milkType: milk, effectiveFrom: fromInputDate(from), slabs }, user.id)
      toast('Rate chart saved', 'ok')
      onClose()
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }

  const lo = slabs[0]?.rate, hi = slabs[slabs.length - 1]?.rate
  return (
    <Modal open width="wide" title="New rate chart" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" disabled={busy || !slabs.length} onClick={() => void save()}>Save chart</button></>}>
      <div className="grid grid-2">
        <Field label="Name"><input className="input" placeholder="Cow – Oct 2026" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Effective from"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      </div>
      <div className="form-section"><h3>Milk</h3><Segmented value={milk} options={MILK} onChange={setMilkType} /></div>
      <div className="form-section">
        <h3>Build the grid</h3>
        <div className="grid grid-3">
          <Field label="Fat from %"><input className="input num" inputMode="decimal" value={g.fatFrom} onChange={(e) => setG({ ...g, fatFrom: e.target.value })} /></Field>
          <Field label="Fat to %" hint="blank = from + 3"><input className="input num" inputMode="decimal" value={g.fatTo} onChange={(e) => setG({ ...g, fatTo: e.target.value })} /></Field>
          <Field label="Step %"><input className="input num" inputMode="decimal" value={g.step} onChange={(e) => setG({ ...g, step: e.target.value })} /></Field>
          <Field label="SNF from %"><input className="input num" inputMode="decimal" value={g.snfFrom} onChange={(e) => setG({ ...g, snfFrom: e.target.value })} /></Field>
          <Field label="SNF to %" hint="blank = from + 1.5"><input className="input num" inputMode="decimal" value={g.snfTo} onChange={(e) => setG({ ...g, snfTo: e.target.value })} /></Field>
          <Field label="Base rate ₹/L" hint="lowest cell"><input className="input num" inputMode="decimal" value={g.base} onChange={(e) => setG({ ...g, base: e.target.value })} /></Field>
          <Field label="+ per 0.1 Fat"><input className="input num" inputMode="decimal" value={g.perFat} onChange={(e) => setG({ ...g, perFat: e.target.value })} /></Field>
          <Field label="+ per 0.1 SNF"><input className="input num" inputMode="decimal" value={g.perSnf} onChange={(e) => setG({ ...g, perSnf: e.target.value })} /></Field>
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          {slabs.length ? <>Creates <b>{slabs.length}</b> rate cells, from ₹{lo} to ₹{hi} per litre. A reading counts in a cell from its lower value up to (not including) the next one — Fat 3.5 falls in the 3.5 cell.</> : 'Check the ranges — "to" must be larger than "from".'}
        </div>
      </div>
    </Modal>
  )
}
