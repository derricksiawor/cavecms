import 'server-only'
import { readFileSync } from 'node:fs'

// The memory budget this install actually runs inside. On shared
// cPanel/CloudLinux hosting /proc/meminfo is VIRTUALIZED per account (LVE):
// MemTotal IS the account's memory cap, not the physical host's RAM — which
// makes it the honest number to show an operator wondering why their site
// went down during an update. On a normal VPS it's simply the machine's RAM.
// Returns nulls off-Linux (macOS dev) so callers can skip the readout.

export interface MemoryBudget {
  totalMb: number | null
  availableMb: number | null
}

export function readMemoryBudget(): MemoryBudget {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8')
    const total = /^MemTotal:\s+(\d+)\s*kB/m.exec(text)
    const avail = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text)
    return {
      totalMb: total && total[1] ? Math.floor(Number(total[1]) / 1024) : null,
      availableMb: avail && avail[1] ? Math.floor(Number(avail[1]) / 1024) : null,
    }
  } catch {
    return { totalMb: null, availableMb: null }
  }
}

/** Below this account-wide cap, updates (and busy traffic) run close to the
 *  wire — worth telling the operator before they find out via a 503. */
export const MEMORY_TIGHT_BELOW_MB = 1536
