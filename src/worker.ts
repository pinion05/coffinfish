// The plugin's own worker. It is what talks to Z.AI: a panel cannot reach the network, so it asks
// here. The status bar item keeps the worker running while the plugin is enabled, so this is also
// what refreshes on a schedule. A save restarts the worker and drops everything it holds, and
// nothing here needs to last longer than that: the next read brings it all back.

import type { OrcaWorkerApi } from 'orca/worker'
import type { KeySource, KeyStatus, Region, Snapshot, UsageError, View } from './protocol'
import { RequestError, fetchUsage, isDue, nextTickDelay, refreshMinutesOf, statusLine } from './zai'

/** The manifest's ids: `contributes.commands` and `contributes.statusBarItems`. */
const REFRESH_COMMAND = 'zai-usage.refresh'
const STATUS_BAR_ITEM = 'usage'

/** Where the panel saves the key, in the plugin's encrypted secrets. */
const SECRET = 'zaiApiKey'

/** Read when neither the secret nor the `apiKey` setting has a key. */
const ENV_KEYS = ['ZAI_API_KEY', 'ZHIPU_API_KEY']

let stop: (() => void) | null = null

/** Ends the schedule and the request in flight; Orca awaits it before the worker stops. */
export function deactivate(): void {
  stop?.()
  stop = null
}

