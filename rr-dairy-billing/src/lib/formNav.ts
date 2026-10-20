import type { KeyboardEvent } from 'react'

const FIELDS = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([disabled]), select:not([disabled]), textarea:not([disabled])'

/**
 * Enter moves to the next field (like Tab) in a form, and runs `onLast` from the final one. Put it on the form's
 * wrapper element: `onKeyDown={(e) => moveOnEnter(e, save)}`. It leaves alone anything that already handled Enter
 * (a tag box turning typed text into a tag), buttons, checkboxes and multi-line text boxes.
 */
export function moveOnEnter(e: KeyboardEvent<HTMLElement>, onLast?: () => void) {
  if (e.key !== 'Enter' || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.metaKey) return
  const t = e.target as HTMLElement
  if (t.tagName !== 'INPUT' && t.tagName !== 'SELECT') return
  if (t.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'submit'].includes((t as HTMLInputElement).type)) return
  e.preventDefault()
  const fields = [...e.currentTarget.querySelectorAll<HTMLElement>(FIELDS)].filter((el) => el.offsetParent !== null)
  const next = fields[fields.indexOf(t) + 1]
  if (next) {
    next.focus()
    if (next instanceof HTMLInputElement && next.type !== 'number') next.select()
  } else onLast?.()
}
