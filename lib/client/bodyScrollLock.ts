'use client'

// Cooperative body-scroll lock. Multiple modals (mobile drawer,
// ConfirmModal, MediaPickerModal, …) can stack: we keep a counter on
// `document.body.dataset.bwcScrollLocks` so the LAST modal closing is
// the one that restores the original `overflow` value. Naive
// save/restore inside each component races — the second modal's
// "restore" overwrites the first modal's "set hidden".

let saved: string | null = null

function readCount(): number {
  if (typeof document === 'undefined') return 0
  const raw = document.body.dataset['bwcScrollLocks']
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function writeCount(n: number) {
  if (n <= 0) {
    delete document.body.dataset['bwcScrollLocks']
  } else {
    document.body.dataset['bwcScrollLocks'] = String(n)
  }
}

export function acquireScrollLock(): void {
  if (typeof document === 'undefined') return
  const current = readCount()
  if (current === 0) {
    saved = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  writeCount(current + 1)
}

export function releaseScrollLock(): void {
  if (typeof document === 'undefined') return
  const current = readCount()
  if (current <= 1) {
    writeCount(0)
    document.body.style.overflow = saved ?? ''
    saved = null
  } else {
    writeCount(current - 1)
  }
}
