/**
 * A small preview of an image the user attached, as a data: URL: it stays
 * valid as long as the chip shows it, with no blob: URL to revoke.
 */

export const THUMBNAIL_SIZE = 128

// Scales the image down to fit THUMBNAIL_SIZE (never up); null when the
// browser cannot decode it (the chip then shows an icon).
export async function imageThumbnail(
  blob: Blob,
  size = THUMBNAIL_SIZE,
): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return null
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}
