// Z.AI's quota endpoint: how to call it, how to read it, and the arithmetic the panel and the
// status bar share. Nothing here touches Orca, so `src/zai.test.ts` runs it in plain Node.

import { formatRemaining, planLabel } from './format'
import { countLine, en, windowTitle } from './messages'
import type {
  QuotaKind,
  QuotaWindow,
  Region,
  Snapshot,
  StatusTone,
  UsageErrorCode,
  View
} from './protocol'

/** The two Z.AI platforms; the quota path is the same on both. */
export const REGIONS = {
  global: {
    base: 'https://api.z.ai',
    planPage: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan'
  },
  cn: {
    base: 'https://open.bigmodel.cn',
    planPage: 'https://bigmodel.cn/coding-plan/personal/usage'
  }
} as const

const QUOTA_PATH = '/api/monitor/usage/quota/limit'
const TIMEOUT_MS = 15_000

/** Minutes in one `number` of a limit's `unit`: a day, an hour, a month and a week. */
const MINUTES_PER_UNIT: Record<number, number> = { 1: 1440, 3: 60, 5: 43200, 6: 10080 }

const KINDS: Partial<Record<string, QuotaKind>> = {
  TOKENS_LIMIT: 'tokens',
  CREDIT_LIMIT: 'credits',
  TIME_LIMIT: 'tools'
}

/**
 * Z.AI's own codes for a key it will not take. It refuses one with HTTP 200 and the reason in the
 * body: 1001 with no key sent, 401 with a key that is wrong or expired. The other 1000s are its
 * documented authentication failures.
 */
const AUTH_CODES = new Set([401, 403, 1000, 1001, 1002, 1003, 1004])

const REFRESH_DEFAULT_MINUTES = 5
const REFRESH_MIN_MINUTES = 1
const REFRESH_MAX_MINUTES = 60

/** Why a request failed, in terms the panel can show without asking again. */
export class RequestError extends Error {
  readonly code: UsageErrorCode
  readonly httpStatus: number | null
  readonly detail: string | null

