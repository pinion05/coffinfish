// One quota window: the share used, how long until it resets, and what was used.
import { Card, env, Progress, RelativeTime, Row, Stack, Text } from 'orca'
import { clockTime } from './format'
import { countLine, detailLine, windowTitle, type Messages } from './messages'
import type { QuotaWindow } from './protocol'
import { usageTone } from './zai'

export function QuotaCard({ quota, m }: { quota: QuotaWindow; m: Messages }) {
  const title = windowTitle(quota, m)
  const count = countLine(quota, m)
  const details = detailLine(quota)
  return (
    <Card title={title}>
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Text weight="semibold" tone={usageTone(quota.percent)}>
            {m.used(quota.percent)}
          </Text>
          {quota.resetsAt === null ? (
            <Text size="xs" muted>
              {m.resetUnknown}
            </Text>
          ) : (
            // RelativeTime keeps the countdown current by itself, next to the exact local time.
            <Text size="xs" muted>
              {m.resetsIn}{' '}
              <RelativeTime at={quota.resetsAt} format="duration" />
              {' · '}
              {clockTime(quota.resetsAt, env.locale)}
            </Text>
          )}
        </Row>
        <Progress label={title} labelHidden value={quota.percent} />
        {count === null ? null : (
          <Text size="xs" muted>
            {count}
          </Text>
        )}
        {details === null ? null : (
          <Text size="xs" muted>
            {details}
          </Text>
        )}
      </Stack>
    </Card>
  )
}
