// The right-sidebar panel. It draws what the worker reads (src/worker.ts): a panel cannot reach
// Z.AI itself. No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  Badge,
  Button,
  Callout,
  Code,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  RelativeTime,
  Row,
  Select,
  shell,
  Spinner,
  Stack,
  Text,
  atom,
  env,
  plugin,
  read,
  set,
  settings,
  update,
  type PanelContext
} from 'orca'
import { planLabel } from './format'
import { messagesFor, type Messages } from './messages'
import { QuotaCard } from './quota-card'
import type { Region, Snapshot, UsageError, View } from './protocol'
import { REGIONS } from './zai'

/** What the worker last answered; null until it does. */
const view = atom<View | null>(null)
/** What went wrong asking the worker or saving a setting, in the host's words. */
const failure = atom<{ title: string | null; message: string; retry: boolean } | null>(null)
/** The key as it is typed. Never persisted. */
const draft = atom('')
/** A request is running, so the controls wait for it. */
const busy = atom(false)

const words = (): Messages => messagesFor(env.locale)

/** How a refused request is reported: under which title, and whether asking again can help. */
type Refusal = { title: string | null; retry: boolean }

/** Asks the worker and draws its answer. A refusal is shown and the last answer stays. */
async function ask(refusal: Refusal, request: () => Promise<View>): Promise<boolean> {
  set(busy, true)
  try {
    set(view, await request())
    set(failure, null)
    return true
  } catch (error) {
    set(failure, { ...refusal, message: describe(error) })
    return false
  } finally {
    set(busy, false)
  }
}

const loadFailed = (): Refusal => ({ title: words().errorTitle, retry: true })

const load = (): Promise<boolean> => ask(loadFailed(), () => plugin.request('usage.get'))
const refresh = (): Promise<boolean> => ask(loadFailed(), () => plugin.request('usage.refresh'))
const forget = (): Promise<boolean> => ask({ title: null, retry: false }, () =>
  plugin.request('key.forget')
)

async function saveKey(): Promise<void> {
  const value = read(draft).trim()
  if (value === '' || read(busy)) {
    return
  }
  // Starts the worker if it is not running; typed by src/protocol.ts.
  if (await ask({ title: words().saveFailed, retry: false }, () => plugin.request('key.set', { value }))) {
    set(draft, '')
  }
}

async function changeRegion(region: Region): Promise<void> {
  // Draw the choice at once; the worker's next answer confirms it.
  update(view, (current) => (current === null ? current : { ...current, region }))
  try {
    await settings.set('region', region)
  } catch (error) {
    set(failure, { title: null, message: describe(error), retry: false })
  }
}

async function openPlanPage(region: Region): Promise<void> {
  try {
    await shell.openExternal(REGIONS[region].planPage)
  } catch (error) {
    set(failure, { title: null, message: describe(error), retry: false })
  }
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  // Every refresh the worker makes, on its schedule or for another panel, arrives here.
  ctx.subscriptions.push(plugin.on('usage.changed', ({ view: next }) => set(view, next)))
  void load()
}

export default function Panel() {
  const m = words()
  const current = read(view)
  const problem = read(failure)
  const plan = planLabel(snapshotOf(current)?.plan ?? null)
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>{m.title}</Heading>
        <Row gap="xs" align="center">
          {plan === null ? null : <Badge tone="accent">{plan}</Badge>}
          {current !== null && current.key.source !== 'none' ? (
            <IconButton
              icon="refresh"
              label={m.refresh}
              tooltip={m.refresh}
              disabled={read(busy)}
              onPress={() => void refresh()}
            />
          ) : null}
        </Row>
      </Row>
      {problem === null ? null : (
        <Callout tone="danger" title={problem.title ?? undefined}>
          <Stack gap="xs">
            <Text size="xs">{problem.message}</Text>
            {problem.retry ? (
              <Button variant="outline" size="xs" icon="refresh" onPress={() => void load()}>
                {m.retry}
              </Button>
            ) : null}
          </Stack>
        </Callout>
      )}
      {current === null ? (
        problem === null ? <Spinner label={m.loading} /> : null
      ) : (
        <Body current={current} m={m} />
      )}
    </Stack>
  )
}

