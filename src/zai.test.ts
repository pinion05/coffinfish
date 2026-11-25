// Runs src/zai.ts's reading of the quota endpoint in plain Node: no Orca, and no network.
import { assert, test } from 'orca/testing'
import { formatCount, formatRemaining, planLabel } from './format'
import { KEY, NOW, RESETS_IN_MINUTES, SAMPLE, sampleBody } from './fixtures'
import { countLine, detailLine, en, ko, messagesFor, windowTitle } from './messages'
import type { QuotaWindow, Snapshot, StatusTone, UsageErrorCode, View } from './protocol'
import {
  RequestError,
  earliestReset,
  fetchUsage,
  isDue,
  nextTickDelay,
  parseUsage,
  refreshMinutesOf,
  statusLine,
  windowMinutes
} from './zai'

const minute = 60_000
const hour = 60 * minute
const fiveHour = { type: 'TOKENS_LIMIT', unit: 3, number: 5 }

const reads = (limits: unknown[]): Snapshot => parseUsage({ code: 200, data: { limits } }, 'global', NOW)
const sample = (): Snapshot => parseUsage(SAMPLE, 'global', NOW)
const [five, tools] = sample().windows

test('reads the five-hour window and the monthly tools', () => {
  const snapshot = sample()
  assert.equal(snapshot.plan, 'pro')
  assert.equal(snapshot.region, 'global')
  assert.equal(snapshot.fetchedAt, NOW)
  assert.deepEqual(snapshot.windows, [
    {
      kind: 'tokens',
      windowMinutes: 300,
      percent: 15,
      used: 127_694_464,
      total: 800_000_000,
      resetsAt: NOW + RESETS_IN_MINUTES * minute,
      details: []
    },
    {
      kind: 'tools',
      windowMinutes: 43200,
      percent: 45,
      used: 1828,
      total: 4000,
      resetsAt: null,
      details: [
        { code: 'search-prime', used: 1433 },
        { code: 'web-reader', used: 462 },
        { code: 'zread', used: 0 }
      ]
    }
  ])
})

test('lists the window that runs out first, and skips what it cannot read', () => {
  const snapshot = reads([
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 5 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 52 },
    { type: 'SOMETHING_ELSE', unit: 3, number: 5, percentage: 99 },
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 7, currentValue: 70, usage: 1000 },
    'not a limit',
    { type: 'TOKENS_LIMIT' }
  ])
  assert.deepEqual(
    snapshot.windows.map((quota) => [quota.kind, quota.windowMinutes, quota.percent]),
    [
      ['credits', 300, 7],
      ['tokens', 10080, 52],
      ['tools', 43200, 5]
    ]
  )
})

test('finds the plan where Z.AI names it', () => {
  const plan = (data: object): string | null =>
    parseUsage({ code: 200, data: { ...data, limits: [] } }, 'global', NOW).plan
  assert.equal(plan({ planName: 'GLM Coding Max', level: 'lite' }), 'GLM Coding Max')
  assert.equal(plan({ level: 'lite' }), 'lite')
  assert.equal(plan({}), null)
})

test('keeps a reset time it can trust, and drops the rest', () => {
  const limit = (nextResetTime: number): object => ({ ...fiveHour, percentage: 10, nextResetTime })
  const resets = (limits: unknown[]): (number | null)[] => reads(limits).windows.map((quota) => quota.resetsAt)
  const soon = NOW + 2 * hour
  assert.deepEqual(resets([limit(soon)]), [soon])
  assert.deepEqual(resets([limit(NOW - 1000)]), [null]) // already past
  // A five-hour window cannot reset in ten hours, though Z.AI now and then says one does.
  assert.deepEqual(resets([limit(NOW + 10 * hour)]), [null])
  assert.deepEqual(resets([limit(NOW + 310 * minute)]), [NOW + 310 * minute]) // a clock five minutes slow
  assert.deepEqual(resets([limit(NOW + 320 * minute)]), [null])
  // A window this plugin does not know the length of is taken as it comes.
  assert.deepEqual(resets([{ ...limit(soon), unit: 99 }]), [soon])
  assert.deepEqual(resets([{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1 }]), [null])
})

