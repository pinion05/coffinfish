// `orca plugin test` runs this in Node with the same runtime and checks Orca uses. The worker is
// stood in for: each `plugin.request` name is answered from src/fixtures.ts.
import type { JsonValue } from 'orca'
import {
  assert,
  hostError,
  mockHost,
  mount,
  test,
  type MockHost,
  type MockHostOptions,
  type TestPanel
} from 'orca/testing'
import { clockTime } from './format'
import { failedView, noKeyView, readyView, staleView } from './fixtures'
import * as panel from './panel'
import type { View } from './protocol'

/** Mounts the panel over a worker that answers as told, and unmounts it however the test ends. */
async function withPanel(
  options: MockHostOptions & { locale?: string },
  run: (view: TestPanel, host: MockHost) => Promise<void>
): Promise<void> {
  const { locale, ...hostOptions } = options
  const host = mockHost(hostOptions)
  const view = await mount(panel, { host, locale })
  try {
    await run(view, host)
  } finally {
    await view.unmount()
  }
}

const nothingWentWrong = (view: TestPanel): void => {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

test('asks for the key when there is none, and saves what is typed', async () => {
  let saved: string | null = null
  await withPanel(
    {
      requests: {
        'usage.get': () => noKeyView(),
        'key.set': ({ value }) => {
          saved = value
          return readyView()
        }
      }
    },
    async (view, host) => {
      assert.ok(view.find({ text: 'Add your Z.AI API key' }))
      assert.equal(view.find({ text: 'Save key' })?.disabled, true) // nothing to save yet
      await view.type({ label: 'Z.AI API key' }, '  sk-test  ')
      await view.press({ text: 'Save key' })
      assert.equal(saved, 'sk-test')
      assert.ok(view.find({ text: '15% used' }))
      assert.equal(view.find({ label: 'Z.AI API key' }), null) // the form is gone
      // The key is the worker's to keep encrypted: the panel never stores it itself.
      assert.deepEqual(host.callsOf('secrets.set'), [])
      assert.deepEqual(host.data().storage, {})
      nothingWentWrong(view)
    }
  )
})

test('shows each window with its share, what was used, and when it resets', async () => {
  const answer = readyView() // one read for the worker's answer and for what is expected of it
  assert.ok(answer.usage.status === 'ready')
  const snapshot = answer.usage.snapshot
  const [five, tools] = snapshot.windows
  await withPanel({ requests: { 'usage.get': () => answer } }, async (view) => {
    assert.ok(view.find({ text: 'Pro' }))
    assert.ok(view.find({ label: '5-hour window' }))
    assert.ok(view.find({ label: 'Monthly tools' }))
    assert.ok(view.find({ text: '15% used' }))
    assert.ok(view.find({ text: '45% used' }))
    assert.ok(view.find({ text: '127.7M / 800M tokens' }))
    assert.ok(view.find({ text: 'search-prime 1433 · web-reader 462 · zread 0' }))
    // The countdown is Orca's own RelativeTime, which keeps itself current: it is fed each window's
    // reset time, and reads as the largest whole unit (133 minutes read "2h"), beside the exact
    // local time.
    const times = view.findAll({ type: 'RelativeTime' })
    assert.deepEqual(
      times.map((time) => [time.props.format, time.props.at]),
      [
        ['duration', five.resetsAt],
        ['short', snapshot.fetchedAt]
      ]
    )
    assert.equal(
      view.find({ text: /^Resets in/ })?.text.replace(/\s+/g, ' ').trim(),
      `Resets in 2h · ${clockTime(five.resetsAt ?? 0, 'en-US')}`
    )
    assert.ok(view.find({ text: 'Reset time not reported' })) // the tools window: Z.AI names no time
    assert.ok(view.find({ type: 'Progress' }) !== null)
    assert.deepEqual(
      view.findAll({ type: 'Progress' }).map((bar) => bar.props.value),
      [five.percent, tools.percent]
    )
    assert.match(
      view.find({ text: /^Encrypted API key/ })?.text ?? '',
      /^Encrypted API key\s+••••1234\s+·\s+Z\.AI \(Global\)$/
    )
    assert.equal(view.findAll({ text: '15% used' }).length, 1)
    nothingWentWrong(view)
  })
})

test('says what went wrong when a first read fails, and tries again when asked', async () => {
  const asked: string[] = []
  await withPanel(
    {
      requests: {
        'usage.get': () => failedView('bad_key'),
        'usage.refresh': () => {
          asked.push('refresh')
          return readyView()
        }
      }
    },
    async (view) => {
      assert.ok(view.find({ text: /Usage could not be loaded/ }))
      assert.ok(view.find({ text: 'Z.AI rejected this API key. Check the key, or switch the region.' }))
      assert.ok(view.find({ text: 'token expired or incorrect' })) // what Z.AI said
      assert.equal(view.find({ text: '15% used' }), null)
      await view.press({ text: 'Retry' })
      assert.deepEqual(asked, ['refresh'])
      assert.equal(view.find({ text: /Usage could not be loaded/ }), null)
      assert.ok(view.find({ text: '15% used' }))
      nothingWentWrong(view)
    }
  )
})

test('keeps the last usage on screen when a later read fails', async () => {
  await withPanel({ requests: { 'usage.get': () => staleView() } }, async (view) => {
    assert.ok(view.find({ text: /Showing the last usage loaded/ }))
    assert.ok(view.find({ text: '15% used' }))
    assert.ok(view.find({ text: 'Cannot reach Z.AI. Check the connection.' }))
    nothingWentWrong(view)
  })
})

test('follows the worker as it refreshes', async () => {
  await withPanel({ requests: { 'usage.get': () => noKeyView() } }, async (view) => {
    assert.ok(view.find({ text: 'Add your Z.AI API key' }))
    await view.post('usage.changed', { view: readyView() })
    assert.ok(view.find({ text: '15% used' }))
    await view.post('usage.changed', { view: failedView('timeout') })
    assert.equal(view.find({ text: '15% used' }), null)
    assert.ok(view.find({ text: 'Z.AI took too long to answer.' }))
    nothingWentWrong(view)
  })
})

test('asks the worker to refresh, and to forget the key', async () => {
  const asked: string[] = []
  await withPanel(
    {
      requests: {
        'usage.get': () => readyView(),
        'usage.refresh': () => {
          asked.push('refresh')
          return readyView()
        },
        'key.forget': () => {
          asked.push('forget')
          return noKeyView()
        }
      }
    },
    async (view) => {
      await view.press({ label: 'Refresh' })
      await view.press({ text: 'Forget key' })
      assert.deepEqual(asked, ['refresh', 'forget'])
      assert.ok(view.find({ text: 'Add your Z.AI API key' }))
      nothingWentWrong(view)
    }
  )
})

test('saves the region the person picks', async () => {
  await withPanel({ requests: { 'usage.get': () => noKeyView() } }, async (view, host) => {
    await view.select({ label: 'Region' }, 'cn')
    const settings = host.data().settings as Record<string, JsonValue>
    assert.equal(settings.region, 'cn')
    nothingWentWrong(view)
  })
})

test('shows why the key could not be saved, and keeps it typed', async () => {
  await withPanel(
    {
      requests: {
        'usage.get': () => noKeyView(),
        'key.set': () => {
          throw hostError('action_failed', 'no OS key store on this device')
        }
      }
    },
    async (view) => {
      await view.type({ label: 'Z.AI API key' }, 'sk-test')
      await view.press({ text: 'Save key' })
      assert.ok(view.find({ text: /The key could not be saved\./ }))
      assert.ok(view.find({ text: 'no OS key store on this device' })) // what the host said
      assert.equal(view.valueOf({ label: 'Z.AI API key' }), 'sk-test')
      nothingWentWrong(view)
    }
  )
})

test('points to the other ways to give a key on a device without a key store', async () => {
  const noStore: View = {
    ...noKeyView(),
    key: { source: 'none', masked: null, protection: 'unavailable' }
  }
  await withPanel({ requests: { 'usage.get': () => noStore } }, async (view) => {
    assert.ok(view.find({ text: /no OS key store/ }))
    assert.equal(view.find({ text: 'Use the API key of your GLM Coding Plan. It is saved encrypted on this device.' }), null)
    nothingWentWrong(view)
  })
})

test('says when the worker cannot be asked at all', async () => {
  await withPanel({}, async (view) => {
    // No worker answers, so `usage.get` is an unknown method.
    assert.ok(view.find({ text: /Usage could not be loaded/ }))
    assert.equal(view.find({ text: '15% used' }), null)
    nothingWentWrong(view)
  })
})

test('speaks Korean in a Korean Orca', async () => {
  const answer = readyView() // one read for the worker's answer and for what is expected of it
  assert.ok(answer.usage.status === 'ready')
  const [five] = answer.usage.snapshot.windows
  await withPanel({ locale: 'ko', requests: { 'usage.get': () => answer } }, async (view) => {
    assert.ok(view.find({ text: 'ZAI 사용량' }))
    assert.ok(view.find({ text: '15% 사용' }))
    assert.ok(view.find({ label: '월간 도구' }))
    assert.ok(view.find({ label: '5시간 윈도우' }))
    assert.ok(view.find({ text: '127.7M / 800M 토큰' }))
    assert.match(view.find({ text: /^암호화된 API 키/ })?.text ?? '', /••••1234/)
    // The words around the countdown and the clock time are the plugin's, in Korean. The
    // countdown's own words are Orca's to translate: the test kit always shows them in English.
    assert.equal(
      view.find({ text: /^초기화까지/ })?.text.replace(/\s+/g, ' ').trim(),
      `초기화까지 2h · ${clockTime(five.resetsAt ?? 0, 'ko')}`
    )
    assert.ok(view.find({ text: '초기화 시각 미제공' }))
    nothingWentWrong(view)
  })
})

test('speaks English in an Orca in any other language', async () => {
  await withPanel({ locale: 'ja', requests: { 'usage.get': () => readyView() } }, async (view) => {
    assert.ok(view.find({ text: 'ZAI Usage' }))
    assert.ok(view.find({ text: '15% used' }))
    nothingWentWrong(view)
  })
})
