import type { MediaOverrideFieldStatus, MediaOverrideStatus } from './media-overrides.ts'
import {
  loadMediaOverrideStatus,
  SettingsRequestTimeoutError,
  updateMediaOverride,
  type MediaOverrideField,
  type MediaProfileUpdate,
} from './settings-api.ts'
import {
  DEFAULT_DISPLAY_SETTINGS,
  clearDisplaySettings,
  normalizeDisplaySettings,
  readDisplaySettings,
  writeDisplaySettings,
  type DisplaySettings,
} from './settings-storage.ts'

export function initializeSettingsInterface(): void {
  const root = document.querySelector<HTMLElement>('[data-settings-interface]')
  if (!root || root.dataset.initialized === 'true') return
  root.dataset.initialized = 'true'
  new SettingsInterface(root)
}

class SettingsInterface {
  private readonly root: HTMLElement
  private readonly outputRtmpInput: HTMLInputElement
  private readonly outputPreviewInput: HTMLInputElement
  private readonly sourceWebcamInput: HTMLInputElement
  private readonly sourceStreamHlsInput: HTMLInputElement
  private readonly sourceStreamRtmpInput: HTMLInputElement
  private readonly videoIdInput: HTMLInputElement
  private readonly streamVideoField: HTMLElement
  private readonly streamRtmpField: HTMLElement
  private readonly outputRtmpFields: HTMLElement
  private readonly outputResolutionInput: HTMLSelectElement
  private readonly bufferPrimingInput: HTMLInputElement
  private readonly resetBtn: HTMLButtonElement
  private readonly status: HTMLElement
  private readonly rtmpInputOverrideInput: HTMLInputElement
  private readonly rtmpInputLiveInputId: HTMLInputElement
  private readonly rtmpOutputOverrideInput: HTMLInputElement
  private readonly rtmpOutputLiveInputId: HTMLInputElement
  private readonly rtmpInputOverrideState: HTMLElement
  private readonly rtmpOutputOverrideState: HTMLElement
  private readonly mediaOverridesAvailability: HTMLElement
  private readonly saveRtmpInputOverride: HTMLButtonElement
  private readonly saveRtmpOutputOverride: HTMLButtonElement
  private readonly clearRtmpInputOverride: HTMLButtonElement
  private readonly clearRtmpOutputOverride: HTMLButtonElement
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private mediaOverridesWritable = false

  constructor(root: HTMLElement) {
    this.root = root
    this.outputRtmpInput = this.requiredElement('outputRtmp')
    this.outputPreviewInput = this.requiredElement('outputPreview')
    this.sourceWebcamInput = this.requiredElement('sourceWebcam')
    this.sourceStreamHlsInput = this.requiredElement('sourceStreamHls')
    this.sourceStreamRtmpInput = this.requiredElement('sourceStreamRtmp')
    this.videoIdInput = this.requiredElement('videoId')
    this.streamVideoField = this.requiredElement('streamVideoField')
    this.streamRtmpField = this.requiredElement('streamRtmpField')
    this.outputRtmpFields = this.requiredElement('outputRtmpFields')
    this.outputResolutionInput = this.requiredElement('outputResolution')
    this.bufferPrimingInput = this.requiredElement('bufferPriming')
    this.resetBtn = this.requiredElement('resetBtn')
    this.status = this.requiredElement('status')
    this.rtmpInputOverrideInput = this.requiredElement('rtmpInputOverride')
    this.rtmpInputLiveInputId = this.requiredElement('rtmpInputLiveInputId')
    this.rtmpOutputOverrideInput = this.requiredElement('rtmpOutputOverride')
    this.rtmpOutputLiveInputId = this.requiredElement('rtmpOutputLiveInputId')
    this.rtmpInputOverrideState = this.requiredElement('rtmpInputOverrideState')
    this.rtmpOutputOverrideState = this.requiredElement('rtmpOutputOverrideState')
    this.mediaOverridesAvailability = this.requiredElement('mediaOverridesAvailability')
    this.saveRtmpInputOverride = this.requiredElement('saveRtmpInputOverride')
    this.saveRtmpOutputOverride = this.requiredElement('saveRtmpOutputOverride')
    this.clearRtmpInputOverride = this.requiredElement('clearRtmpInputOverride')
    this.clearRtmpOutputOverride = this.requiredElement('clearRtmpOutputOverride')

    this.applySettings(readDisplaySettings())
    this.bindEvents()
    if (!this.isPlayground) void this.refreshMediaOverrideStatus()
    window.addEventListener('pagehide', () => this.flushPendingSettings())
  }