test('computes the share when none is reported, and keeps it within 0 to 100', () => {
  const share = (limit: object): number => reads([limit]).windows[0].percent
  assert.equal(share({ ...fiveHour, usage: 800, currentValue: 120, remaining: 680 }), 15)
  assert.equal(share({ ...fiveHour, currentValue: 30, remaining: 70 }), 30) // the total from what is left
  assert.equal(share({ ...fiveHour, percentage: 140 }), 100)
  assert.equal(share({ ...fiveHour, percentage: -3 }), 0)
})

test('says when the key is no good, and when the answer makes no sense', () => {
  const outcome = (body: unknown): string => {
    try {
      parseUsage(body, 'global', NOW)
      return 'accepted'
    } catch (error) {
      return error instanceof RequestError ? error.code : String(error)
    }
  }
  assert.equal(outcome({ code: 1002, msg: 'Authentication Token 非法' }), 'bad_key')
  assert.equal(outcome({ code: 401 }), 'bad_key')
  assert.equal(outcome(null), 'bad_response')
  assert.equal(outcome({ code: 200 }), 'bad_response') // no limits at all
  assert.equal(outcome({ code: 200, data: { limits: [fiveHour] } }), 'bad_response') // no share to read
  assert.equal(outcome({ code: 500, msg: 'boom' }), 'bad_response')
  assert.equal(outcome({ code: 200, data: { limits: [] } }), 'accepted')
  assert.throws(
    () => parseUsage({ code: 1002, msg: 'Authentication Token 非法' }, 'global', NOW),
    (error: unknown): boolean =>
      error instanceof RequestError &&
      error.code === 'bad_key' &&
      error.httpStatus === null &&
      error.detail === 'Authentication Token 非法'
  )
})

type Answer = Response | Promise<Response>

/** A stand-in for the runtime's fetch: it notes each request and answers as told. */
function stubFetch(answer: (signal: AbortSignal | null | undefined) => Answer) {
  const calls: { url: string; headers: Headers }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return answer(init?.signal)
  }) as typeof fetch
  return { calls, fetchImpl }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

/** A request that never answers, until it is aborted. */
const hang = (signal: AbortSignal | null | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })

/** What a request ended in: a snapshot, or the code it was refused with. */
async function outcomeOf(answer: () => Answer): Promise<'answered' | [UsageErrorCode, number | null, string | null]> {
  const { fetchImpl } = stubFetch(answer)
  try {
    await fetchUsage({ region: 'global', key: KEY, now: NOW, fetchImpl })
    return 'answered'
  } catch (error) {
    assert.ok(error instanceof RequestError)
    return [error.code, error.httpStatus, error.detail]
  }
}

test('asks the quota endpoint of the region, with the key as a bearer token', async () => {
  const global = stubFetch(() => json(SAMPLE))
  const snapshot = await fetchUsage({ region: 'global', key: KEY, now: NOW, fetchImpl: global.fetchImpl })
  assert.equal(snapshot.windows.length, 2)
  const cn = stubFetch(() => json(SAMPLE))
  await fetchUsage({ region: 'cn', key: KEY, now: NOW, fetchImpl: cn.fetchImpl })
  assert.deepEqual(
    [global.calls[0], cn.calls[0]].map((call) => call.url),
    [
      'https://api.z.ai/api/monitor/usage/quota/limit',
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
    ]
  )
  assert.equal(global.calls[0].headers.get('authorization'), `Bearer ${KEY}`)
})

