import { inr } from '../lib/money'

export interface ReportCol { key: string; label: string; /** Right-aligned number column. */ num?: boolean; /** Format as rupees. */ money?: boolean }

/**
 * A plain, ink-on-paper table for printing any report: shop name, report title, period, then the rows.
 * Rendered into the print area (not the screen), so it prints identically whatever the app looks like.
 */
export function ReportPrint({ store, title, period, cols, rows, footer }: {
  store: string
  title: string
  period: string
  cols: ReportCol[]
  rows: Array<Record<string, string | number>>
  footer?: string
}) {
  const cell = (c: ReportCol, v: string | number | undefined) =>
    v === undefined || v === '' ? '' : c.money && typeof v === 'number' ? inr(v) : String(v)
  return (
    <div className="invoice">
      <h2>{store}</h2>
      <div style={{ fontWeight: 700, marginTop: 2 }}>{title}</div>
      <div style={{ marginBottom: 10 }}>{period} · Printed {new Date().toLocaleString('en-IN')}</div>
      <table>
        <thead><tr>{cols.map((c) => <th key={c.key} className={c.num || c.money ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c.key} className={c.num || c.money ? 'num' : ''}>{cell(c, r[c.key])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {footer && <div style={{ marginTop: 10, fontSize: 10.5 }}>{footer}</div>}
    </div>
  )
}
