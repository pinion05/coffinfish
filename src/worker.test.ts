// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host. The one
// thing the mock cannot stand in for is Z.AI, so each test lends the worker a fetch of its own.
import type { JsonValue } from 'orca'
import { assert, mockHost, mountWorker, test, type MockHost, type TestWorker } from 'orca/testing'
import { KEY, REFUSES_A_KEY, sampleBody } from './fixtures'
import type { Snapshot, View } from './protocol'
import * as main from './worker'

type Answer = Response | Promise<Response>
type Call = { url: string; headers: Headers }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

/** The worker's environment, which the typings leave out. */
const environment = (): Record<string, string | undefined> => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env ?? {}
}

/** The code a request was refused with, when it was. */
const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code

/** What the status bar was told, in order. */
const statusTexts = (worker: TestWorker): string[] =>
  worker.host.callsOf('statusBar.update').map((params) => (params as { text: string }).text)

/** The colours the status bar was told, in order. */
const statusTones = (worker: TestWorker): string[] =>
  worker.host.callsOf('statusBar.update').map((params) => (params as { tone: string }).tone)

/** The usage a view can draw, whether current or kept from before a failed read. */
const snapshotOf = (view: View): Snapshot | null =>
  view.usage.status === 'ready'
    ? view.usage.snapshot
    : view.usage.status === 'error'
      ? view.usage.snapshot
      : null

/** `promise`, or a failure if it has not settled in `ms`: a hung request fails a test, not hangs it. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not settled within ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

/**
 * Runs a test with the worker's fetch and its environment under the test's control: no request
 * leaves the machine, and no key from the machine's environment is picked up by accident. The
 * worker is stopped however the test ends, as a live one would keep its timer and read again.
 */
async function withWorker(
  options: { host?: MockHost; answer?: (signal: AbortSignal | null | undefined) => Answer },
  run: (worker: TestWorker, calls: Call[]) => Promise<void>
): Promise<void> {
  const names = ['ZAI_API_KEY', 'ZHIPU_API_KEY'] as const
  const env = environment()
  const saved = names.map((name) => env[name])
  for (const name of names) {
    delete env[name]
  }
  const answer = options.answer ?? ((): Response => json(sampleBody(Date.now())))
  const real = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return answer(init?.signal)
  }) as typeof fetch
  let worker: TestWorker | null = null
  try {
    worker = await mountWorker(main, { host: options.host })
    await run(worker, calls)
  } finally {
    await worker?.deactivate()
    globalThis.fetch = real
    names.forEach((name, index) => {
      if (saved[index] === undefined) {
        delete env[name]
      } else {
        env[name] = saved[index]
      }
    })
  }
}

/** A host with a key saved, as the panel leaves it. */
const withKey = (settings?: Record<string, JsonValue>): MockHost =>
  mockHost({ secrets: { zaiApiKey: KEY }, settings })

test('has nothing to ask for without a key', async () => {
  await withWorker({}, async (worker, calls) => {
    assert.deepEqual(await worker.request('usage.get'), {
      key: { source: 'none', masked: null, protection: 'os-keyring' },
      region: 'global',
      usage: { status: 'idle' }
    })
    assert.equal(calls.length, 0)
    assert.deepEqual(statusTexts(worker), ['ZAI · no key'])
    assert.deepEqual(worker.posts.map((post) => post.event), ['usage.changed'])
    assert.deepEqual(worker.refusals, [])
  })
})