test('names what went wrong when Z.AI does not answer as hoped', async () => {
  assert.equal(await outcomeOf(() => json(SAMPLE)), 'answered')
  // How Z.AI in fact refuses a key, on both platforms: HTTP 200, and the reason in the body.
  assert.deepEqual(
    await outcomeOf(() => json({ code: 401, msg: 'token expired or incorrect', success: false })),
    ['bad_key', null, 'token expired or incorrect']
  )
  assert.deepEqual(
    await outcomeOf(() =>
      json({
        code: 1001,
        msg: 'Authentication parameter not received in Header, unable to authenticate',
        success: false
      })
    ),
    ['bad_key', null, 'Authentication parameter not received in Header, unable to authenticate']
  )
  // The same reasons behind an HTTP status, as some gateways send them.
  assert.deepEqual(await outcomeOf(() => json({ code: 401, msg: 'expired' }, 401)), ['bad_key', 401, 'expired'])
  assert.deepEqual(await outcomeOf(() => new Response('slow down', { status: 429 })), ['rate_limited', 429, null])
  assert.deepEqual(await outcomeOf(() => new Response(null, { status: 503 })), ['http', 503, null])
  // An error page is not an answer: the status is kept, and not the page.
  const page = await outcomeOf(() => new Response('<html>down</html>', { status: 200 }))
  assert.equal(page[0], 'bad_response')
  assert.deepEqual(await outcomeOf(() => { throw new TypeError('fetch failed') }), ['unreachable', null, 'fetch failed'])
})

test('gives up after the timeout, and leaves an abort to the caller', async () => {
  const slow = stubFetch(hang)
  try {
    await fetchUsage({ region: 'global', key: KEY, now: NOW, fetchImpl: slow.fetchImpl, timeoutMs: 20 })
    assert.fail('a request that hangs times out')
  } catch (error) {
    assert.ok(error instanceof RequestError)
    assert.equal(error.code, 'timeout')
  }
  const caller = new AbortController()
  const pending = fetchUsage({
    region: 'global',
    key: KEY,
    now: NOW,
    signal: caller.signal,
    fetchImpl: stubFetch(hang).fetchImpl
  })
  caller.abort()
  await assert.rejects(pending, (error: unknown): boolean => error instanceof Error && error.name === 'AbortError')
})

test('knows a day, an hour, a month and a week', () => {
  assert.equal(windowMinutes(1, 1), 1440)
  assert.equal(windowMinutes(3, 5), 300)
  assert.equal(windowMinutes(5, 1), 43200)
  assert.equal(windowMinutes(6, 1), 10080)
  assert.equal(windowMinutes(99, 1), null)
  assert.equal(windowMinutes(3, 0), null)
})

test('keeps the refresh interval to what the manifest allows', () => {
  assert.equal(refreshMinutesOf(5), 5)
  assert.equal(refreshMinutesOf(0.4), 1)
  assert.equal(refreshMinutesOf(999), 60)
  assert.equal(refreshMinutesOf(7.6), 8)
  assert.equal(refreshMinutesOf('5'), 5)
  assert.equal(refreshMinutesOf(undefined), 5)
})

test('reads again when the interval has passed, or right after a window reset', () => {
  const snapshot = sample()
  assert.equal(earliestReset(snapshot), NOW + RESETS_IN_MINUTES * minute)
  assert.equal(earliestReset(reads([])), null)
  assert.equal(isDue(0, 5, null, true, NOW), true) // never read
  assert.equal(isDue(NOW, 5, snapshot, true, NOW + 4 * minute), false) // four minutes after a read
  assert.equal(isDue(NOW, 5, snapshot, true, NOW + 5 * minute), true) // the interval has passed
  // A window read a moment ago that is about to reset: its share is whole again once it has, so
  // read at once rather than when the interval is up.
  const reset = NOW + 2 * minute
  const soon = parseUsage(sampleBody(reset - RESETS_IN_MINUTES * minute), 'global', NOW)
  assert.equal(earliestReset(soon), reset)
  assert.equal(isDue(NOW, 5, soon, true, reset - 1), false) // a second too early
  assert.equal(isDue(NOW, 5, soon, true, reset), true)
  // Not after a failed read: that waits for the interval instead of failing every minute.
  assert.equal(isDue(NOW, 5, soon, false, reset), false)
})

test('looks again in a minute, or when the next window resets', () => {
  const snapshot = sample()
  const reset = NOW + RESETS_IN_MINUTES * minute
  assert.equal(nextTickDelay(null, true, NOW), 60_000)
  assert.equal(nextTickDelay(snapshot, true, NOW), 60_000)
  assert.equal(nextTickDelay(snapshot, true, reset - 30_000), 30_000)
  assert.equal(nextTickDelay(snapshot, true, reset + 500), 1_000)
  assert.equal(nextTickDelay(snapshot, false, NOW + 100_000), 60_000)
})

