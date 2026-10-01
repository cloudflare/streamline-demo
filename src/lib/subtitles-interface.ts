import {
  STREAMING_EVENTS,
  getSubtitlePresentation,
  type StreamingBeforeStartDetail,
  type StreamingStartErrorDetail,
  type StreamingStartedDetail,
  type StreamingStatusType,
} from './streaming-interface.ts'
import { readStreamlineSettings } from './settings-storage.ts'

export function initializeSubtitlesInterface(): void {
  const root = document.querySelector<HTMLElement>('[data-subtitles-interface]')
  if (!root || root.dataset.initialized === 'true') return
  root.dataset.initialized = 'true'

  const videoIdInput = requiredElement<HTMLInputElement>(root, 'subtitleVideoId')
  const subtitleStatus = requiredElement<HTMLElement>(root, 'subtitleStatus')
  const subtitleInfo = requiredElement<HTMLElement>(root, 'subtitleInfo')
  const subtitleLang = requiredElement<HTMLElement>(root, 'subtitleLang')
  const subtitleCues = requiredElement<HTMLElement>(root, 'subtitleCues')

  function updateSubtitleStatus(
    message: string,
    type: StreamingStatusType = 'info',
    showSettingsLink = false,
  ): void {
    const paragraph = document.createElement('p')
    paragraph.className = `status-text status-${type}`
    paragraph.textContent = message
    if (showSettingsLink) {
      paragraph.append(' ')
      const link = document.createElement('a')
      link.href = '/settings'
      link.textContent = 'Go to Settings'
      paragraph.append(link, ' and select "Stream Video (HLS)" as the input source.')
    }
    subtitleStatus.replaceChildren(paragraph)
    subtitleStatus.style.display = 'block'
  }

  document.addEventListener(STREAMING_EVENTS.beforeStart, (event) => {
    const startEvent = event as CustomEvent<StreamingBeforeStartDetail>
    const settings = startEvent.detail.options.settings
    const videoId = videoIdInput.value.trim()
    if (!videoId) {
      startEvent.detail.validationError = 'Please enter a Stream Video ID.'
      startEvent.preventDefault()
      updateSubtitleStatus('Please enter a Stream Video ID.', 'error')
      return
    }
    if (settings.sourceType !== 'stream-hls') {
      startEvent.detail.validationError = 'Subtitle burn-in requires Stream Video (HLS) input.'
      startEvent.preventDefault()
      updateSubtitleStatus('Subtitle burn-in requires Stream Video (HLS) source.', 'error', true)
      return
    }
    updateSubtitleStatus('Fetching subtitles and starting stream...')
    subtitleInfo.style.display = 'flex'
    settings.videoId = videoId
    startEvent.detail.options.burnSubtitles = true
  })

  document.addEventListener(STREAMING_EVENTS.started, (event) => {
    const { response } = (event as CustomEvent<StreamingStartedDetail>).detail
    const presentation = getSubtitlePresentation(response.subtitle)
    subtitleLang.textContent = presentation.language
    subtitleCues.textContent = presentation.cues
    if (presentation.message) updateSubtitleStatus(presentation.message, presentation.type)
  })

  document.addEventListener(STREAMING_EVENTS.startError, (event) => {
    const { message } = (event as CustomEvent<StreamingStartErrorDetail>).detail
    updateSubtitleStatus(`Error: ${message}`, 'error')
  })

  const settings = readStreamlineSettings()
  if (settings.videoId && !videoIdInput.value) videoIdInput.value = settings.videoId
}

function requiredElement<T extends HTMLElement>(root: ParentNode, id: string): T {
  const element = root.querySelector(`#${id}`)
  if (!element) throw new Error(`Subtitles interface is missing #${id}`)
  return element as T
}