export default function activate(orca: OrcaWorkerApi): void {
  const live = {
    key: { source: 'none', masked: null, protection: 'os-keyring' } as KeyStatus,
    /** The key last read with, as `source` and `masked`: enough to tell whether the account changed. */
    keyIdentity: 'none:',
    region: 'global' as Region,
    snapshot: null as Snapshot | null,
    failure: null as UsageError | null,
    loading: false,
    lastAttemptAt: 0,
    lastAttemptOk: true,
    /** A read in flight; a caller joins it rather than starting a second. */
    running: null as Promise<void> | null,
    /** Set when a caller asks for a read while one is already in flight. */
    forced: false,
    request: null as AbortController | null,
    timer: undefined as number | undefined,
    stopped: false
  }

  /** What a panel draws with, and what the status bar is drawn from. */
  const view = (): View => ({
    key: { ...live.key },
    region: live.region,
    usage:
      live.key.source === 'none'
        ? { status: 'idle' }
        : live.loading && live.snapshot === null
          ? { status: 'loading' }
          : live.failure !== null
            ? { status: 'error', error: live.failure, snapshot: live.snapshot }
            : live.snapshot !== null
              ? { status: 'ready', snapshot: live.snapshot }
              : { status: 'loading' }
  })

  type Config = {
    key: KeyStatus
    keyValue: string | null
    region: Region
    refreshMinutes: number
  }

  /** The key, where it comes from, and the settings. Read again each time, so a change in
   *  Settings or in the secrets is picked up without a restart. */
  const readConfig = async (): Promise<Config> => {
    const [secret, fallback, protection, region, minutes] = await Promise.all([
      orca.secrets.get(SECRET),
      orca.settings.get('apiKey'),
      orca.host.call('secrets.protection'),
      orca.settings.get('region'),
      orca.settings.get('refreshMinutes')
    ])
    const env = environment()
    const found: [string | null, KeySource][] = [
      [nonEmpty(secret), 'secret'],
      [typeof fallback === 'string' ? nonEmpty(fallback) : null, 'setting'],
      [ENV_KEYS.map((name) => nonEmpty(env[name])).find((value) => value !== null) ?? null, 'env']
    ]
    const [keyValue, source] = found.find(([value]) => value !== null) ?? [null, 'none']
    return {
      key: {
        source,
        masked: keyValue === null ? null : mask(keyValue),
        protection: protection.status
      },
      keyValue,
      region: region === 'cn' ? 'cn' : 'global',
      refreshMinutes: refreshMinutesOf(minutes)
    }
  }

  let posted = ''
  let statusShown = ''
  let statusFailure = ''

  /** Tells every open panel, and the status bar, what changed; and only that. */
  const publish = async (): Promise<void> => {
    const current = view()
    const json = JSON.stringify(current)
    if (json !== posted) {
      posted = json
      try {
        orca.panels.post('usage.changed', { view: current })
      } catch (error) {
        orca.log(`panel post: ${describe(error)}`)
      }
    }
    const line = statusLine(current, Date.now())
    const status = JSON.stringify(line)
    if (status !== statusShown) {
      statusShown = status
      try {
        await orca.host.call('statusBar.update', { id: STATUS_BAR_ITEM, ...line })
        statusFailure = ''
      } catch (error) {
        // The status bar is the desktop app's: without it the panel still works. Said once per
        // reason, as the line changes every minute and would otherwise say it every time.
        if (describe(error) !== statusFailure) {
          statusFailure = describe(error)
          orca.log(`status bar: ${statusFailure}`)
        }
      }
    }
  }

  const schedule = (): void => {
    // The one timer there is. A run that a request started between ticks leaves the old one
    // pending, so clear it first: a timer whose handle is overwritten is never cleared.
    clearTimeout(live.timer)
    live.timer = setTimeout(() => {
      live.timer = undefined
      void tick()
    }, nextTickDelay(live.snapshot, live.lastAttemptOk, Date.now()))
  }

  /**
   * One read: asks Z.AI when one is due, then publishes. `force` reads whatever the interval says.
   */
  const run = async (force: boolean): Promise<void> => {
    try {
      const config = await readConfig()
      const identity = `${config.key.source}:${config.key.masked ?? ''}`
      const otherAccount = identity !== live.keyIdentity || config.region !== live.region
      live.key = config.key
      live.keyIdentity = identity
      live.region = config.region
      if (otherAccount) {
        // What was read before is another account's, or another platform's.
        live.snapshot = null
        live.failure = null
        live.lastAttemptAt = 0
        live.lastAttemptOk = true
      }
      if (
        config.keyValue !== null &&
        (force ||
          live.forced ||
          isDue(live.lastAttemptAt, config.refreshMinutes, live.snapshot, live.lastAttemptOk, Date.now()))
      ) {
        live.loading = true
        live.request = new AbortController()
        try {
          live.snapshot = await fetchUsage({
            region: live.region,
            key: config.keyValue,
            signal: live.request.signal
          })
          live.failure = null
          live.lastAttemptOk = true
        } catch (error) {
          if (!live.stopped) {
            live.failure = toFailure(error)
            live.lastAttemptOk = false
            orca.log(`usage: ${describe(error)}`)
          }
        } finally {
          // A read asked for meanwhile is answered by this one.
          live.forced = false
          live.loading = false
          live.request = null
          live.lastAttemptAt = Date.now()
        }
      }
    } catch (error) {
      // The settings or the secrets could not be read: keep what was read before, and say so.
      orca.log(`config: ${describe(error)}`)
    } finally {
      if (!live.stopped) {
        await publish()
      }
      // From here another read may start, and nothing awaits before it is decided whether one does.
      live.running = null
      if (!live.stopped) {
        if (live.forced) {
          live.forced = false
          // Through `tick`, so this read counts as the one in flight.
          await tick(true)
        } else {
          schedule()
        }
      }
    }
  }

  /** Reads Z.AI when a read is due, then publishes. `force` reads whatever the interval says. */
  const tick = (force = false): Promise<void> => {
    if (live.stopped) {
      return Promise.resolve()
    }
    if (live.running !== null) {
      live.forced ||= force
      return live.running
    }
    live.running = run(force)
    return live.running
  }

  orca.panels.handle('usage.get', async () => {
    await tick()
    return view()
  })
  orca.panels.handle('usage.refresh', async () => {
    await tick(true)
    return view()
  })
  orca.panels.handle('key.set', async ({ value }) => {
    const key = value.trim()
    if (key === '') {
      throw hostFailure('invalid_params', 'The API key is empty.')
    }
    await orca.secrets.set(SECRET, key)
    await tick(true)
    return view()
  })
  orca.panels.handle('key.forget', async () => {
    await orca.secrets.delete(SECRET)
    await tick(true)
    return view()
  })
  orca.commands.register(REFRESH_COMMAND, async () => {
    await tick(true)
    return statusLine(view(), Date.now()).text
  })
  orca.settings.onDidChange(() => {
    // The region, the interval or the fallback key: read again with what is set now.
    void tick(true)
  })

  stop = (): void => {
    live.stopped = true
    clearTimeout(live.timer)
    live.request?.abort()
  }
  void tick()
}

/** The worker's environment: the typings have no `process`, so it is read the plain way. */
function environment(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}

/** Enough of a key to tell two apart, and no more than that. */
function mask(key: string): string {
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function toFailure(error: unknown): UsageError {
  return error instanceof RequestError
    ? { code: error.code, httpStatus: error.httpStatus, detail: error.detail }
    : { code: 'bad_response', httpStatus: null, detail: describe(error) }
}

/** A refusal the panel sees with its code, as it sees Orca's own. */
function hostFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
