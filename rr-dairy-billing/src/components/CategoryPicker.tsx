import type { Category } from '../db/types'

/**
 * Pick a category with one click instead of opening a long list. Buttons are grouped (Women, Men, …) in the order
 * the caller sorted them, so Sarees comes first. Fully keyboard-usable: Tab/Shift-Tab between buttons, Enter or Space picks.
 */
export function CategoryPicker({ categories, value, onPick }: {
  categories: Category[]
  value: string
  onPick: (categoryId: string) => void
}) {
  // Keep the caller's order, but group headings in order of first appearance.
  const groups: Array<{ name: string; items: Category[] }> = []
  for (const c of categories) {
    const g = groups.find((x) => x.name === c.group)
    if (g) g.items.push(c); else groups.push({ name: c.group, items: [c] })
  }
  if (!categories.length) return <div className="small muted">No categories yet.</div>
  return (
    <div className="col gap-8" role="radiogroup" aria-label="Category">
      {groups.map((g) => (
        <div key={g.name} className="row gap-6 wrap" style={{ alignItems: 'center' }}>
          <span className="small muted" style={{ width: 84, flex: '0 0 auto' }}>{g.name}</span>
          {g.items.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={value === c.id}
              className={`chip ${value === c.id ? 'on' : ''}`} onClick={() => onPick(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
