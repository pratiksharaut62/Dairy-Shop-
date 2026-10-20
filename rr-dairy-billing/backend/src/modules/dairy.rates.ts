/**
 * Rate-chart arithmetic, identical to src/lib/milkRate.ts on the client: a cell matches when
 * fatMin ≤ fat < fatMax and snfMin ≤ snf < snfMax; if cells overlap the highest fat floor, then SNF floor, wins.
 */
export interface Slab { fatMin: number; fatMax: number; snfMin: number; snfMax: number; rate: number }

export function slabFor(slabs: Slab[], fat: number, snf: number): Slab | null {
  let best: Slab | null = null
  for (const s of slabs) {
    if (fat < s.fatMin || fat >= s.fatMax || snf < s.snfMin || snf >= s.snfMax) continue
    if (!best || s.fatMin > best.fatMin || (s.fatMin === best.fatMin && s.snfMin > best.snfMin)) best = s
  }
  return best
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
