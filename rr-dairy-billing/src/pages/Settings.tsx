import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, exportBackup } from '../db'
import { clearSalesData } from '../db/ops'
import { id } from '../lib/id'
import { hashPin, verifyPin } from '../lib/pin'
import { rememberPlainPin } from '../db/plainPin'
import { downloadFile } from '../lib/csv'
import { fmtDateTime } from '../lib/dates'
import { DEFAULT_SLABS } from '../lib/gst'
import { useDebounced } from '../lib/useDebounced'
import { Field, Modal, Segmented, Confirm, Empty } from '../components/ui'
import { SyncBadge } from '../components/SyncBadge'
import { DataSafety } from '../components/DataSafety'
import { Diagnostics } from '../components/Diagnostics'
import { restoreBackup, type BackupPayload } from '../lib/backup'
import { cloudRequest, isCloudReady } from '../lib/sync'
import { decryptWithPassphraseOrKey, encryptText, isEncryptedBackup } from '../lib/crypto'
import { Download, HistoryIcon, Plus, Search, TrashIcon, Upload } from '../components/icons'
import { useApp } from '../state'
import { isDesktop, listSerialPorts, openBackup, printRaw, saveBackup, type PrinterTarget, type SerialPortInfo } from '../lib/tauri'
import { buildDrawerKickEscPos, buildTestPrintEscPos } from '../lib/escpos'
import type { AuditLog, Role, StoreSettings, User } from '../db/types'

type Tab = 'store' | 'tax' | 'receipt' | 'users' | 'data' | 'diagnostics'
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/
const NO_LIMIT = Number.MAX_SAFE_INTEGER

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including profit, settings and backups',
  manager: 'Billing, stock, purchases and reports',
  cashier: 'Billing and customers only',
}

