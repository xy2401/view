import { extname } from 'node:path'

const supported = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'])

export function supportsThumbnail(filename) {
  return supported.has(extname(filename).toLowerCase())
}