  private bindEvents(): void {
    for (const input of [
      this.sourceWebcamInput,
      this.sourceStreamHlsInput,
      this.sourceStreamRtmpInput,
    ]) {
      input.addEventListener('change', () => {
        this.updateSourceVisibility()
        this.saveSettings('Settings saved automatically.')
      })
    }
    for (const input of [this.outputRtmpInput, this.outputPreviewInput]) {
      input.addEventListener('change', () => {
        this.updateOutputVisibility()
        this.saveSettings('Settings saved automatically.')
      })
    }
    this.videoIdInput.addEventListener('input', () => this.scheduleSave())
    this.outputResolutionInput.addEventListener('change', () => this.saveSettings('Settings saved automatically.'))
    this.bufferPrimingInput.addEventListener('input', () => this.scheduleSave())
    this.resetBtn.addEventListener('click', () => this.resetSettings())
    this.saveRtmpInputOverride.addEventListener('click', () => {
      void this.saveMediaProfile('input', this.rtmpInputOverrideInput, this.rtmpInputLiveInputId)
    })
    this.saveRtmpOutputOverride.addEventListener('click', () => {
      void this.saveMediaProfile('output', this.rtmpOutputOverrideInput, this.rtmpOutputLiveInputId)
    })
    this.clearRtmpInputOverride.addEventListener('click', () => {
      void this.clearMediaOverride('input', 'input profile')
    })
    this.clearRtmpOutputOverride.addEventListener('click', () => {
      void this.clearMediaOverride('output', 'output profile')
    })
  }

  private applySettings(settings: DisplaySettings): void {
    this.setOutputMode(this.isPlayground || settings.previewMode)
    this.sourceWebcamInput.checked = settings.sourceType === 'webcam'
    this.sourceStreamHlsInput.checked = settings.sourceType === 'stream-hls'
    this.sourceStreamRtmpInput.checked = !this.isPlayground && settings.sourceType === 'stream-rtmp'
    if (this.isPlayground && !this.sourceWebcamInput.checked && !this.sourceStreamHlsInput.checked) {
      this.sourceWebcamInput.checked = true
    }
    this.videoIdInput.value = settings.videoId
    this.outputResolutionInput.value = settings.outputResolution
    this.bufferPrimingInput.value = String(settings.bufferPriming)
    this.updateSourceVisibility()
  }

  private collectSettings(): DisplaySettings {
    return normalizeDisplaySettings({
      previewMode: this.isPlayground || this.outputPreviewInput.checked,
      sourceType: this.sourceStreamHlsInput.checked
        ? 'stream-hls'
        : !this.isPlayground && this.sourceStreamRtmpInput.checked
          ? 'stream-rtmp'
          : 'webcam',
      videoId: this.videoIdInput.value.trim(),
      outputResolution: this.outputResolutionInput.value,
      bufferPriming: Number.parseFloat(this.bufferPrimingInput.value),
    })
  }

  private updateSourceVisibility(): void {
    this.streamVideoField.style.display = this.sourceStreamHlsInput.checked ? '' : 'none'
    this.streamRtmpField.style.display = this.sourceStreamRtmpInput.checked ? '' : 'none'
  }

  private get isPlayground(): boolean {
    return this.root.dataset.playground === 'true'
  }

  private setOutputMode(previewMode: boolean): void {
    if (previewMode) this.outputPreviewInput.checked = true
    else this.outputRtmpInput.checked = true
    this.updateOutputVisibility()
  }

  private updateOutputVisibility(): void {
    this.outputRtmpFields.style.display = this.outputRtmpInput.checked ? '' : 'none'
  }

