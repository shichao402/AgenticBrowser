export function sanitizeDownloadFileName(input: string): string {
  let sanitized = input
    // 有意匹配 ASCII 控制字符，用于从下载文件名中剔除不可见字符
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 180)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)) {
    sanitized = `_${sanitized}`
  }
  return sanitized.length > 0 ? sanitized.slice(0, 180) : 'download'
}
