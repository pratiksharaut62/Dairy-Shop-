import { Barcode } from '../components/ui'
import { amountInWords, inr, round2 } from '../lib/money'
import { hsnSummary } from '../lib/gst'
import { receiptOptions } from '../lib/receiptOptions'
import { variantLabel } from '../lib/variantLabel'
import type { Bill, Customer, StoreSettings, User } from '../db/types'

const dt = (ms: number) =>
  new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const MODE_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', credit: 'Store Credit' }

/** 58mm / 80mm thermal receipt. Monospace + dashed rules so it prints cleanly on roll paper. */
export function Receipt({ bill, settings, customer, cashier }: {
  bill: Bill; settings: StoreSettings; customer?: Customer | null; cashier?: User | null
}) {
  const isReturn = bill.status === 'returned' && bill.refundOfBillId
  const hsn = hsnSummary(bill.items.map((i) => ({
    hsn: i.hsn, taxable: i.taxable, cgst: i.cgst, sgst: i.sgst, taxRate: i.taxRate, qty: i.qty,
  })))
  const savings = round2(bill.itemDiscount + bill.billDiscount)
  const opt = receiptOptions(settings)

  return (
    <div className={`receipt ${settings.receiptWidth === '58mm' ? 'w58' : 'w80'}`}>
      <div className="c">
        <div className="store">{settings.name}</div>
        <div>{settings.tagline}</div>
        <div>{[settings.address, settings.city].filter(Boolean).join(', ')} · Ph: {settings.phone}</div>
        {settings.gstin && <div>GSTIN: {settings.gstin}</div>}
      </div>
      <hr />
      <div className="c big">{isReturn ? 'CREDIT NOTE' : 'TAX INVOICE'}</div>
      <hr />
      <table>
        <tbody>
          <tr><td>Bill No</td><td className="r">{bill.no}</td></tr>
          <tr><td>Date</td><td className="r">{dt(bill.date)}</td></tr>
          <tr><td>Cashier</td><td className="r">{cashier?.name ?? '—'}</td></tr>
          {customer && <tr><td>Customer</td><td className="r">{customer.name}</td></tr>}
          {customer?.phone && <tr><td>Mobile</td><td className="r">{customer.phone}</td></tr>}
          {customer?.gstin && <tr><td>Cust GSTIN</td><td className="r">{customer.gstin}</td></tr>}
          {isReturn && <tr><td>Against</td><td className="r">{bill.notes.replace('Return against ', '')}</td></tr>}
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          {bill.items.map((it, i) => (
            <tr key={i}>
              <td colSpan={2}>
                <div><strong>{i + 1}. {it.name}</strong></div>
                <div>{[variantLabel(it.size, it.color), it.sku].filter(Boolean).join(' · ')}</div>
                <table>
                  <tbody>
                    {it.mrp > it.price && (
                      <tr><td>MRP {inr(it.mrp)}</td><td className="r">Price {inr(it.price)}</td></tr>
                    )}
                    <tr>
                      <td>{it.qty} x {inr(it.price)}{it.discountAmount > 0 ? ` (-${inr(it.discountAmount)})` : ''}</td>
                      <td className="r"><strong>{inr(it.lineTotal)}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          <tr><td>Items / Qty</td><td className="r">{bill.items.length} / {bill.items.reduce((s, i) => s + i.qty, 0)}</td></tr>
          <tr><td>Gross (MRP)</td><td className="r">{inr(bill.grossMrp)}</td></tr>
          {savings > 0 && <tr><td>Discount</td><td className="r">- {inr(savings)}</td></tr>}
          {opt.showTax && <>
            <tr><td>Taxable Value</td><td className="r">{inr(bill.taxableTotal)}</td></tr>
            <tr><td>CGST</td><td className="r">{inr(bill.cgstTotal)}</td></tr>
            <tr><td>SGST</td><td className="r">{inr(bill.sgstTotal)}</td></tr>
          </>}
          {bill.roundOff !== 0 && <tr><td>Round Off</td><td className="r">{inr(bill.roundOff)}</td></tr>}
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          <tr className="big">
            <td><strong>{isReturn ? 'REFUND' : 'TOTAL'}</strong></td>
            <td className="r"><strong>{inr(Math.abs(bill.total))}</strong></td>
          </tr>
        </tbody>
      </table>
      <div style={{ fontSize: 12 }}>{amountInWords(Math.abs(bill.total))}</div>
      {!opt.showTax && <div style={{ fontSize: 11.5 }}>Inclusive of all taxes</div>}
      <hr />
      <table>
        <tbody>
          {bill.payments.map((p, i) => (
            <tr key={i}><td>{MODE_LABEL[p.mode] ?? p.mode}</td><td className="r">{inr(Math.abs(p.amount))}</td></tr>
          ))}
          {bill.changeDue > 0 && <tr><td><strong>Change</strong></td><td className="r"><strong>{inr(bill.changeDue)}</strong></td></tr>}
        </tbody>
      </table>
      {opt.showSavings && savings > 0 && !isReturn && (
        <>
          <hr />
          <div className="c"><strong>You saved {inr(savings)} on this bill!</strong></div>
        </>
      )}
      {opt.showLoyalty && customer && (bill.loyaltyEarned > 0 || customer.loyaltyPoints > 0) && (
        <div className="c" style={{ fontSize: 12 }}>
          Loyalty: +{bill.loyaltyEarned} pts earned
        </div>
      )}
      {opt.showHsn && <>
      <hr />
      <div style={{ fontSize: 11.5 }}>
        <strong>HSN Summary</strong>
        <table>
          <tbody>
            <tr><td>HSN</td><td className="r">Rate</td><td className="r">Taxable</td><td className="r">Tax</td></tr>
            {hsn.map((h, i) => (
              <tr key={i}>
                <td>{h.hsn}</td>
                <td className="r">{h.rate}%</td>
                <td className="r">{h.taxable.toFixed(2)}</td>
                <td className="r">{(h.cgst + h.sgst).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>}
      <hr />
      <div className="c" style={{ fontSize: 11.5 }}>{settings.returnPolicy}</div>
      <div className="c" style={{ margin: '6px 0' }}>
        <Barcode value={bill.no.replace(/[^A-Za-z0-9-]/g, '')} height={30} width={1.1} fontSize={11} />
      </div>
      <div className="c"><strong>{settings.footerNote}</strong></div>
      <div className="c" style={{ fontSize: 11 }}>RR Dairy</div>
    </div>
  )
}
