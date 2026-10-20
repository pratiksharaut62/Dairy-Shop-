import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { saveCollection, decideCollection } from '../db/dairy'
import { quoteMilk, MILK_LABEL } from '../lib/milkRate'
import { inr, round2 } from '../lib/money'
import { fmtTime, fromInputDate, toInputDate, startOfDay, endOfDay } from '../lib/dates'
import { toCSV, downloadFile } from '../lib/csv'
import { Card, Empty, Field, Modal, Segmented } from '../components/ui'
import { CheckCircle, Close, Download, Printer, Warning } from '../components/icons'
import { MilkSlip } from '../print/MilkSlip'
import { usePrint } from '../print/PrintProvider'
import { useApp } from '../state'
import type { Collection as Col, CollectionSession, Farmer, MilkType } from '../db/types'

const SESSIONS: Array<{ value: CollectionSession; label: string }> = [{ value: 'morning', label: 'Morning shift' }, { value: 'evening', label: 'Evening shift' }]
const MILK: Array<{ value: MilkType; label: string }> = [{ value: 'cow', label: 'Cow' }, { value: 'buffalo', label: 'Buffalo' }, { value: 'mixed', label: 'Mixed' }]
const defaultSession = (): CollectionSession => (new Date().getHours() < 14 ? 'morning' : 'evening')
const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
const PRINT_KEY = 'rr_print_slip'

export function StatusBadge({ status }: { status: Col['status'] }) {
  if (status === 'approved') return <span className="badge badge-ok"><i className="dot" />Approved</span>
  if (status === 'rejected') return <span className="badge badge-danger"><i className="dot" />Rejected</span>
  return <span className="badge badge-warn"><i className="dot" />Pending</span>
}

/** Litres-weighted Fat/SNF over everything physically received (pending entries count; rejected ones do not). */
function received(rows: Col[]) {
  const ok = rows.filter((c) => c.status !== 'rejected')
  const litres = round2(ok.reduce((s, c) => s + c.qtyL, 0))
  const amount = round2(ok.reduce((s, c) => s + c.amount, 0))
  const w = (f: (c: Col) => number) => (litres ? round2(ok.reduce((s, c) => s + f(c) * c.qtyL, 0) / litres) : 0)
  return { litres, amount, fat: w((c) => c.fat), snf: w((c) => c.snf), farmers: new Set(ok.map((c) => c.farmerId)).size, entries: ok.length }
}

function sameDayNow(day: number): number {
  const now = Date.now()
  return startOfDay(now) === startOfDay(day) ? now : day
}

