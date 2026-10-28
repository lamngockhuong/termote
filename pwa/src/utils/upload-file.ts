/**
 * Sends a file from this device into a folder of Files (POST files/upload):
 * first with check=1, which answers every refusal as JSON before any byte
 * goes (a refusal sent while a large body is still coming reaches the page
 * as a reset connection), then its raw bytes.
 */

import { type FilesTarget, filesUrl } from '../hooks/use-mux-api'

// Mirrors the server's limit (what files/download sends back); the server
// still decides.
export const MAX_FILE_UPLOAD_BYTES = 100 * 1024 * 1024

// Why a file was not uploaded: the server's codes, the pane's root having
// moved (root is the new one), the session having ended, the request never
// answered, or its answer lost after every byte went (unsure)
export type FileUploadReason =
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
  | 'place_moved'
  | 'unknown_place'
  | 'too_large'
  | 'timeout'
  | 'upload_busy'
  | 'storage_full'
  | 'unsupported_type'
  | 'root_changed'
  | 'unauthorized'
  | 'network'
  | 'aborted'
  | 'unsure'
  | 'failed'

const SERVER_REASONS: readonly FileUploadReason[] = [
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
  'place_moved',
  'unknown_place',
  'too_large',
  'timeout',
  'upload_busy',
  'storage_full',
  'unsupported_type',
]

// Where a file goes: dir under root ("." for the root itself), as name.
// reveal: the user agreed to write where secrets may be.
export interface UploadAt {
  root: string
  dir: string
  name: string
  reveal: boolean
}

export type UploadResult =
  | { ok: true; path: string }
  | { ok: false; reason: FileUploadReason; root?: string }

// The folder an upload goes in, from a tree path ("" or "src/", as the New
// file box takes it): without the trailing /, "." for the root
export function uploadDir(path: string): string {
  return path.replace(/\/$/, '') || '.'
}

function uploadUrl(target: FilesTarget, at: UploadAt, check: boolean): string {
  return filesUrl(target, 'upload', {
    root: at.root,
    dir: at.dir,
    name: at.name,
    reveal: at.reveal ? '1' : undefined,
    check: check ? '1' : undefined,
  })
}

// The result an answer stands for. The reason comes from the JSON code,
// not the status alone.
function answer(status: number, data: unknown): UploadResult {
  const d = (data ?? {}) as { root?: string; path?: string; code?: string }
  if (status >= 200 && status < 300 && d.path) return { ok: true, path: d.path }
  if (status === 401) return { ok: false, reason: 'unauthorized' }
  // The pane's directory moved since the tree was read
  if (status === 409 && d.root && !d.code)
    return { ok: false, reason: 'root_changed', root: d.root }
  const code = d.code as FileUploadReason | undefined
  if (code && SERVER_REASONS.includes(code)) return { ok: false, reason: code }
  return { ok: false, reason: 'failed' }
}

// What an upload of file to at would give now: the path it would get (a
// taken name is numbered), or why it would be refused. Nothing is sent.
export async function checkUpload(
  target: FilesTarget,
  at: UploadAt,
  file: File,
  signal?: AbortSignal,
): Promise<UploadResult> {
  if (file.size > MAX_FILE_UPLOAD_BYTES)
    return { ok: false, reason: 'too_large' }
  let res: Response
  try {
    res = await fetch(uploadUrl(target, at, true), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
      signal,
    })
  } catch {
    return { ok: false, reason: signal?.aborted ? 'aborted' : 'network' }
  }
  return answer(res.status, await res.json().catch(() => null))
}

export interface UploadCallbacks {
  // How much of the file went, 0 to 1
  onProgress?: (part: number) => void
  // Every byte went: a cancel can no longer stop the file being saved
  onSent?: () => void
  signal?: AbortSignal
}

// Sends file's bytes to at. An XMLHttpRequest, since fetch reports no upload
// progress; always application/octet-stream, whatever the file's type.
export function uploadFile(
  target: FilesTarget,
  at: UploadAt,
  file: File,
  { onProgress, onSent, signal }: UploadCallbacks = {},
): Promise<UploadResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: 'aborted' })
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', uploadUrl(target, at, false))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total) onProgress?.(e.loaded / e.total)
    }
    xhr.upload.onload = () => onSent?.()
    const stop = () => xhr.abort()
    const done = (r: UploadResult) => {
      signal?.removeEventListener('abort', stop)
      resolve(r)
    }
    xhr.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {}
      done(answer(xhr.status, data))
    }
    xhr.onerror = () => done({ ok: false, reason: 'network' })
    xhr.onabort = () => done({ ok: false, reason: 'aborted' })
    signal?.addEventListener('abort', stop, { once: true })
    xhr.send(file)
  })
}

// What the user is told when a file was not uploaded
export function fileUploadErrorMessage(reason: FileUploadReason): string {
  switch (reason) {
    case 'view_only':
      return 'A view-only device cannot upload'
    case 'sensitive':
      return 'This folder may hold secrets: not uploaded'
    case 'symlink':
      return 'The folder is a link: not uploaded'
    case 'not_directory':
      return 'A folder on the way is a file: not uploaded'
    case 'exists':
      return 'Too many files with this name. Rename one first'
    case 'invalid_name':
      return "This file's name can't be used on the host"
    case 'not_allowed':
      return "Files can't be uploaded to this folder"
    case 'not_found':
      return 'The folder is no longer on the host'
    case 'permission':
      return "The server can't write in this folder"
    case 'read_only':
      return 'The file system there is read-only'
    case 'place_moved':
    case 'unknown_place':
      return "This place isn't available any more"
    case 'too_large':
      return 'File is larger than 100 MB'
    case 'timeout':
      return 'The upload stalled. Try again on a better connection'
    case 'upload_busy':
      return 'Another upload is running. Try again shortly'
    case 'storage_full':
      return "The host's disk or quota is full"
    case 'unsupported_type':
      return 'The server refused how the file was sent'
    case 'root_changed':
      return "This pane's folder changed: not uploaded"
    case 'unauthorized':
      return 'Sign in again to upload'
    case 'network':
      return 'Upload failed: network error'
    case 'aborted':
      return 'Upload canceled'
    case 'unsure':
      return 'Not sure the file was saved. Check the folder'
    default:
      return 'Upload failed'
  }
}

// The files a drop carries, and how many folders it held: a folder is never
// uploaded. Told apart by its entry where the browser gives one, else by
// what a folder looks like as a File (no size, no type), which also skips an
// empty file with no extension: the Upload button still takes that one.
export function droppedFiles(dt: DataTransfer): {
  files: File[]
  folders: number
} {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file')
  const dropped = items.length
    ? items.map((i) => ({
        file: i.getAsFile(),
        entry: i.webkitGetAsEntry?.() ?? undefined,
      }))
    : Array.from(dt.files).map((file) => ({ file, entry: undefined }))
  const files: File[] = []
  let folders = 0
  for (const { file, entry } of dropped) {
    if (!file) continue
    const folder = entry
      ? entry.isDirectory
      : file.size === 0 && file.type === ''
    if (folder) folders++
    else files.push(file)
  }
  return { files, folders }
}
