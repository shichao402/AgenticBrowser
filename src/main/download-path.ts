export function sanitizeDownloadFileName(input: string): string {
  let sanitized = input
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 180)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)) {
    sanitized = `_${sanitized}`
  }
  return sanitized.length > 0 ? sanitized.slice(0, 180) : 'download'
}