export default function Collection() {
  const { user, toast, can, settings } = useApp()
  const { print } = usePrint()
  const [dateStr, setDateStr] = useState(toInputDate(Date.now()))
  const [session, setSession] = useState<CollectionSession>(defaultSession())
  const [farmerText, setFarmerText] = useState('')
  const [milkType, setMilkType] = useState<MilkType>('cow')
  const [qty, setQty] = useState('')
  const [fat, setFat] = useState('')
  const [snf, setSnf] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [dupAck, setDupAck] = useState(false)
  const [autoPrint, setAutoPrint] = useState(() => localStorage.getItem(PRINT_KEY) !== '0')
  const [last, setLast] = useState<{ c: Col; farmer: Farmer } | null>(null)
  const [rejecting, setRejecting] = useState<Col | null>(null)
  const [reason, setReason] = useState('')
  const qtyRef = useRef<HTMLInputElement>(null)
  const fatRef = useRef<HTMLInputElement>(null)
  const snfRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => { localStorage.setItem(PRINT_KEY, autoPrint ? '1' : '0') }, [autoPrint])

  const day = useMemo(() => fromInputDate(dateStr), [dateStr])
  const isToday = startOfDay(day) === startOfDay(Date.now())
  const allFarmers = useLiveQuery(() => db.farmers.toArray(), [], [] as Farmer[]) ?? []
  const farmers = useMemo(() => allFarmers.filter((f) => f.active), [allFarmers])
  const charts = useLiveQuery(() => db.rateCharts.toArray(), [], []) ?? []
  const rows = useLiveQuery(
    () => db.collections.where('date').between(startOfDay(day), endOfDay(day), true, true).reverse().sortBy('date'),
    [day], [] as Col[],
  ) ?? []
  const nameOf = (id: string) => allFarmers.find((f) => f.id === id)

  // "F-001", "f1", "1" or part of a name → exactly one farmer.
  const farmer: Farmer | undefined = useMemo(() => {
    const t = farmerText.trim().toLowerCase()
    if (!t) return undefined
    const digits = t.replace(/^f-?/, '')
    const byCode = farmers.find((f) => f.code.toLowerCase() === t || (/^\d+$/.test(digits) && f.code.toLowerCase() === `f-${digits.padStart(3, '0')}`))
    if (byCode) return byCode
    const byName = farmers.filter((f) => f.name.toLowerCase().includes(t))
    return byName.length === 1 ? byName[0] : undefined
  }, [farmerText, farmers])

  const monthStart = useMemo(() => { const d = new Date(day); return new Date(d.getFullYear(), d.getMonth(), 1).getTime() }, [day])
  const farmerMonth = useLiveQuery(async () => {
    if (!farmer) return null
    const list = (await db.collections.where('farmerId').equals(farmer.id).toArray()).filter((c) => c.status !== 'rejected' && c.date >= monthStart)
    return { litres: round2(list.reduce((s, c) => s + c.qtyL, 0)), amount: round2(list.reduce((s, c) => s + c.amount, 0)) }
  }, [farmer?.id, monthStart, rows.length], null)

  const q = Number(qty) || 0
  const fatN = Number(fat) || 0
  const snfN = Number(snf) || 0
  const quote = fatN > 0 && snfN > 0 && q > 0 ? quoteMilk(charts, milkType, fatN, snfN, q, day) : null

  const shiftRows = rows.filter((c) => c.session === session)
  const sum = received(shiftRows)
  const dayTotal = received(rows)
  const pending = rows.filter((c) => c.status === 'pending').length
  const delivered = new Set(shiftRows.filter((c) => c.status !== 'rejected').map((c) => c.farmerId))
  const yet = farmers.filter((f) => !delivered.has(f.id))
  const dup = farmer ? shiftRows.find((c) => c.farmerId === farmer.id && c.status !== 'rejected') : undefined
  const byMilk = (['cow', 'buffalo', 'mixed'] as MilkType[]).map((m) => ({ m, litres: round2(shiftRows.filter((c) => c.status !== 'rejected' && c.milkType === m).reduce((s, c) => s + c.qtyL, 0)) })).filter((x) => x.litres > 0)

  function chooseFarmer(f: Farmer) {
    setFarmerText(f.code); setMilkType(f.milkType); setDupAck(false)
    setTimeout(() => qtyRef.current?.focus(), 30)
  }

  function printSlip(c: Col, f: Farmer, month?: { litres: number; amount: number } | null) {
    if (!settings) return
    print(<MilkSlip settings={settings} farmer={f} c={c} monthLitres={month?.litres} monthAmount={month?.amount} />, { silent: true })
  }

  async function save() {
    if (!user || saving) return
    if (!farmer) { toast('Enter a farmer code (e.g. F-001)', 'err'); codeRef.current?.focus(); return }
    if (!quote || !quote.ok) { toast(quote && !quote.ok ? quote.error : 'Enter litres, Fat and SNF', 'err'); return }
    if (dup && !dupAck) { setDupAck(true); toast(`${farmer.name} already has a ${session} entry — press Save again to add another`, 'info'); return }
    setSaving(true)
    try {
      const c = await saveCollection({ farmerId: farmer.id, date: sameDayNow(day), session, milkType, qtyL: q, fat: fatN, snf: snfN, note }, user.id, can('quality'))
      const month = { litres: round2((farmerMonth?.litres ?? 0) + c.qtyL), amount: round2((farmerMonth?.amount ?? 0) + c.amount) }
      setLast({ c, farmer })
      if (autoPrint) printSlip(c, farmer, month)
      setFarmerText(''); setQty(''); setFat(''); setSnf(''); setNote(''); setDupAck(false)
      codeRef.current?.focus()
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally { setSaving(false) }
  }

  async function decide(c: Col, accept: boolean, why = '') {
    if (!user) return
    try { await decideCollection(c.id, accept, user.id, why); toast(accept ? `${c.no} approved` : `${c.no} rejected`, 'ok') } catch (e) { toast((e as Error).message, 'err') }
  }

  const next = (ref: React.RefObject<HTMLInputElement>) => (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); ref.current?.focus() } }
  const submit = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }
  const ready = !!farmer && !!quote && quote.ok

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Milk collection</h1>
        <div className="grow" />
        <button className="btn" disabled={!rows.length} onClick={() => {
          downloadFile(`milk-collection-${dateStr}.csv`, toCSV(rows.map((c) => ({
            no: c.no, farmer: nameOf(c.farmerId)?.name ?? '', code: nameOf(c.farmerId)?.code ?? '', shift: c.session, milk: c.milkType,
            litres: c.qtyL, fat: c.fat, snf: c.snf, rate: c.rate, amount: c.amount, status: c.status,
          }))))
        }}><Download size={15} /> Export day</button>
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          <div className="shift-banner">
            <div>
              <h2>{new Date(day).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
              <div className="sub">{settings?.name ?? 'Collection centre'} · {sum.entries ? `${sum.litres} L from ${sum.farmers} farmers this shift` : 'No milk received yet this shift'}</div>
            </div>
            <div className="grow" />
            <Segmented value={session} options={SESSIONS} onChange={(v) => { setSession(v); setDupAck(false) }} />
            <input type="date" className="input" style={{ width: 150 }} value={dateStr} max={toInputDate(Date.now())} onChange={(e) => e.target.value && setDateStr(e.target.value)} aria-label="Collection date" />
          </div>

          {!allFarmers.length ? (
            <Card><Empty icon={<Warning size={24} />} title="Add your farmers first" hint="Open Farmers, add each milk supplier, then come back here to record what they bring." /></Card>
          ) : !charts.length ? (
            <Card><Empty icon={<Warning size={24} />} title="No rate chart yet" hint="Milk is paid by Fat and SNF — set up a rate chart under Rate Chart before recording collections." /></Card>
          ) : (
            <div className="counter-grid">
              <div className="col gap-16">
                <Card title="Collection counter" action={<span className="small muted">Enter ⏎ moves to the next box</span>}>
                  <div className="grid grid-2">
                    <Field label="Farmer code *">
                      <input ref={codeRef} className="input code-input" list="farmer-list" autoFocus placeholder="F-001" value={farmerText}
                        onChange={(e) => { setFarmerText(e.target.value); setDupAck(false) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (farmer) { setMilkType(farmer.milkType); qtyRef.current?.focus() } } }} />
                      <datalist id="farmer-list">{farmers.map((f) => <option key={f.id} value={f.code}>{f.name}</option>)}</datalist>
                    </Field>
                    <Field label="Milk">
                      <Segmented value={milkType} options={MILK} onChange={setMilkType} />
                    </Field>
                  </div>

                  {farmer ? (
                    <div className="farmer-card">
                      <div className="avatar">{initials(farmer.name)}</div>
                      <div className="grow">
                        <div className="bold">{farmer.name}</div>
                        <div className="meta">{[farmer.village, farmer.phone].filter(Boolean).join(' · ') || 'No village / phone'}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="meta">This month</div>
                        <div className="bold num">{farmerMonth ? `${farmerMonth.litres} L` : '—'}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="farmer-card empty">{farmerText ? 'No single farmer matches yet — type the code, e.g. F-001' : 'Type the farmer code to begin'}</div>
                  )}

                  <div className="grid grid-3" style={{ marginTop: 14 }}>
                    <Field label="Litres *"><input ref={qtyRef} className="input big-input" inputMode="decimal" placeholder="0.00" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={next(fatRef)} /></Field>
                    <Field label="Fat % *"><input ref={fatRef} className="input big-input" inputMode="decimal" placeholder="4.5" value={fat} onChange={(e) => setFat(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={next(snfRef)} /></Field>
                    <Field label="SNF % *"><input ref={snfRef} className="input big-input" inputMode="decimal" placeholder="8.5" value={snf} onChange={(e) => setSnf(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={submit} /></Field>
                  </div>

                  {quote === null ? (
                    <div className="rate-band idle"><div><div className="lbl">Amount payable</div><div className="amt">₹ 0.00</div></div><div className="calc">Enter litres, Fat and SNF to see the rate</div></div>
                  ) : quote.ok ? (
                    <div className="rate-band">
                      <div><div className="lbl">Amount payable</div><div className="amt">{inr(quote.amount)}</div></div>
                      <div className="calc" style={{ textAlign: 'right' }}>{q} L × ₹{quote.rate.toFixed(2)} / L<br /><span style={{ opacity: .7 }}>{quote.chart.name}</span></div>
                    </div>
                  ) : (
                    <div className="rate-band bad"><div className="bold">{quote.error}</div></div>
                  )}

                  {dup && <div className="small" style={{ marginTop: 10, color: 'var(--warn)' }}><Warning size={13} /> {farmer?.name} already has a {session} entry on this date ({dup.qtyL} L).</div>}

                  <div className="row gap-6" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                    <input className="input" style={{ flex: '1 1 180px', maxWidth: 280 }} placeholder="Remark (optional)" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={submit} />
                    <label className="checkbox"><input type="checkbox" checked={autoPrint} onChange={(e) => setAutoPrint(e.target.checked)} /> Print slip</label>
                    <div className="grow" />
                    <button className="btn btn-primary btn-lg" disabled={saving || !ready} onClick={() => void save()}>
                      {autoPrint && <Printer size={16} />} {dup && dupAck ? 'Save anyway' : can('quality') ? 'Save & approve' : 'Save for approval'}
                    </button>
                  </div>
                </Card>

                {last && (
                  <div className="saved-banner">
                    <CheckCircle size={18} />
                    <div className="grow"><b>{last.c.no}</b> · {last.farmer.name} · {last.c.qtyL} L · Fat {last.c.fat} · SNF {last.c.snf} · <b>{inr(last.c.amount)}</b>{last.c.status === 'pending' ? ' · awaiting approval' : ''}</div>
                    <button className="btn btn-sm" onClick={() => printSlip(last.c, last.farmer, farmerMonth)}><Printer size={14} /> Reprint slip</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setLast(null)} aria-label="Dismiss"><Close size={14} /></button>
                  </div>
                )}
              </div>

              <div className="col gap-16">
                <Card title={`${session === 'morning' ? 'Morning' : 'Evening'} shift summary`}>
                  <div className="mini-stats">
                    <div className="mini-stat"><div className="v">{sum.litres}</div><div className="l">Litres</div></div>
                    <div className="mini-stat"><div className="v">{sum.farmers}<span className="muted small"> / {farmers.length}</span></div><div className="l">Farmers</div></div>
                    <div className="mini-stat"><div className="v">{sum.litres ? sum.fat : '—'}</div><div className="l">Avg Fat %</div></div>
                    <div className="mini-stat"><div className="v">{sum.litres ? sum.snf : '—'}</div><div className="l">Avg SNF %</div></div>
                  </div>
                  <div className="kv" style={{ marginTop: 10 }}><span>Milk value</span><b>{inr(sum.amount)}</b></div>
                  <div className="kv"><span>Day total (both shifts)</span><b>{dayTotal.litres} L · {inr(dayTotal.amount)}</b></div>
                  {byMilk.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <div className="bar">{byMilk.map((x, i) => <i key={x.m} className={['a', 'b', 'c'][i]} style={{ width: `${(x.litres / sum.litres) * 100}%` }} />)}</div>
                      <div className="small muted" style={{ marginTop: 4 }}>{byMilk.map((x) => `${MILK_LABEL[x.m]} ${x.litres} L`).join(' · ')}</div>
                    </div>
                  )}
                  {pending > 0 && <div className="small" style={{ marginTop: 8, color: 'var(--warn)' }}><Warning size={13} /> {pending} entr{pending === 1 ? 'y' : 'ies'} awaiting approval</div>}
                </Card>

                <Card title={isToday ? `Yet to deliver (${yet.length})` : `Did not deliver (${yet.length})`}>
                  {!yet.length ? <div className="small muted">Every active farmer has delivered this shift.</div> : (
                    <div className="chip-wrap">
                      {yet.slice(0, 40).map((f) => <button key={f.id} className="chip-btn" onClick={() => chooseFarmer(f)} title={f.name}>{f.code} · {f.name.split(' ')[0]}</button>)}
                      {yet.length > 40 && <span className="small muted">+{yet.length - 40} more</span>}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          )}

          <Card title={`${session === 'morning' ? 'Morning' : 'Evening'} entries`} tight>
            {!shiftRows.length ? <Empty title="Nothing recorded for this shift" /> : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>#</th><th>Farmer</th><th className="num">Litres</th><th className="num">Fat</th><th className="num">SNF</th><th className="num">Rate</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {shiftRows.map((c, i) => {
                      const f = nameOf(c.farmerId)
                      return (
                        <tr key={c.id}>
                          <td className="muted">{shiftRows.length - i}</td>
                          <td><div className="bold">{f?.name ?? 'Unknown'}</div><div className="small muted mono">{f?.code} · {c.no} · {fmtTime(c.date)} · {MILK_LABEL[c.milkType]}</div></td>
                          <td className="num">{c.qtyL}</td><td className="num">{c.fat}</td><td className="num">{c.snf}</td>
                          <td className="num">₹{c.rate}</td><td className="num bold">{inr(c.amount)}</td>
                          <td><StatusBadge status={c.status} />{c.rejectReason && <div className="tiny muted">{c.rejectReason}</div>}</td>
                          <td className="right nowrap">
                            {c.status === 'pending' && can('quality') && (
                              <>
                                <button className="btn btn-sm btn-primary" onClick={() => void decide(c, true)}><CheckCircle size={14} /> Approve</button>{' '}
                                <button className="btn btn-sm" onClick={() => { setRejecting(c); setReason('') }}><Close size={14} /> Reject</button>{' '}
                              </>
                            )}
                            {f && c.status !== 'rejected' && <button className="btn btn-sm btn-ghost" onClick={() => printSlip(c, f)} aria-label={`Print slip ${c.no}`} title="Print slip"><Printer size={14} /></button>}
                          </td>
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

      <Modal open={!!rejecting} title={`Reject ${rejecting?.no ?? ''}`} onClose={() => setRejecting(null)}
        footer={<><button className="btn" onClick={() => setRejecting(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { if (rejecting) void decide(rejecting, false, reason); setRejecting(null) }}>Reject milk</button></>}>
        <p className="small muted" style={{ marginBottom: 10 }}>Rejected milk is not added to stock and the farmer is not credited.</p>
        <Field label="Reason"><input className="input" autoFocus placeholder="Sour / adulterated / low SNF…" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </div>
  )
}