test('writes sizes and remaining time the way a status bar can show them', () => {
  assert.equal(formatCount(1433), '1433')
  assert.equal(formatCount(45_000), '45K')
  assert.equal(formatCount(127_694_464), '127.7M')
  assert.equal(formatCount(800_000_000), '800M')
  assert.equal(formatCount(1_200_000_000), '1.2B')
  assert.equal(formatRemaining(30_000), '1m')
  assert.equal(formatRemaining(45 * minute), '45m')
  assert.equal(formatRemaining(133 * minute), '2h 13m')
  assert.equal(formatRemaining(2 * hour), '2h')
  assert.equal(formatRemaining((4 * 1440 + 12 * 60) * minute), '4d 12h')
  assert.equal(formatRemaining(3 * 1440 * minute), '3d')
  assert.equal(formatRemaining(0), 'now')
  assert.equal(planLabel('pro'), 'Pro')
  assert.equal(planLabel('GLM Coding Max'), 'GLM Coding Max')
  assert.equal(planLabel(null), null)
})

const key = { source: 'secret', masked: '••••1234', protection: 'os-keyring' } as const
const unreachable = { code: 'unreachable', httpStatus: null, detail: 'fetch failed' } as const

const showing = (snapshot: Snapshot): View => ({ key, region: 'global', usage: { status: 'ready', snapshot } })
const failing = (snapshot: Snapshot | null): View => ({
  key,
  region: 'global',
  usage: { status: 'error', error: unreachable, snapshot }
})
const withoutAKey: View = {
  key: { source: 'none', masked: null, protection: 'os-keyring' },
  region: 'global',
  usage: { status: 'idle' }
}
const atFivePercent = (percent: number): Snapshot => ({
  ...sample(),
  windows: [{ ...five, percent }]
})

test('writes the status bar line, and says more when hovered', () => {
  const snapshot = sample()
  assert.equal(statusLine(showing(snapshot), NOW).text, 'ZAI 15% · 2h 13m')
  const line = statusLine(showing(snapshot), NOW + 2 * minute)
  assert.equal(line.text, 'ZAI 15% · 2h 11m')
  assert.equal(line.tone, 'neutral')
  assert.equal(
    line.tooltip,
    [
      'ZAI Usage — Pro',
      '5-hour window: 15% used (127.7M / 800M tokens), resets in 2h 11m',
      'Monthly tools: 45% used (1828 / 4000 calls)',
      'Updated 2m ago'
    ].join('\n')
  )
  assert.equal(statusLine(showing(snapshot), NOW).tooltip.endsWith('Updated just now'), true)
  // Without a reset time there is nothing to count down to.
  const unreported = { ...snapshot, windows: [{ ...five, resetsAt: null }, tools] }
  assert.equal(statusLine(showing(unreported), NOW).text, 'ZAI 15%')
})

test('changes the status bar tone as a window runs out', () => {
  const toneOf = (view: View): StatusTone => statusLine(view, NOW).tone
  assert.equal(toneOf(showing(atFivePercent(69))), 'neutral')
  assert.equal(toneOf(showing(atFivePercent(70))), 'warning')
  assert.equal(toneOf(showing(atFivePercent(90))), 'danger')
  // Out of date data warns, unless what it says is already an alarm.
  assert.equal(toneOf(failing(atFivePercent(15))), 'warning')
  assert.equal(toneOf(failing(atFivePercent(95))), 'danger')
})

