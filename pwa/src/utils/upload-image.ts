/**
 * Uploads an image to the host (POST /api/mux/uploads), so an agent can read
 * it by path: the host clipboard is empty when the image sits on a phone.
 */

// Mirrors the server's limit; the server still decides.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

// A little past the server's own 5-minute read deadline for an upload.
export const UPLOAD_TIMEOUT_MS = 330_000

export const UPLOAD_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

export interface Upload {
  id: string
  path: string
  // What goes into the terminal: the path, quoted when it holds a space.
  insert: string
}

export type UploadErrorReason =
  | 'too_large'
  | 'unsupported_image'
  | 'heic'
  | 'busy'
  | 'storage_full'
  | 'uploads_unavailable'
  | 'network'
  | 'timeout'
  | 'failed'

export type UploadResult =
  | { ok: true; upload: Upload }
  | { ok: false; reason: UploadErrorReason }

const SERVER_REASONS: readonly UploadErrorReason[] = [
  'too_large',
  'unsupported_image',
  'busy',
  'storage_full',
  'uploads_unavailable',
]

// An image the server accepts, by type and size; checked before sending so a
// wrong file fails at once instead of after the upload.
function precheck(blob: Blob): UploadErrorReason | null {
  if (/^image\/hei[cf]$/.test(blob.type)) return 'heic'
  if (!(UPLOAD_TYPES as readonly string[]).includes(blob.type))
    return 'unsupported_image'
  if (blob.size > MAX_UPLOAD_BYTES) return 'too_large'
  return null
}

// The reason comes from the JSON code, not the status alone: an old server
// answers this route with a plain 404.
export async function uploadImage(blob: Blob): Promise<UploadResult> {
  const pre = precheck(blob)
  if (pre) return { ok: false, reason: pre }
  let res: Response
  try {
    res = await fetch('/api/mux/uploads', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      credentials: 'same-origin',
      body: blob,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError'
    return { ok: false, reason: timedOut ? 'timeout' : 'network' }
  }
  const data = (await res.json().catch(() => null)) as
    | (Partial<Upload> & { code?: string })
    | null
  if (res.ok && data?.id && data.path && data.insert) {
    return {
      ok: true,
      upload: { id: data.id, path: data.path, insert: data.insert },
    }
  }
  const code = data?.code as UploadErrorReason | undefined
  if (code && SERVER_REASONS.includes(code)) return { ok: false, reason: code }
  if (res.status === 404) return { ok: false, reason: 'uploads_unavailable' }
  return { ok: false, reason: 'failed' }
}

export function uploadErrorMessage(reason: UploadErrorReason): string {
  switch (reason) {
    case 'too_large':
      return 'Image is larger than 10 MB'
    case 'heic':
      return 'HEIC images are not supported. Share the photo as JPEG'
    case 'unsupported_image':
      return 'Only PNG, JPEG, GIF and WebP images can be attached'
    case 'busy':
      return 'Another upload is running. Try again in a moment'
    case 'storage_full':
      return 'Upload storage on the host is full. Try again later'
    case 'uploads_unavailable':
      return 'This server cannot take image uploads'
    case 'network':
      return 'Upload failed: network error'
    case 'timeout':
      return 'Upload took too long. Try a smaller image or a better connection'
    default:
      return 'Upload failed'
  }
}

// The image a paste carries, only when it carries no text: copying from a
// web page often puts both, and the text is what the user meant then.
export function imageFromClipboard(data: DataTransfer | null): File | null {
  if (!data || data.types.includes('text/plain')) return null
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

// Opens the OS picker for one image (gallery or camera on a phone); null when
// the user cancels. The input sits in the page while the picker is open: iOS
// Safari may not report a choice made on a detached one.
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.hidden = true
    const done = (file: File | null) => {
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => done(null))
    document.body.append(input)
    input.click()
  })
}
