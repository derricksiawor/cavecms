// Pure color-contrast math. No DOM, no server-only — safe to import
// from the client Theme picker AND unit tests.
//
// Two standards:
//   - wcagRatio(): WCAG 2.x relative-luminance ratio (the LEGAL/tooling
//     baseline the product gates Save on — AA = 4.5:1 text, 3:1 large/UI).
//   - apcaLc(): APCA Lc (perceptual; SHOWN as an advisory second opinion,
//     does NOT gate Save). Implements the published APCA-W3 0.1.9 / 0.98G
//     constants. Returns signed Lc (negative = light-on-dark / reverse
//     polarity); callers take abs() for thresholding.

export type RGB = [number, number, number]

export function hexToRgb(hex: string): RGB | null {
  const m = hex.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(m)) {
    const r = m.slice(0, 1)
    const g = m.slice(1, 2)
    const b = m.slice(2, 3)
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)]
  }
  if (/^[0-9a-fA-F]{6}$/.test(m)) {
    return [
      parseInt(m.slice(0, 2), 16),
      parseInt(m.slice(2, 4), 16),
      parseInt(m.slice(4, 6), 16),
    ]
  }
  return null
}

// WCAG 2.x relative luminance (sRGB piecewise linearization).
function relLuminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function wcagRatio(fg: string, bg: string): number {
  const a = hexToRgb(fg)
  const b = hexToRgb(bg)
  if (!a || !b) return 1
  const L1 = relLuminance(a)
  const L2 = relLuminance(b)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}

// APCA-W3 0.1.9 constants ("0.98G-4g").
function apcaY([r, g, b]: RGB): number {
  const lin = (c: number) => Math.pow(c / 255, 2.4)
  return 0.2126729 * lin(r) + 0.7151522 * lin(g) + 0.072175 * lin(b)
}
function softClamp(Y: number): number {
  return Y < 0.022 ? Y + Math.pow(0.022 - Y, 1.414) : Y
}

export function apcaLc(text: string, bg: string): number {
  const t = hexToRgb(text)
  const b = hexToRgb(bg)
  if (!t || !b) return 0
  const Ytxt = softClamp(apcaY(t))
  const Ybg = softClamp(apcaY(b))
  if (Math.abs(Ybg - Ytxt) < 0.0005) return 0
  let C: number
  if (Ybg > Ytxt) {
    // Normal polarity: dark text on light bg.
    C = (Math.pow(Ybg, 0.56) - Math.pow(Ytxt, 0.57)) * 1.14
    if (C < 0.1) return 0
    C -= 0.027
  } else {
    // Reverse polarity: light text on dark bg.
    C = (Math.pow(Ybg, 0.65) - Math.pow(Ytxt, 0.62)) * 1.14
    if (C > -0.1) return 0
    C += 0.027
  }
  return C * 100
}