function Body({ current, m }: { current: View; m: Messages }) {
  if (current.key.source === 'none') {
    return <Setup current={current} m={m} />
  }
  const source = current.key.source
  const masked = current.key.masked
  const { usage } = current
  if (usage.status === 'idle' || usage.status === 'loading') {
    return <Spinner label={m.loading} />
  }
  const snapshot = usage.snapshot
  if (snapshot === null) {
    // Only a first read that failed has nothing to show.
    return usage.status === 'error' ? (
      <Problem error={usage.error} m={m} />
    ) : (
      <Spinner label={m.loading} />
    )
  }
  return (
    <Stack gap="sm">
      {usage.status === 'error' ? <Problem error={usage.error} m={m} stale /> : null}
      {snapshot.windows.length === 0 ? (
        <EmptyState icon="gauge" title={m.empty} description={m.emptyBody} />
      ) : null}
      {snapshot.windows.map((quota, index) => (
        <QuotaCard key={String(index)} quota={quota} m={m} />
      ))}
      <Row justify="between" align="center">
        <Text size="xs" muted>
          {m.updated} <RelativeTime at={snapshot.fetchedAt} format="short" />
        </Text>
        {source === 'secret' ? (
          <Button variant="ghost" size="xs" disabled={read(busy)} onPress={() => void forget()}>
            {m.forgetKey}
          </Button>
        ) : null}
      </Row>
      <Text size="xs" muted>
        {m.keySource[source]}
        {masked === null ? null : ' '}
        {masked === null ? null : <Code>{masked}</Code>}
        {' · '}
        {m.regions[snapshot.region]}
      </Text>
    </Stack>
  )
}

/** The key, the region, and where to get a key. */
function Setup({ current, m }: { current: View; m: Messages }) {
  const waiting = read(busy)
  return (
    <Stack gap="sm">
      <Stack gap="xs">
        <Text weight="semibold">{m.noKeyTitle}</Text>
        <Text size="sm" muted>
          {current.key.protection === 'unavailable' ? m.noKeyStore : m.noKeyBody}
        </Text>
      </Stack>
      <Input
        label={m.keyLabel}
        type="password"
        placeholder={m.keyPlaceholder}
        value={read(draft)}
        disabled={waiting}
        onChange={(value) => set(draft, value)}
        onSubmit={() => void saveKey()}
      />
      <Select
        label={m.regionLabel}
        value={current.region}
        options={[
          { value: 'global', label: m.regions.global },
          { value: 'cn', label: m.regions.cn }
        ]}
        disabled={waiting}
        onChange={(value) => void changeRegion(value === 'cn' ? 'cn' : 'global')}
      />
      <Row gap="sm" align="center">
        <Button
          icon="check"
          disabled={read(draft).trim() === '' || waiting}
          onPress={() => void saveKey()}
        >
          {m.saveKey}
        </Button>
        <Link onPress={() => void openPlanPage(current.region)}>{m.planPage}</Link>
      </Row>
    </Stack>
  )
}

/** A failed read: what went wrong, what Z.AI said about it, and a way to try again. */
function Problem({ error, m, stale = false }: { error: UsageError; m: Messages; stale?: boolean }) {
  return (
    <Callout tone={stale ? 'warning' : 'danger'} title={stale ? m.staleTitle : m.errorTitle}>
      <Stack gap="xs">
        <Text size="xs">{m.errors[error.code](error)}</Text>
        {error.detail === null ? null : (
          <Text size="xs" muted>
            {error.detail}
          </Text>
        )}
        <Button variant="outline" size="xs" icon="refresh" onPress={() => void refresh()}>
          {m.retry}
        </Button>
      </Stack>
    </Callout>
  )
}

/** The snapshot a view can draw: the current one, or the one kept from before a failed read. */
function snapshotOf(current: View | null): Snapshot | null {
  const usage = current?.usage
  return usage?.status === 'ready' ? usage.snapshot : usage?.status === 'error' ? usage.snapshot : null
}

/** What a refusal says, in the host's words; its code when it says nothing. */
function describe(error: unknown): string {
  const { message, code } = error as { message?: string; code?: string }
  return message || code || String(error)
}
