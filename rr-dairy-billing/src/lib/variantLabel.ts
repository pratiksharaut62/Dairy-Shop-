/**
 * How a variant is described to a person: "M / Navy", or just "Kanjivaram" for an item that has no colour (sarees),
 * or nothing at all for a plain single item. Never leaves a dangling " / ".
 */
export function variantLabel(size: string | undefined, color: string | undefined): string {
  return [size, color].map((s) => (s ?? '').trim()).filter(Boolean).join(' / ')
}

/**
 * A scannable SKU: style code, then the first three letters of the colour and the size when they exist. Upper case
 * and without spaces, so it can be typed or scanned reliably (the barcode lookup upper-cases what it receives).
 */
export function skuFor(styleCode: string, color: string, size: string): string {
  const clean = (s: string) => s.replace(/\s+/g, '').toUpperCase()
  return [clean(styleCode), clean(color).slice(0, 3), clean(size)].filter(Boolean).join('-')
}
