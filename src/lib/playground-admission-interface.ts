interface PlaygroundConfig {
  sitekey: string
  action: string
}

interface Turnstile {
  render: (container: HTMLElement, options: {
    sitekey: string
    action: string
    appearance: 'always'
    callback: (token: string) => void
    'error-callback': () => void
    'expired-callback': () => void
  }) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window { turnstile?: Turnstile }
}

let configuration: Promise<PlaygroundConfig | null> | null = null
let turnstileScript: Promise<Turnstile> | null = null

export async function preparePlaygroundAdmission(): Promise<{ pollMetrics: false } | void> {
  const config = await getPlaygroundConfig()
  if (!config) return
  const turnstile = await loadTurnstile()
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Confirm you are human')
  dialog.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:1.5rem;background:rgb(5 6 8 / 72%);'
  const panel = document.createElement('div')
  panel.style.cssText = 'width:min(100%,24rem);padding:1.5rem;border:1px solid #485161;border-radius:.5rem;background:#151922;color:#f5f7fa;box-shadow:0 1rem 3rem rgb(0 0 0 / 45%);'
  const message = document.createElement('p')
  message.textContent = 'Confirm you are human to start a Playground session.'
  message.style.cssText = 'margin:0 0 1rem;font:600 1rem system-ui,sans-serif;'
  const container = document.createElement('div')
  panel.append(message, container)
  dialog.append(panel)
  document.body.append(dialog)
  let widgetId: string | undefined
  try {
    const token = await new Promise<string>((resolve, reject) => {
      widgetId = turnstile.render(container, {
        sitekey: config.sitekey,
        action: config.action,
        appearance: 'always',
        callback: resolve,
        'error-callback': () => reject(new Error('Turnstile verification failed. Please try again.')),
        'expired-callback': () => reject(new Error('Turnstile verification expired. Please try again.')),
      })
    })
    const response = await fetch('/playground/admit', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    })
    if (!response.ok) throw new Error(await response.text() || 'Playground admission was denied.')
    return { pollMetrics: false }
  } finally {
    if (widgetId) turnstile.remove(widgetId)
    dialog.remove()
  }
}

async function getPlaygroundConfig(): Promise<PlaygroundConfig | null> {
  configuration ??= (async () => {
    const response = await fetch('/playground/config', { credentials: 'same-origin' })
    if (response.status === 404) return null
    if (!response.ok) throw new Error('The public playground is not configured yet.')
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The public playground returned invalid configuration.')
    const { sitekey, action } = value as Record<string, unknown>
    if (typeof sitekey !== 'string' || !sitekey || typeof action !== 'string' || !action) throw new Error('The public playground is not configured yet.')
    return { sitekey, action }
  })()
  return configuration
}

async function loadTurnstile(): Promise<Turnstile> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load.'))
    script.onerror = () => reject(new Error('Turnstile did not load. Please try again.'))
    document.head.append(script)
  })
  return turnstileScript
}