test('says so in the status bar when there is no key, no data, or a read failed', () => {
  assert.deepEqual(statusLine(withoutAKey, NOW), {
    text: 'ZAI · no key',
    tone: 'neutral',
    tooltip: 'ZAI Usage: add your Z.AI API key in the ZAI Usage panel.'
  })
  assert.deepEqual(statusLine({ ...withoutAKey, key, usage: { status: 'loading' } }, NOW), {
    text: 'ZAI · …',
    tone: 'neutral',
    tooltip: 'ZAI Usage: loading.'
  })
  assert.deepEqual(statusLine(failing(null), NOW), {
    text: 'ZAI · error',
    tone: 'danger',
    tooltip: 'ZAI Usage: Cannot reach Z.AI. Check the connection.'
  })
  assert.equal(statusLine(showing({ ...sample(), windows: [] }), NOW).text, 'ZAI · —')
  assert.equal(
    statusLine(showing({ ...sample(), windows: [] }), NOW).tooltip,
    ['ZAI Usage — Pro', en.emptyBody, 'Updated just now'].join('\n')
  )
})

test('keeps the last good numbers in the status bar after a failed read', () => {
  const line = statusLine(failing(sample()), NOW)
  assert.equal(line.text, 'ZAI 15% · 2h 13m')
  assert.equal(
    line.tooltip,
    [
      'ZAI Usage — Pro',
      '5-hour window: 15% used (127.7M / 800M tokens), resets in 2h 13m',
      'Monthly tools: 45% used (1828 / 4000 calls)',
      'Showing the last usage loaded: Cannot reach Z.AI. Check the connection.',
      'Updated just now'
    ].join('\n')
  )
})

test('speaks the language Orca does, and names each window', () => {
  assert.equal(messagesFor('en-US'), en)
  assert.equal(messagesFor('ko-KR'), ko)
  assert.equal(messagesFor('ko'), ko)
  const like = (quota: object): QuotaWindow => ({ ...five, ...quota }) as QuotaWindow
  const english = [
    windowTitle(five, en),
    windowTitle(tools, en),
    windowTitle(like({ kind: 'tokens', windowMinutes: 10080 }), en),
    windowTitle(like({ kind: 'credits', windowMinutes: 300 }), en),
    windowTitle(like({ kind: 'tokens', windowMinutes: 1440 }), en),
    windowTitle(like({ kind: 'tokens', windowMinutes: 480 }), en),
    windowTitle(like({ kind: 'tokens', windowMinutes: 90 }), en),
    windowTitle(like({ kind: 'tools', windowMinutes: 300 }), en),
    windowTitle(like({ kind: 'tools', windowMinutes: null }), en)
  ]
  assert.deepEqual(english, [
    '5-hour window',
    'Monthly tools',
    'Weekly window',
    '5-hour window (credits)',
    '1-day window',
    '8-hour window',
    'Usage window',
    'Tools · 5-hour window',
    'Tools'
  ])
  const korean = [
    windowTitle(five, ko),
    windowTitle(tools, ko),
    windowTitle(like({ kind: 'tokens', windowMinutes: 10080 }), ko),
    windowTitle(like({ kind: 'credits', windowMinutes: 43200 }), ko),
    windowTitle(like({ kind: 'tokens', windowMinutes: 1440 }), ko),
    windowTitle(like({ kind: 'tools', windowMinutes: null }), ko)
  ]
  assert.deepEqual(korean, [
    '5시간 윈도우',
    '월간 도구',
    '주간 윈도우',
    '월간 윈도우 (크레딧)',
    '1일 윈도우',
    '도구'
  ])
  assert.equal(countLine(five, en), '127.7M / 800M tokens')
  assert.equal(countLine(tools, ko), '1828 / 4000 회')
  assert.equal(countLine(like({ used: null, total: 1000 }), en), null)
  assert.equal(countLine(like({ used: 500, total: null }), en), '500 tokens')
  assert.equal(detailLine(tools), 'search-prime 1433 · web-reader 462 · zread 0')
  assert.equal(detailLine(five), null)
  for (const words of [en, ko]) {
    for (const code of ['bad_key', 'rate_limited', 'http', 'unreachable', 'timeout', 'bad_response'] as const) {
      assert.ok(words.errors[code]({ code, httpStatus: 502, detail: null }).length > 0)
    }
  }
  assert.equal(en.errors.http({ code: 'http', httpStatus: 502, detail: null }), 'Z.AI answered with HTTP 502.')
})
