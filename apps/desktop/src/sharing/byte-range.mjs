export function byteRange(range, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range)
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return start < size && end >= start ? { start, end } : null
}
