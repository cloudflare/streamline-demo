void fetch('/playground/config').then((response) => {
  if (!response.ok) return
  for (const link of document.querySelectorAll('[data-owner-only]')) link.remove()
  for (const element of document.querySelectorAll<HTMLElement>('[data-playground-only]')) element.hidden = false
}).catch(() => {})
