// What the panel says, in Orca's UI language. The worker's status bar is always English (`en`).

import { formatCount } from './format'
import type { KeySource, QuotaWindow, Region, UsageError, UsageErrorCode } from './protocol'

type Words = {
  fiveHour: string
  weekly: string
  monthly: string
  /** With `{n}`. */
  day: string
  /** With `{n}`. */
  hour: string
  other: string
  credits: string
  toolsMonthly: string
  tools: string
  /** With `{window}`. */
  toolsIn: string
}

export type Messages = {
  title: string
  loading: string
  noKeyTitle: string
  noKeyBody: string
  /** Shown instead of `noKeyBody` on a device without an OS key store. */
  noKeyStore: string
  keyLabel: string
  keyPlaceholder: string
  saveKey: string
  saveFailed: string
  regionLabel: string
  regions: Record<Region, string>
  planPage: string
  used: (percent: number) => string
  resetsIn: string
  resetUnknown: string
  tokens: string
  credits: string
  calls: string
  window: Words
  empty: string
  emptyBody: string
  errorTitle: string
  staleTitle: string
  errors: Record<UsageErrorCode, (error: UsageError) => string>
  retry: string
  refresh: string
  updated: string
  forgetKey: string
  keySource: Record<Exclude<KeySource, 'none'>, string>
}

export const en: Messages = {
  title: 'ZAI Usage',
  loading: 'Loading usage…',
  noKeyTitle: 'Add your Z.AI API key',
  noKeyBody: 'Use the API key of your GLM Coding Plan. It is saved encrypted on this device.',
  noKeyStore:
    'This device has no OS key store, so the key cannot be saved here. Start Orca with ZAI_API_KEY set, or fill in the API key setting of this plugin in Orca Settings.',
  keyLabel: 'Z.AI API key',
  keyPlaceholder: 'Paste the API key',
  saveKey: 'Save key',
  saveFailed: 'The key could not be saved.',
  regionLabel: 'Region',
  regions: { global: 'Z.AI (Global)', cn: 'BigModel (China)' },
  planPage: 'Z.AI plan page',
  used: (percent) => `${Math.round(percent)}% used`,
  resetsIn: 'Resets in',
  resetUnknown: 'Reset time not reported',
  tokens: 'tokens',
  credits: 'credits',
  calls: 'calls',
  window: {
    fiveHour: '5-hour window',
    weekly: 'Weekly window',
    monthly: 'Monthly window',
    day: '{n}-day window',
    hour: '{n}-hour window',
    other: 'Usage window',
    credits: ' (credits)',
    toolsMonthly: 'Monthly tools',
    tools: 'Tools',
    toolsIn: 'Tools · {window}'
  },
  empty: 'No usage yet',
  emptyBody: 'Z.AI reports no quota windows for this key.',
  errorTitle: 'Usage could not be loaded',
  staleTitle: 'Showing the last usage loaded',
  errors: {
    bad_key: () => 'Z.AI rejected this API key. Check the key, or switch the region.',
    rate_limited: () => 'Too many requests. Wait a minute before trying again.',
    http: (error) => `Z.AI answered with HTTP ${error.httpStatus}.`,
    unreachable: () => 'Cannot reach Z.AI. Check the connection.',
    timeout: () => 'Z.AI took too long to answer.',
    bad_response: () => 'Z.AI sent a response this plugin cannot read.'
  },
  retry: 'Retry',
  refresh: 'Refresh',
  updated: 'Updated',
  forgetKey: 'Forget key',
  keySource: {
    secret: 'Encrypted API key',
    setting: 'API key from the plugin settings',
    env: 'API key from the environment'
  }
}

