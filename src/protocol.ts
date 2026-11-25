// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type Region = 'global' | 'cn'

/** What a Z.AI limit counts. */
export type QuotaKind = 'tokens' | 'credits' | 'tools'

/** One quota window of a GLM Coding Plan, as GET /api/monitor/usage/quota/limit reports it. */
export type QuotaWindow = {
  kind: QuotaKind
  /** How long the window lasts; null for a unit this plugin does not know. */
  windowMinutes: number | null
  /** Share of the window used, 0 to 100. */
  percent: number
  used: number | null
  total: number | null
  /** Epoch ms. Null when Z.AI reports none, or one that cannot be right for this window. */
  resetsAt: number | null
  /** Per-tool counts of a `tools` window. */
  details: { code: string; used: number | null }[]
}

export type Snapshot = {
  /** The plan's tier or name, e.g. "pro" or "GLM Coding Max". */
  plan: string | null
  region: Region
  fetchedAt: number
  windows: QuotaWindow[]
}

export type UsageErrorCode =
  | 'bad_key'
  | 'rate_limited'
  | 'http'
  | 'unreachable'
  | 'timeout'
  | 'bad_response'

export type UsageError = {
  code: UsageErrorCode
  /** The HTTP status, when Z.AI answered with one. */
  httpStatus: number | null
  /** What Z.AI said, when it said something readable. */
  detail: string | null
}

export type UsageState =
  /** No API key, so there is nothing to ask for. */
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; snapshot: Snapshot }
  /** `snapshot` is the last good one, kept so the panel can show it as out of date. */
  | { status: 'error'; error: UsageError; snapshot: Snapshot | null }

/** Where the API key comes from, most trusted first. */
export type KeySource = 'secret' | 'setting' | 'env' | 'none'

/** How Orca protects secrets on this machine (`secrets.protection`). */
export type KeyProtection = 'os-keyring' | 'unavailable'

export type KeyStatus = {
  source: KeySource
  /** The key's last four characters; null without a key. */
  masked: string | null
  protection: KeyProtection
}

/** Everything a panel draws with, as the worker last computed it. */
export type View = {
  key: KeyStatus
  region: Region
  usage: UsageState
}

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger'

declare module 'orca' {
  interface PluginRequests {
    /** The current view; fetches first when the data is due. */
    'usage.get': { output: View }
    /** The current view after fetching now, whatever the refresh interval says. */
    'usage.refresh': { output: View }
    /** Saves the API key in the plugin's encrypted secrets, then fetches with it. */
    'key.set': { input: { value: string }; output: View }
    /** Deletes the saved API key. One from a setting or the environment stays in use. */
    'key.forget': { output: View }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel each time the view changes. */
    'usage.changed': { view: View }
  }
}
