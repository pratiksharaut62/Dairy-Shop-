import { useRef, useState } from 'react'
import { Close } from './icons'

/** Splits the comma-separated string the forms store ("S, M, L") into clean tags. */
export const parseTags = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

/**
 * Chip input for comma-separated lists (sizes, colours). Type and press Enter or comma to
 * make a chip, Backspace on an empty box removes the last one, pasting "S, M, L" splits it.
 * The value stays a plain comma-separated string, so it drops into existing form state.
 */
export function TagInput({ value, onChange, placeholder, invalid }: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  invalid?: boolean
}) {
  const tags = parseTags(value)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = (raw: string) => {
    const add = parseTags(raw).filter((t) => !tags.some((x) => x.toLowerCase() === t.toLowerCase()))
    if (add.length) onChange([...tags, ...add].join(', '))
    setText('')
  }
  const remove = (t: string) => onChange(tags.filter((x) => x !== t).join(', '))

  return (
    <div className={`tags ${invalid ? 'invalid' : ''}`} onClick={() => inputRef.current?.focus()}>
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
          <button type="button" aria-label={`Remove ${t}`} onClick={(e) => { e.stopPropagation(); remove(t) }}><Close size={11} /></button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={text}
        placeholder={tags.length ? '' : placeholder}
        onChange={(e) => { if (e.target.value.includes(',')) commit(e.target.value); else setText(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { if (text.trim()) { e.preventDefault(); commit(text) } }
          else if (e.key === 'Backspace' && !text && tags.length) remove(tags[tags.length - 1])
        }}
        onBlur={() => text.trim() && commit(text)}
      />
    </div>
  )
}