export const ko: Messages = {
  title: 'ZAI 사용량',
  loading: '사용량 불러오는 중…',
  noKeyTitle: 'Z.AI API 키를 등록하세요',
  noKeyBody: 'GLM Coding Plan의 API 키를 입력하세요. 이 기기에 암호화되어 저장됩니다.',
  noKeyStore:
    '이 기기에는 OS 키 저장소가 없어 여기서 키를 저장할 수 없습니다. ZAI_API_KEY를 설정한 채로 Orca를 시작하거나, Orca 설정에서 이 플러그인의 API 키 항목을 채워 주세요.',
  keyLabel: 'Z.AI API 키',
  keyPlaceholder: 'API 키를 붙여넣으세요',
  saveKey: '키 저장',
  saveFailed: '키를 저장하지 못했습니다.',
  regionLabel: '지역',
  regions: { global: 'Z.AI (글로벌)', cn: 'BigModel (중국)' },
  planPage: 'Z.AI 플랜 페이지',
  used: (percent) => `${Math.round(percent)}% 사용`,
  resetsIn: '초기화까지',
  resetUnknown: '초기화 시각 미제공',
  tokens: '토큰',
  credits: '크레딧',
  calls: '회',
  window: {
    fiveHour: '5시간 윈도우',
    weekly: '주간 윈도우',
    monthly: '월간 윈도우',
    day: '{n}일 윈도우',
    hour: '{n}시간 윈도우',
    other: '사용량 윈도우',
    credits: ' (크레딧)',
    toolsMonthly: '월간 도구',
    tools: '도구',
    toolsIn: '도구 · {window}'
  },
  empty: '아직 사용량이 없습니다',
  emptyBody: '이 키에 대해 Z.AI가 할당량 창을 보고하지 않았습니다.',
  errorTitle: '사용량을 불러오지 못했습니다',
  staleTitle: '마지막으로 불러온 사용량입니다',
  errors: {
    bad_key: () => 'Z.AI가 이 API 키를 거부했습니다. 키를 확인하거나 지역을 변경하세요.',
    rate_limited: () => '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
    http: (error) => `Z.AI가 HTTP ${error.httpStatus}(으)로 응답했습니다.`,
    unreachable: () => 'Z.AI에 연결할 수 없습니다. 네트워크를 확인하세요.',
    timeout: () => 'Z.AI 응답이 너무 늦습니다.',
    bad_response: () => 'Z.AI가 이 플러그인이 읽을 수 없는 응답을 보냈습니다.'
  },
  retry: '다시 시도',
  refresh: '새로고침',
  updated: '업데이트',
  forgetKey: '키 삭제',
  keySource: {
    secret: '암호화된 API 키',
    setting: '플러그인 설정의 API 키',
    env: '환경 변수의 API 키'
  }
}

/** Korean for a Korean Orca, English for every other language. */
export function messagesFor(locale: string): Messages {
  return locale.toLowerCase().split(/[-_]/)[0] === 'ko' ? ko : en
}

/** What a window is called on its card: "5-hour window", "Weekly window", "Monthly tools". */
export function windowTitle(quota: QuotaWindow, m: Messages): string {
  const minutes = quota.windowMinutes
  const w = m.window
  const span =
    minutes === 300
      ? w.fiveHour
      : minutes === 10080
        ? w.weekly
        : minutes === 43200
          ? w.monthly
          : minutes !== null && minutes % 1440 === 0
            ? w.day.replace('{n}', String(minutes / 1440))
            : minutes !== null && minutes % 60 === 0
              ? w.hour.replace('{n}', String(minutes / 60))
              : w.other
  if (quota.kind === 'tools') {
    return minutes === 43200 ? w.toolsMonthly : minutes === null ? w.tools : w.toolsIn.replace('{window}', span)
  }
  return quota.kind === 'credits' ? `${span}${w.credits}` : span
}

/** "127.7M / 800M tokens"; less when Z.AI reports less. */
export function countLine(quota: QuotaWindow, m: Messages): string | null {
  const unit = quota.kind === 'tools' ? m.calls : quota.kind === 'credits' ? m.credits : m.tokens
  if (quota.used !== null && quota.total !== null) {
    return `${formatCount(quota.used)} / ${formatCount(quota.total)} ${unit}`
  }
  return quota.used === null ? null : `${formatCount(quota.used)} ${unit}`
}

/** A `tools` window's per-tool counts: "search-prime 1433 · web-reader 462". */
export function detailLine(quota: QuotaWindow): string | null {
  if (quota.details.length === 0) {
    return null
  }
  return quota.details
    .map((detail) => (detail.used === null ? detail.code : `${detail.code} ${formatCount(detail.used)}`))
    .join(' · ')
}
