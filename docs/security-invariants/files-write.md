# Security invariants: Files: changes

Part of the [security invariants](README.md): creating, saving pasted images, uploading, finding, searching, deleting, staging, renaming, image uploads, and the palette and windows that open files.

- **Command palette and app shortcuts** (`pwa/src/components/command-palette.tsx`,
  `shortcuts-section.tsx`, `pwa/src/utils/shortcuts.ts`, `app-commands.ts`,
  `pwa/src/hooks/use-shortcuts.ts`; desktop only: `(pointer: fine)` and not the phone layout):
  no server change and no route of its own. Files are found through `GET files/find` with the
  Files store's `root` (a 409 moves the store to the pane's root and searches again), and open
  through the same store as the tree. The keys the user set are kept in `localStorage`
  `termote-shortcuts` (`{v:1, keys:{<command id>:{key, inTerminal}}}`, one per browser like
  `termote-settings`, kept after signing out: it holds command ids and key names only, nothing
  of a server). Read back, an id is kept only when it is in the static list of command ids
  (`Object.hasOwn`, so `__proto__` and the like are dropped), a key only when it parses, holds
  Ctrl or Meta (or is F1-F12) and is not one the browser, the editor (Mod+S), the terminal
  (Ctrl+Shift+C, Ctrl+Shift+V) or text editing (Mod+A/C/V/X/Z) keeps; nothing is written back on reading. One
  listener on `window` (bubble phase, after the focused element's own handlers) runs a command:
  never from a dialog, menu or `inert` content (its key is only kept from the browser there),
  and in the terminal only a command marked to run there, which only a key xterm sends nothing
  for and the terminal does not use can be (Ctrl+Shift+letter but C and V; on Apple Cmd with a
  letter, digit or punctuation key, without Ctrl): no key the program in the pane would get is
  taken. A sensitive file shown (`reveal`) is not written to the files opened lately when its
  tab opens it again. An agent's command (`/name`, a Codex skill `$name`) is put in front of the
  Chat draft, or typed into the terminal without Enter only when the pane's command is that
  agent; nothing is sent, and a view-only client gets neither. A prompt template (the `Template:`
  entries, `caps.templates`) is filled in, then put in the Chat draft where the caret was, never
  sent nor typed into the terminal; disabled for a view-only client and a pane without the Chat
  composer. Tab, pane, file and template names are shown through `visibleUnsafe`
- **Focus windows and file links** (`pwa/src/utils/deep-link.ts`, `focus-mode.ts`,
  `open-window.ts`, `App.tsx`; desktop only for the action): no server change and no route of its
  own; the link is a hash, which never reaches the server. `file` and `orig` are dropped as a bad
  file (one short notice, "File not found or not allowed") when empty, absolute (`/`, a drive), or
  holding a backslash, NUL or an empty, `.` or `..` segment; otherwise the path is only a hint,
  opened through the Files store's `follow` (`GET files/tree` of its parent) or the Changes list
  (the side must be one git lists), so `os.Root`, the deny lists and `reveal` apply as to any
  other file. A failure shows the same notice, never the path or the server's text. A link only
  selects: it never sends keys, creates or closes anything. A focus window (`solo=1`, read once
  when the page loads) reads and writes none of the `files-persist.ts` records, nor the tab
  selection, tab metadata or sidebar folding, and sweeps nothing (this device's preferences, such
  as settings, theme, font size, keys and command history, are still saved); signing out from it
  still removes everything. It offers no new window of its own and no tab or pane to switch to
  (the palette's `@` rows are disabled), so it never leaves its target. **Open in new window** keeps the new window's `opener` (this app's own
  page); **Open in main window** drives an opener only when reading its `location.origin` works
  and equals this one, else it opens a new window. A stream closed with 4001 (evicted) shows
  `Disconnected by a newer window` and reconnects only when asked, each pane of Herdr's layout
  view on its own
- **Creating a file** (`POST files/create?root=`, `server/files_create.go`): an empty file (an
  empty directory with `dir: true`: New folder of the Files menus) and the directories missing
  above it (0666/0777 under the umask; directories made before a later
  failure stay, as with `mkdir -p`); the text then goes through `PUT files/content`. Same guards
  as a save (`writeGuard`, the handler's cross-site check, `requireWriteRole`, `root` required:
  400, 409 once it moved); the body (`{path, reveal, dir}`, 8 KB) is read first, and its read deadline
  stays 60s; 201 `{root, path}`. The name is checked
  before the disk is touched (400 `invalid_name`): no empty component, at most 32 components and
  1024 bytes, 255 a component, none ending in a dot or a space, no control character, no
  `<>:"|?*` on Windows, not a temporary file's name (`.termote-edit-`, `.termote-rename-` or
  `.termote-upload-<16 hex>`, `tempName`), then `cleanRelPath`. Deny dirs, `.git`/the git dir and the
  write-only deny list → 403 `not_allowed`; a sensitive name needs `reveal: true` (403
  `sensitive`; the PWA asks once, then opens the editor without a Show). One lock per root, taken
  before one of the 2 write slots shared with saves (429 `busy`), so a create waiting on another
  holds no slot a save could use; each
  directory is opened from the one before (`Lstat`, `Mkdir` when missing, `OpenRoot`, then
  `SameFile` with what was checked): a symlink, a Windows junction (Go reports it irregular) or a
  directory swapped in → 403 `symlink`, a
  parent that is a file → 409 `not_directory`, EACCES → 403 `permission`, EROFS (Windows
  `ERROR_WRITE_PROTECT`) → 403 `read_only`, ENOSPC/EDQUOT (Windows disk full or quota) → 507
  `storage_full` (as uploads); each directory is
  checked against the deny lists again once it exists, before anything is made inside it (an 8.3
  name or a junction is only caught there). The file is opened `O_CREATE|O_EXCL` on its parent's
  handle, a directory made with `Mkdir` on it, after every check above (a `dir` create skips
  none): anything there, a dangling symlink included → 409 `exists` with the cleaned `path`
  (`/`-separated; Open it opens that), never replaced. A reply after the box was closed opens
  nothing, the tree is only read again. A create
  drops the root's cached git status. Accepted risk: a new file can be one another tool trusts
  or runs (`.claude/settings.local.json`, `.claude/commands/*.md`, `.vscode/tasks.json`,
  `.github/workflows/*`, a systemd/launchd unit when the root is the home dir); a signed-in user
  has a shell anyway, and a view-only client gets 403 `view_only` for creates as well as saves.
  The root's lock is keyed `root + "\x01create"`: `"\x00create"` was the key of a file named
  `create` at the root, and a delete takes both
- **Files menus** (`pwa/src/components/file-actions-menu.tsx`, `pwa/src/utils/file-paths.ts`): a
  right click on a tree row, the tree, a file tab or a Changes row opens the app's menu
  (`preventDefault`, so `context-menu-guard.ts` leaves it). Copied and typed paths are built in the
  PWA from the `root` and `dir` the tree route returned and the tree path; nothing goes back to the
  server, and no new route exists. **Insert @path in terminal** sends text into the pane (a
  bracketed paste where the program asked for one, no Enter), so it is offered only to a full
  client: `App` gives views no `insertText` when view-only. A name may hold any byte but NUL, and
  a pane that takes no bracketed paste runs what follows a line break: a path with a C0/C1 control
  character, DEL or `"` (which would end `@"…"`) is never typed (`pasteable`), only refused with a
  toast. The pane's directory a relative `@path` starts from is read at that moment
  (`paneDirNow`, `files/tree?now=1` with the root shown; a moved root or a failed read types the
  absolute path), never one kept from an earlier read. New file, New folder, Upload, Download, Rename and Delete go
  through their own routes and dialogs above, offered by the same role checks as their buttons;
  a view-only client sees the copies, Refresh and Collapse all only
- **Pasting an image into Markdown** (`POST files/image?root=&dir=[&reveal=1]`,
  `server/files_image.go`): an image pasted into a `.md`/`.mdx` file being edited becomes a new
  file next to it. Raw `image/png|jpeg|gif|webp` body (never SVG, never multipart: `writeGuard`
  takes these types on this path and uploads only, anything else → 415 `unsupported_image`).
  Order, as a save and a create: `root` required (400), then the handler's cross-site check,
  `requireWriteRole` (403 `view_only`) and the root still the pane's (409), `dir` checked (400
  `invalid_name`: `.` for the root, else `validPathShape`, no `\`, then `cleanRelPath`), a
  `Content-Length` over 10 MB → 413 `too_large` unread, then one of the 2 write slots shared with
  saves, creates, deletes, renames and restores (429 `busy`; held while the body streams), then the read deadline grows to 5
  minutes and the body is capped at 10 MB (`MaxBytesReader`). The first 512 bytes must be the
  declared type (415); the image's pixels are counted with `imageType` as it is written (over 40 MP
  → 413 `too_many_pixels`, not an image → 415), the rest streamed to disk, never held whole. The
  directory is walked as a create walks it, without making any (`walkParents`: a symlink or
  junction → 403 `symlink`, deny dirs and the git dir → 403 `not_allowed`, missing → 404
  `not_found`);
  `dir/assets` is used when it is a real directory (a link, a file or nothing there → `dir` itself,
  never through the link), checked against the deny lists too. The server names the file
  (`pasted-YYYYMMDD-HHMMSS.<ext>`, then `-2` … `-99`, then 409 `exists`; the client's name is
  never read) and opens it `O_CREATE|O_EXCL` on the directory's handle: nothing is ever replaced,
  and there is no temporary name or rename. A sensitive path (`.ssh/…`) needs `reveal=1` (403
  `sensitive`). The root's lock (`rootLockKey`) is held only while the name is chosen and opened,
  never while the body streams; a failure after the open (a body cut short, over the cap, not an
  image, a disk error: a write error is kept apart from the body's, so a full disk is 507
  `storage_full`, and a body error is checked even when the GIF count took it for the file's end)
  removes the file by name through the same directory handle (a local process renaming it and
  making another of that name meanwhile would lose that one: accepted). A file being written can be
  read half-written by another tool. 201 `{root, path}` (`/`-separated); the root's cached git
  status is dropped. Accepted risk: no quota and no sweep (unlike uploads), at most 10 MB per
  request and 2 at a time, since the file is the user's own in their repo, as a save is. No caps
  flag: the PWA offers it where Edit is offered
- **Uploading a file** (`POST files/upload?root=&dir=&name=[&reveal=1][&check=1]`,
  `server/files_upload.go`; PWA `hooks/use-file-uploads.ts`, `utils/upload-file.ts`): a file from
  the device (the Upload button, a drop on Files, a paste of files in the tree) becomes a new file
  in a folder of the root, any type, 0 bytes allowed, never sniffed. The body is raw
  `application/octet-stream` only (`writeGuard`, above: any other type → 415 `unsupported_type`);
  `check=1` is a JSON write like any other and its body is never read. Order: POST only (405),
  `root` required (400), the handler's cross-site check, `requireWriteRole` (403 `view_only`), the
  root still the pane's (409) or the Place's (403 `place_moved`, 404 `unknown_place`), `dir` as
  `files/image` checks it (`imageDir`, 400 `invalid_name`), then `name` (`validUploadName`, 400
  `invalid_name`): exactly one component on every OS (no `/`, no `\`, `filepath.IsLocal`,
  `Base(name) == name`), a create's per-name rules (`validNamePart`: at most 255 bytes, no
  control character, not ending in a dot or a space, so never `.` or `..`, and `<>:"|?*` on a
  Windows host), never a temporary file's name (`tempName`), no Windows device name on any OS
  (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹²³`, `LPT¹²³`, `CONIN$`,
  `CONOUT$`, with or without an extension: `CON.txt`), no format character (a bidi override or a
  zero-width space makes one name pose as another) and no U+FFFD or invalid UTF-8.
  - `check=1` runs every check that needs no body (the walk, the deny lists, sensitive, the name
    the upload would get now), creates nothing, takes no slot, and answers 200 `{root, path}` or
    the refusal; with no refusal, 429 `upload_busy` while another upload holds the slot (looked at
    only). The PWA always checks first: a refusal written before a large body is read reaches the
    browser as a reset connection (`net/http` stops reading past 256 KiB), not as its code. The
    upload checks everything again.
  - The upload: a `Content-Length` over 100 MiB (`maxUploadFileSize`, as `maxDownloadSize`) → 413
    `too_large` unread; one slot of its own (`uploadSlots`, capacity 1, never one of the 2 write
    slots of saves) else 429 `upload_busy` unread; the body capped at 100 MiB (`MaxBytesReader`,
    413); a read deadline of 2 minutes from each read that brought bytes and 30 minutes for the
    whole body (`idleReader`): a client that stops sending gets 408 `timeout` and frees the slot.
    The folder is walked as a create walks it, making none (`walkParents`: a symlink or junction
    → 403 `symlink`, deny dirs and the git dir → 403 `not_allowed`, missing → 404 `not_found`, a
    file on the way → 409 `not_directory`); the name is checked again before the body is read
    (deny lists, sensitive without `reveal=1` → 403 `sensitive`). `.termote-upload-<16 hex>`
    files over an hour old in that folder are swept (that exact form only), then the body streams
    into a new hidden `.termote-upload-<16 hex>` (`O_CREATE|O_EXCL`, 0666 under the umask), synced
    and closed; a disk error is kept apart from the body's (507 `storage_full`, 403 `read_only`,
    403 `permission`).
  - Only then, under the root's lock (`rootLockKey`, never held while the body streams), the
    first free name: `name`, then `stem (2)ext` … `stem (99)ext` (a dotfile with no other dot has
    no extension: `.env (2)`; the stem cut on a rune boundary to stay within 255 bytes; each one
    checked again: the name rules, the deny lists, sensitive), past 99 → 409 `exists`.
    `os.Root.Link(temp, name)` gives it the name (a hard link never replaces: a taken name moves
    on to the next), then the temp is removed. Where the file system has no hard links (`Link`
    fails with `ErrUnsupported`, `EPERM`, `ENOTSUP`, `EXDEV` or `ENOSYS`; on Windows
    `ERROR_INVALID_FUNCTION` or `ERROR_NOT_SUPPORTED`): the name is `Lstat`ed and, free, the temp
    renamed to it under the lock. Any failure removes the temp by its random name, never a name a
    user sees: a visible name only ever holds a whole file, and a server stopped mid-upload leaves
    only a hidden temp. 201 `{root, path}` (`path` names the file as saved); the root's cached git
    status is dropped; an `audit: upload path= size= by= via=` line.
  - Upload temps are refused as a name by every write (`tempName`) and are sensitive
    (`isSensitive`), as a save's: one a failed remove left shows in the tree as sensitive until
    the sweep, and one whose `Link` worked shares the visible file's inode, so it is swept only
    once that file went an hour unchanged. Accepted risks: on a file system without hard links
    (a FAT or exFAT stick on Windows too), a file another process makes under the same name
    between the `Lstat` and the rename is replaced, on Windows as on Unix (Go's `Root.Rename`
    replaces an existing file there, unless it is open without delete sharing), and so is a file
    a create makes through another root's lock (a Place inside the pane's root); the slot is one
    for the whole server, so a writer sending a byte just under every 2 minutes holds it up to 30
    minutes; an uploaded file is as trusted as one made with `files/create` (Windows runs a
    file by its extension, so an uploaded `.exe` or `.ps1` can be run like any file the user has;
    a writer has a shell anyway); no quota beyond 100 MiB a file and one at a time, writer role
    only.
  - The PWA sends one file at a time from a queue that outlives the Files view (switching to the
    terminal never stops it); each file keeps the pane, Place and root it was started for. It asks
    once per batch before a sensitive folder or name (`.ssh/…`, `.env`), naming the file, the
    folder and the root (Enter cancels; a no sends nothing of the batch and says nothing), waits on `upload_busy` (every 3 s, 150 s at most), and after every byte went checks
    a lost answer by reading the folder (the name and the size). Drops are taken in the capture
    phase on the whole Files view: the browser never navigates to a dropped file, and the editor
    never inserts its text. A view-only device has no Upload button and no paste, and a drop only
    tells it so
- **Finding a file** (`GET files/find?q=&root=&ignored=1&exclude=…&fresh=1`,
  `server/files_find.go`): the GET guards of the other files routes; only names are sent, as
  the tree does. `q` is trimmed, 1–256 bytes; `exclude` (repeated) is at most 50 directory
  names of at most 255 bytes, never `.`/`..` nor holding `/ \` NUL `* ? [` (400
  `invalid_exclude`), compared without case on Windows/macOS. In a repo the list is
  `git ls-files -co --exclude-standard --deduplicate -z` less `ls-files -d` (files gone from the
  disk) and less what git lists as a directory (a nested repo, a submodule); a view-only client's
  is `git ls-files -c --deduplicate -z` (tracked files only), cached apart. Tracked files are
  never filtered by `exclude`. `ignored=1` adds `git ls-files -o -i --exclude-standard
  --directory -z`, read and cached apart: a path with an excluded component is dropped unread,
  a directory git names whole is walked through `os.Root` without entering an excluded name at
  any depth. Outside a repo the root is walked the same way. A walk never enters a symlinked
  directory or a junction (irregular), lists a symlink only when `os.Root` stats it as a file,
  and is bounded per list: 200 000 paths, 32 levels, 5 s, git output 16 MiB → `incomplete`.
  Building a list drops `.git` components and paths under a deny dir or the git dir by name;
  the ranked results then pass `f.denied` (through symlinks) and an `Lstat` (gone or a directory
  → dropped) until 200 are kept (`truncated` past that). git runs as `heavy` with `noBackoff`: a
  timeout answers 503 but never makes Changes back off. Lists are built under
  `context.WithoutCancel` (the PWA aborts the previous request at each key), cached 30 s per
  root + `SafeDir` + kind (+ the sorted excludes; a failure is not kept), dropped by `forgetRoot` on a save, a create, a
  delete and a restore, by `fresh=1` (the PWA's refresh), and at a search that finds the list's stamp changed
  (`server/files_find_stamp.go`): the times of the directories it was read from (the root, every directory a walk
  read or above a listed file; at most 20 000, past that only the 30 s end it) and of the repo's index, taken
  after the build; a directory gone, no longer a directory or of another time, or the index of another time or
  unreadable, is a change, and a time from 2 s before the build to 2 s after the stamp makes the first check one
  too (a time far ahead is only compared). A stamp is checked at most once a second, by one request at a time
  (the others wait for its answer), and only the finished list read is then dropped (`ttlCache.forgetIf`): a build in
  flight is joined, never restarted. The stamp is server-side `Stat`s of what the list was built from (`os.Root`
  for directories), never a path from the client; a view-only client's request rebuilds only for such a
  change, never for its `fresh=1`
- **Searching file contents** (`GET files/search?q=&root=&case=1&word=1&regex=1&files=…&skip=…&exclude=…&fresh=1`,
  `server/files_search.go`, `server/files_search_glob.go`): the GET guards of the other files
  routes. `q` is 1–256 bytes, never trimmed. `files`/`skip` (repeated) are at most 20 globs
  each, of at most 255 bytes, no NUL or `\`, at most 4 `**` (400 `invalid_glob`), matched by
  dynamic programming over (pattern part, path component), so a `**` pattern costs parts ×
  depth `path.Match` calls; `exclude` is Find's (same parser, 400 `invalid_exclude`). The
  pattern is Go `regexp` (RE2): a regex is parsed alone before any wrapping (whole word, case),
  so wrapping never makes an invalid one valid, and a program past `searchMaxProg` (1000)
  instructions is refused; every failure is 400 `invalid_regex` with a generic message, never
  Go's text. A regex that can match empty text (`a*`, `^`, `x*|foo`) is 400 `empty_match`: its
  non-empty matches would take a scan of the line per position. RE2 costs input × program size,
  so a line is matched on its first 16 KiB only (a cut line → `incomplete`), once to tell whether
  it matches; its other matches are looked for in the 240-rune window sent, at most 240 of
  them, never in the whole line (no search costs a scan of the line per match). There is no
  whole-file search: the deadline is checked before each line, so a scan overruns its budget by
  at most one line's search. Nothing reaches git
  argv: a query starting with `-` is text. The list is Find's (`findLists`, the same cache key
  with the PWA's excludes; a view-only client searches its `req.view`, tracked files only, and
  `fresh=1` is ignored for it), sorted by path. Per file, before anything is
  opened: the `files`/`skip` globs, matched within the scan's deadline (checked every 64 paths,
  a client leaving stops them too); under a root holding a home dir (`holdsHome`) every
  dot-path is skipped (`skipped.hidden`: shell histories hold secrets under ordinary names);
  then one `EvalSymlinks` shared by `deniedPaths` (deny dirs, the git dir, `.git` parts, on
  both paths), the view-only target check (where a link leads must be listed), the dot-path
  rule on where a link leads (a link of an ordinary name to `.bash_history`; for a link into another
  work tree, its path in that work tree, checked before it is opened) and
  `isSensitive` on both paths (never opened, `skipped.sensitive`). Only then `os.Root`
  `OpenFile` with `openNonblock`, and every check on the handle (`readTextFile`, shared with
  content): regular, at most 1 MiB (`skipped.tooLarge`), a NUL in the first 8 KiB stops the read
  (`skipped.binary`), not UTF-8 → `skipped.binary`. Caps: 2000 matching lines (`truncated`), 100
  per file (`more`), 256 MiB read and 5 s from the scan's start, kept 500 ms short of the
  request deadline (`incomplete`: answered with what was found, never an empty body), 2 scans
  server-wide without waiting (429 `busy`; a view-only client never takes the last free one,
  `takeSlot`), 4 workers at most 8 files ahead of the merge.
  A client that leaves gets nothing written; the response ends once every worker has (each
  stops at its next line, or when a read returns), and the slot is freed after that. No git runs beyond Find's `ls-files`. Matches are sent as a window
  of 240 runes of the line with UTF-16 ranges; Go's `\b` is ASCII only
- **Deleting a file** (`POST files/delete?root=`, `POST files/restore?root=`,
  `server/files_delete.go`, `server/files_trash*.go`): the guards of a create (`writeGuard`, the
  handler's cross-site check, `requireWriteRole`, `root` required), body read first (8 KB);
  then the root's lock, the file's lock (shared with saves) and a write slot without waiting
  (429 `busy`), then the trash's mutex: a save takes its slot before the file's lock, but a
  delete never waits on a slot, so they never wait on each other. Delete body
  `{path, kind: file|dir, baseHash, reveal, permanent}`: `.`/`""` → 400 `invalid_path`, the
  create's deny lists → 403 `not_allowed`, a sensitive name without `reveal` → 403 `sensitive`;
  the parents are opened one at a time without making any (a symlink, a junction or a swapped
  directory → 403 `symlink`, a missing one 404). A file must be regular (409 `not_file`), the
  one opened (`SameFile`), one link (409 `hardlink`), the server user's (403 `permission`), and
  its sha256 (streamed, at most 512 MiB, else 413 `too_large`) must equal `baseHash` (409
  `changed`). A record `<32 hex>.json` (`{root, path, kind, deletedAt, size, mode[, after]}`, `.part`
  0600 `O_EXCL` then rename) is written, then the file is renamed into
  `os.UserCacheDir()/termote/trash/<32 hex>` (0700, refused when a symlink or another user's →
  503 `trash_unavailable`, `Caps.trash` false) by directory descriptors (`renameat2`
  `RENAME_NOREPLACE`, `renameatx_np` `RENAME_EXCL`, else `linkat` + `unlinkat`; Windows
  `MoveFileEx` without `MOVEFILE_REPLACE_EXISTING` on paths checked first, an accepted gap: a
  writer of the root who is the server's own user has a shell anyway, and a root another Windows
  account can write is not supported, since that account can swap a junction in between the check
  and the move and redirect it, or a permanent delete's `DeleteFile`, to a folder of its choice); what landed must be the file checked, or it
  goes back (never replacing) and 409 `changed` (with `trashId` when its name was taken again
  meanwhile). `EXDEV`/`ERROR_NOT_SAME_DEVICE` (WSL `/mnt/c`, a volume, the container's
  `/workspace` bind mount): 409 `cross_device`, nothing deleted, unless `permanent: true` (the
  PWA asks a second time): then the file is checked again (`SameFile`) and unlinked by
  descriptor, 200 `{permanent: true}`; `permanent` never skips a trash that works. An empty
  directory is removed by `unlinkat(AT_REMOVEDIR)`/`RemoveDirectory` (a file swapped in →
  409 `changed`; entries → 409 `not_empty`) after its record; the root never. Never
  `os.Root.Remove`, which unlinks before trying rmdir. Restore `{trashId, reveal}`: a 32-hex id
  (400), its record (404 `not_in_trash`), the record's root (409 with the root), its path
  checked as a create's but not its name (`a.` must come back), parents made, then renamed back
  never replacing (409 `exists` with `path`; `cross_device`), with one controlled exception: a
  record of `kind: discard` (below) replaces the file, and only while it still holds exactly what
  the discard left; the trash's mutex is held from
  reading the record again to removing it. The sweep (at start and before every delete) ages an
  entry by `deletedAt` only, never the mtime a rename keeps: 7 days, then the oldest past 1 GiB,
  never one younger than an hour; names left half done (a payload or a record alone, a `.part`)
  go 10 minutes after the sweep first sees them; a payload that is the restored file itself (a
  `linkat` restore that died) is only unlinked; only `^[0-9a-f]{32}(\.json(\.part)?)?$` names
  are removed, never through a directory or a symlink; a `discard` record without its payload is
  swept like a `file` one. `GET files/content?hash=1` answers
  `{root, path, size, hash}` with no text for any regular file (no `hash` past 512 MiB), even a
  sensitive one not revealed, so deleting a `.env` never sends its secret to the browser
  (accepted risk: a short secret's hash can be guessed by a signed-in user, who has a shell);
  it takes one of the 4 `files/raw` slots (429 `busy`). `termote uninstall` keeps the trash
  (the user's files) and says where; `--purge` removes it. A view-only client gets 403 `view_only`
  for deletes and restores, and `content?hash=1`.
  The root's trash (`GET files/trash?root=`, `POST files/trash/delete?root=`,
  `POST files/trash/empty?root=`, `server/files_trash_list.go`): full clients only, the list
  too (403 `view_only`: it names files a view-only client may not read), `root` required (400,
  never the trash of a directory the pane moved to; a different one → 409 with the root), no
  trash → 503 `trash_unavailable`. The client sends only ids (`trashId`, `trashIds`, each
  `^[0-9a-f]{32}$`, else 400), never a path. Scope is the exact root: an entry whose record's
  `root` differs (deleted before a `cd`, or from a Place or repository holding this folder) is
  never listed or removed here, and a delete of one answers 404 `not_in_trash`, as for an id that
  is gone (not 409 like a restore, which needs the new root). The list holds no lock (a record
  is renamed into place whole, never changed): it reads every record, skips one past 7 days, a
  `file`/`discard` whose payload is missing or not a regular file, and a `file` whose `linkat`
  restore died, removes nothing, answers the 500 newest (`truncated`), with `sensitive` computed
  for those only, and takes one of the 4 `files/raw` slots (429 `busy`). A delete and an empty
  hold only the trash's mutex, for one id at a time, and take no write slot (they change nothing
  under the root): the record is read again under it and must name this root, the payload is
  removed first, only when `Lstat` says it is a regular file of the store (a symlink or a
  directory is left alone), and when that or the `Lstat` fails (not `ENOENT`) the record stays,
  so the entry is still listed: 500 for a delete (an access denied too, logged), counted in
  `failed` for an empty; a store that cannot be opened is 503 `trash_unavailable`. The list reads each record through the store's `os.Root`: on Windows a
  plain open shares no delete, and a restore removing that record meanwhile would fail unseen. Both ignore the one-hour
  `trashMinAge` (the user asked), but an empty (`{trashIds: [...]}`, 1–500, body 24 KB) removes
  only the ids sent, those the client listed, never one deleted since (another device's Undo);
  ids gone or of another root are skipped (`{removed, failed}`). A restore racing a delete of the
  same id rereads the record under the same mutex: exactly one wins, the other gets 404
  `not_in_trash`. `audit: trash-delete id=…` and `audit: trash-empty removed=… failed=…` (with
  `by`, `via`) never carry a path or a root
- **Staging and discarding a change** (`POST files/changes/apply?root=`,
  `server/files_git_apply.go`, `server/files_git_patch.go`): a file git status lists, or one hunk
  of its diff, is staged, unstaged or discarded. Guards in order: `writeGuard`, POST, `root`
  required, the handler's cross-site check, `requireWriteRole` (a view-only client gets 403
  `view_only`), the body (8 KB), then the action (`invalid_action`), a discard with no trash
  (503 `trash_unavailable`), the path (`.`/`""` → 400 `invalid_path`), the create's deny lists for
  `path` and for `orig` too (403 `not_allowed`), a root that is no repo (404 `not_changed`),
  and the root's lock, the file's lock and a write slot without waiting (429 `busy`), shared with
  saves and deletes. The root's cached status is dropped, then a fresh one is read. Body
  `{action: stage|unstage|discard, path, orig, hunk, baseHash, reveal, permanent}`: only a path
  (and `orig`) that status lists, on the side the action acts on (the index side for `unstage`),
  else 404 `not_changed`; a conflicted path or `orig` → 409 `conflict`, checked first because a
  conflict has no staged side. The status letter must be one of `MD?` for `stage`, `MADRC` for
  `unstage`, `MD?` for `discard`, and a discard refuses any entry whose index or worktree mode is
  `120000` or `160000` (a symlink, a submodule): 409 `unsupported`. A sensitive name without
  `reveal` → 403 `sensitive`. Every read (status, `check-attr`, diff, the index version) comes
  before the first write.
  - **Filters.** A path (and `orig`) with any `filter` attribute other than unset or unspecified
    → 409 `filtered` (LFS, `git-crypt`): the filter drivers are off, so `git add` would stage what
    the clean filter should have turned into something else, and a driver set at the system level
    cannot even be seen. `git check-attr --stdin -z` takes names, not pathspecs.
  - **Whole file.** Stage is `git add -- :(literal)<path>`; unstage is `git restore --staged`
    (with `orig` for a rename, so both sides go back), or `git reset -q` when there is no commit
    yet (`rev-parse --verify HEAD` exits 1). Every path is a `:(literal)` pathspec.
  - **One hunk** (`hunk` is an id, never text). `files/diff` gives a hunk an `id`, the sha256 of
    its header and lines as git printed them, only when the side is a change in place (`M`, no
    rename or copy, a regular file, the same mode on both sides, not binary, not truncated) and
    git's `---`/`+++` lines name the path itself (`hunkHeadOK`); else no `id`, and an apply
    by hunk → 409 `hunk_unsupported`. The diff runs with fixed `--src-prefix=a/ --dst-prefix=b/`,
    whatever `diff.noprefix` the user set. An apply takes the diff again and finds the id in it:
    not found → 409 `stale_hunk`. The patch is built by the server: the `diff --git`, `---` and
    `+++` lines are written from the path, always C-quoted (`quoteC`), never copied from git's
    output, and there is no `index` line; then the hunk, as git printed it. It goes to
    `git -c apply.ignoreWhitespace=no apply --cached -p1 --whitespace=nowarn` (`-R` to unstage) on
    **stdin**, never as a file or argv: only the index is written. Any git failure → 409
    `stale_hunk`. A name with `\r` or `\n` needs no 400: `cat-file` gets the name in argv, not
    stdin.
  - **Discard** writes the worktree, which git never does here. Untracked (`?`): the delete
    route's code (`deleteFileLocked`, kind `file`, `baseHash` required, `permanent` as for a
    delete: `cross_device` and its record), so it is one entry in the trash. Deleted (`D`): the
    file is made again from the index (`recreate`: the parents made as a create makes them,
    `O_EXCL`, never over a file that came back → 409 `changed`; 0644 or 0755 from the index mode,
    set on the handle). Changed (`M`), whole file: `baseHash` required (400), the file is
    opened as a save opens it (`openEditDir`, `readEditTarget`: no symlink on the way, a regular
    file, one link, the server user's, at most 1 MiB: 422 `not_editable` with `reason`, 403
    `permission`, 413 `too_large`; a binary file is discarded whole too), its sha256 must equal
    `baseHash` (409 `changed`); the new text is the index version. A copy of what it replaces is
    kept first (`keepCopy`: payload `O_EXCL` 0600, then the record `{kind: discard, mode, after}`,
    `after` the sha256 of the new text), then `replaceFile` writes it. That write narrows the race
    with another writer as a save does, and does not close it. If the write fails the entry is
    removed. Changed, one hunk: not `M` → 409 `hunk_unsupported`; the hunk is undone **in Go**
    (`reverseHunk`) on the bytes just read, not with `git apply -R`, because `apply` writes the
    worktree through paths, filters and `core.autocrlf` this server does not control, and the
    save's checks and `replaceFile` must be the only writer. Each line is compared (one trailing
    `\r` ignored, written with the file's own line break); any line that differs, a count or a
    missing newline that does not fit → 409 `stale_hunk`, nothing is guessed. The response has
    `{root, path, trashId[, permanent]}`.
  - **Restore** of a discard (`files/restore`, `restoreDiscard`) is the one restore that
    replaces a file. Under the restore's locks it reads the file as a save does and puts the copy
    back only when the file's sha256 equals the record's `after`; a directory on the way gone or
    turned into a file or a symlink, a missing, oversize, hard-linked or non-regular file, or any
    other hash → 409 `changed`, the file and the entry stay. The payload is opened with
    `os.Open` like the record (the store is private), at most 1 MiB, written by `replaceFile`
    with the recorded mode, then the entry goes.
  - **Size.** An index version is read at most 1 MiB (`too_large` 413): `cat-file -s` first, and
    nothing is read when it is larger; then `cat-file --filters` with the same limit, because the
    line breaks can make it grow (cut → 413 `too_large`). The save's own checks apply to the
    worktree file.
  - **Index writes** (`gitCall.write`: `add`, `apply --cached`, `restore --staged`, `reset`) do
    not end with the request (`context.WithoutCancel`): a half-finished index is worse than one
    that took a moment. They run under a 30 s timeout and, on Unix, are interrupted (SIGINT)
    rather than killed, so git removes its own `index.lock`. On Windows the process is killed
    after 30 s: an accepted risk, a stale `index.lock` may stay. They take a git slot (no
    backoff) like the diff. `index.lock` in git's message → 409 `index_locked`. Git's own text is
    logged, never returned; every other failure is a `codedError` or a generic 500. The root's
    caches are dropped (`forgetRoot`) before the status and after the write, so Changes reads the
    new state; the PWA refetches.
- **Renaming a file** (`POST files/rename?root=`, `server/files_rename.go`): a regular file moved
  to a new path under the same root (a rename, or a move whose missing directories are made, and
  stay if a later step fails, as with `mkdir -p`); never a directory. The guards of a create
  (`writeGuard`, the handler's cross-site check, `requireWriteRole`: a view-only client gets 403
  `view_only`; `root` required: 400, 409 once it moved), body `{path, newPath, reveal}` read
  first (8 KB) → 200 `{root, path}` (the cleaned new path); no trash needed (`caps.trash` off
  still renames). The source is checked as a delete's: `.`/`""` → 400 `invalid_path`, the deny
  lists → 403 `not_allowed`, parents opened one at a time without making any (a symlink, a
  junction or a swapped directory → 403 `symlink`, missing → 404), a regular file (409
  `not_file`, a symlink 403 `symlink`) owned by the server user (`fileOwnedByServer`, Unix; 403
  `permission`); never opened, never hashed, any number of hard links. The new path:
  `validRenameTarget` (a create's shape rules; its per-name rules only for the new base name and
  for each directory the walk has to make, so a file inside an existing directory whose name ends in a space can
  still be renamed; never a `.termote-edit-`/`.termote-rename-`/`.termote-upload-<16 hex>` name) → 400
  `invalid_name`, the deny lists → 403 `not_allowed`, missing parents made and checked again as
  a create's. A sensitive name on either side needs `reveal: true` (403 `sensitive`). Locks: the
  root's lock, both files' locks (shared with saves) in the order of their keys, one write slot
  without waiting (429 `busy`). The same path → 200, nothing done (after the source is checked);
  only the directories' case differing on a file system that ignores it → 200 with the source
  path. Never replaces: `renameat2 RENAME_NOREPLACE` / `renameatx_np RENAME_EXCL` /
  `MoveFileEx` without `MOVEFILE_REPLACE_EXISTING`; anything at the new path, a dangling symlink
  included, → 409 `exists` with `path`. A file system without the flag takes
  `linkCheckUnlink`: `linkat`, then the old name is unlinked only while it is still the file
  checked (an agent's write-then-rename over it in between is kept: the new link is removed, 409
  `changed`; accepted gap: a replacement between that check and the unlink). A new name differing
  only in case from the file itself (`SameFile` and `strings.EqualFold`) moves in two no-replace
  steps through `.termote-rename-<16 hex>` (never swept, a sensitive name); `SameFile` otherwise
  (another hard link, a name differing only in Unicode normalization) → 409 `exists`, nothing
  moved. What landed must be the file checked, or it goes back (never replacing) and 409
  `changed`; if it cannot go back, 409 `changed` with `path` (where it is now). `EXDEV` /
  `ERROR_NOT_SAME_DEVICE` → 409 `cross_device`, nothing moved, never a copy. Windows: a file
  another program holds open (`ERROR_SHARING_VIOLATION`/`ERROR_LOCK_VIOLATION`) → 409 `in_use`.
  OS errors as a create's (403 `permission`, 403 `read_only`, 507 `storage_full`). A rename drops
  the root's cached git status and file lists (`forgetRoot`); Changes shows a deleted and an
  untracked file until the user stages, as with `mv`. The PWA moves every tab, draft and Changes
  editor of the old path, in every pane of the root, to the new one, never onto a draft with
  unsaved changes (refused before sending), and offers Undo (a second rename, not offered when
  the old name fails those name rules)
- **Image uploads** (`POST /api/mux/uploads`): the PWA sends an image so an agent can read it by
  path (the host clipboard is empty when the image sits on a phone). Same auth, Host allowlist,
  `Sec-Fetch-Site`/`Origin` check and `requireWriteRole` as every write; the body is a raw
  `image/png|jpeg|gif|webp` (`writeGuard` takes these types on this path and `files/image` only: `image/*` is not
  CORS-safelisted, so another site still needs the preflight; multipart stays 415, since a form
  posts it without one). At most 10 MB (a larger `Content-Length` is refused unread); once
  authenticated and given a slot its read deadline grows to 5 minutes; the type is read
  from the first bytes and must equal the declared one; the name is random (`<32 hex>.<ext>`,
  the client's name is never read), written to a `.part` (0600, `O_EXCL`) then renamed, in
  `os.UserCacheDir()/termote/uploads` (`serveConfig.UploadDir`, set by `serve`): created 0700,
  refused when a symlink or (Unix) owned by another user, and then uploads answer 503
  `uploads_unavailable`. 2 uploads at a time (429 `busy`); 10 MB is reserved against a 200 MB
  quota before writing (507 `storage_full`); files older than 7 days go, then the oldest when
  over quota, never one younger than an hour; only the store's own names are ever deleted.
  Errors carry a JSON `code`. The Chat view sends the returned ids in `agent/message` (see
  Agent chat in [`agent-chat.md`](agent-chat.md)). `Caps.uploads` tells the PWA (snapshot); a view-only client
  gets 403 `view_only`. The container
  creates `/home/termote/.cache` and `/home/termote/.config` mode 1777 so the host uid can
  create its upload dir and the generated password's file (kept out of the log: where that file
  cannot be written, the entrypoint stops with an error and never prints the password). The store is
  never served by the Files view, even when a pane's root holds it
