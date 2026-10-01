import { STREAMING_EVENTS, type StreamingStateChangeDetail } from './streaming-interface.ts'
import type { FilterValues } from './stream-session-config.ts'

interface FilterControls {
  blur: HTMLInputElement
  brightness: HTMLInputElement
  contrast: HTMLInputElement
  saturation: HTMLInputElement
  gamma: HTMLInputElement
  sharpen: HTMLInputElement
  flip: HTMLInputElement
  rotate: HTMLSelectElement
}

export function initializeFiltersInterface(): void {
  const root = document.querySelector<HTMLElement>('[data-filters-interface]')
  if (!root || root.dataset.initialized === 'true') return
  root.dataset.initialized = 'true'

  const controls: FilterControls = {
    blur: requiredElement(root, 'blur'),
    brightness: requiredElement(root, 'brightness'),
    contrast: requiredElement(root, 'contrast'),
    saturation: requiredElement(root, 'saturation'),
    gamma: requiredElement(root, 'gamma'),
    sharpen: requiredElement(root, 'sharpen'),
    flip: requiredElement(root, 'flip'),
    rotate: requiredElement(root, 'rotate'),
  }
  const valueLabels = {
    blur: requiredElement<HTMLElement>(root, 'blurValue'),
    brightness: requiredElement<HTMLElement>(root, 'brightnessValue'),
    contrast: requiredElement<HTMLElement>(root, 'contrastValue'),
    saturation: requiredElement<HTMLElement>(root, 'saturationValue'),
    gamma: requiredElement<HTMLElement>(root, 'gammaValue'),
    sharpen: requiredElement<HTMLElement>(root, 'sharpenValue'),
  }
  const filterStatus = requiredElement<HTMLElement>(root, 'filterStatus')
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let filterRevision = 0
  let appliedRevision = 0
  let startingRevision = 0
  let restartInFlight = false
  let streamState = 'idle'

  function getFilterValues(): FilterValues {
    return {
      blur: Number.parseFloat(controls.blur.value),
      brightness: Number.parseFloat(controls.brightness.value),
      contrast: Number.parseFloat(controls.contrast.value),
      saturation: Number.parseFloat(controls.saturation.value),
      gamma: Number.parseFloat(controls.gamma.value),
      sharpen: Number.parseFloat(controls.sharpen.value),
      flip: controls.flip.checked,
      rotate: Number.parseInt(controls.rotate.value),
    }
  }

  function showFilterStatus(message: string): void {
    filterStatus.textContent = message
    filterStatus.style.display = message ? 'block' : 'none'
  }

  async function sendFilterUpdate(): Promise<void> {
    if (
      restartInFlight
      || filterRevision <= appliedRevision
      || !window.isStreamingActive?.()
      || !window.restartStreaming
    ) return
    const targetRevision = filterRevision
    restartInFlight = true
    showFilterStatus('Restarting stream with new filters...')

    let restarted: boolean
    try {
      restarted = await window.restartStreaming()
    } catch (error) {
      restartInFlight = false
      showFilterStatus('Stream restart failed; filters will apply on the next start.')
      console.error('Filter restart failed', error)
      return
    }

    restartInFlight = false
    if (restarted) appliedRevision = Math.max(appliedRevision, targetRevision)
    showFilterStatus(restarted ? '' : 'Stream is no longer active; filters will apply on the next start.')
    if (restarted && filterRevision > appliedRevision) scheduleFilterUpdate()
  }

  function scheduleFilterUpdate(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void sendFilterUpdate()
    }, 500)
  }

  function onFilterChange(): void {
    valueLabels.blur.textContent = controls.blur.value
    valueLabels.brightness.textContent = controls.brightness.value
    valueLabels.contrast.textContent = controls.contrast.value
    valueLabels.saturation.textContent = controls.saturation.value
    valueLabels.gamma.textContent = controls.gamma.value
    valueLabels.sharpen.textContent = controls.sharpen.value
    filterRevision++
    if (streamState === 'running' || restartInFlight) scheduleFilterUpdate()
  }

  for (const control of Object.values(controls)) {
    control.addEventListener('input', onFilterChange)
    control.addEventListener('change', onFilterChange)
  }
  window.getFilterValues = getFilterValues
  document.addEventListener(STREAMING_EVENTS.beforeStart, () => {
    startingRevision = filterRevision
  })
  document.addEventListener(STREAMING_EVENTS.started, () => {
    appliedRevision = Math.max(appliedRevision, startingRevision)
    if (filterRevision > appliedRevision) scheduleFilterUpdate()
  })
  document.addEventListener(STREAMING_EVENTS.stateChange, (event) => {
    const { state } = (event as CustomEvent<StreamingStateChangeDetail>).detail
    streamState = state
    if (state === 'idle' && !restartInFlight && debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  })
}

function requiredElement<T extends HTMLElement>(root: ParentNode, id: string): T {
  const element = root.querySelector(`#${id}`)
  if (!element) throw new Error(`Filters interface is missing #${id}`)
  return element as T
}