test('reads the usage with the saved key, and shows it in the status bar', async () => {
  await withWorker({ host: withKey() }, async (worker, calls) => {
    const view = await worker.request('usage.get')
    assert.deepEqual(view.key, { source: 'secret', masked: '••••1234', protection: 'os-keyring' })
    assert.equal(view.usage.status, 'ready')
    assert.deepEqual(
      calls.map((call) => call.url),
      ['https://api.z.ai/api/monitor/usage/quota/limit']
    )
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`)
    assert.deepEqual(statusTexts(worker), ['ZAI 15% · 2h 13m'])
    assert.equal(worker.posts.at(-1)?.event, 'usage.changed')
    assert.deepEqual(worker.refusals, [])
  })
})

test('takes a key from the setting, then from the environment, when none is saved', async () => {
  await withWorker({}, async (worker, calls) => {
    // Set after the mount, which `withWorker` starts with a clean environment.
    environment().ZAI_API_KEY = 'sk-from-environment'
    assert.equal((await worker.request('usage.refresh')).key.source, 'env')
    assert.equal(calls.at(-1)?.headers.get('authorization'), 'Bearer sk-from-environment')
  })
  await withWorker({ host: mockHost({ settings: { apiKey: 'sk-from-setting' } }) }, async (worker, calls) => {
    const view = await worker.request('usage.get')
    assert.deepEqual(view.key, { source: 'setting', masked: '••••ting', protection: 'os-keyring' })
    assert.equal(calls[0].headers.get('authorization'), 'Bearer sk-from-setting')
  })
})

test('asks the platform of the region setting', async () => {
  await withWorker({ host: withKey({ region: 'cn' }) }, async (worker, calls) => {
    const view = await worker.request('usage.get')
    assert.equal(view.region, 'cn')
    assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
  })
})

test('reads again when asked, and not before the interval says so', async () => {
  await withWorker({ host: withKey() }, async (worker, calls) => {
    await worker.request('usage.get')
    assert.equal(calls.length, 1)
    const told = worker.posts.length
    await worker.request('usage.get')
    assert.equal(calls.length, 1) // read a moment ago
    assert.equal(worker.posts.length, told) // so there is nothing new to tell
    await worker.request('usage.refresh')
    assert.equal(calls.length, 2)
    assert.equal(worker.posts.length, told + 1)
  })
})

test('says why a read failed, and keeps the last good one to show as out of date', async () => {
  let answer: (signal: AbortSignal | null | undefined) => Answer = (): Response =>
    json(sampleBody(Date.now()))
  await withWorker({ host: withKey(), answer: (signal) => answer(signal) }, async (worker) => {
    const snapshot = snapshotOf(await worker.request('usage.get'))
    assert.ok(snapshot !== null)
    // Z.AI answers a key it will not take with HTTP 200 and the reason in the body.
    answer = () => json(REFUSES_A_KEY)
    const rejected = await worker.request('usage.refresh')
    assert.deepEqual(rejected.usage, {
      status: 'error',
      error: { code: 'bad_key', httpStatus: null, detail: 'token expired or incorrect' },
      snapshot
    })
    // The status bar keeps the numbers it had, now as a warning.
    assert.deepEqual(statusTones(worker), ['neutral', 'warning'])
    answer = () => {
      throw new TypeError('fetch failed')
    }
    const failed = await worker.request('usage.refresh')
    assert.deepEqual(failed.usage, {
      status: 'error',
      error: { code: 'unreachable', httpStatus: null, detail: 'fetch failed' },
      snapshot
    })
    assert.match(worker.logs.at(-1) ?? '', /fetch failed/)
    answer = (): Response => json(sampleBody(Date.now()))
    assert.equal((await worker.request('usage.refresh')).usage.status, 'ready')
    assert.equal(statusTones(worker).at(-1), 'neutral')
  })
})

test('has nothing to show but the reason when a first read fails, and does not retry at once', async () => {
  await withWorker({ host: withKey(), answer: () => new Response(null, { status: 503 }) }, async (worker, calls) => {
    const view = await worker.request('usage.get')
    assert.deepEqual(view.usage, {
      status: 'error',
      error: { code: 'http', httpStatus: 503, detail: null },
      snapshot: null
    })
    assert.deepEqual(statusTexts(worker), ['ZAI · error'])
    await worker.request('usage.get')
    assert.equal(calls.length, 1) // the next read waits for the interval
    await worker.request('usage.refresh')
    assert.equal(calls.length, 2) // unless asked
  })
})

test('saves the key where the panel asks it to, and forgets it', async () => {
  await withWorker({}, async (worker, calls) => {
    const saved = await worker.request('key.set', { value: `  ${KEY}  ` })
    assert.equal(saved.key.source, 'secret')
    assert.equal(saved.key.masked, '••••1234')
    assert.equal(worker.host.data().secrets.zaiApiKey, KEY)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${KEY}`)
    await assert.rejects(
      worker.request('key.set', { value: '   ' }),
      (error: unknown): boolean => codeOf(error) === 'invalid_params'
    )
    assert.equal(calls.length, 1)
    const forgotten = await worker.request('key.forget')
    assert.equal(forgotten.key.source, 'none')
    assert.deepEqual(forgotten.usage, { status: 'idle' })
    assert.equal(worker.host.data().secrets.zaiApiKey, undefined)
    assert.deepEqual(statusTexts(worker), ['ZAI · no key', 'ZAI 15% · 2h 13m', 'ZAI · no key'])
  })
})

test('stops the request in flight when it is stopped, and asks nothing more', async () => {
  let started: (() => void) | undefined
  const inFlight = new Promise<void>((resolve) => {
    started = resolve
  })
  let aborted = false
  await withWorker(
    {
      host: withKey(),
      answer: (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          })
          started?.()
        })
    },
    async (worker, calls) => {
      const pending = worker.request('usage.refresh').then(
        () => 'answered',
        () => 'refused'
      )
      await within(inFlight, 2_000) // the read has reached Z.AI, or here its stand-in
      await worker.deactivate()
      assert.equal(aborted, true)
      await within(pending, 2_000)
      // A read that never ended is nothing to show, and nothing to tell a panel.
      assert.deepEqual(statusTexts(worker), [])
      assert.deepEqual(worker.posts, [])
      assert.equal(calls.length, 1)
      // Stopped, it has no handler left to ask.
      await assert.rejects(
        worker.request('usage.get'),
        (error: unknown): boolean => codeOf(error) === 'unknown_method'
      )
      assert.equal(calls.length, 1)
      assert.deepEqual(statusTexts(worker), [])
    }
  )
})

/** How many timers are waiting in this process. */
const timers = (): number =>
  (globalThis as unknown as { process: { getActiveResourcesInfo(): string[] } })
    .process.getActiveResourcesInfo()
    .filter((kind) => kind === 'Timeout').length

test('keeps one timer, however many reads a request starts between ticks', async () => {
  await withWorker({ host: withKey() }, async (worker) => {
    await worker.request('usage.get')
    const waiting = timers()
    for (let read = 0; read < 5; read++) {
      await worker.request('usage.refresh')
    }
    // A timer whose handle is overwritten is never cleared, and would outlive the worker.
    assert.equal(timers(), waiting)
    await worker.deactivate()
    assert.equal(timers(), waiting - 1)
  })
})
