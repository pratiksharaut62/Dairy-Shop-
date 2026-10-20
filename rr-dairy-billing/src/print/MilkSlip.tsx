import { inr } from '../lib/money'
import { MILK_LABEL } from '../lib/milkRate'
import type { Collection, Farmer, StoreSettings } from '../db/types'

const dt = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** The slip a farmer carries home from the collection counter: what was received, its quality and what it is worth. */
export function MilkSlip({ settings, farmer, c, monthLitres, monthAmount }: {
  settings: StoreSettings; farmer: Farmer; c: Collection; monthLitres?: number; monthAmount?: number
}) {
  return (
    <div className={`receipt ${settings.receiptWidth === '58mm' ? 'w58' : 'w80'}`}>
      <div className="c">
        <div className="store">{settings.name}</div>
        {settings.tagline && <div>{settings.tagline}</div>}
        {settings.phone && <div>Ph: {settings.phone}</div>}
      </div>
      <hr />
      <div className="c big">MILK COLLECTION SLIP</div>
      <hr />
      <table>
        <tbody>
          <tr><td>Slip No</td><td className="r">{c.no}</td></tr>
          <tr><td>Date</td><td className="r">{dt(c.date)}</td></tr>
          <tr><td>Shift</td><td className="r">{c.session === 'morning' ? 'Morning' : 'Evening'} · {MILK_LABEL[c.milkType]}</td></tr>
          <tr><td>Farmer</td><td className="r">{farmer.code} · {farmer.name}</td></tr>
          {farmer.village && <tr><td>Village</td><td className="r">{farmer.village}</td></tr>}
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          <tr><td>Quantity</td><td className="r">{c.qtyL.toFixed(2)} L</td></tr>
          <tr><td>Fat</td><td className="r">{c.fat.toFixed(1)} %</td></tr>
          <tr><td>SNF</td><td className="r">{c.snf.toFixed(1)} %</td></tr>
          <tr><td>Rate</td><td className="r">₹ {c.rate.toFixed(2)} / L</td></tr>
        </tbody>
      </table>
      <hr />
      <table>
        <tbody><tr className="slip-total"><td>AMOUNT</td><td className="r">{inr(c.amount)}</td></tr></tbody>
      </table>
      {c.status === 'pending' && <div className="c" style={{ marginTop: 4 }}>(Subject to quality approval)</div>}
      {monthLitres !== undefined && (
        <>
          <hr />
          <table>
            <tbody>
              <tr><td>This month</td><td className="r">{monthLitres.toFixed(2)} L</td></tr>
              {monthAmount !== undefined && <tr><td>Milk value</td><td className="r">{inr(monthAmount)}</td></tr>}
            </tbody>
          </table>
        </>
      )}
      <hr />
      <div className="c">Thank you</div>
    </div>
  )
}
