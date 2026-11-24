import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { buffer } from 'node:stream/consumers'
import sharp from 'sharp'

// The file extension is only a hint. Enable raster decoders for the actual input bytes.
sharp.block({ operation: ['VipsForeignLoad'] })
sharp.unblock({
  operation: [
    'VipsForeignLoadJpegBuffer',
    'VipsForeignLoadPngBuffer',
    'VipsForeignLoadSpngBuffer',
    'VipsForeignLoadWebpBuffer',
    'VipsForeignLoadNsgifBuffer',
    'VipsForeignLoadTiffBuffer',
    'VipsForeignLoadHeifBuffer',
  ],
})

export async function renderThumbnail(filename) {
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const info = await handle.stat()
    if (!info.isFile() || !info.size || info.size > 128 * 1024 * 1024) return null
    if ((await realpath(filename)) !== filename) return null
    const current = await stat(filename)
    if (info.dev !== current.dev || info.ino !== current.ino) return null

    // Decode the already-authorized file descriptor, even if the pathname changes during a read.
    const input = await buffer(handle.createReadStream({ autoClose: false, end: info.size - 1 }))
    const data = await sharp(input, { limitInputPixels: 128_000_000, pages: 1 })
      .autoOrient()
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 3 })
      .toBuffer()
    return { data, mime: 'image/webp' }
  } finally {
    await handle.close()
  }
}
