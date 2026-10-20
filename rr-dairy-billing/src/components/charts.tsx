import { useState } from 'react'

export interface TrendPoint { label: string; value: number; note?: string }

/** Rounds a chart ceiling up to a "nice" figure (1/2/2.5/5 × 10ⁿ) so the grid lines read cleanly. */
function niceMax(v: number) {
  if (v <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
  return step * pow
}

/**
 * Area/line chart in plain SVG (no chart library — keeps the bundle small).
 * The plot stretches to its container; labels, hover dot and tooltip are HTML
 * so text never distorts. Hover (or keyboard focus) on a column shows the day.
 */
export function TrendChart({ points, height = 220, format, axisFormat }: {
  points: TrendPoint[]
  height?: number
  format: (n: number) => string
  axisFormat: (n: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const n = points.length
  const max = niceMax(Math.max(...points.map((p) => p.value), 0))
  const x = (i: number) => ((i + 0.5) / n) * 100
  const y = (v: number) => 100 - (Math.max(0, v) / max) * 100
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ')
  const area = `${line} L${x(n - 1).toFixed(2)},100 L${x(0).toFixed(2)},100 Z`
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const active = hover === null ? null : points[hover]
  // Thin the x labels so 30 days doesn't become an unreadable smear.
  const every = n > 21 ? 5 : n > 10 ? 2 : 1

  return (
    <div className="trend" style={{ height }}>
      <div className="trend-y">
        {ticks.slice().reverse().map((t) => <span key={t}>{axisFormat(max * t)}</span>)}
      </div>
      <div className="trend-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity=".28" />
              <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <line key={t} x1="0" x2="100" y1={100 - t * 100} y2={100 - t * 100} className="trend-grid" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} fill="url(#trend-fill)" />
          <path d={line} className="trend-line" vectorEffect="non-scaling-stroke" />
        </svg>

        {active && hover !== null && (
          <>
            <div className="trend-cursor" style={{ left: `${x(hover)}%` }} />
            <div className="trend-dot" style={{ left: `${x(hover)}%`, top: `${y(active.value)}%` }} />
            <div className={`trend-tip ${x(hover) > 70 ? 'left' : ''}`} style={{ left: `${x(hover)}%` }}>
              <div className="tiny muted">{active.label}</div>
              <div className="bold num">{format(active.value)}</div>
              {active.note && <div className="tiny muted">{active.note}</div>}
            </div>
          </>
        )}

        <div className="trend-hit">
          {points.map((p, i) => (
            <button key={i} type="button" className="trend-col" aria-label={`${p.label}: ${format(p.value)}`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
          ))}
        </div>

        <div className="trend-x">
          {points.map((p, i) => (
            <span key={i} style={{ visibility: i % every === 0 ? 'visible' : 'hidden' }}>{p.label}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Tiny inline trend line for stat tiles. */
export function Sparkline({ values, tone = 'brand' }: { values: number[]; tone?: 'brand' | 'ok' | 'danger' }) {
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(100 - ((v - min) / span) * 86 - 7).toFixed(2)}`)
  return (
    <svg className={`sparkline tone-${tone}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
