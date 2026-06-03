import { describe, it, expect } from 'vitest'
import { isScheduledBackupDue } from '@/lib/backups/scheduler'

// A fixed local "now": 2026-06-01 is a Monday (getDay() === 1).
function at(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

describe('isScheduledBackupDue', () => {
  it('off → never due', () => {
    expect(isScheduledBackupDue({ schedule: 'off', scheduleHour: 3, scheduleWeekday: 0 }, 0, at(2026, 6, 1, 10))).toBe(false)
  })

  it('daily → due once the hour is reached and not yet run today', () => {
    const cfg = { schedule: 'daily' as const, scheduleHour: 3, scheduleWeekday: 0 }
    // Before 03:00 → not due.
    expect(isScheduledBackupDue(cfg, 0, at(2026, 6, 1, 2, 59))).toBe(false)
    // At/after 03:00, never run → due.
    expect(isScheduledBackupDue(cfg, 0, at(2026, 6, 1, 3, 5))).toBe(true)
  })

  it('daily → not due again if already run after today’s scheduled instant', () => {
    const cfg = { schedule: 'daily' as const, scheduleHour: 3, scheduleWeekday: 0 }
    const ranAt = at(2026, 6, 1, 3, 1).getTime()
    expect(isScheduledBackupDue(cfg, ranAt, at(2026, 6, 1, 10))).toBe(false)
    // Next day after the hour → due again.
    expect(isScheduledBackupDue(cfg, ranAt, at(2026, 6, 2, 3, 5))).toBe(true)
  })

  it('weekly → only fires on the configured weekday', () => {
    // Monday = 1.
    const cfg = { schedule: 'weekly' as const, scheduleHour: 3, scheduleWeekday: 1 }
    expect(isScheduledBackupDue(cfg, 0, at(2026, 6, 1, 4))).toBe(true) // Monday, after 3am
    expect(isScheduledBackupDue(cfg, 0, at(2026, 6, 2, 4))).toBe(false) // Tuesday
  })
})