export default function Settings() {
  const { settings, toast, user, sync } = useApp()
  const [tab, setTab] = useState<Tab>('store')
  const [f, setF] = useState<StoreSettings | null>(settings)
  const [base, setBase] = useState<StoreSettings | null>(settings)
  const users = useLiveQuery(() => db.users.toArray(), [], [] as User[]) ?? []
  const logs = useLiveQuery(() => db.audit.orderBy('at').reverse().limit(200).toArray(), [], [] as AuditLog[]) ?? []
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [printing, setPrinting] = useState(false)

  useEffect(() => { if (settings && !f) { setF(settings); setBase(settings) } }, [settings, f])

  useEffect(() => {
    if (!isDesktop() || f?.printerMode !== 'usbSerial') return
    listSerialPorts().then(setPorts).catch(() => setPorts([]))
  }, [f?.printerMode])

  const dirty = !!f && !!base && JSON.stringify(f) !== JSON.stringify(base)

  // Browser-level guard: closing the tab with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function printerTarget(): PrinterTarget | null {
    if (!f) return null
    if (f.printerMode === 'usbSerial') return f.printerSerialPath ? { kind: 'usbSerial', path: f.printerSerialPath, baud: f.printerBaud } : null
    if (f.printerMode === 'network') return f.printerHost ? { kind: 'network', host: f.printerHost, port: f.printerPort } : null
    return null
  }

  async function testPrint() {
    const target = printerTarget()
    if (!f || !target) { toast('Choose a port or enter the printer\'s address first', 'err'); return }
    setPrinting(true)
    try { await printRaw(target, buildTestPrintEscPos(f)); toast('Test receipt sent', 'ok') }
    catch (e) { toast(String(e).replace(/^.*Error:\s*/, '') || 'Print failed', 'err') }
    finally { setPrinting(false) }
  }

  async function openDrawer() {
    const target = printerTarget()
    if (!target) { toast('Choose a port or enter the printer\'s address first', 'err'); return }
    try { await printRaw(target, buildDrawerKickEscPos()) }
    catch (e) { toast(String(e).replace(/^.*Error:\s*/, '') || 'Could not open drawer', 'err') }
  }

  if (!f || !base) return null
  const set = (patch: Partial<StoreSettings>) => setF({ ...f, ...patch })

  // ---- GST slab checks ----
  const slabProblem = ((): string => {
    if (!f.slabs.length) return 'Add at least one slab.'
    for (let i = 0; i < f.slabs.length; i++) {
      if (f.slabs[i].rate < 0 || f.slabs[i].rate > 100) return 'A GST rate must be between 0 and 100.'
      if (i > 0 && f.slabs[i].upto <= f.slabs[i - 1].upto) return 'Each slab must be higher than the one above it.'
    }
    if (f.slabs[f.slabs.length - 1].upto < 1e12) return 'The last slab should have no limit, so every price is covered.'
    return ''
  })()

  const gstinBad = f.gstin.trim() !== '' && !GSTIN_RE.test(f.gstin.trim())
  const emailBad = f.email.trim() !== '' && !/^\S+@\S+\.\S+$/.test(f.email.trim())
  const invoiceLowered = f.nextInvoiceNo < base.nextInvoiceNo

  async function saveAll() {
    if (!f) return
    if (!f.name.trim()) { toast('Store name can\'t be empty', 'err'); setTab('store'); return }
    if (slabProblem) { toast(slabProblem, 'err'); setTab('tax'); return }
    if (!(f.labelWidthMm > 0 && f.labelHeightMm > 0)) { toast('Label width and height must be above 0', 'err'); setTab('receipt'); return }
    const clean = { ...f, name: f.name.trim(), gstin: f.gstin.trim(), email: f.email.trim() }
    await db.settings.put(clean)
    setF(clean); setBase(clean)
    toast('Settings saved', 'ok')
  }

  const TABS: Array<{ value: Tab; label: string }> = [
    { value: 'store', label: 'Store' },
    { value: 'tax', label: 'Tax & pricing' },
    { value: 'receipt', label: 'Receipt & labels' },
    { value: 'users', label: 'Staff' },
    { value: 'data', label: 'Data' },
    // Developer / support account only — shop owners and staff never see this tab.
    ...(sync.superAdmin ? [{ value: 'diagnostics' as Tab, label: 'Diagnostics' }] : []),
  ]

  return (
    <div className="inv-scope">
      <header className="topbar">
        <h1>Settings</h1>
        <div className="grow" />
        <Segmented value={tab} options={TABS} onChange={setTab} />
        {dirty && <span className="badge badge-warn">Unsaved changes</span>}
        {dirty && <button className="btn" onClick={() => setF(base)}>Discard</button>}
        <button className="btn btn-primary" disabled={!dirty} onClick={() => void saveAll()}>Save changes</button>
      </header>

      <div className="page">
        <div className="page-narrow col gap-16">
          {tab === 'store' && (
            <>
              <section className="card">
                <div className="card-head"><h2>Store details</h2></div>
                <div className="card-body">
                  <div className="grid grid-2">
                    <Field label="Store name *"><input className={`input ${!f.name.trim() ? 'invalid' : ''}`} value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                    <Field label="Tagline"><input className="input" value={f.tagline} onChange={(e) => set({ tagline: e.target.value })} /></Field>
                    <Field label="Address"><input className="input" value={f.address} onChange={(e) => set({ address: e.target.value })} /></Field>
                    <Field label="City / PIN"><input className="input" value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
                    <Field label="Phone"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
                    <Field label="Email" hint={emailBad ? undefined : ' '}>
                      <input className={`input ${emailBad ? 'invalid' : ''}`} inputMode="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
                      {emailBad && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>Doesn't look like an email</span>}
                    </Field>
                  </div>
                </div>
              </section>

              <section className="card">
                <div className="card-head"><h2>Tax invoice</h2></div>
                <div className="card-body">
                  <div className="grid grid-3">
                    <Field label="GSTIN" hint={gstinBad ? undefined : 'Printed on every tax invoice'}>
                      <input className={`input mono ${gstinBad ? 'invalid' : ''}`} maxLength={15} value={f.gstin}
                        onChange={(e) => set({ gstin: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
                      {gstinBad && <span className="small" style={{ color: 'var(--warn)', fontWeight: 650 }}>Doesn't look like a valid GSTIN</span>}
                    </Field>
                    <Field label="Invoice prefix"><input className="input mono" value={f.invoicePrefix} onChange={(e) => set({ invoicePrefix: e.target.value })} /></Field>
                    <Field label="Next invoice number" hint={invoiceLowered ? undefined : `Next bill will be ${f.invoicePrefix}${String(f.nextInvoiceNo).padStart(4, '0')}`}>
                      <input className={`input num ${invoiceLowered ? 'invalid' : ''}`} inputMode="numeric" value={f.nextInvoiceNo}
                        onChange={(e) => set({ nextInvoiceNo: Number(e.target.value.replace(/\D/g, '')) || 1 })} />
                      {invoiceLowered && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>Lower than before — this can repeat an invoice number</span>}
                    </Field>
                  </div>
                </div>
              </section>
            </>
          )}

          {tab === 'tax' && (
            <>
              <section className="card">
                <div className="card-head">
                  <h2>GST slabs</h2>
                  <button className="btn btn-sm" onClick={() => set({ slabs: DEFAULT_SLABS })}>Reset to flat 5 % default</button>
                </div>
                <div className="card-body">
                  <div className="small muted" style={{ marginBottom: 12 }}>
                    Garments are taxed by price per piece. The rate is picked at billing time from what the customer pays for one piece after discount; CGST and SGST split it evenly.
                  </div>
                  <table className="tbl">
                    <thead><tr><th>When the price per piece is up to</th><th className="num">GST rate (%)</th><th /></tr></thead>
                    <tbody>
                      {f.slabs.map((s, i) => (
                        <tr key={i}>
                          <td>
                            <input className="input num" style={{ width: 190 }} inputMode="numeric"
                              value={s.upto >= 1e12 ? '' : s.upto} placeholder="No limit (top slab)"
                              onChange={(e) => set({ slabs: f.slabs.map((x, j) => (j === i ? { ...x, upto: Number(e.target.value.replace(/\D/g, '')) || NO_LIMIT } : x)) })} />
                          </td>
                          <td className="num">
                            <input className="input num" style={{ width: 90, textAlign: 'right' }} inputMode="decimal" value={s.rate}
                              onChange={(e) => set({ slabs: f.slabs.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 } : x)) })} />
                          </td>
                          <td className="right">
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} disabled={f.slabs.length <= 1}
                              onClick={() => set({ slabs: f.slabs.filter((_, x) => x !== i) })}>Remove</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="row between" style={{ marginTop: 12 }}>
                    <button className="btn btn-sm" onClick={() => set({ slabs: [...f.slabs.filter((s) => s.upto < 1e12), { upto: (f.slabs.filter((s) => s.upto < 1e12).slice(-1)[0]?.upto ?? 0) + 1000, rate: 12 }, ...f.slabs.filter((s) => s.upto >= 1e12)] })}><Plus size={14} /> Add slab</button>
                    {slabProblem && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>{slabProblem}</span>}
                  </div>
                </div>
              </section>

              <section className="card">
                <div className="card-head"><h2>Pricing rules</h2></div>
                <div className="card-body">
                  <label className="checkbox">
                    <input type="checkbox" checked={f.priceIncludesTax} onChange={(e) => set({ priceIncludesTax: e.target.checked })} />
                    Tag prices already include GST (standard for Indian retail)
                  </label>
                  <div className="grid grid-2" style={{ marginTop: 14 }}>
                    <Field label="Maximum discount a cashier can give (%)" hint="Managers and the owner are not capped">
                      <input className="input num" inputMode="decimal" value={f.maxCashierDiscountPct} onChange={(e) => set({ maxCashierDiscountPct: Math.min(100, Number(e.target.value.replace(/[^\d.]/g, '')) || 0) })} />
                    </Field>
                    <Field label="Default reorder level for new items" hint="Below this many pieces, a size shows as low stock">
                      <input className="input num" inputMode="numeric" value={f.lowStockDefault} onChange={(e) => set({ lowStockDefault: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
                    </Field>
                  </div>
                </div>
              </section>
            </>
          )}

          {tab === 'receipt' && (
            <>
              <section className="card">
                <div className="card-head"><h2>Receipt</h2></div>
                <div className="card-body">
                  <Field label="Thermal paper width">
                    <Segmented value={f.receiptWidth} options={[{ value: '58mm', label: '58 mm' }, { value: '80mm', label: '80 mm' }]} onChange={(v) => set({ receiptWidth: v })} />
                  </Field>
                  <div style={{ marginTop: 14 }}>
                    <Field label="Return / exchange policy printed on the bill">
                      <textarea className="input" value={f.returnPolicy} onChange={(e) => set({ returnPolicy: e.target.value })} />
                    </Field>
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <Field label="Footer note"><input className="input" value={f.footerNote} onChange={(e) => set({ footerNote: e.target.value })} /></Field>
                  </div>
                </div>
              </section>

              <section className="card">
                <div className="card-head"><h2>What the printed bill shows</h2></div>
                <div className="card-body">
                  <div className="col gap-8">
                    <label className="checkbox"><input type="checkbox" checked={f.receiptShowTax === true} onChange={(e) => set({ receiptShowTax: e.target.checked })} />Tax split — taxable value, CGST and SGST</label>
                    <label className="checkbox"><input type="checkbox" checked={f.receiptShowHsn === true} onChange={(e) => set({ receiptShowHsn: e.target.checked })} />HSN summary at the bottom</label>
                    <label className="checkbox"><input type="checkbox" checked={f.receiptShowSavings !== false} onChange={(e) => set({ receiptShowSavings: e.target.checked })} />"You saved ₹… on this bill" line</label>
                    <label className="checkbox"><input type="checkbox" checked={f.receiptShowLoyalty !== false} onChange={(e) => set({ receiptShowLoyalty: e.target.checked })} />Loyalty points line</label>
                  </div>
                  <div className="small muted" style={{ marginTop: 12 }}>
                    Applies to the receipt printed at the counter, on every device. The A4 tax invoice always shows the full tax split. A GST tax invoice
                    normally has to show CGST/SGST — turn the tax split off only if your accountant is happy with it.
                  </div>
                </div>
              </section>

              <section className="card">
                <div className="card-head"><h2>Barcode labels</h2></div>
                <div className="card-body">
                  <div className="small muted" style={{ marginBottom: 14 }}>
                    Set this to your actual sticker roll. A label printer feeds one row per page, so a wrong size misaligns every label after the first. Measure the sticker, not the backing sheet.
                  </div>
                  <div className="grid grid-2">
                    <Field label="Label width (mm)" hint="One sticker, not the whole row">
                      <input className={`input num ${f.labelWidthMm <= 0 ? 'invalid' : ''}`} inputMode="decimal" value={f.labelWidthMm} onChange={(e) => set({ labelWidthMm: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
                    </Field>
                    <Field label="Label height (mm)">
                      <input className={`input num ${f.labelHeightMm <= 0 ? 'invalid' : ''}`} inputMode="decimal" value={f.labelHeightMm} onChange={(e) => set({ labelHeightMm: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
                    </Field>
                    <Field label="Labels across" hint="1 for a single-lane roll; 2 or more if labels sit side by side">
                      <input className="input num" inputMode="numeric" value={f.labelsAcross} onChange={(e) => set({ labelsAcross: Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) })} />
                    </Field>
                    <Field label="Gap between labels (mm)" hint="Sideways gap only — ignored when labels across is 1">
                      <input className="input num" inputMode="decimal" value={f.labelGapMm} disabled={f.labelsAcross <= 1}
                        onChange={(e) => set({ labelGapMm: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
                    </Field>
                  </div>
                  <div className="variant-preview">
                    {f.labelsAcross > 1
                      ? <>Each printed page is <b>{f.labelsAcross * f.labelWidthMm + (f.labelsAcross - 1) * f.labelGapMm} × {f.labelHeightMm} mm</b> ({f.labelsAcross} labels of {f.labelWidthMm} mm plus {f.labelsAcross - 1} gap{f.labelsAcross > 2 ? 's' : ''} of {f.labelGapMm} mm). Set that as the stock size in your printer driver, not the single-label size.</>
                      : <>One label per page: <b>{f.labelWidthMm} × {f.labelHeightMm} mm</b>. Set the same size in your printer driver.</>}
                  </div>
                </div>
              </section>

              {isDesktop() && (
                <section className="card">
                  <div className="card-head"><h2>Hardware printer</h2></div>
                  <div className="card-body">
                    <div className="small muted" style={{ marginBottom: 14 }}>
                      Connect an ESC/POS thermal printer and receipts print silently, with the cash drawer opening on cash sales. Leave it on "Browser dialog" to print the usual way on any printer.
                    </div>
                    <Field label="Connection">
                      <Segmented value={f.printerMode} options={[
                        { value: 'browser', label: 'Browser dialog' }, { value: 'usbSerial', label: 'USB' }, { value: 'network', label: 'Network' },
                      ]} onChange={(v) => set({ printerMode: v })} />
                    </Field>
                    {f.printerMode === 'usbSerial' && (
                      <div className="grid grid-2" style={{ marginTop: 14 }}>
                        <Field label="Port" hint={ports.length ? undefined : 'No serial ports found — plug in the printer, then refresh'}>
                          <div className="row gap-6">
                            <select className="select" value={f.printerSerialPath} onChange={(e) => set({ printerSerialPath: e.target.value })}>
                              <option value="">Select a port…</option>
                              {ports.map((p) => <option key={p.path} value={p.path}>{p.path} — {p.label}</option>)}
                            </select>
                            <button type="button" className="btn" onClick={() => listSerialPorts().then(setPorts).catch(() => setPorts([]))}>Refresh</button>
                          </div>
                        </Field>
                        <Field label="Baud rate"><input className="input num" inputMode="numeric" value={f.printerBaud} onChange={(e) => set({ printerBaud: Number(e.target.value.replace(/\D/g, '')) || 9600 })} /></Field>
                      </div>
                    )}
                    {f.printerMode === 'network' && (
                      <div className="grid grid-2" style={{ marginTop: 14 }}>
                        <Field label="Printer IP address"><input className="input mono" placeholder="192.168.1.50" value={f.printerHost} onChange={(e) => set({ printerHost: e.target.value })} /></Field>
                        <Field label="Port" hint="9100 is standard on almost every network thermal printer"><input className="input num" inputMode="numeric" value={f.printerPort} onChange={(e) => set({ printerPort: Number(e.target.value.replace(/\D/g, '')) || 9100 })} /></Field>
                      </div>
                    )}
                    {f.printerMode !== 'browser' && (
                      <div className="row gap-6" style={{ marginTop: 14 }}>
                        <button type="button" className="btn btn-primary" disabled={printing} onClick={() => void testPrint()}>{printing ? 'Printing…' : 'Test print'}</button>
                        <button type="button" className="btn" onClick={() => void openDrawer()}>Open cash drawer</button>
                      </div>
                    )}
                  </div>
                </section>
              )}

              <section className="card">
                <div className="card-head"><h2>Loyalty programme</h2></div>
                <div className="card-body">
                  <div className="grid grid-2">
                    <Field label="Points earned per ₹100 spent"><input className="input num" inputMode="decimal" value={f.loyaltyEarnPct} onChange={(e) => set({ loyaltyEarnPct: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} /></Field>
                    <Field label="Value of 1 point (₹)"><input className="input num" inputMode="decimal" value={f.loyaltyRedeemValue} onChange={(e) => set({ loyaltyRedeemValue: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} /></Field>
                  </div>
                  <div className="variant-preview">
                    A customer spending ₹2,000 earns <b>{Math.floor((2000 * f.loyaltyEarnPct) / 100)} points</b>, worth <b>₹{Math.floor((2000 * f.loyaltyEarnPct) / 100) * f.loyaltyRedeemValue}</b> on their next bill.
                  </div>
                </div>
              </section>
            </>
          )}

          {tab === 'users' && <StaffTab users={users} logs={logs} currentUserId={user?.id} />}
          {tab === 'data' && <DataTab f={f} set={set} />}
          {tab === 'diagnostics' && sync.superAdmin && <Diagnostics />}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- */

function StaffTab({ users, logs, currentUserId }: { users: User[]; logs: AuditLog[]; currentUserId?: string }) {
  const { toast } = useApp()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<User | null>(null)
  const [q, setQ] = useState('')
  const needle = useDebounced(q.trim().toLowerCase(), 120)

  const activeOwners = users.filter((u) => u.role === 'owner' && u.active)
  const isLastOwner = (u: User) => u.role === 'owner' && u.active && activeOwners.length <= 1
  const nameOf = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users])
  const shownLogs = useMemo(() => !needle ? logs : logs.filter((l) =>
    l.action.toLowerCase().includes(needle) || l.detail.toLowerCase().includes(needle) || (nameOf.get(l.userId) ?? '').toLowerCase().includes(needle)), [logs, needle, nameOf])

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Staff logins</h2>
          <div className="row gap-6">
            <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> Add staff</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Role</th><th>New PIN</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><input className="input" style={{ height: 34 }} defaultValue={u.name} aria-label="Name"
                    onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== u.name) void db.users.update(u.id, { name: n }); else e.target.value = u.name }} /></td>
                  <td>
                    <select className="select" style={{ height: 34, width: 140 }} value={u.role} aria-label="Role" title={ROLE_HELP[u.role]}
                      onChange={(e) => {
                        if (isLastOwner(u)) { toast('There must be at least one active owner', 'err'); return }
                        void db.users.update(u.id, { role: e.target.value as Role })
                      }}>
                      <option value="owner">Owner</option><option value="manager">Manager</option><option value="cashier">Cashier</option>
                    </select>
                  </td>
                  <td>
                    <input className="input mono" style={{ height: 34, width: 120 }} type="password" defaultValue="" maxLength={4} inputMode="numeric" aria-label={`New PIN for ${u.name}`}
                      placeholder={u.pin ? '••••  (set)' : 'not set here'} title="PINs are stored scrambled and can't be shown. Type 4 digits to set a new one."
                      onBlur={async (e) => {
                        const input = e.target
                        const p = input.value.replace(/\D/g, '')
                        input.value = ''
                        if (!p) return
                        if (p.length !== 4) { toast('A PIN is exactly 4 digits', 'err'); return }
                        rememberPlainPin(u.id, p)
                        await db.users.update(u.id, { pin: await hashPin(p) })
                        toast(`New PIN saved for ${u.name}`, 'ok')
                      }} />
                  </td>
                  <td>
                    <label className="checkbox">
                      <input type="checkbox" checked={u.active} onChange={(e) => {
                        if (!e.target.checked && isLastOwner(u)) { toast('There must be at least one active owner', 'err'); return }
                        void db.users.update(u.id, { active: e.target.checked })
                      }} />
                      {u.active ? 'Active' : 'Disabled'}
                    </label>
                  </td>
                  <td className="right">
                    {u.id !== currentUserId && (
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} title="Remove" aria-label={`Remove ${u.name}`}
                        onClick={() => (isLastOwner(u) ? toast('There must be at least one active owner', 'err') : setRemoving(u))}><TrashIcon size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="small muted" style={{ padding: 14, borderTop: '1px solid var(--line)' }}>
          <b>Owner:</b> {ROLE_HELP.owner}. <b>Manager:</b> {ROLE_HELP.manager}. <b>Cashier:</b> {ROLE_HELP.cashier}.
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Audit log</h2>
          <div className="search-wrap" style={{ flex: '0 1 280px' }}>
            <span className="ico"><Search /></span>
            <input className="input" placeholder="Search who, action or detail" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {!shownLogs.length ? <Empty icon={<HistoryIcon size={24} />} title={needle ? 'No entries match' : 'Nothing logged yet'} /> : (
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
              <tbody>
                {shownLogs.map((l) => (
                  <tr key={l.id}>
                    <td className="muted nowrap">{fmtDateTime(l.at)}</td>
                    <td>{nameOf.get(l.userId) ?? l.userId}</td>
                    <td><span className="badge">{l.action}</span></td>
                    <td>{l.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {adding && <AddStaff users={users} onClose={() => setAdding(false)} />}
      <Confirm open={!!removing} title="Remove this person?" danger confirmLabel="Remove"
        message={<><strong>{removing?.name}</strong> will no longer be able to log in. Their past bills and activity stay on record. To keep them for later, untick Active instead.</>}
        onConfirm={() => { if (removing) { void db.users.delete(removing.id); toast(`${removing.name} removed`) } }}
        onClose={() => setRemoving(null)} />
    </>
  )
}

function AddStaff({ users, onClose }: { users: User[]; onClose: () => void }) {
  const { toast } = useApp()
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('cashier')
  const [pin, setPin] = useState('')
  const [tried, setTried] = useState(false)
  const dupe = users.some((u) => u.name.trim().toLowerCase() === name.trim().toLowerCase())
  const [pinTaken, setPinTaken] = useState(false)
  useEffect(() => {
    let live = true
    if (pin.length !== 4) { setPinTaken(false); return }
    void Promise.all(users.map((u) => verifyPin(pin, u.pin))).then((r) => { if (live) setPinTaken(r.some(Boolean)) })
    return () => { live = false }
  }, [pin, users])

  async function save() {
    setTried(true)
    if (!name.trim() || dupe || pin.length !== 4) return
    const userId = id('usr')
    rememberPlainPin(userId, pin)
    await db.users.add({ id: userId, name: name.trim(), role, pin: await hashPin(pin), active: true })
    toast(`${name.trim()} added`, 'ok')
    onClose()
  }
  const submit = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void save() } }

  return (
    <Modal open title="Add staff" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary btn-lg" onClick={() => void save()}>Add staff</button></>}>
      <div className="grid grid-2">
        <Field label="Name *">
          <input className={`input ${(tried && !name.trim()) || dupe ? 'invalid' : ''}`} autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={submit} />
          {dupe && <span className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>Someone already has this name</span>}
        </Field>
        <Field label="4-digit PIN *" hint={pinTaken && pin.length === 4 ? undefined : 'They use this to log in at the counter'}>
          <input className={`input mono ${tried && pin.length !== 4 ? 'invalid' : ''}`} inputMode="numeric" maxLength={4} value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={submit} />
          {pinTaken && pin.length === 4 && <span className="small" style={{ color: 'var(--warn)', fontWeight: 650 }}>Another person uses this PIN — pick a different one</span>}
        </Field>
      </div>
      <div className="form-section">
        <h3>Role</h3>
        <Segmented value={role} options={[{ value: 'cashier', label: 'Cashier' }, { value: 'manager', label: 'Manager' }, { value: 'owner', label: 'Owner' }]} onChange={setRole} />
        <div className="small muted" style={{ marginTop: 8 }}>{ROLE_HELP[role]}</div>
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------------- */

interface Pending { payload: BackupPayload; counts: Array<[string, number]>; protectedFile: boolean }

function DataTab({ f, set }: { f: StoreSettings; set: (p: Partial<StoreSettings>) => void }) {
  const { settings, toast } = useApp()
  const [pending, setPending] = useState<Pending | null>(null)
  const [protect, setProtect] = useState(false)
  // A passphrase prompt is needed to lock a new backup file, or to unlock one that was locked.
  const [ask, setAsk] = useState<{ mode: 'lock' } | { mode: 'unlock'; text: string } | null>(null)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [passErr, setPassErr] = useState('')

  async function saveFile(text: string, suffix: string) {
    const name = `rr-dairy-backup-${new Date().toISOString().slice(0, 10)}${suffix}.json`
    if (isDesktop()) {
      const res = await saveBackup(text, name)
      if (res.ok) toast('Backup saved', 'ok')
      return
    }
    downloadFile(name, text, 'application/json')
    toast('Backup downloaded', 'ok')
  }

  async function backup() {
    if (protect) { setPass(''); setPass2(''); setPassErr(''); setAsk({ mode: 'lock' }); return }
    await saveFile(JSON.stringify(await exportBackup(), null, 2), '')
  }

  /** Read the file first and show what it contains — restoring replaces everything, so never do it blind. */
  function review(text: string, wasProtected = false) {
    if (!wasProtected && isEncryptedBackup(text)) { setPass(''); setPassErr(''); setAsk({ mode: 'unlock', text }); return }
    try {
      const payload = JSON.parse(text) as BackupPayload
      if (!payload?.data || typeof payload.data !== 'object') throw new Error('That is not a valid backup file')
      const counts = (['products', 'variants', 'bills', 'customers', 'expenses'] as const)
        .map((k) => [k, Array.isArray(payload.data[k]) ? payload.data[k].length : 0] as [string, number])
      setPending({ payload, counts, protectedFile: wasProtected })
    } catch (e) {
      toast((e as Error).message === 'That is not a valid backup file' ? (e as Error).message : 'That file could not be read as a backup', 'err')
    }
  }

  async function submitPass() {
    if (!ask) return
    setPassErr('')
    try {
      if (ask.mode === 'lock') {
        if (pass.length < 8) { setPassErr('Use at least 8 characters'); return }
        if (pass !== pass2) { setPassErr('The two passphrases don\'t match'); return }
        const locked = await encryptText(JSON.stringify(await exportBackup()), pass)
        setAsk(null)
        await saveFile(locked, '-protected')
      } else {
        const plain = await decryptWithPassphraseOrKey(ask.text, pass)
        setAsk(null)
        review(plain, true)
      }
    } catch (e) {
      setPassErr((e as Error).message)
    }
  }

  async function restoreNative() {
    const res = await openBackup()
    if (res.ok && res.text) review(res.text)
  }

  async function doRestore() {
    if (!pending) return
    try {
      await restoreBackup(pending.payload)
      toast('Backup restored — reloading', 'ok')
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      toast((e as Error).message, 'err')
    }
  }

  const connected = !!settings?.syncApiUrl

  const [clearOpen, setClearOpen] = useState(false)
  async function doClear() {
    setClearOpen(false)
    try {
      // Cloud first: if it fails nothing has changed anywhere, so the two copies can't drift apart.
      if (connected) {
        if (!isCloudReady()) throw new Error('Connect to the internet and sign in to the cloud first, so the cloud copy is cleared too')
        const res = await cloudRequest('/store/clear-sales-data', { method: 'POST' })
        if (!res.ok) throw new Error(res.status === 403 ? 'Only the owner can clear this data' : `The cloud could not clear the data (${res.status})`)
      }
      const r = await clearSalesData()
      toast(`Cleared ${r.bills} bills and ${r.customers} customers — reloading`, 'ok')
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      toast((e as Error).message, 'err')
    }
  }

  return (
    <>
      <DataSafety />

      <section className="card">
        <div className="card-head"><h2>Cloud connection</h2><SyncBadge /></div>
        <div className="card-body">
          <div className="small muted" style={{ marginBottom: 14 }}>
            {connected
              ? 'This device is linked to your cloud database. Billing never waits for it and still works offline.'
              : 'Not connected: everything stays on this device only. Sign in with your store email on the first screen to connect, or enter the details below.'}
          </div>
          <div className="grid grid-2">
            <Field label="API URL" hint="e.g. https://billing.yourstore.in/api">
              <input className="input" placeholder="https://…/api" value={f.syncApiUrl} onChange={(e) => set({ syncApiUrl: e.target.value.trim() })} />
            </Field>
            <Field label="Store ID" hint="Given when the cloud database was set up">
              <input className="input mono" placeholder="store_…" value={f.syncStoreId} onChange={(e) => set({ syncStoreId: e.target.value.trim() })} />
            </Field>
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>After saving, lock the counter and log back in — that's when the app signs in to the cloud with your PIN.</div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Backup file</h2></div>
        <div className="card-body">
          <div className="small muted" style={{ marginBottom: 14 }}>
            A single file with all your data, for keeping a copy somewhere else (a USB drive, an email to yourself). It contains customer phone numbers, scrambled staff PINs and every sale — so lock it with a passphrase if it will leave the shop.
          </div>
          <label className="checkbox" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
            Protect the file with a passphrase
          </label>
          <div className="row gap-6 wrap">
            <button className="btn btn-primary" onClick={() => void backup()}>
              <Download size={15} /> {isDesktop() ? 'Save backup file…' : 'Download backup file'}
            </button>
            {isDesktop() ? (
              <button className="btn" onClick={() => void restoreNative()}><Upload size={15} /> Restore from file…</button>
            ) : (
              <label className="btn">
                <Upload size={15} /> Restore from file
                <input type="file" accept="application/json" className="hidden"
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) void file.text().then((t) => review(t)); e.target.value = '' }} />
              </label>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Clear test data</h2></div>
        <div className="card-body">
          <div className="small muted" style={{ marginBottom: 14 }}>
            Deletes every customer and every bill and return, on this device and in the cloud, and puts the sold stock back. Products, stock, staff, expenses and settings are kept, and the next bill is numbered 1 again. Save a backup file first if you might need the old data.
          </div>
          <button className="btn btn-danger" onClick={() => setClearOpen(true)}><TrashIcon size={15} /> Clear customers and bills…</button>
        </div>
      </section>

      <Confirm open={clearOpen} title="Delete all customers and bills?" danger confirmLabel="Delete everything"
        message={<>This <strong>permanently deletes every customer and every bill</strong>{connected ? ' on this device and in the cloud' : ' on this device'}. It cannot be undone, except by restoring a backup.</>}
        onConfirm={() => void doClear()} onClose={() => setClearOpen(false)} />

      <Modal open={!!ask} title={ask?.mode === 'lock' ? 'Protect this backup' : 'This backup is protected'} onClose={() => setAsk(null)}
        footer={<><button className="btn" onClick={() => setAsk(null)}>Cancel</button><button className="btn btn-primary btn-lg" onClick={() => void submitPass()}>{ask?.mode === 'lock' ? 'Save protected backup' : 'Unlock'}</button></>}>
        <div className="dim" style={{ marginBottom: 14 }}>
          {ask?.mode === 'lock'
            ? 'Choose a passphrase. You will need it to restore this file — there is no way to recover it if it is forgotten.'
            : 'Enter the passphrase this backup was saved with — or, for a file from the backup folder on this computer, its recovery key.'}
        </div>
        <div className="col" style={{ gap: 12 }}>
          <Field label="Passphrase">
            <input className={`input input-lg ${passErr ? 'invalid' : ''}`} type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitPass() }} autoComplete="off" />
          </Field>
          {ask?.mode === 'lock' && (
            <Field label="Type it again">
              <input className={`input input-lg ${passErr ? 'invalid' : ''}`} type="password" value={pass2} onChange={(e) => setPass2(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitPass() }} autoComplete="off" />
            </Field>
          )}
          {passErr && <div className="small" style={{ color: 'var(--danger)', fontWeight: 650 }}>{passErr}</div>}
        </div>
      </Modal>

      <Confirm open={!!pending} title="Replace everything with this backup?" danger confirmLabel="Restore backup"
        message={pending && (
          <>
            This file{pending.payload.exportedAt ? <> was saved on <strong>{fmtDateTime(pending.payload.exportedAt)}</strong> and</> : null} contains{' '}
            <strong>{pending.counts.map(([k, n]) => `${n.toLocaleString('en-IN')} ${k}`).join(', ')}</strong>.
            Restoring <strong>erases everything currently on this device</strong> and replaces it with these. Take a backup of the current data first if you might want it.
          </>
        )}
        onConfirm={() => void doRestore()} onClose={() => setPending(null)} />
    </>
  )
}
