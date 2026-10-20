import { amountInWords, inr, round2 } from '../lib/money'
import { hsnSummary } from '../lib/gst'
import { Barcode } from '../components/ui'
import type { Bill, Customer, StoreSettings, User } from '../db/types'

const d = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

/** A4 GST tax invoice — used for larger sales and B2B customers who need a proper invoice. */
export function Invoice({ bill, settings, customer, cashier }: {
  bill: Bill; settings: StoreSettings; customer?: Customer | null; cashier?: User | null
}) {
  const hsn = hsnSummary(bill.items.map((i) => ({
    hsn: i.hsn, taxable: i.taxable, cgst: i.cgst, sgst: i.sgst, taxRate: i.taxRate, qty: i.qty,
  })))
  const savings = round2(bill.itemDiscount + bill.billDiscount)

  return (
    <div className="invoice">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>{settings.name}</h2>
          <div>{settings.address}</div>
          <div>{settings.city}</div>
          <div>Ph: {settings.phone} · {settings.email}</div>
          <div><strong>GSTIN: {settings.gstin}</strong></div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '.06em' }}>TAX INVOICE</div>
          <div>Invoice No: <strong>{bill.no}</strong></div>
          <div>Date: {d(bill.date)}</div>
          <div>Billed by: {cashier?.name ?? '—'}</div>
          <div style={{ marginTop: 6 }}>
            <Barcode value={bill.no.replace(/[^A-Za-z0-9-]/g, '')} height={28} width={1.1} fontSize={9} />
          </div>
        </div>
      </div>

      <div style={{ border: '1px solid #999', padding: 8, margin: '12px 0', display: 'flex', gap: 24 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: '#555' }}>Bill To</div>
          <div><strong>{customer?.name ?? 'Walk-in Customer'}</strong></div>
          {customer?.phone && <div>Mobile: {customer.phone}</div>}
          {customer?.address && <div>{customer.address}</div>}
          {customer?.gstin && <div>GSTIN: {customer.gstin}</div>}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em', color: '#555' }}>Place of Supply</div>
          <div>{settings.city}</div>
          <div>Payment: {bill.payments.map((p) => p.mode.toUpperCase()).join(' + ')}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 26 }}>#</th>
            <th>Description</th>
            <th style={{ width: 58 }}>HSN</th>
            <th style={{ width: 48 }}>Size</th>
            <th className="num" style={{ width: 40 }}>Qty</th>
            <th className="num" style={{ width: 62 }}>MRP</th>
            <th className="num" style={{ width: 70 }}>Price</th>
            <th className="num" style={{ width: 66 }}>Disc</th>
            <th className="num" style={{ width: 76 }}>Taxable</th>
            <th className="num" style={{ width: 48 }}>GST%</th>
            <th className="num" style={{ width: 82 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {bill.items.map((it, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{it.name}<div style={{ fontSize: 11.5, color: '#555' }}>{[it.color, it.sku].filter(Boolean).join(' · ')}</div></td>
              <td>{it.hsn}</td>
              <td>{it.size}</td>
              <td className="num">{it.qty}</td>
              <td className="num">{inr(it.mrp)}</td>
              <td className="num">{inr(it.price)}</td>
              <td className="num">{it.discountAmount ? inr(it.discountAmount) : '—'}</td>
              <td className="num">{inr(it.taxable)}</td>
              <td className="num">{it.taxRate}%</td>
              <td className="num">{inr(it.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 14, marginTop: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <table>
            <thead>
              <tr><th>HSN</th><th className="num">Rate</th><th className="num">Qty</th><th className="num">Taxable</th><th className="num">CGST</th><th className="num">SGST</th></tr>
            </thead>
            <tbody>
              {hsn.map((h, i) => (
                <tr key={i}>
                  <td>{h.hsn}</td><td className="num">{h.rate}%</td><td className="num">{h.qty}</td>
                  <td className="num">{inr(h.taxable)}</td><td className="num">{inr(h.cgst)}</td><td className="num">{inr(h.sgst)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12.5 }}>
            <strong>Amount in words:</strong> {amountInWords(Math.abs(bill.total))}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: '#444' }}>
            <strong>Terms:</strong> {settings.returnPolicy}
          </div>
        </div>

        <div style={{ width: 280 }}>
          <table>
            <tbody>
              <tr><td>Gross (MRP)</td><td className="num">{inr(bill.grossMrp)}</td></tr>
              {savings > 0 && <tr><td>Discount</td><td className="num">- {inr(savings)}</td></tr>}
              <tr><td>Taxable Value</td><td className="num">{inr(bill.taxableTotal)}</td></tr>
              <tr><td>CGST</td><td className="num">{inr(bill.cgstTotal)}</td></tr>
              <tr><td>SGST</td><td className="num">{inr(bill.sgstTotal)}</td></tr>
              {bill.roundOff !== 0 && <tr><td>Round Off</td><td className="num">{inr(bill.roundOff)}</td></tr>}
              <tr style={{ background: '#f1f3f7' }}>
                <td><strong>Grand Total</strong></td>
                <td className="num"><strong>{inr(Math.abs(bill.total))}</strong></td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 46, textAlign: 'center', borderTop: '1px solid #999', paddingTop: 5, fontSize: 12.5 }}>
            For {settings.name}<br />Authorised Signatory
          </div>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginTop: 14, fontSize: 12, color: '#555' }}>
        This is a computer-generated invoice. {settings.footerNote}
      </div>
    </div>
  )
}