  private saveSettings(message: string): void {
    try {
      writeDisplaySettings(this.collectSettings())
      this.showStatus(message, 'success')
    } catch (error) {
      this.showStatus(errorMessage(error), 'error')
    }
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer)
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null
      this.saveSettings('Settings saved automatically.')
    }, 400)
  }

  private resetSettings(): void {
    if (!confirm('Reset browser display preferences to defaults? This cannot be undone.')) return
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer)
    this.saveDebounceTimer = null
    this.applySettings({ ...DEFAULT_DISPLAY_SETTINGS })
    clearDisplaySettings()
    this.showStatus('Settings reset to defaults.', 'info')
  }

  private showStatus(message: string, type = 'info'): void {
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.status.textContent = message
    this.status.className = `status status-${type}`
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.status.textContent = ''
      this.status.className = 'status'
    }, 3_000)
  }

  private renderMediaOverrideStatus(configuration: MediaOverrideStatus): void {
    this.mediaOverridesWritable = configuration.writable === true
    this.rtmpInputOverrideState.textContent = describeOverride(configuration.input)
    this.rtmpOutputOverrideState.textContent = describeOverride(configuration.output)
    this.rtmpInputOverrideState.className = `secret-state ${configuration.input.valid ? 'secret-state-valid' : 'secret-state-invalid'}`
    this.rtmpOutputOverrideState.className = `secret-state ${configuration.output.valid ? 'secret-state-valid' : 'secret-state-invalid'}`
    this.rtmpInputOverrideInput.disabled = !this.mediaOverridesWritable
    this.rtmpInputLiveInputId.disabled = !this.mediaOverridesWritable
    this.rtmpOutputOverrideInput.disabled = !this.mediaOverridesWritable
    this.rtmpOutputLiveInputId.disabled = !this.mediaOverridesWritable
    this.saveRtmpInputOverride.disabled = !this.mediaOverridesWritable
    this.saveRtmpOutputOverride.disabled = !this.mediaOverridesWritable
    this.clearRtmpInputOverride.disabled = !this.mediaOverridesWritable || configuration.input.source !== 'override'
    this.clearRtmpOutputOverride.disabled = !this.mediaOverridesWritable || configuration.output.source !== 'override'
    this.mediaOverridesAvailability.hidden = this.mediaOverridesWritable
    this.mediaOverridesAvailability.textContent = this.mediaOverridesWritable
      ? ''
      : 'Editing owner overrides requires the deployed Durable Object.'
  }

  private async refreshMediaOverrideStatus(): Promise<void> {
    try {
      this.renderMediaOverrideStatus(await loadMediaOverrideStatus())
    } catch (error) {
      this.mediaOverridesWritable = false
      this.setMediaControlsDisabled()
      this.rtmpInputOverrideState.textContent = 'Configuration status unavailable.'
      this.rtmpOutputOverrideState.textContent = 'Configuration status unavailable.'
      this.rtmpInputOverrideState.className = 'secret-state secret-state-invalid'
      this.rtmpOutputOverrideState.className = 'secret-state secret-state-invalid'
      this.showStatus(errorMessage(error), 'error')
    }
  }

  private async updateMediaOverride(field: MediaOverrideField, value: MediaProfileUpdate): Promise<boolean> {
    this.setMediaControlsDisabled()
    try {
      const configuration = await updateMediaOverride(field, value)
      this.renderMediaOverrideStatus(configuration)
      this.showStatus(
        value === null
          ? 'Deployment defaults restored for the next stream.'
          : 'Owner Stream profile saved for the next stream.',
        'success',
      )
      return true
    } catch (error) {
      if (error instanceof SettingsRequestTimeoutError) {
        await this.refreshMediaOverrideStatus()
        this.showStatus('Update outcome is unknown; verify the refreshed profile status before retrying.', 'warning')
        return true
      }
      this.showStatus(errorMessage(error), 'error')
      await this.refreshMediaOverrideStatus()
      return false
    }
  }

  private setMediaControlsDisabled(): void {
    for (const control of [
      this.rtmpInputOverrideInput,
      this.rtmpInputLiveInputId,
      this.rtmpOutputOverrideInput,
      this.rtmpOutputLiveInputId,
      this.saveRtmpInputOverride,
      this.saveRtmpOutputOverride,
      this.clearRtmpInputOverride,
      this.clearRtmpOutputOverride,
    ]) control.disabled = true
  }

  private async saveMediaProfile(
    field: MediaOverrideField,
    keyInput: HTMLInputElement,
    liveInputIdInput: HTMLInputElement,
  ): Promise<void> {
    const key = keyInput.value.trim()
    const liveInputId = liveInputIdInput.value.trim()
    if (!key || !liveInputId) {
      this.showStatus('Enter both the RTMPS key and its matching Stream Live Input ID.', 'error')
      return
    }
    if (await this.updateMediaOverride(field, { key, liveInputId })) {
      keyInput.value = ''
      liveInputIdInput.value = ''
    }
  }

  private async clearMediaOverride(field: MediaOverrideField, label: string): Promise<void> {
    if (!confirm(`Remove the owner ${label} override and use the deployment default?`)) return
    await this.updateMediaOverride(field, null)
  }

  private flushPendingSettings(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer)
      this.saveDebounceTimer = null
      try {
        writeDisplaySettings(this.collectSettings())
      } catch (error) {
        console.error('Failed to flush display settings:', error)
      }
    }
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.statusTimer = null
  }

  private requiredElement<T extends HTMLElement>(id: string): T {
    const element = this.root.querySelector(`#${id}`)
    if (!element) throw new Error(`Settings interface is missing #${id}`)
    return element as T
  }
}

function describeOverride(field: MediaOverrideFieldStatus): string {
  if (field.source === 'override') {
    const updated = field.updatedAt ? ` Updated ${new Date(field.updatedAt).toLocaleString()}.` : ''
    return field.valid ? `Owner profile configured.${updated}` : `Owner profile is no longer valid.${updated}`
  }
  if (field.source === 'default') {
    return field.valid ? 'Deployment default configured.' : 'Deployment default is invalid.'
  }
  return 'No value configured.'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
