interface PreviewRelay {
  url: string
  token: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function injectPreviewRelay(
  body: Record<string, unknown>,
  relay: PreviewRelay,
): Record<string, unknown> {
  if (!isRecord(body.output) || body.output.mode !== 'websocket') return body
  return {
    ...body,
    output: {
      ...body.output,
      relay,
    },
  }
}
