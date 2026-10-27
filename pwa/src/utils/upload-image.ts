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
export function imageRefusal(blob: Blob): UploadErrorReason | null {
  if (/^image\/hei[cf]$/.test(blob.type)) return 'heic'
  if (!(UPLOAD_TYPES as readonly string[]).includes(blob.type))
    return 'unsupported_image'
  if (blob.size > MAX_UPLOAD_BYTES) return 'too_large'
  return null
}

// An image sent as its raw bytes: the response and its JSON body, or why it
// never arrived (a type or size refused before sending, the network, the
// timeout)
async function postImage(
  url: string,
  blob: Blob,
): Promise<
  | { ok: true; res: Response; data: Record<string, unknown> | null }
  | { ok: false; reason: UploadErrorReason }
> {
  const pre = imageRefusal(blob)
  if (pre) return { ok: false, reason: pre }
  let res: Response
  try {
    res = await fetch(url, {
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
  const data = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  return { ok: true, res, data }
}

// The reason comes from the JSON code, not the status alone: an old server
// answers this route with a plain 404.
export async function uploadImage(blob: Blob): Promise<UploadResult> {
  const sent = await postImage('/api/mux/uploads', blob)
  if (!sent.ok) return sent
  const { res } = sent
  const data = sent.data as (Partial<Upload> & { code?: string }) | null
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

// Why an image pasted into a Markdown file was not saved next to it: an
// upload's reasons, the files routes' own, or the pane's root having moved
// (root is the new one)
export type FileImageErrorReason =
  | UploadErrorReason
  | 'view_only'
  | 'sensitive'
  | 'symlink'
  | 'not_directory'
  | 'exists'
  | 'invalid_name'
  | 'not_allowed'
  | 'not_found'
  | 'permission'
  | 'read_only'
  | 'too_many_pixels'
  | 'root_changed'

export type FileImageResult =
  | { ok: true; root: string; path: string }
  | { ok: false; reason: FileImageErrorReason; root?: string }

const FILE_IMAGE_REASONS: readonly FileImageErrorReason[] = [
  'too_large',
  'unsupported_image',
  'busy',
  'storage_full',
  'view_only',
  'sensitive',
  'symlink',
  'not_directory',
  'exists',
  'invalid_name',
  'not_allowed',
  'not_found',
  'permission',
  'read_only',
  'too_many_pixels',
]

// Saves an image pasted into the Markdown file being edited (POST
// files/image) in dir, its directory under root ("." for the root itself),
// or the assets/ directory there; the server picks the name. reveal: the
// file was shown though it is sensitive, so its folder may be too.
export async function uploadFileImage(
  paneId: string,
  at: { root: string; dir: string; reveal: boolean },
  blob: Blob,
): Promise<FileImageResult> {
  const q = new URLSearchParams({ root: at.root, dir: at.dir })
  if (at.reveal) q.set('reveal', '1')
  const sent = await postImage(
    `/api/mux/panes/${encodeURIComponent(paneId)}/files/image?${q}`,
    blob,
  )
  if (!sent.ok) return sent
  const { res } = sent
  const data = sent.data as {
    root?: string
    path?: string
    code?: string
  } | null
  if (res.ok && data?.root && data.path)
    return { ok: true, root: data.root, path: data.path }
  // The pane's directory moved since the file was read
  if (res.status === 409 && data?.root && !data.code)
    return { ok: false, reason: 'root_changed', root: data.root }
  const code = data?.code as FileImageErrorReason | undefined
  if (code && FILE_IMAGE_REASONS.includes(code))
    return { ok: false, reason: code }
  return { ok: false, reason: 'failed' }
}

// What the user is told when a pasted image was not saved next to the file
export function fileImageErrorMessage(reason: FileImageErrorReason): string {
  switch (reason) {
    case 'view_only':
      return 'A view-only device cannot save images'
    case 'sensitive':
      return 'This folder may hold secrets: the image was not saved'
    case 'symlink':
      return 'The folder is a link: the image was not saved'
    case 'not_directory':
      return 'A folder on the way is a file: the image was not saved'
    case 'exists':
      return 'Too many images pasted this second. Try again'
    case 'invalid_name':
    case 'not_allowed':
      return "Images can't be saved in this folder"
    case 'not_found':
      return "The file's folder is no longer on the host"
    case 'permission':
      return "The server can't write in this folder"
    case 'read_only':
      return 'The file system there is read-only'
    case 'too_many_pixels':
      return 'Image is larger than 40 megapixels'
    case 'storage_full':
      return "The host's disk or quota is full"
    case 'busy':
      return 'Too many saves at once. Try again'
    case 'root_changed':
      return "This pane's folder changed: the image was not saved"
    case 'timeout':
      return 'Not sure the image was saved. Check the folder'
    case 'unsupported_image':
      return 'Only PNG, JPEG, GIF and WebP images can be pasted'
    default:
      return uploadErrorMessage(reason)
  }
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
