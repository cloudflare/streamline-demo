export async function readBodyWithLimit(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const contentLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > limit) return null
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array<ArrayBufferLike>[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function normalizeEmptyRequestBody(request: Request): Promise<Request | null> {
  if (!request.body) return request
  if (await readBodyWithLimit(request, 0) === null) return null
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
    signal: request.signal,
  })
}
