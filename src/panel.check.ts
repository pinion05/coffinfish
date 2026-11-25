// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
// The views come from src/fixtures.ts, and each stands in for the worker's `usage.get`: the real
// worker is mounted beside the panel, and would otherwise have to reach Z.AI to answer.
import { defineCheck } from 'orca/testing'
import { failedView, noKeyView, readyView, staleView } from './fixtures'
import type { View } from './protocol'
import { parseUsage } from './zai'

// The worker takes a key from the environment when it finds none saved. Take that way away, so a
// check never asks Z.AI with the key of whoever runs it.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
for (const name of ['ZAI_API_KEY', 'ZHIPU_API_KEY']) {
  delete env?.[name]
}

/** No key, on a device that cannot keep one encrypted. */
const noKeyStore: View = {
  ...noKeyView(),
  key: { source: 'none', masked: null, protection: 'unavailable' }
}

export default defineCheck({
  noKey: { requests: { 'usage.get': () => noKeyView() } },
  noKeyStore: { requests: { 'usage.get': () => noKeyStore } },
  loading: { requests: { 'usage.get': () => ({ ...readyView(), usage: { status: 'loading' } }) } },
  ready: { requests: { 'usage.get': () => readyView() } },
  readyDark: { requests: { 'usage.get': () => readyView() }, theme: 'dark' },
  stale: { requests: { 'usage.get': () => staleView() } },
  badKey: { requests: { 'usage.get': () => failedView('bad_key') } },
  unreachable: { requests: { 'usage.get': () => failedView('unreachable') } },
  empty: {
    requests: {
      'usage.get': () => ({
        ...readyView(),
        usage: {
          status: 'ready',
          snapshot: parseUsage({ code: 200, data: { limits: [] } }, 'global', Date.now())
        }
      })
    }
  }
})