  constructor(code: UsageErrorCode, httpStatus: number | null = null, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`)
    this.name = 'RequestError'
    this.code = code
    this.httpStatus = httpStatus
    this.detail = detail
  }
}

/** Minutes a limit's window lasts; null for a unit or a count this plugin does not know. */
export function windowMinutes(unit: number, count: number): number | null {
  const per = MINUTES_PER_UNIT[unit]
  return typeof per === 'number' && Number.isFinite(count) && count > 0 ? per * count : null
}

/** The refresh interval setting, kept to what the manifest allows. */
export function refreshMinutesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return REFRESH_DEFAULT_MINUTES
  }
  return Math.min(REFRESH_MAX_MINUTES, Math.max(REFRESH_MIN_MINUTES, Math.round(value)))
}

export type FetchUsageOptions = {
  region: Region
  key: string
  /** When the answer is read; a test passes a fixed one. */
  now?: number
  /** Aborting it stops the request as the caller's choice, not as a failure to report. */
  signal?: AbortSignal
  timeoutMs?: number
  /** A test passes a stand-in; the default is the runtime's fetch. */
  fetchImpl?: typeof fetch
}

/** Asks Z.AI for the plan's quota windows. Rejects with a `RequestError`. */
export async function fetchUsage(options: FetchUsageOptions): Promise<Snapshot> {
  const { region, key, signal } = options
  const now = options.now ?? Date.now()
  const controller = new AbortController()
  let timedOut = false
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? TIMEOUT_MS)
  try {
    let response: Response | null = null
    let body: unknown
    try {
      response = await (options.fetchImpl ?? fetch)(REGIONS[region].base + QUOTA_PATH, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal
      })
      if (!response.ok) {
        throw new RequestError(
          httpErrorCode(response.status),
          response.status,
          await messageOf(response)
        )
      }
      body = await response.json()
    } catch (error) {
      if (error instanceof RequestError) {
        throw error
      }
      if (timedOut) {
        throw new RequestError('timeout')
      }
      if (signal?.aborted) {
        // The caller stopped waiting: it decides what that means.
        throw error
      }
      throw new RequestError(
        response === null ? 'unreachable' : 'bad_response',
        response?.status ?? null,
        error instanceof Error ? error.message : null
      )
    }
    return parseUsage(body, region, now)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** Reads the quota endpoint's body. Rejects with a `RequestError` when it makes no sense. */
export function parseUsage(body: unknown, region: Region, now: number): Snapshot {
  const root = record(body)
  if (root === null || Number(root.code) !== 200) {
    if (root !== null && typeof root.code === 'number' && AUTH_CODES.has(root.code)) {
      throw new RequestError('bad_key', null, text(root.msg))
    }
    throw new RequestError(
      'bad_response',
      null,
      text(root?.msg) ?? (root === null ? 'not a JSON object' : `code ${String(root.code)}`)
    )
  }
  const data = record(root.data)
  if (data === null || !Array.isArray(data.limits)) {
    throw new RequestError('bad_response', null, 'no limits in the response')
  }
  const windows = data.limits
    .map((limit) => parseLimit(limit, now))
    .filter((quota): quota is QuotaWindow => quota !== null)
  if (data.limits.length > 0 && windows.length === 0) {
    throw new RequestError('bad_response', null, 'no readable limit in the response')
  }
  return {
    plan:
      [data.planName, data.plan, data.plan_type, data.packageName, data.level]
        .map(text)
        .find((plan) => plan !== null) ?? null,
    region,
    fetchedAt: now,
    windows: windows.sort(byWindow)
  }
}

/** How often the worker looks, at most: the status bar's countdown moves once a minute. */
export const TICK_MS = 60_000
const WAKE_FLOOR_MS = 1_000

/** The earliest moment one of the windows resets; null when none reports one. */
export function earliestReset(snapshot: Snapshot): number | null {
  const times = snapshot.windows
    .map((quota) => quota.resetsAt)
    .filter((at): at is number => at !== null)
  return times.length === 0 ? null : Math.min(...times)
}

/** Whether a read is wanted now: the interval has passed, or a window has just reset. */
export function isDue(
  lastAttemptAt: number,
  refreshMinutes: number,
  snapshot: Snapshot | null,
  lastAttemptOk: boolean,
  now: number
): boolean {
  if (now - lastAttemptAt >= refreshMinutes * 60_000) {
    return true
  }
  // Once a window has reset its share is whole again, so read again at once. Only after a good
  // read: a failing one is not repeated every tick for as long as it keeps failing.
  const reset = snapshot === null ? null : earliestReset(snapshot)
  return lastAttemptOk && reset !== null && reset <= now
}

/** How long until the next look: a minute, or less when a window is about to reset. */
export function nextTickDelay(snapshot: Snapshot | null, lastAttemptOk: boolean, now: number): number {
  const reset = snapshot === null || !lastAttemptOk ? null : earliestReset(snapshot)
  if (reset === null) {
    return TICK_MS
  }
  return Math.min(TICK_MS, Math.max(WAKE_FLOOR_MS, reset - now))
}

export type StatusLine = { text: string; tone: StatusTone; tooltip: string }

/** What the status bar item shows, and says when hovered. English: it is the worker's. */
export function statusLine(view: View, now: number): StatusLine {
  const { usage } = view
  if (view.key.source === 'none') {
    return {
      text: 'ZAI · no key',
      tone: 'neutral',
      tooltip: 'ZAI Usage: add your Z.AI API key in the ZAI Usage panel.'
    }
  }
  if (usage.status === 'idle' || usage.status === 'loading') {
    return { text: 'ZAI · …', tone: 'neutral', tooltip: 'ZAI Usage: loading.' }
  }
  const snapshot = usage.snapshot
  const failure = usage.status === 'error' ? usage.error : null
  const failureText = (): string | null =>
    failure === null ? null : en.errors[failure.code](failure)
  if (snapshot === null) {
    return {
      text: 'ZAI · error',
      tone: 'danger',
      tooltip: `ZAI Usage: ${failureText() ?? en.errorTitle}`
    }
  }
  const stale = failure !== null
  const headline = snapshot.windows[0]
  const plan = planLabel(snapshot.plan)
  const lines = [`ZAI Usage${plan === null ? '' : ` — ${plan}`}`]
  for (const quota of snapshot.windows) {
    const count = countLine(quota, en)
    const inText =
      quota.resetsAt === null ? '' : `, ${en.resetsIn.toLowerCase()} ${formatRemaining(quota.resetsAt - now)}`
    lines.push(
      `${windowTitle(quota, en)}: ${en.used(quota.percent)}${count === null ? '' : ` (${count})`}${inText}`
    )
  }
  if (headline === undefined) {
    lines.push(en.emptyBody)
  }
  if (stale) {
    lines.push(`${en.staleTitle}: ${failureText() ?? ''}`)
  }
  lines.push(`${en.updated} ${ago(now - snapshot.fetchedAt)}`)
  const tooltip = lines.join('\n')
  if (headline === undefined) {
    // Z.AI reports no window for this key, so there is nothing to count.
    return { text: 'ZAI · —', tone: stale ? 'warning' : 'neutral', tooltip }
  }
  const tone = usageTone(headline.percent)
  const used = `ZAI ${Math.round(headline.percent)}%`
  return {
    text: headline.resetsAt === null ? used : `${used} · ${formatRemaining(headline.resetsAt - now)}`,
    // Out of date data warns, unless what it says is already an alarm.
    tone: stale && tone !== 'danger' ? 'warning' : tone,
    tooltip
  }
}

/** The colour of a share: nothing until it starts to run out. */
export function usageTone(percent: number): StatusTone {
  return percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'neutral'
}

function ago(ms: number): string {
  return ms < 60_000 ? 'just now' : `${formatRemaining(ms)} ago`
}

function byWindow(a: QuotaWindow, b: QuotaWindow): number {
  const length = (quota: QuotaWindow): number => quota.windowMinutes ?? Number.MAX_SAFE_INTEGER
  // The shortest token or credit window first: it is the one that runs out first.
  return rank(a) - rank(b) || length(a) - length(b)
}

function rank(quota: QuotaWindow): number {
  return quota.kind === 'tools' ? 1 : 0
}

function httpErrorCode(status: number): UsageErrorCode {
  return status === 401 || status === 403 ? 'bad_key' : status === 429 ? 'rate_limited' : 'http'
}

/** What Z.AI said in the body of an error answer, when that is JSON with a message. */
async function messageOf(response: Response): Promise<string | null> {
  try {
    return text(record(await response.json())?.msg)
  } catch {
    return null
  }
}

function parseLimit(raw: unknown, now: number): QuotaWindow | null {
  const limit = record(raw)
  if (limit === null || typeof limit.type !== 'string') {
    return null
  }
  const kind = KINDS[limit.type]
  if (kind === undefined) {
    return null
  }
  const used = finite(limit.currentValue)
  const remaining = finite(limit.remaining)
  const total = finite(limit.usage) ?? (used !== null && remaining !== null ? used + remaining : null)
  const reported = finite(limit.percentage)
  const computed = used !== null && total !== null && total > 0 ? (used / total) * 100 : null
  const percent = clamp(reported ?? computed)
  if (percent === null) {
    // Nothing to draw a share from.
    return null
  }
  const span =
    typeof limit.unit === 'number' && typeof limit.number === 'number'
      ? windowMinutes(limit.unit, limit.number)
      : null
  return {
    kind,
    windowMinutes: span,
    percent,
    used,
    total,
    resetsAt: resetAt(limit.nextResetTime, span, now),
    details:
      kind === 'tools' && Array.isArray(limit.usageDetails)
        ? limit.usageDetails.map(tool).filter((detail) => detail.code !== '')
        : []
  }
}

function tool(raw: unknown): { code: string; used: number | null } {
  const detail = record(raw)
  return { code: text(detail?.modelCode) ?? '', used: finite(detail?.usage) }
}

/**
 * When the window resets, or null. Z.AI leaves it out for some windows, and now and then reports
 * one that cannot be right for the window it belongs to (a five-hour window "resetting" in ten
 * hours). Such a time is hidden rather than counted down to.
 */
function resetAt(value: unknown, spanMinutes: number | null, now: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= now) {
    return null
  }
  if (spanMinutes === null) {
    // Nothing to check the time against.
    return value
  }
  // With room for a clock that runs a little behind Z.AI's.
  const span = spanMinutes * 60_000
  const tolerance = Math.max(60_000, span / 20)
  return value > now + span + tolerance ? null : value
}

function clamp(percent: number | null): number | null {
  return percent === null ? null : Math.min(100, Math.max(0, percent))
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
