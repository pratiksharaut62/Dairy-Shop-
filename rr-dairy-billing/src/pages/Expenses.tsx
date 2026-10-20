import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { id } from '../lib/id'
import { inr, round2 } from '../lib/money'
import { fmtDate, rangeBounds, RANGE_OPTIONS, toInputDate, fromInputDate, type RangeKey } from '../lib/dates'
import { toCSV, downloadFile } from '../lib/csv'
import { useDebounced } from '../lib/useDebounced'
import { Modal, Empty, Field, Segmented, Confirm } from '../components/ui'
import { Download, ExpensesIcon, Plus, Search, TrashIcon } from '../components/icons'
import { useApp } from '../state'
import type { Expense, ExpenseMode } from '../db/types'

const CATEGORIES = ['Rent', 'Salary', 'Electricity', 'Transport', 'Packaging', 'Marketing', 'Repairs', 'Tea & Snacks', 'GST / Taxes', 'Misc']
const MODES: Array<{ value: ExpenseMode; label: string }> = [
  { value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }, { value: 'bank', label: 'Bank' },
]
const PAGE = 100

const blank = (userId: string): Expense => ({
  id: '', date: Date.now(), category: CATEGORIES[0], amount: 0, mode: 'cash', vendor: '', note: '', recurring: false, userId,
})

