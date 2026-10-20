/** All money is handled as rupees in JS numbers but rounded to 2dp at every boundary. */

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export const inr = (n: number) =>
  '₹' + round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Compact form for tiles: ₹1.2L, ₹45.3k */
export function inrShort(n: number) {
  const a = Math.abs(n)
  if (a >= 1e7) return '₹' + (n / 1e7).toFixed(2) + 'Cr'
  if (a >= 1e5) return '₹' + (n / 1e5).toFixed(2) + 'L'
  if (a >= 1e3) return '₹' + (n / 1e3).toFixed(1) + 'k'
  return inr(n)
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigit(n: number): string {
  if (n < 20) return ONES[n]
  return (TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')).trim()
}

/** Indian numbering: crore / lakh / thousand / hundred. Used on the printed invoice. */
export function amountInWords(amount: number): string {
  const rupees = Math.floor(round2(amount))
  const paise = Math.round((round2(amount) - rupees) * 100)
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only'

  const parts: string[] = []
  const push = (v: number, label: string) => { if (v) parts.push(twoDigit(v) + ' ' + label) }
  push(Math.floor(rupees / 1e7), 'Crore')
  push(Math.floor((rupees % 1e7) / 1e5), 'Lakh')
  push(Math.floor((rupees % 1e5) / 1e3), 'Thousand')
  push(Math.floor((rupees % 1e3) / 100), 'Hundred')
  const last = rupees % 100
  if (last) parts.push((parts.length ? 'and ' : '') + twoDigit(last))

  let out = parts.join(' ').trim() + ' Rupees'
  if (paise) out += ' and ' + twoDigit(paise) + ' Paise'
  return out + ' Only'
}

/** Cash-drawer friendly rounding to the nearest rupee. Returns [roundedTotal, roundOffDelta]. */
export function roundOff(total: number): [number, number] {
  const rounded = Math.round(round2(total))
  return [rounded, round2(rounded - round2(total))]
}
