// A quota answer in the shape Z.AI's endpoint reports, and the views the panel draws in each of
// its states. The tests and `orca plugin check` share them.

import { parseUsage } from './zai'
import type { KeyStatus, Snapshot, UsageErrorCode, View } from './protocol'

/** A fixed moment (28 May 2026), so a test reads the same on any day. */
export const NOW = 1_780_000_000_000

/** A stand-in for a real key. */
export const KEY = 'sk-test-1234'

/** Minutes until the five-hour window resets in a sample. */
export const RESETS_IN_MINUTES = 133

/** The endpoint's answer at `now`: a Pro plan using 15% of its five-hour tokens and 45% of its
 *  monthly tool calls. */
export const sampleBody = (now: number): unknown => ({
  code: 200,
  msg: '操作成功',
  success: true,
  data: {
    level: 'pro',
    limits: [
      {
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        usage: 800_000_000,
        currentValue: 127_694_464,
        remaining: 672_305_536,
        percentage: 15,
        nextResetTime: now + RESETS_IN_MINUTES * 60_000
      },
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 1828,
        remaining: 2172,
        percentage: 45,
        usageDetails: [
          { modelCode: 'search-prime', usage: 1433 },
          { modelCode: 'web-reader', usage: 462 },
          { modelCode: 'zread', usage: 0 }
        ]
      }
    ]
  }
})

/** What Z.AI answers a key it will not take: HTTP 200, and the reason in the body's code. */
export const REFUSES_A_KEY = {
  code: 401,
  msg: 'token expired or incorrect',
  success: false
}

/** The sample as read at the fixed moment: its reset is at NOW + 133 minutes. */
export const SAMPLE = sampleBody(NOW)

const key: KeyStatus = { source: 'secret', masked: '••••1234', protection: 'os-keyring' }
const noKey: KeyStatus = { source: 'none', masked: null, protection: 'os-keyring' }

/** The sample as read a moment ago, so its reset is still in the future whenever this runs. */
const live = (): Snapshot => parseUsage(sampleBody(Date.now()), 'global', Date.now())

/** No key, so the panel asks for one. */
export const noKeyView = (): View => ({
  key: noKey,
  region: 'global',
  usage: { status: 'idle' }
})

/** The usage as read a moment ago. */
export const readyView = (): View => ({
  key,
  region: 'global',
  usage: { status: 'ready', snapshot: live() }
})

/** A first read that failed, so there is nothing to show but the reason. */
export const failedView = (code: UsageErrorCode): View => ({
  key,
  region: 'global',
  usage: {
    status: 'error',
    error: {
      code,
      httpStatus: null,
      detail: code === 'bad_key' ? REFUSES_A_KEY.msg : null
    },
    snapshot: null
  }
})

/** A later read that failed: the last good one is still there to show as out of date. */
export const staleView = (code: UsageErrorCode = 'unreachable'): View => ({
  key,
  region: 'global',
  usage: {
    status: 'error',
    error: { code, httpStatus: null, detail: code === 'unreachable' ? 'fetch failed' : null },
    snapshot: live()
  }
})
