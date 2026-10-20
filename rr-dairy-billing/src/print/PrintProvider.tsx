import { isDesktop, printSilent } from '../lib/tauri'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

interface PrintOpts {
  /** Overrides the page's physical size for this print job (e.g. a barcode
   *  label's exact mm dimensions) instead of using the printer's default
   *  paper size — critical for a label-roll printer, where the OS maps
   *  "page size" straight onto how far it feeds between labels. */
  pageSizeMm?: { w: number; h: number }
  /** Desktop app: send straight to the Windows default printer with no print dialog (receipts). Anything else still shows the dialog. */
  silent?: boolean
}
interface PrintApi { print: (node: ReactNode, opts?: PrintOpts) => void }
const Ctx = createContext<PrintApi | null>(null)

/**
 * Renders whatever needs printing into a container that is hidden on screen and
 * visible on paper, then fires the browser print dialog. Works with any printer,
 * including 58/80mm thermal, because the receipt CSS sets its own paper width.
 */
export function PrintProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null)
  const [pageSizeMm, setPageSizeMm] = useState<{ w: number; h: number } | null>(null)
  const [silent, setSilent] = useState(false)

  const print = useCallback((n: ReactNode, opts?: PrintOpts) => {
    setPageSizeMm(opts?.pageSizeMm ?? null)
    setSilent(!!opts?.silent)
    setNode(n)
  }, [])

  useEffect(() => {
    if (!node) return
    const done = () => setNode(null)
    window.addEventListener('afterprint', done)
    // Give React and JsBarcode a frame to paint before the dialog opens.
    const t = setTimeout(() => {
      if (silent && isDesktop()) {
        // If silent printing isn't possible (not Windows, old WebView2) fall back to the normal dialog rather than losing the print.
        printSilent().then(done, () => window.print())
      } else {
        window.print()
      }
    }, 220)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', done) }
  }, [node, silent])

  return (
    <Ctx.Provider value={{ print }}>
      {children}
      {pageSizeMm && (
        <style>{`@media print { @page { size: ${pageSizeMm.w}mm ${pageSizeMm.h}mm; margin: 0; } }`}</style>
      )}
      <div className="print-only" id="print-root">{node}</div>
    </Ctx.Provider>
  )
}

export function usePrint(): PrintApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePrint must be used inside PrintProvider')
  return v
}