export default function Expenses() {
  const { user, toast, can } = useApp()
  const [range, setRange] = useState<RangeKey>('30d')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [editing, setEditing] = useState<Expense | null>(null)
  const [deleting, setDeleting] = useState<Expense | null>(null)
  const [sel, setSel] = useState(0)
  const [limit, setLimit] = useState(PAGE)
  const searchRef = useRef<HTMLInputElement>(null)
  const needle = useDebounced(q.trim().toLowerCase(), 120)

  const [from, to] = useMemo(() => rangeBounds(range), [range])
  // Only the chosen period is read, straight off the date index.
  const inRange = useLiveQuery(() => db.expenses.where('date').between(from, to, true, true).reverse().toArray(), [from, to], [] as Expense[]) ?? []
  const revenue = useLiveQuery(async () => {
    let s = 0
    await db.bills.where('date').between(from, to, true, true).each((b) => { if (b.status !== 'held') s += b.total })
    return round2(s)
  }, [from, to], 0) ?? 0

  const categoryOptions = useMemo(() => [...new Set([...CATEGORIES, ...inRange.map((e) => e.category)])], [inRange])

  const rows = useMemo(() => inRange.filter((e) => {
    if (cat && e.category !== cat) return false
    if (!needle) return true
    return e.category.toLowerCase().includes(needle) || e.note.toLowerCase().includes(needle) || e.vendor.toLowerCase().includes(needle)
  }), [inRange, cat, needle])

  useEffect(() => { setSel(0); setLimit(PAGE) }, [rows.length, needle, cat, range])
  const visible = rows.slice(0, limit)

  const total = round2(rows.reduce((s, e) => s + e.amount, 0))
  const byCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of rows) m.set(e.category, round2((m.get(e.category) ?? 0) + e.amount))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  // Keyboard: ↑↓ move, Enter edits, / searches, N adds an expense.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || deleting || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t === searchRef.current && e.key === 'ArrowDown') { e.preventDefault(); searchRef.current?.blur(); setSel(0); return }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setEditing(blank(user?.id ?? '')) }
      else if (!visible.length) return
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(visible.length - 1, s + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
      else if (e.key === 'Enter') { e.preventDefault(); setEditing(visible[sel]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => { document.querySelector('.exp-row.sel')?.scrollIntoView({ block: 'nearest' }) }, [sel])

  async function remove(e: Expense) {
    await db.expenses.delete(e.id)
    toast('Expense deleted', 'ok')
  }

  /** Copies an entry forward to today — for rent, salary and other bills that repeat every month. */
  function repeat(e: Expense) {
    setEditing({ ...e, id: '', date: Date.now(), userId: user?.id ?? e.userId })
  }

  const filtered = !!(needle || cat)

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Expenses</h1>
        <div className="grow" />
        <Segmented value={range} options={RANGE_OPTIONS} onChange={setRange} />
        <button className="btn" disabled={!rows.length} onClick={() => {
          downloadFile(`expenses-${range}.csv`, toCSV(rows.map((e) => ({
            date: fmtDate(e.date), category: e.category, amount: e.amount, mode: e.mode,
            vendor: e.vendor, note: e.note, recurring: e.recurring ? 'yes' : 'no',
          }))))
          toast('Expenses exported', 'ok')
        }}><Download size={15} /> Export</button>
        <button className="btn btn-primary" onClick={() => setEditing(blank(user?.id ?? ''))}><Plus size={15} /> Add expense</button>
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          <div className="bills-filters">
            <div className="search-wrap" style={{ flex: '1 1 300px', maxWidth: 420 }}>
              <span className="ico"><Search /></span>
              <input ref={searchRef} className="input" placeholder="Search category, vendor or note"
                value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); searchRef.current?.blur() } }} />
            </div>
            <select className="select" style={{ width: 190 }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {categoryOptions.map((c) => <option key={c}>{c}</option>)}
            </select>
            <div className="grow" />
            <span className="small muted">
              <b className="num">{rows.length}</b> entries · Spent <b className="num">{inr(total)}</b>
              {can('viewProfit') && !filtered && <> · Sales <b className="num">{inr(revenue)}</b> · Left after expenses <b className="num" style={{ color: revenue - total < 0 ? 'var(--danger)' : undefined }}>{inr(round2(revenue - total))}</b></>}
            </span>
          </div>

          <div className="grid split-side">
            <section className="card">
              {!rows.length ? (
                <Empty icon={<ExpensesIcon size={24} />} title={filtered ? 'No expenses match' : 'No expenses in this period'}
                  hint={filtered ? 'Try a different search or category.' : 'Press N or use Add expense to record one.'} />
              ) : (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead><tr><th>Date</th><th>Category</th><th>Details</th><th>Paid by</th><th className="num">Amount</th><th /></tr></thead>
                    <tbody>
                      {visible.map((e, i) => (
                        <tr key={e.id} className={`exp-row clickable ${i === sel ? 'sel' : ''}`} onClick={() => { setSel(i); setEditing(e) }} onMouseEnter={() => setSel(i)}>
                          <td className="muted">{fmtDate(e.date)}</td>
                          <td className="nowrap"><span className="badge">{e.category}</span>{e.recurring && <span className="badge badge-brand" style={{ marginLeft: 6 }}>Monthly</span>}</td>
                          <td>{e.note || <span className="muted">—</span>}{e.vendor && <span className="muted"> · {e.vendor}</span>}</td>
                          <td className="muted">{MODES.find((m) => m.value === e.mode)?.label ?? e.mode}</td>
                          <td className="num bold">{inr(e.amount)}</td>
                          <td className="right nowrap">
                            <button className="btn btn-sm btn-ghost exp-act" title="Copy to today" onClick={(ev) => { ev.stopPropagation(); repeat(e) }}>Repeat</button>
                            <button className="btn btn-sm btn-ghost exp-act" style={{ color: 'var(--danger)' }} onClick={(ev) => { ev.stopPropagation(); setDeleting(e) }} title="Delete" aria-label="Delete expense"><TrashIcon size={14} /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > limit && (
                    <div className="center" style={{ padding: 14 }}>
                      <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more · {rows.length - limit} not shown</button>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="card" style={{ alignSelf: 'start' }}>
              <div className="card-head"><h2>Where the money went</h2></div>
              <div className="card-body">
                {!byCategory.length ? <div className="small muted">Nothing recorded yet.</div> : byCategory.map(([name, amt]) => (
                  <div key={name} style={{ marginBottom: 12 }}>
                    <div className="row between">
                      <span className="bold">{name}</span>
                      <span className="num">{inr(amt)} <span className="muted small">{total ? Math.round((amt / total) * 100) : 0}%</span></span>
                    </div>
                    <div className="bar-track" style={{ marginTop: 5 }}>
                      <div className="bar-fill" style={{ width: `${(amt / byCategory[0][1]) * 100}%`, background: 'var(--danger)' }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      {editing && <ExpenseForm expense={editing} onClose={() => setEditing(null)} />}
      <Confirm open={!!deleting} title="Delete expense?" danger confirmLabel="Delete"
        message={<>This removes the <strong>{deleting?.category}</strong> entry of <strong>{inr(deleting?.amount ?? 0)}</strong> from {deleting && fmtDate(deleting.date)}.</>}
        onConfirm={() => deleting && void remove(deleting)} onClose={() => setDeleting(null)} />
    </div>
  )
}

function ExpenseForm({ expense, onClose }: { expense: Expense; onClose: () => void }) {
  const { toast, user } = useApp()
  const [f, setF] = useState({ ...expense, dateStr: toInputDate(expense.date) })
  const [tried, setTried] = useState(false)
  const isNew = !expense.id
  const dirty = isNew || JSON.stringify(f) !== JSON.stringify({ ...expense, dateStr: toInputDate(expense.date) })
  const amountBad = tried && !(f.amount > 0)

  async function save() {
    setTried(true)
    if (!f.amount || f.amount <= 0) { toast('Enter an amount', 'err'); return }
    const payload: Expense = {
      id: f.id || id('exp'), date: fromInputDate(f.dateStr), category: f.category,
      amount: round2(f.amount), mode: f.mode, vendor: f.vendor.trim(), note: f.note.trim(),
      recurring: f.recurring, userId: f.userId || user?.id || '',
    }
    if (f.id) await db.expenses.update(f.id, payload)
    else await db.expenses.add(payload)
    toast(isNew ? `${f.category} expense of ${inr(payload.amount)} added` : 'Expense updated', 'ok')
    onClose()
  }
  const submit = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }

  return (
    <Modal open title={isNew ? 'Add expense' : 'Edit expense'} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-lg" disabled={!dirty} onClick={() => void save()}>{isNew ? 'Save expense' : 'Save changes'}</button>
        </>
      }>
      <div className="grid grid-2">
        <Field label="Amount (₹) *">
          <input className={`input input-lg num ${amountBad ? 'invalid' : ''}`} autoFocus inputMode="decimal" placeholder="0" value={f.amount || ''}
            onChange={(e) => setF({ ...f, amount: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} onKeyDown={submit} />
        </Field>
        <Field label="Date"><input type="date" className="input input-lg" value={f.dateStr} onChange={(e) => setF({ ...f, dateStr: e.target.value })} onKeyDown={submit} /></Field>
      </div>

      <div className="form-section">
        <h3>Category</h3>
        <div className="chips" role="group" aria-label="Category">
          {(CATEGORIES.includes(expense.category) ? CATEGORIES : [expense.category, ...CATEGORIES]).map((c) => (
            <button key={c} type="button" className={`chip ${f.category === c ? 'on' : ''}`} onClick={() => setF({ ...f, category: c })}>{c}</button>
          ))}
        </div>
      </div>

      <div className="form-section">
        <h3>Paid by</h3>
        <Segmented value={f.mode} options={MODES} onChange={(m) => setF({ ...f, mode: m })} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <Field label="Paid to / vendor"><input className="input" value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} onKeyDown={submit} /></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} onKeyDown={submit} /></Field>
      </div>
      <label className="checkbox" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={f.recurring} onChange={(e) => setF({ ...f, recurring: e.target.checked })} />
        Fixed monthly expense (rent, salary, electricity)
      </label>
    </Modal>
  )
}
