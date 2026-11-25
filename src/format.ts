// Number and time formatting the panel and the status bar share. Pure: no imports.

/** A size the way usage dashboards write it: 1433, 45K, 127.7M, 1.2B. */
export function formatCount(value: number): string {
  if (value < 10_000) {
    return String(Math.round(value))
  }
  const [size, suffix] =
    value >= 1e9 ? [1e9, 'B'] : value >= 1e6 ? [1e6, 'M'] : [1e3, 'K']
  const scaled = value / size
  // Three digits that matter: one decimal from 10 up, two below.
  const digits = scaled >= 10 ? 1 : 2
  // parseFloat drops the zeros toFixed pads with: 800.0 reads "800".
  return `${parseFloat(scaled.toFixed(digits))}${suffix}`
}

/** How long until a moment, the way the status bar writes it: "45m", "2h 13m", "4d 12h", "3d". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) {
    return 'now'
  }
  // Rounded up, so "2h 13m" never reads "2h 12m" with 13 minutes left, nor "0m" before a reset.
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  if (hours > 0) {
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  }
  return `${minutes}m`
}

/** A local clock time such as "11:30", in the language Orca shows. */
export function clockTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(at)
  )
}

/** The plan's tier with a capital: "pro" reads "Pro"; a name such as "GLM Coding Max" is kept. */
export function planLabel(plan: string | null): string | null {
  if (plan === null) {
    return null
  }
  return /^[a-z]+$/.test(plan) ? plan.charAt(0).toUpperCase() + plan.slice(1) : plan
}
