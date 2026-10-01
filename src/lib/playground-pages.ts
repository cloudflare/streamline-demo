const UNSUPPORTED_PLAYGROUND_PAGES = new Set([
  '/probe',
])

export function isUnsupportedPlaygroundPage(pathname: string): boolean {
  return UNSUPPORTED_PLAYGROUND_PAGES.has(pathname)
}
