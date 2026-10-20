import { useEffect, useState } from 'react'
import { getBackupState, onBackupStateChange, type BackupState } from './backup'

/** Live backup status for the UI. */
export function useBackupState(): BackupState {
  const [s, setS] = useState<BackupState>(getBackupState())
  useEffect(() => onBackupStateChange(setS), [])
  return s
}

/** Re-renders on a timer so "5 minutes ago" keeps moving without any data changing. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

/** "just now", "6 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number, now = Date.now()): string {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
