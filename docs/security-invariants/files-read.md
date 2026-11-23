# Security invariants: Files: reading and previews

Part of the [security invariants](README.md): Files/Changes, Places, previews, the editor, state kept on the device, downloads and opening files on Windows.

- **Files/Changes** (`/api/mux/panes/{id}/files/*`): GETs that also check
  `Sec-Fetch-Site`/`Origin` (and the writes below; none is read-only any more, Changes included: `POST files/changes/apply` writes the index); every path is opened through `os.Root` under the pane's root (its
  git toplevel when a `.git` sits at it, else its directory) or a Place's (see Places); the server
  user's `~/.ssh` and `~/.gnupg` (in every root, a pane at `~` included), termote's config/state dirs, the
  upload store and the trash (a pane in the home dir would otherwise serve a deleted `.env` under
  its random name),
  `/proc`, `/sys`, `/dev`, `.git` and the repo's git dir (`--separate-git-dir`) are never served
  (on Linux a path differing only in case is denied when its directory is the same one: WSL
  `/mnt/c`, casefold, vfat);
  sensitive names (`.env`, keys, ...) return contents or a diff only with `reveal=1`.
  A path that leaves the root through a symlink (the path itself or a directory above it,
  `server/files_linked.go`) is read by `files/tree`, `files/content`, `files/raw` (the worktree
  file, never a `side`) and `files/document` (`rootFor`) only for a full client, only when it
  resolves inside another work tree of the root's own repository (`git worktree list --porcelain
  -z` through `gitRunner`, git 2.36 or later: an older git fails it, logged once, and no link is
  followed; bare entries, paths that do not resolve and work trees whose `.git` does
  not lead back to the shared git dir or a `worktrees/<name>` under it left out (`ownWorktrees`: git
  lists a work tree from that record, which can name any directory), the deepest work tree holding
  it), and only when that path is under no deny dir, the root's git dir, the shared
  git dir (`commonGitDir`) or a `.git` below that work tree (a link listed inside such a directory
  is checked the same way); it is opened through `os.Root` at that work tree by its resolved path,
  never by the link, so a swap stays in that work tree. Anything else, or a view-only client:
  refused as before (400 `path outside root`, view-only 404). Sensitive names are checked on the
  path and where it leads (`reveal`); a save, rename or delete never goes through it (`editable:
  false`, `symlink`; the write routes refuse a symlink on the way). Find's tracked and ignored
  lists (`server/files_find_linked.go`, never the view-only `committed` list nor its
  `files`/`dirs` index) add the files under an untracked symlink of the root (`git ls-files -o
  --directory`, at most `maxLinkedDirs` = 64) that leads to such a directory, listed by that work
  tree's own `git ls-files` (`:(literal)` pathspec, the `findCall` limits, `--exclude-standard`,
  `safe.directory` set to that work tree only when the root had one; an ignored ancestor git names
  whole is read as the linked directory only; ignored dirs walked through `os.Root` at that work
  tree; a link of an excluded name is not walked) and named under the link, within one
  `findMaxPaths` budget; a tracked symlink, or one inside an untracked directory, is not looked at.
  A git failure there only marks the list incomplete. `findResults` and the content search check
  each such path through `linkedTarget` (deny dirs, git dirs) and open it through `os.Root` at that
  work tree; a view-only client's `committed` list holds none, and its search never opens one. The
  list's stamp stats a directory under the link by its path (`stampStat`, its time only). The work
  trees are listed once per root every `filesRootTTL` (`worktreeRoots`). A Windows junction is not
  followed (Go reports it irregular): only a symlink is.
  The pane's root moves only once reads 2 s apart agree on it (`rootSettle`), except for
  `GET files/tree?now=1` (Refresh), which takes it from where the pane is now
  (`rootResolver.paneRootNow`): still the directory the backend reports, resolved by the server,
  never a path from the client; ignored with `place=` and on every other route. The settled root
  is the pane's, shared by every reader (Files, Changes, the overview's changes, agent commands)
  and every client, a view-only one included (it is set before `viewHidesRoot`, which still
  refuses that client the root): one Refresh moves it for all of them, only ever to the
  directory the pane reports, and plain reads settle it again as before. The settle state is kept
  per pane for as long as it lives: on tmux by its pane id and the server's pid, since a restarted
  server numbers its panes from `%0` again and a new pane must not start from an old one's root;
  on psmux, which numbers panes per session (two sessions both have `%1`) and hands out session ids
  out of order, by the session id, the pane id and the pane's pid (`PaneDir`). psmux finds a
  session's server through `<session>.port` in its data dir (`PSMUX_DATA_DIR`, else `.psmux` in the
  user's profile) and sends that port its key without checking who listens: while a server is gone
  and its file stays, another user could listen there and get the keys typed. So no psmux command or
  attach starts (`psmuxPorts`, `server/psmux_owner.go`, checked at most every 2 s; the log names
  the `.port` file to remove, the client gets 503 `psmux_port_taken`) while a recorded port is
  listened on by a process of another user than the server's, SYSTEM, LOCAL SERVICE or NETWORK
  SERVICE (`listenerOwnersOn`; a process whose token cannot be read counts as another
  user's); a free port or a missing data dir passes. What cannot be read refuses too (503
  `psmux_ports_unverified`, the reason in the log): a profile directory that cannot be read (with no
  `PSMUX_DATA_DIR`; psmux may still find one), a data dir that exists but cannot be listed, a
  `.port` file, the TCP table, or the server's own account while something listens on the port; `tcpTable` reads again with a buffer of what
  the table last needed plus half and 64 rows more, up to 5 times, so sockets opened between reads
  cannot make it give up and be taken for nothing listening. Not covered: a process that takes the
  port within those 2 s. psmux reports the
  foreground process's directory verbatim (`#`, `%`, non-ASCII and a UNC path are not expanded or
  changed) and refuses `:` in a session name, so the path, read last, stays whole (the line is
  split into at most 6 fields, so a `|` in a path the pane announced stays in it and the windows
  after it are kept). From psmux 3.4
  that path can be what the pane printed (OSC 7 / OSC 9;9 while `ssh.exe` or `wsl.exe` runs in it),
  so a remote host can name `\\host\share`: on Windows a pane's directory not on a drive letter (a
  drive path in the `\\?\` form is one; `\\?\UNC\` and `\\.\` are not) is refused, whatever the
  backend (`mayBeFromPaneOutput`: Herdr reports its process's directory, which may also have come
  from what the pane printed; 400 `directory not available`, as a directory that is gone) before
  anything stats it, unless it is inside a Place (`--allow-path`). The refusal (`refusesDir`) is in
  `rootResolver.resolve` itself on Windows, not only in the Files routes' `paneRootAt`, so every
  caller handing it a pane's directory goes through it before any `Lstat`, `Stat` or git: the
  worktree routes (`source`, `list` in `server/git_worktree_mux.go`), the snapshot's nesting by git
  (`gitNester` through `repoInfo`) and herdr-core's repository tops (`resolveTop`); a refused folder
  is outside any repository there. A symbolic link
  in a tree (a repository or an archive can hold one to `\\host\share`) is never followed off a
  drive letter: on Windows every path the Files routes resolve goes through `evalSymlinks`
  (`server/files_links_windows.go`), which reads each link on the way with `Lstat`/`Readlink`
  (the link itself, never its target) and refuses (`errRemoteLink`, the path kept as it is, as one
  that does not resolve) a link whose target, or a link that target leads through, is a UNC,
  `\\?\UNC\` or device path on another volume than the path started on (a Place the user named on
  a share keeps working, a link out of it to another share does not), before
  `filepath.EvalSymlinks` runs; `os.Root` refuses a link whose
  target starts with a separator, as every UNC one does.
  A repository's own files can make git open a share too, in every command it runs (`rev-parse`,
  `config`, `status`, `log`), and git cannot be asked first (`git config --no-includes` reads the
  repository's config, includes and all, as it starts). So on Windows, before any git command, in
  every directory git runs in and not only one `resolve` returned (`gitRunner.output` calls
  `checkRepoRoot`: blame through a link into another work tree, `worktree add` in the git dir, Find
  in a linked folder; the answer kept 2 s per directory, and forgotten as soon as termote writes
  under it, so a config include a discard restores is read by the next git, and every answer
  forgotten after a new worktree's checkout, which may write a file a repository's config includes),
  termote reads the
  repository git would find there (walking up, stopping only
  at a git dir git takes too, and trying a directory itself as a bare repository when its `.git`
  is no repository git takes, as git does) as text (`repoConfigRefused`, `server/git_repo_config.go`) and refuses
  it (400 `directory not available`, as a refused pane directory, the reason in the log only) when
  a `.git` file's `gitdir:`, its `commondir`, a line of `objects/info/alternates` (the lines of every file to depth 5, the repository's own
  at 0, as git looks at them; each objects directory read once, as git takes it once),
  a linked worktree's `gitdir` (the `worktrees` folder itself opened only once `realRepoDir` has
  checked the links on its way, as every other file it reads) or the `gitdir:` of the `.git` file that one names names a path off a
  drive letter outside the Places (the test `refusesDir` uses; a share, `\\?\UNC\`, `\\.\`, and an
  NT path `\??\UNC\` alike), or when `config`, `config.worktree` (the git dir's, and the common
  dir's too, which git run there reads) or any local file they include (followed
  10 deep; read only from a git dir holding a `HEAD`, as git reads them only from one) sets `include.path`, `includeIf.*.path`, `core.worktree`, `core.excludesFile`,
  `core.attributesFile`, `mailmap.file` or `diff.orderFile` to one (`:(optional)` read past). In a
  config value but `core.worktree` (`configPath`), one after git's `%(prefix)/` is checked as git uses it (an absolute
  path as written; a relative one is git's own install directory, not read), and one under `~/` is
  the user's home as git finds it (`HOME`, else `HOMEDRIVE` and `HOMEPATH`, else the profile), read
  like any local include (`~user/`, another user's home, is not read); a `gitdir:`, `commondir`,
  alternates line, worktree `gitdir` or `core.worktree` is read literally, as git reads it (`repoPath`). Its parser
  (`parseGitConfig`) takes git's syntax strictly, and a file it cannot parse or read, includes too
  deep, more than 256 config and alternates files read for one git dir (`repoFollowMax`: files that
  name each other many times over), or a link on the way off a drive (`evalSymlinks`) refuses the
  repository rather than passing it. The path a key that opens a file names is followed for such a link from every place a relative
  one starts (the config file's folder, the git dir, the directory git runs in, and the
  `core.worktree` that `config` or `config.worktree` sets: the last of each, the one git uses, and
  never one from an include, which git does not read for it); only a link off a drive refuses there, another error does not. Before a
  heavy git command (`gitCall.heavy`: status, `ls-files -o`, diff, find; git looks into every
  untracked folder for a nested repository, reading its `.git` file and the git dir it names, and
  nothing turns that off), `checkRepoTree` (`server/git_nested_repo.go`, kept and forgotten with
  the root's check) walks the whole work tree from its top, ignored folders too, never following a
  link to a folder nor looking inside a `.git` entry, and checks each nested repository as
  `checkGitDir` checks the repository; a work tree of more than 20000 folders (`repoTreeMaxDirs`)
  is refused as one off a drive. Elsewhere than Windows `repoConfigRefused` and `checkRepoTree`
  read nothing. Behind it, on Windows, `gitEntryTarget` refuses a `.git`
  file in a directory on a drive that names a git dir off one outside the Places
  (`gitfileOffDrive`, which reads the Places from `gitEntryPlaces`) before resolving it (a linked
  worktree's own `.git` file, read by `ownWorktree`), and the worktree list resolves each path with
  `evalSymlinks`.
  `GET files/content` takes an `encoding` of a fixed set (`utf-8`, `utf-16le`, `utf-16be`,
  `shift_jis`, `euc-jp`; another → 400, ignored by `?hash=1`) or detects one
  (`server/files_encoding.go`: a BOM, then valid UTF-8, then Shift-JIS/EUC-JP only when the
  bytes are valid in it and enough of the result is kana and kanji, a half-width katakana
  counting as kana only next to another; UTF-16 without a BOM is never guessed); its `hash` is
  the sha256 of the bytes read, never of the decoded text. A sensitive name without `reveal=1` is
  answered before anything is decoded; a read as another encoding than UTF-8, or one that
  detects the encoding of bytes not valid UTF-8, takes one of 2 server-wide slots (429 `busy`), of
  which a view-only client never takes the last free one (`takeSlot`); a UTF-8 read none. It reads at most 4 MiB (`maxViewSize`, past it `previewable: false`,
  `too-large`); a save, a discard, content search and a whole-file diff stay at 1 MiB
  (`maxPreviewSize`), so a file shown past that is `editable: false`, `notEditable: too-large`.
  A read past 1 MiB (by its size before the read, or the bytes read) takes one of 2 server-wide
  `largeReadSlots` (429 `busy`; a view-only client never takes the last free one, `takeSlot`), held until the answer is written under a 2-minute write deadline
  (its JSON escapes `<`, `>`, `&` and control bytes to six bytes each); a sensitive name not
  revealed takes none.
  The answer is gzipped when `Accept-Encoding` takes gzip (`jsonOKGzip`, `Vary: Accept-Encoding`):
  it holds a file's text and hash but no session token; a browser request from another site carries
  no session (`SameSite=Strict` cookies) or is refused by `Sec-Fetch-Site`/`Origin`, and the PWA
  reads a file again only when the user asks, so nothing makes the many requests a compression
  oracle (guessing a file's secret by the answer's length) needs.
  Content search and git diffs stay UTF-8 only. A repository git refuses for its owner ("dubious
  ownership") is read as a git repository (`safe.directory` set to its work tree) only when
  `trustRepo` trusts the work tree, its git dir and the work tree's `.git` entry alike: each owned by
  the server user (Unix), or inside the container's `/workspace` or a Place; the `.git` entry is
  checked before git runs with `safe.directory` (`trustGitEntry`), the git dir git names right
  after; anything else is browsed as a plain directory. git runs
  without a shell, with `GIT_*`/`TERMOTE_*` stripped, hooks (`core.hooksPath` to an empty
  directory termote owns, `<user cache dir>/termote/no-hooks` (`noHooksDir`: absolute, a real directory,
  empty, and on Unix 0700 and owned by the server user (`checkPrivateDir`), else no git runs at all,
  `errNoHooksDir`: Files browses the folder as a plain directory, as with no git, and the allow-path
  probe counts it as a git dir). Never the null device: Windows' `NUL` is relative, and git resolves a
  relative `core.hooksPath` against the worktree, where a repository can ship
  `NUL/post-index-change`. Neither reaches a hook defined in config: every `hook.<name>.*` the config
  lists, includes followed, gets `-c hook.<name>.enabled=false` on every command, looked up in
  the same `git config` call as the filter drivers. That call is cached per root for 2 s, except
  for a command that could run a filter or a hook (`noFilters`, `write`), which reads it afresh:
  an include can name a file a checkout has just written (a new worktree's branch), and a list
  read before it would leave that file's filter on. A name `-c` cannot carry (`=`, a line break)
  fails the command, `errUnsafeRepoConfig`, and a config git cannot read fails it with git's own
  error), index refresh on diff,
  fsmonitor, filter drivers, external diff and textconv off, `mailmap.file` and `mailmap.blob`
  emptied (blame opens the file wherever the repository's config points it; `log` also passes
  `--no-mailmap`; `diff.orderFile` cannot be emptied, git refuses an empty one, so only
  `repoConfigRefused` checks it), on Windows
  `core.excludesFile` and `core.attributesFile` emptied behind `repoConfigRefused` (`status` opens
  either wherever the repository's config points it; empty means no file, so the user's global
  ignore and attributes files no longer apply there, the repository's `.gitignore`,
  `.gitattributes` and `info/exclude` still do), and `core.symlinks=false` and
  `core.protectNTFS=true` whatever the repository sets (a new worktree's checkout writes a committed
  link as a file holding its target, so Git for Windows never looks a `\\host\share` target up),
  submodules ignored, 10s timeout, 2 at a time (a heavy command of a view-only client waits rather
  than take the last free slot, `waitSlot`, so view-only devices cannot hold both), and 1 at a
  time per root except a write; a
  `tryOnly` call (the overview's status, blame) answers busy while its root runs another, as when it
  would take the last slot (a command that writes the index runs under the
  same `-c` overrides but another timeout and cancellation: Staging and discarding a change in [`files-write.md`](files-write.md)); a call
  that waited for its root's slot checks the root's backoff again before it runs. git waits on
  opening a FIFO it reads as an ignore or attributes file until the timeout (git 2.34: every one
  below, and a `.gitignore` in any directory it walks), so on Linux and macOS a root is browsed as a
  plain directory, its git dir still denied, before any status, when one of these is a FIFO or a
  socket (`blockingGitFile`; `/dev/null`, a directory or a missing file pass, as git reads or skips
  them at once): the work tree's `.gitignore` and `.gitattributes`, not followed (git opens them
  without following a link), the shared git dir's `info/exclude` and `info/attributes` (a linked
  worktree reads those of its repository), and what `core.excludesFile` and `core.attributesFile`
  name, followed (read with `git config --type=path`, relative to the root); the user's global files
  still apply. Not looked for (not covered): a `.gitignore` or `.gitattributes` deeper in the tree
  (that is a walk of the tree), another file git opens that is a FIFO (`config` and its includes,
  `HEAD`, `index`, `packed-refs`, `shallow`, `info/sparse-checkout`, `objects/info/alternates`,
  `.gitmodules`, `.mailmap` for blame, what `diff.orderFile` names off Windows), and a root reached without `resolve` (Find and blame through
  a link into another worktree of the repository, a worktree's dirty check). Such a root's heavy git
  waits out the timeout holding one of the two slots, so other roots keep the other; a status then
  backs it off 30 s, while Find and a worktree's branch list (`noBackoff`) try again on the next
  request; two such roots can hold both slots.
  `files/raw` serves an image's bytes (Files: the worktree file, streamed from the open handle;
  Changes: `side=old|new` of an entry git status lists, picked like `diff`, never a client rev):
  the index is always `:0:<path>` (git reads `:1:a.png` as stage 1), `HEAD:<orig‖path>` for the
  staged old side, read by one `git cat-file --batch` (no filters, not `heavy`: no status/diff
  slot, no backoff; a name with `\r` or `\n` → 400, missing → 404 `no_version`, time out → 503). The type
  comes from the first bytes through `imageTypeOf` (shared with uploads: PNG/JPEG/GIF/WebP), plus
  SVG only for a `.svg` path whose first element is `<svg`; 10 MiB (413 `too_large`), 40 MP
  (PNG/JPEG header, a GIF's largest frame with its offset, a WebP's first chunk; 413
  `too_many_pixels`), else 415 `not_image`, a Git LFS pointer 415
  `lfs_pointer`, a sensitive name without `reveal=1` 403 `sensitive`. 4 at a time server-wide
  (429 `busy`), of which a view-only client never takes the last free one (`takeRawSlot`, through `takeSlot`;
  downloads and hashes, full only, share them), 2-minute write deadline, `Cross-Origin-Resource-Policy: same-origin`,
  `Cache-Control: no-store`; an SVG also gets a second CSP
  (`sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`) and
  `Content-Disposition: attachment`.
  The last commit (`files/commit`, `files/commit/diff`, `server/files_git_commit.go`) reads `HEAD`
  only: `rev-parse --verify --quiet HEAD^{commit}`, then `log -1` and `diff-tree` of that hash
  against its first parent (`--root` for a root commit), never a client rev. `commit/diff` takes
  the hash the client saw only to compare: another one than the current `HEAD` is 409
  `head_moved`, before any path reaches git. The path (and a rename's source) must be one that
  commit's `diff-tree` lists, under the same deny lists and `reveal=1` for a sensitive name, then
  goes in as `:(literal)` after `--`; a view-only client goes through `viewHides` with the path
  checked against the root's tracked list, as in Changes, and reads the diff only of a path in it:
  a file the commit deleted (or stopped tracking), a rename's source and a file removed from the
  index since the commit (`git rm --cached`, which only `HEAD` still holds) stay listed by name, but
  their diff is 404 as if missing (history is not what it may read); a full client reads them all. A commit's
  file list is kept 30 s per root and hash (a hash never changes what it names); a sensitive name
  is checked again when its diff is read. Message and author are shown with `visibleUnsafe`.
  Blame (`files/blame`, `server/files_git_blame.go`) is a read route (`begin`: `crossSiteRejection`,
  a view-only client allowed, through `viewHides` like `content`, `reveal=1` refused to it). The
  file is read like `content`'s: `cleanRelPath`, the deny lists, `rootFor` (a link into another
  work tree of the repository is followed, git then runs in that work tree with `safe.directory`
  set to it only when the root had one), opened through `os.Root`, a regular file of at most
  `maxPreviewSize` (1 MiB, else 413 `too_large`, no large-read slot), a sensitive name without
  `reveal=1` answers `{sensitive: true}` before the hash is compared. The client sends the sha256
  of the bytes it shows (`hash`, required, else 400); other bytes on disk are 409 `file_changed`.
  Those bytes go to `git blame --incremental --no-ignore-revs-file --no-textconv --contents - --
  <path>` on stdin, so git never opens the worktree path, and the path (where a symlink inside the
  root leads) only names the history to follow from `HEAD`: no client rev reaches git. `heavy`
  with `tryOnly` and `noBackoff`: it never takes the last free git slot nor waits for one (503
  `busy`), and a slow one never backs the root off, so one long history cannot hold up Changes.
  `noFilters`, output capped at 8 MiB (413 `too_large`). A request out of time is 503, never
  `not_tracked`; a failure for a path `HEAD` does not hold (`cat-file -e HEAD:./<path>`) is 404
  `not_tracked`, outside a repo 404 `not_repo`; any other git failure is logged only. Blame serves
  a Place that is its own repo (full role only, as every Place route); a file with a
  `working-tree-encoding` attribute whose lines git counts otherwise is a plain 500. The answer holds the line
  count, runs of lines per commit hash (the all-zero hash goes to `uncommitted`) and per commit
  only author name, author time and a summary cut at 512 bytes: no e-mail, no line text. git
  applies the repo's `.mailmap` to the author name (a read, nothing runs).
- **Branch since its base** (`GET files/branch?base=&root=`, `GET files/branch/diff?base=&path=&orig=&root=&reveal=`,
  `server/files_git_branch.go`): read only, through `f.begin` (`requireMethod(GET)`,
  `crossSiteRejection`, the pane's root, the view-only rules) and `gitRunner` only. `base` is a
  branch name checked as a worktree branch is (`validBranchName`: no `-` start, no `..`, no `@{`,
  never `HEAD`) and resolved with `rev-parse --verify --end-of-options`; every later git call gets
  only full hashes (the merge base and HEAD). Without `base`, the branch the repo's main worktree has
  checked out; detached, or the pane's own branch, answers `base_required`. A path must be one of
  the range's `--name-status` list (with its `orig` for a rename), then passes the deny lists, and a
  sensitive name answers `sensitive` without its text unless `reveal`; a view-only client sees only
  the files it could open, never a deleted file's or a rename source's text, and never reveals.
  Errors are codes (`invalid_base`, `base_not_found`, `base_required`, `no_merge_base`); git's text
  is logged only.
- **Places** (`--allow-path`, `server/cli_allow_path.go`, `server/files_places.go`): folders the
  operator names on the host with `termote start --allow-path <dir>` / `--remove-path <dir>`
  (saved like `--allow-host`, `TERMOTE_ALLOWED_PATHS` `:`-separated on Unix, refused by the Unix
  encoder when a path holds `:`; `AllowPath` in the Windows JSON) or `container up` (its own list).
  No route adds, removes or widens one: the client only picks one by an opaque id, `place=<id>`
  (the first 16 hex of the sha256 of the host path; the container passes the host ids), and an id
  not in the list is 404 `unknown_place`, never a path lookup. `validateAllowPath` refuses, on the
  path as typed and on its `EvalSymlinks` form: not a directory; a volume root, the home dir or one
  above it; a path at, inside or above `~/.ssh`, `~/.gnupg`, termote's config, state, data and cache
  dirs (the cache holds the trash and uploads), `/proc` `/sys` `/dev`, and on Unix the dirs holding
  the host's control sockets (`/tmp`, `/run`, `/var/run`, `$TMPDIR`, `$XDG_RUNTIME_DIR`: mounted in
  the container they would let a terminal drive the host's tmux or docker), and the user's own mux
  sockets elsewhere (`muxControlDirs`: Herdr's config dir `$XDG_CONFIG_HOME/herdr` or
  `~/.config/herdr`, which holds `herdr.sock`; herdr-core's state dir `$XDG_STATE_HOME/herdr-core`
  or `~/.local/state/herdr-core`; the folders of `$HERDR_SOCKET_PATH` and `$HC_SOCKET`;
  `$ZELLIJ_SOCKET_DIR`; `$TMUX_TMPDIR`; an absolute value only) (so `~/.config`,
  `~/.cache` and `~/.local` are refused, `~/.config/fish` is not); a
  component matching `isGitDirName`, or a dir git (through a `gitRunner` that checks the repository
  first as the server's does, `checkedGitRunner`) calls a git dir or a bare repo (a config whose
  hooks or filter drivers cannot be turned off, or a repository that check refuses, counts as one); a quote, line
  break or NUL; an unknown home (fails closed). `start` refuses a new path that
  fails (exit 2, nothing saved or stopped) and re-checks every saved one, printing a failing one as
  skipped with the `--remove-path` that drops it; `serve` checks each again against its own user and
  dirs and skips a failing one with a log line. Each request re-resolves the Place (1 s cache) and
  refuses one that leads elsewhere than when `serve` started (403 `place_moved`, logged). The root is
  the Place itself, never a repo around it (`isRepo` only when the git toplevel is the Place), and an
  enclosing repo's git dir stays a deny extra. From there every Files check of a pane root applies
  unchanged (`os.Root`, deny lists, `reveal=1`, trash, `writeDeny`, `requireWriteRole`). Full role
  only (see View-only role in [`access.md`](access.md)). Changes stays pane-scoped: `changes`, `changes/apply`, `diff`,
  `commit`, `commit/diff` and `raw` with `side=` refuse `place` (400 `place_not_supported`);
  `blame` is a Files route and serves a Place whose git toplevel is the Place. A
  file's write lock is keyed by its absolute path and a write drops the find/status caches of every
  root that holds it or lies in it, so a pane root and a Place inside it never interleave saves of
  one file (the per-root lock of creates, deletes and renames is still per root string: a create
  in one and a rename in the other are not serialised, each still checked on its own handles).
  The PWA sends no `place` from a view-only client, and a Place refused (`view_only`,
  `unknown_place`, `place_moved`) sends the view back to the pane's folder.
  `GET /api/mux/files/places` (`requireMethod` GET, `crossSiteRejection`, `requireFilesRead`)
  lists `id`, `name` and the resolved path. In the container each Place is mounted at
  `/places/<id>-<name>` (`[A-Za-z0-9._-]`), refused with `,` or overlapping the workspace, a saved
  one failing on the host is not mounted; `TERMOTE_PLACES` (JSON id, name, container path) goes by
  name with `-e`, is in `termoteEnvKeys`, and `trustRepo` trusts these mounts like `/workspace`.
  A Place on another file system than the trash gets permanent delete only (`cross_device`).
- **A file the agent named** (`POST /api/mux/panes/{id}/files/mentioned` `{path}`,
  `server/files_mentioned.go`; the Chat view's link to a path outside the pane's root): the one
  route that takes a host path from the client, and only to compare it, never to look anything up
  by it first. `requireMethod` POST, `crossSiteRejection`, `requireWriteRole` (a view-only client
  never sees a tool's input, where most paths are; the PWA does not ask from one), `decodeJSON`
  (`maxJSONBody`). With `agent` and `session` (the History's session read), the transcript is that
  past session's, found as `history/{session}/transcript` finds it (`historySessionID`, then
  `findHistorySession` among the sessions of the pane's root, `historyAgentSession`); an unknown or
  invalid one answers `not_mentioned`. The path must be absolute, at most 4096 bytes, without NUL or a `.`/`..` part,
  and not a volume root. The server then reads the pane's own agent transcript, found as the
  transcript route finds it (`agentAPI.session`, the adapter's `Locate`: Claude Code and Codex;
  OpenCode and a pane without an agent answer `not_mentioned`), a chunk at a time, and answers
  404 `not_mentioned` unless the path is there as written or in its JSON-escaped form, as a whole
  path (`wholePath`: not the tail of a longer path nor the head of one; a `\n`/`\r`/`\t` escape
  before it is a line break). A path with a git dir component (as named or where it leads,
  `gitDirOnPath`) or under a deny dir (`denied`) is 403; a folder or a missing file is 404. It
  answers an opaque id (`m-` + 32 random hex, never a Place id's 16 hex), kept in memory per pane
  for an hour after its last use (at most 128, the oldest dropped), with the folder as `root` and
  the base name as `path`. The Files routes take the id as `place=`: `startAt` refuses it from a
  view-only client like a Place, then `mentionedRoot` serves it only to the pane it was opened
  for (another pane: 404 `unknown_place`), only on `GET` `content`, `raw` (no `side`) and
  `document` (anything else, `tree`, `find`, `search` and every write included: 400
  `place_not_supported`), only for the base name it was opened for (403 otherwise), and checks
  `gitDirOnPath` again at each read. The root is the file's folder with no repo (`IsRepo` false,
  so no git runs and no linked work tree is looked up), so `content` applies its own checks
  unchanged: `os.Root` (a symlink leaving the folder is refused), the deny lists, the
  sensitive-name `reveal`, the size limits. In the PWA such a file is a Files tab of its own
  (`FileTab.mentioned` holds the id), pinned: read only (no edit, rename, delete, download, blame, review
  comment or link followed), kept when the pane's root moves, and never kept on the device.
- **`<details>` in a previewed Markdown file** (`detailsBlocks` in
  `pwa/src/utils/markdown-safety.ts`, Files/Changes only): raw HTML is never parsed or passed to
  React. A remark plugin, run before `htmlAsText`, folds an html node that is exactly a
  `<details …>` (optionally with `<summary …>…</summary>`) up to its matching `</details>`, at
  block level only, into a `details` node built from markdown nodes: no attribute but `open` is
  kept, the summary is a text node (its inline tags dropped), the body stays markdown under the
  same link and image rules. Tags are paired in one pass per level and nesting past 32 levels
  stays text, so a crafted file cannot stall the page. Anything else, an unclosed `<details>`
  included, stays text.
- **Tags in a table cell of a previewed Markdown file** (`tableCellTags` in
  `pwa/src/utils/markdown-safety.ts`, Files/Changes only): raw HTML is never parsed or passed to
  React. A remark plugin, run after `detailsBlocks` and before `htmlAsText`, looks only at the
  html nodes of a table cell (each one tag there) that are exactly `<br>` (`<br/>`, `<br />`, no
  attribute) or an opening or closing `ul`, `ol`, `li`, `details` or `summary`. `<br>` becomes a
  markdown `break`; the others are rebuilt as nodes with no attribute but a `<details>`' `open`,
  holding the cell's own markdown nodes (same link and image rules). They are rebuilt only when
  every one of them pairs up in one pass: a `li` only in a list, a list holding nothing but its
  items, a `summary` only first in a `details` and holding no tag, nesting at most 32 deep;
  otherwise the cell keeps them as text (its `<br>` still breaks the line). Any other tag stays
  text.
- **Tables in a previewed Markdown file** (`pwa/src/components/markdown-table.tsx`,
  `pwa/src/utils/table-prefs.ts`, Files/Changes only): the tools (expand, full screen, column
  resize and hide, tall cells cut) are React elements and plain CSS (`.md-table`, `.md-cell`,
  `data-cell`, `data-clamped`, `tr[data-open]` in `index.css`); no `innerHTML`. A file cannot
  give those classes or marks to its own content: raw HTML stays text (`htmlAsText`). A cell's
  content keeps the preview's link and image rules, in full screen too, where a link is followed
  only once the full screen's history entry is gone. The set-up is kept in this browser's
  `localStorage` (`termote-md-tables`, `loadTables`/`saveTables` in `files-persist.ts`), keyed by
  the file's path and its header texts (the header part cut at 512 characters, so a file cannot
  make a key of any size): read into a prototype-less object, every value checked for its shape
  (booleans, column indexes, finite widths) before use, at most 300 tables, the oldest written
  dropped first. Since a key names a file of the pane root, it goes with the Files records: each
  table expires 14 days after it was last written (dropped on read, swept when the PWA loads),
  every sign-out that removes the Files records removes it, and nothing is written once this tab
  or another one signed out. A failed write (full, no storage, signed out) keeps the set-up for
  the view only. Nothing of it reaches the server.
- **Mermaid diagrams** (`pwa/src/utils/mermaid-render.ts`, `mermaid-sandbox.ts`, `mermaid-worker.ts`,
  `mermaid-block.tsx`, through `fenced-code.tsx`): a `mermaid` fenced block of a previewed Markdown
  file or of a Chat view message (agent text, as untrusted as a file) is drawn in the PWA
  only, by Pele (pinned to an exact version) in a worker that a hidden
  `<iframe sandbox="allow-scripts">` of `/assets/mermaid-sandbox-<hash>.html` starts from a `blob:` URL, so code
  a flaw in Pele lets a diagram run lives in an opaque origin: it reads no cookie (and none of
  the server's goes with its requests), nothing of the app, and its page's own policy (see
  Content-Security-Policy in [`access.md`](access.md)) refuses every connection; the page treats each message of the frame
  as untrusted (only from `frame.contentWindow`, objects only, an unknown error read as
  `render_failed`), posts to it with `'*'` (its origin is opaque) and the frame relays only from
  its `parent`, copying the three request fields. The sandbox page is one inline script (built by
  `pwa/vite.config.ts`: the relay with the worker's IIFE bundle, every diagram type of Pele, as a
  string; `</script` and `<!--` escaped inside it), since an opaque origin can load nothing from
  the server; named by its content, it is cached as an asset (a year, immutable) and by the
  service worker at runtime (`mermaid`), left out of the precache and never the navigation
  fallback (`/assets/` is on its denylist).
  Shown as an `<img>` whose
  `src` is a `data:image/svg+xml` URL, so no script runs, no link navigates and nothing it names
  loads; the SVG string never enters the DOM, and nothing is added to `body`. The worker gets the
  source and the page's font list only; its render options are fixed there and never taken from
  the file: `links: false`, `images: false` (a shape's `img:` is drawn without the image, nothing
  fetched), no `icons`, `math` or `config` (Pele inserts icon and math markup unfiltered), `limit`
  50 000 characters, `maxEdges` 500. A `%%{init}%%` directive or front matter `config:` changes
  only Pele's own layout settings; HTML labels, `click` callbacks and `javascript:` links are not
  drawn, and a `style`/`classDef` holding `url(...)` or `@import` is refused (a syntax error) or
  dropped, depending on the diagram type. Only
  `PeleError.code` leaves the worker, never its message (it quotes the diagram). Dark colors go
  into the SVG's root `style` as `--pele-*` values (an `<img>` sees no page CSS). Never rendered
  (shown as code with a reason): over 50 KB (checked before the worker is asked) or over Pele's
  limits; a syntax error; a diagram type Pele does not know; 10 s past the moment drawing started
  (the iframe is removed, which ends its worker; the next diagram starts a new one); the sandbox
  saying it is broken (its worker failed to start or load), not ready 2 s after its page loaded
  (an error or sign-in page), or not ready and answering within 30 s. One diagram in the sandbox
  at a time, only near the viewport, 50 results cached by source and theme. Export (`utils/mermaid-export.ts`, `mermaid-export.tsx`): the PNG
  is that same `data:` URL decoded into an `Image` and drawn on a detached canvas (filled with
  the theme's background, at most 2×, 16 M pixels and 16 384 px a side), the SVG file that URL
  decoded in JS: Pele's output under the fixed options above as `svgToDataUrl` writes it,
  plus `background:<theme color>` in its root `style` (opened on its own, outside an `<img>`,
  it holds no script, link, image or external `url()`); nothing is fetched (`connect-src` has no `data:`), no CSP source added, and the
  SVG never enters the DOM. Share and Copy image only in a secure context (Web Share,
  `ClipboardItem`), the SVG download through a `blob:` link revoked after 60 s (the share sheet
  in the iOS Home Screen app). The saved name is the Markdown file's base name less its extension
  and `UNSAFE_CHARS`, plus `-mermaid-N`
- **Full-screen image viewer** (`pwa/src/components/image-viewer.tsx`, lazy chunk, mounted only
  while open): a Mermaid diagram, an image in Files and each side of an image in Changes open in
  a modal `<dialog>` showing the same URL already on screen (`data:`/`blob:`; nothing is read
  again, no request is made); a `blob:` URL replaced (and revoked) while it is open closes it.
  It pushes one history entry at the same URL (`history.state.termoteViewer`, a random id, no
  hashchange) so Back closes it; X, Escape and Android's `cancel` pop that entry
  (`use-history-close.ts`: one `back()` at a time, none while another is pending); `App.tsx`
  does not replace the address on that entry and drops a mark a reload left. Zoom/pan is Pointer
  Events and `transform` (`use-zoom-pan.ts`, `utils/zoom-pan.ts`; 0.5×–8× of fit, panning keeps
  the image on screen), `touch-action: none` on its stage, wheel listener non-passive; an SVG is
  drawn again at its zoomed size once a gesture ends. Its title is the app's name for the image
  (`visibleUnsafe` path, or "Mermaid diagram N"), never text from the file. Extra bar buttons
  (`actions`) are opt-in, given by a Mermaid block only, in a bar below the stage; their
  messages are the app's own text, in a `role="status"` node there, the dialog's name staying
  the title
- **Saving a file** (`PUT files/content?root=`, `server/files_write.go`): replaces the whole text
  of an existing file (a new one comes from `POST files/create`, see Creating a file in [`files-write.md`](files-write.md)). `writeGuard` (same-site JSON) plus the handler's own cross-site check and
  `requireWriteRole`; the `root` query is required (400, 409 once it moved). Body
  `{path, baseHash, text, reveal, encoding?, saveAs?}`: `encoding` (what GET `content` read the
  text as) from the fixed set of Files/Changes, `saveAs` only `utf-8` and only with `encoding`
  (else 400). Bytes on disk that already equal what the text encodes to are 200 (a repeated save
  is no conflict, a save as UTF-8 sent again too, with either line breaks), checked with
  `encoding` before anything about those bytes, without it after the checks of the file and its
  text; otherwise bytes other than `baseHash` (GET `content`'s `hash`, sha256 of the raw bytes) → 409
  `changed` (with `encoding`, before any fault of the text they decode to); never an overwrite. The read's path checks plus a write-only deny list (the
  install's data dir, the upload store); a sensitive name needs `reveal: true` (403
  `sensitive`). No component of the path may be a symlink; the parent is opened once through
  `os.Root` and used for every step. The file must be regular, one link, owned by the server user
  (Unix), owner-writable, without NUL once decoded from `encoding`, line breaks all `\n` or all
  `\r\n`, every byte valid in `encoding` (`invalid-encoding`, a save as UTF-8 too: those bytes
  would be lost) and encoding back to the very bytes read (`lossy-encoding`, not asked of a save
  as UTF-8) (422 `not_editable` + `reason`, or 403 `permission`; writing the new text on a read-only mount → 403
  `read_only`, on a full disk or quota → 507 `storage_full`, as a create); GET `content` reports the same check as
  `editable`/`notEditable`. Without `encoding` (a client or a kept draft from before encodings)
  the file must be valid UTF-8 whose BOM the text keeps (text starts with U+FEFF exactly when the
  file starts with `EF BB BF`), else 422 `not_editable` + `encoding-required`: no such save
  writes UTF-8 over a Shift-JIS, EUC-JP or UTF-16 file or drops a BOM. Text arrives with `\n` (a
  `\r\n` file gets them back), NUL or a lone `\r` → 422 `not_text`. It is encoded strictly, in
  `encoding` with the file's BOM, or as UTF-8 without one for `saveAs`: for Shift-JIS and EUC-JP
  a fixed table of characters an Apple keyboard types (〜 − ‖ ¢ £ ¬ — ¥) is first replaced by
  their full-width forms, and a character still not held → 422 `unencodable` + `line` and `char`
  (from the client's text, never the file's), never a `?`. At most 1 MiB once encoded (413
  `too_large`); body limit 6 MiB + 64 KiB, unchanged: a 1 MiB file decodes to at most 3 MiB of
  UTF-8 (half-width katakana) and JSON spells a control character in 6 bytes. 2 saves at a time
  (429 `busy`), read deadline 5 minutes once authenticated with a slot. A release from before
  encodings has none of these checks: a draft of a non-UTF-8 file kept on a device and saved
  after `termote update --version` back to one is written as UTF-8. Written to
  `.termote-edit-<random>` in the same directory (`O_EXCL`, mode set on the handle, `fsync`),
  the file read again, then renamed over it; the temporary file goes on any failure, ones older
  than 10 minutes are swept (only names of that exact form), every `.termote-edit-*` name is
  sensitive, and a save drops the root's cached git status. Saves of one file are serialised; an agent writing between the last read and the rename still loses its change (no
  compare-and-swap), and the rename drops ACLs/xattrs. A view-only client gets 403 `view_only`. The draft is kept in browser storage only as
  "Files/Changes state kept on the device" allows, never a sensitive file's
- **Desktop editor** (`pwa/src/components/code-editor.tsx`, CodeMirror 6, lazy chunk; languages
  and Vim mode in `assets/cm/`, never precached): shown only where `(pointer: fine)`; it edits
  the same draft as the textarea and saves through the same `PUT files/content` (Ctrl+S, and `:w`
  in Vim, only when there is something to save). No CSP source added: CodeMirror and
  `@replit/codemirror-vim` run no `eval` or `new Function`, and their styles are inline
  (`style-src 'unsafe-inline'`). Its `aria-label` is the app's text with the path, never the
  file's. Vim keeps its registers and search and `:` histories in module state shared by every
  editor: when the editor of a sensitive file the user chose to show (`reveal`) closes, they are
  dropped (`Vim.resetVimGlobalState_`). Escape is stopped at the editor while Vim is on, so the
  key that leaves insert mode does not restore a maximized panel
- **Files/Changes state kept on the device** (`pwa/src/utils/files-persist.ts`,
  `persisted-tabs.ts`, `pane-view.ts`; server `server/instance_id.go`): the snapshot's
  `instanceId` (16 random hex digits made once with `crypto/rand`, kept in `<stateDir>/instance-id`
  0600 through `writeStateFile`, made again when unreadable as one; not a secret, never logged;
  the state dir is in `FilesDenyDirs`) names the server. The PWA keeps in `localStorage`, under
  `termote-{files-tabs,changes-tabs,file-drafts,pane-view,recent-files}:<instanceId>:<pane key>[:<root>\0<path>]`
  with the pane's key and group name in each record: the open Files and Changes tabs (paths,
  scroll offsets, history, table layout), the Place the Files view shows (its id, kept even
  without a tab; one the server no longer offers falls back to the pane's folder), each pane's last view, the unsaved draft of a file
  (`root, path, baseHash, base, crlf, encoding, text, cells`; a draft whose `encoding` is not
  one of the fixed set of Files/Changes is not restored), and the files the user opened lately (at
  most 20 `root, path` pairs, written when the user opens a file from the tree, a search, a link
  or the command palette, never when tabs are restored or a file is created). Never kept: a tab
  or draft of a sensitive file the user chose to show (`reveal`/`revealed`: neither its name nor
  its text), nor such a file in a tab's Back history (an entry marked `reveal`, set by a link or
  a rename) or in the files opened lately (showing it, or a rename to it marked `reveal`, takes
  it out; a sensitive file not shown keeps its path, as its tab does), `intent`, the tree's open
  directories. A draft is written at once (never delayed) while it differs from
  the text read, removed at once on Save, Discard or back to that text; at most 1,000,000
  characters each and 1,500,000 for all, measured as stored JSON; too big, no room or a
  sensitive file's → in memory only, and `beforeunload` asks (it asks only for such drafts, for
  one another tab of the browser wrote or removed since, and for every one once this tab signed
  out).
  Drafts are written and read back only for a client that may write: a snapshot with
  `caps.role` `view` removes every kept draft. They come back once per pane in `applySnapshot`
  (`hydrateDrafts`), before any view reads a file, never over a draft in memory (one kept under
  the key of a version before Places, `:<path>`, is moved to its root's key; that read goes after
  one release); a record of
  another instance, or whose group name differs (a tmux `@N` used again after tmux restarted),
  is not read (a tab or view record is removed, a draft left to expire). A group renamed while
  the PWA is open (tmux, Herdr: the keys stay; Zellij: they move with it) takes its records
  along. Reading the file again: equal to the draft → the draft
  goes; another `hash` than `baseHash` → the `changed` banner (Save still never overwrites;
  Reload asks before dropping the draft); now sensitive → the draft goes; gone → a banner to
  copy or discard it. Restored tabs send their saved `root`: a pane that moved answers 409 and
  `rootChanged` closes clean tabs and asks about those with drafts. Records expire 14 days after
  they were written (a draft: after its text last changed), swept when the PWA loads. Log out,
  Clear cache & reload (before it ends the session, also when sign-in is off or the request
  fails), revoking this device in Devices and signing this browser out in Signed-in browsers remove
  every record, stop every later write in this tab (pending ones included) and set
  `termote-signed-out`, on which every other tab of the origin does the same and forgets its
  tabs and drafts; each write first checks that key, so a tab not yet told writes nothing back. Accepted gaps: a 401 (session expired, revoked from another device, server
  restarted) removes nothing, and `/login` runs no script, so a revoked device keeps its drafts
  until the PWA opens there again or 14 days pass; a non-sensitive file can still hold a secret;
  psmux keys panes by window index, so after windows are renumbered tabs and drafts may not come
  back; a group renamed while the PWA is closed (tmux, Herdr) leaves its records unread; another
  tab of the browser editing the same file: the last write wins
- **Downloading a file** (`GET files/download?root=&path=&reveal=[&check=1]`,
  `server/files_download.go`): any regular file under the pane root, at most 100 MiB, as a download
  the browser never renders. `requireWriteRole` first (a view-only client gets 403 `view_only`,
  `check=1` too), then `begin` (`requireMethod(GET)`, the files routes' cross-site check, `nosniff`,
  `root` 409 once it moved). The path: `cleanRelPath` (`.` → 400 `not_file`), `createDenied` (the
  read deny list plus the install's data dir and the upload store → 403 `not_allowed`: such a file
  shows in Files but is not downloaded), parents through `walkParents` (a symlink, junction or
  swapped directory → 403 `symlink`, missing → 404), the file's `Lstat` (symlink/junction → 403
  `symlink`, directory, FIFO, socket or device → 400 `not_file`, never opened), a sensitive name
  without `reveal=1` → 403 `sensitive` (after the `Lstat`: a missing one stays 404), opened
  `O_NONBLOCK`, `SameFile` with the `Lstat` (409 `changed`), size from `Stat` over 100 MiB → 413
  `too_large`. It shares the 4 `files/raw` slots (429 `busy`, no wait). Headers:
  `application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<name>` (RFC 5987
  escaped, the base name without control or format characters, `download` when nothing is left),
  `Content-Length`, `Cache-Control: no-store`, CORP `same-origin`, and a second CSP `sandbox;
  default-src 'none'` on every answer of the route. Exactly the `Stat` size is sent (`CopyN`, 256
  KiB chunks; a file that grew sends no more), each chunk under a 2-minute write deadline and the
  whole within 30 minutes, so a client that stops reading frees its slot. One `audit: download
  path="<relative>" size by via` line (`by`: `password`, `session:<id>`, `device:<id>` or `none`; `via`:
  `session|device|basic|local|none`) right before the bytes, none for a refusal or `check=1`.
  `check=1` runs every check, takes no slot (a full pool still answers 429), sends no bytes and
  answers `{root, path, size}` (`no-store`): the PWA calls it first so each refusal gets a toast (a
  link with `download` never tells the page why it failed), then clicks a same-origin `<a
  download>`; between the check and the download a change shows as the browser's own failed
  download. In the iOS home-screen app (`isIos` and `isStandalone`), where such a link does nothing,
  the PWA skips `check=1` (the read of the bytes answers the same codes, and the tap's activation,
  about 5 s, is kept for the sheet), reads the bytes and calls `navigator.share({files})`; a
  `NotAllowedError` (the activation ran out) shows a toast whose Save shares from a new tap, closing
  the sheet is silent, and a `blob:` link revoked after 60 s is used only when `canShare` refuses
  the file. Download is in the open file's header (not for a sensitive file not shown, nor for a
  path through a link the tree has read) and on each regular file's row menu (a sensitive one asks
  first); never on a directory or a symlink row, never for a view-only client. Out of scope:
  directories, git versions, ranges
- **Opening a file in Windows** (`POST files/open-windows?root=` `{path, reveal, run}`,
  `server/files_wsl.go`): only when the server runs under WSL outside a container
  (`systemScope() == "wsl"`), with WSL interop on (`WSLInterop` or `WSLInterop-late` reads
  `enabled`) and `explorer.exe` found under the drives' mount (`wslpath -u C:\` at startup, never
  `WSL_DISTRO_NAME` or `PATH`), and never over the machine bridge (`isBridge`: the user of another
  termote sits at another device); otherwise 501 `unavailable`. `startJSONWrite` (POST, `root`
  required, `writeGuard`, `requireWriteRole`: a view-only client gets 403 `view_only`), one of the 4
  `files/raw` slots (429 `busy`, no wait). The path: `cleanRelPath` (`.` is the root, opened as a
  folder); then the absolute Linux path (root and `rel`) must name the same file to Windows
  (`windowsReadsAsIs`), else 400 `windows_name` before anything is stat'd or run: no `\` (a
  separator to Windows, so a Linux name `..\..\x` opens a file outside the root, checked on WSL),
  no `,` (explorer.exe splits its argument there and opens what is before it: `a.txt,z` opened
  `a.txt`), no `:` (a stream), no `* ? " < > |` or control character (not allowed in a Windows
  name), no component ending in `.` or a space (Windows drops it: `a.cmd.` opens `a.cmd`), no
  U+F000 to U+F0FF (WSL shows a Linux name holding one of those characters to Windows with it moved
  there and moves it back on access, so `d` U+F03A opens the Linux `d:`); then
  `createDenied` → 403 `not_allowed`, parents through `walkParents` (symlink, junction or
  swapped directory → 403 `symlink`, missing → 404), the entry's `Lstat` (symlink/junction → 403
  `symlink`; only a regular file or a directory, else 400 `not_file`), a sensitive name without
  `reveal` → 403 `sensitive`, a regular file Windows may run as a program without `run: true` → 403
  `runs_program` (`windowsMayRun`): an allow list, not a deny list, since a deny list kept missing
  types Windows or a common program runs on open (`.sh` with Git for Windows, `.py` with the `py`
  launcher, `.wsb`, a theme, a disk image). Only an extension in `windowsViews` (text and code,
  `.pdf`, pictures; compared in ASCII lower case) opens without asking. Left out, so
  asked about: a type whose program acts on what the file says as it opens it (Office, ODF and
  `.rtf` fetch a remote template, Excel opens `.csv`/`.tsv`, an `.xml` names the Office program, a
  browser opens `.html .htm .svg .epub`, an interpreter may own `.lua` or `.jl`, Photoshop and
  ExtendScript run a `.jsx`, WinGHCi a `.hs`, and a media player such as VLC reads a sound or a
  video by its content, a playlist naming another computer's share among them; `.ts` and `.mts` are
  transport streams as well as TypeScript), and `.zip`, which
  Explorer shows as a folder without the folder check below, and so does a name with no extension (Windows asks which program);
  any other, a dotfile's whole name included, asks, and so does any extension holding a byte beyond
  ASCII (Windows folds case its own way: U+017F is an S to it). A directory named like a shell object
  (an extension starting `.{`, `x.{CLSID}`) asks too, and so does any path through one (a folder of
  the path named so, the pane root or the Place and the folders above it included: Explorer runs its
  handler to reach what is below it); a path through one that the folder check below refuses (a
  Folder Shortcut's `target.lnk`) is refused, run or not, 403 `folder_reaches`. A directory, the root included, that directly
  holds a `.url .lnk .scf .library-ms .searchconnector-ms .search-ms .website .settingcontent-ms`, a theme (`.theme
  .themepack .deskthemepack`, whose thumbnail has loaded a remote wallpaper), a `.pif`, a name whose
  extension holds a byte beyond ASCII (`x.ſcf` is a `.scf` to Windows), a name like a shell object
  (`x.{CLSID}`, file or folder: a Folder Shortcut resolves its `target.lnk` to show it) or a `desktop.ini`
  (any case, a letter beyond ASCII standing for any letter: `desktop.ıni`), each name read as Win32 reads
  it, without trailing dots or spaces (`x.{CLSID}.`, `a.lnk`, which Linux can write under `/mnt/c`),
  or holds a subfolder,
  or a link to a folder inside the pane root (Windows may follow it), that holds a `desktop.ini`, which
  Explorer reads to show that subfolder, or, on the distribution's share, a link out of the pane root,
  a link to nothing or an entry neither a file nor a folder (Explorer draws the subfolder's thumbnail
  from the pictures in it; on a Windows drive Windows answers for those, below, since drvfs shows a
  junction there, as pnpm and npm make in `node_modules`, as an absolute link) (or,
  in the folder itself, a link out of the pane root, a link to nothing, which may be an
  NT link to another computer's share under `/mnt/c` that Linux cannot follow, an entry neither a
  file nor a folder, more than 10000 entries across
  both levels, or one that cannot be read; a shortcut deeper down is not shown, so not looked for)
  is refused, run or not, 403 `folder_reaches`. So is a folder below the root when a folder
  Explorer's navigation pane shows on the way to it, expanded to it, holds a `desktop.ini`, a name
  like a shell object, a link that cannot be followed inside the pane root or an entry neither a file
  nor a folder (a dangling link at a repository's root refuses each folder below it): each folder
  from the root down to its parent, and the folders beside each (their own count of 10000 entries;
  the shell object on the way itself is the one `run` was asked about; a second shell object on the
  way, at any depth, the root's included, is refused even with `run`).
  Explorer reads their icon or the folder's settings from a location they name, a
  share on another computer among them, while it only shows the folder, sending the Windows user's
  NTLM hash there. On a Windows drive (`/mnt/<letter>`), where drvfs may show an NT link to another
  computer's share as a plain file, Windows itself is asked before `explorer.exe` runs: Windows
  PowerShell, found at startup beside `explorer.exe`, run with `-Command` and a fixed script (no
  double quote in it), the path in `TERMOTE_OPEN_PATH` passed through `WSLENV` (no character of the
  path is read as PowerShell), answers whether the file or folder, a folder on the way to it up to the
  drive's root, or, only once those are known not to be links, an entry of the folder is a symbolic
  link or a junction, or, only once every entry is known not to be one, an entry of one of its
  subfolders is a symbolic link (a junction there, as pnpm and npm make in `node_modules`, only
  reaches a local volume) (so no link is followed to list it; a subfolder that cannot be listed, as
  a drive's `System Volume Information`, fails); a link, any other answer, a failure, a
  timeout (10 s) or no PowerShell refuses it, 403 `folder_reaches`. Other reparse points (OneDrive's placeholders) are not links. The
  distribution's share shows Linux's own view and is not asked. The check is of the folder as it is when opened: a file a later `git pull` adds
  to the open Explorer window is not looked at, nor is a folder above the root but for a shell
  object on the way. Windows
  asks before running a file only when its zone says so (on the machine checked, a `.cmd` under
  `\\wsl.localhost` was asked about, one under `/mnt/c` ran at once), so termote asks itself. The Windows path is built from the absolute
  path (`/mnt/<x>/…` → `X:\…`, else the distribution's share from `wslpath -w /`) and refused (400
  `not_file`) when it is empty or holds NUL, a line break or `"`; `explorer.exe` runs with it as its only argv entry (never a shell, `cmd.exe` or
  `start`), cwd `/`, a 10 s timeout, its exit status ignored (it exits 1 on success); a program that
  never started is logged and answered as an internal error. One `audit: open-windows path by via`
  line before the run, with `run=true` after `path` when the user said to run it. Windows then opens it with the default program for its type, on the machine
  the server runs on: a full client can run a Windows program this way, as it can from its shell.
  The tree answer carries `windowsRoot` (the root as Windows names it, also to a view-only client:
  it already gets `root`) and `windowsOpen` (full role and the route usable), neither over the
  machine bridge. The PWA offers Copy
  Windows path on every row and tab menu, and Open in Windows on a file's or folder's row and on a
  tab of the current root, never for a sensitive file not shown nor for a path through a link. On
  `runs_program` it asks first ("Run this file as a program?", naming the file and that Windows
  runs it with the Windows account's access; Run and Cancel, Cancel focused), then sends the same
  request with `run: true` once; Cancel sends nothing. `windows_name` shows that the path has a
  character Windows reads differently
- **Reading a document to preview** (`GET files/document?root=&path=&reveal=`,
  `server/files_document.go`): the bytes of a `.pdf`, `.xlsx` or `.docx` under the pane root, for
  the PWA to parse in a worker. Read like `files/raw`'s worktree file: `begin`, `viewHides` (a
  view-only client reads it too, as it reads `files/raw` and `content`, only what git lists, and
  never with `reveal=1`, refused 403 for it as on every read route),
  `cleanRelPath`, the read deny list, `os.Root` `O_NONBLOCK` and every check on the open handle in
  `content()`'s order (missing → 404 even for a sensitive name; a sensitive name without
  `reveal=1` → 403 `sensitive`; not a regular file → 415 `not_document`). `side` is refused (400):
  Changes keeps showing these as binary. The kind comes from the name and is checked on the first
  1 024 bytes: a PDF holds `%PDF-`, an `.xlsx`/`.docx` starts `PK\x03\x04`, else 415
  `not_document`; an OLE compound file (a password-protected or IRM Office file) → 415 `encrypted`;
  a Git LFS pointer → 415 `lfs_pointer`. Over 30 MiB → 413 `too_large` with `size` in the body
  (`documentTooLargeError`). It shares the 4 `files/raw` slots (429 `busy`, "too many files at
  once"), taken through `takeRawSlot` like `files/raw`, so a view-only client never holds the last
  one. Sent by `writeDownload` (256 KiB chunks, 2-minute idle deadline each, 30 minutes in
  all) with its headers and a second CSP `sandbox; default-src 'none'` on every answer. One
  `audit: document path="<relative>" size by via` line before the bytes, none for a refusal
- **Office and PDF previews** (`pwa/src/components/document-preview.tsx` and its viewers): the
  page's CSP is not loosened for them (no `'unsafe-eval'`, no `'wasm-unsafe-eval'`, no `font-src
  data:`); every E2E spec fails on a violation of the page or of any worker
  (`pwa/e2e/fixtures.ts`). Parsing runs in workers only, each request with a timeout (30 s to load
  the worker, 20 s per request, `DocumentWorkerClient`); on timeout or failure the worker is
  `terminate()`d and the viewer says why with Download (full clients). PDF: one worker per
  document, owned by the viewer (`new PDFWorker({port})`; pdf.js never terminates a port it was
  given), ended on close, failure or a 20 s open timeout; `getDocument` gets fixed options only
  (`pdf-options.ts`: `enableXfa: false`, `useWasm: false`, `wasmUrl`/`cMapUrl`/
  `standardFontDataUrl` under `/assets/doc/pdfjs-<version>/`, `maxImageSize` 40 MP), no scripting
  manager, annotations shown but not editable, `maxCanvasPixels` 16 M; `wasmUrl` only serves the
  JS fallback decoders of JPEG 2000 and JBIG2. External links open in a new tab with `noopener
  noreferrer nofollow`; internal ones move between pages without touching `location.hash`.
  `.xlsx`/`.docx`: `zip-guard.ts` runs first in the worker and checks only what the zip declares
  (no ZIP64, no data descriptor, local header equal to the central one, no repeated name, at most
  2 000 entries, 100 MiB per entry and 200 MiB in all); what really bounds a zip bomb is the
  timeout and `terminate()`, and an entry that inflates past the worker's memory before the
  timeout ends the worker (or, at worst, the tab), never the page's data. A sheet is read by the
  cells it holds, not by the range it declares (rows up to the last with data, 201 columns), a
  row at a time until its TSV reaches 1 MiB: it reaches the table view as at most 1 MiB and 200
  columns (the size its main-thread fallback was built for), cut by rows with a note. A `.docx` is
  converted by mammoth, parsed by xmldom and filtered by an allowlist in the worker
  (`docx-sanitize.ts`: no `id`, no `#` link, `href` only `http(s)`/`mailto`, images only
  `data:image/(png|jpeg|gif|webp)`, spans 1–1000; limits of 5 Mi UTF-16 units of text, 50 000 nodes, depth
  64, 20 MiB of images); the page gets a JSON tree, checks each tag and attribute again and builds
  React elements. No `innerHTML` or `dangerouslySetInnerHTML` in `pwa/src` outside tests
