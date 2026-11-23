# Security invariants: Release and install

Part of the [security invariants](README.md): Homebrew, release integrity, the website build, git hooks and the agent guide.

- **Homebrew install** (`homebrewOpt`, `server/install_layout.go`): a binary is a brew install only
  when its resolved path is `<prefix>/Cellar/termote/<v>/bin/termote` (path components, not a
  substring) and `<prefix>/opt/termote/bin/termote` resolves to the same file. Then `start`
  registers the service with that `opt` path (it survives `brew upgrade`, the Cellar path does
  not), `update` refuses and names `brew upgrade termote && termote restart`, `link` writes
  nothing, `unlink` still removes only its own links, `uninstall` removes the service and leaves
  the binary to `brew uninstall`, and health reports `install: "homebrew"`. Any other layout, or
  an `opt` link to another version, runs as an unknown binary (its own path), as before
- **Release integrity**: `release.yml` runs on `workflow_dispatch` only, on `main`, with the
  version to release: its `prepare` job refuses another ref, resolves tag `v<version>` to its
  commit and refuses one not on `main` (`git merge-base --is-ancestor` against the run's commit)
  or whose `server/cli_version.go` names another version (an old commit tagged as a newer version
  would be offered to every unpinned `update`),
  and every later job, and `deploy-website.yml` when it calls it, checks out that commit by hash,
  so the tag moved during the run changes nothing. `deploy-website.yml` started by hand (Run
  workflow on `main`, naming a tag; no `sha` input) deploys only the latest published stable
  release: before checkout it refuses a tag that is not `vX.Y.Z`, is no published release
  (`gh api releases/tags/<tag>` with the job's `GITHUB_TOKEN`, `contents: read`), is a draft or a
  pre-release, or is not the one `releases/latest` names; on either path the checked-out commit
  must be on `main` and its `server/cli_version.go` must name that version, before any dependency
  runs. A version-like tag that is no release, or an older release, so never deploys by hand. A
  write-role account can still publish a release for its own tag or mark an older one latest: then
  the `cli_version.go` check (a commit of `main` that is not that version) and the maintainer's
  `github-pages` approval are what stand in the way. The `release` and `github-pages` environments
  take `main` only (deployment branch policy, no tag): a `v*` tag pushed to an unreviewed commit,
  or a run of the workflow file of another branch, never reaches the signing key, the tap's deploy
  key or the Pages deploy, whoever approves. The `protect-release-tags` ruleset keeps a `v*` tag from
  being moved, deleted or force-pushed by anyone but an admin; it does not block creating one,
  since release-please makes its tags with `GITHUB_TOKEN` and GitHub lets no app bypass a ruleset
  on a personal repository, so a writer's new tag still meets the `prepare` checks above. The release job runs in the `release` environment (the
  maintainer approves each release; it holds `RELEASE_SIGNING_KEY`), writes `image-digest.txt`
  (the pushed image by digest) into `checksums.txt`, signs it with `openssl pkeyutl` and checks
  the signature with the key `install.sh` pins. It also signs it as `checksums.txt.sshsig`
  (SSHSIG, namespace `termote-release`, made with openssl alone by `scripts/release-sshsig.sh`, so
  the key is only ever handed to openssl) and checks that with `ssh-keygen -Y verify` against the
  allowed-signers line `install.sh` pins (`RELEASE_SIGNER`; `install.ps1` pins the same line, and
  `TestReleaseSignerMatchesInstallers` keeps both equal to the CLI's key); the release needs 14
  assets. `update` and `install.sh` (OpenSSL 3) refuse a 1.10.0+ release whose signature does
  not verify. Without OpenSSL 3, `install.sh`, and `install.ps1` always, check the `.sshsig`
  with an `ssh-keygen` that has `-Y` (OpenSSH 8.1+; one that answers "option -- Y" counts as
  absent), refuse a bad one, and refuse a release from `FIRST_SSHSIG_VERSION` (2.14.0) without
  one. With neither tool, a release from that version on is refused too, since whoever can
  publish a release also writes its `.sha256`: only a pinned version (`TERMOTE_VERSION`) with
  `TERMOTE_SKIP_SIGNATURE_CHECK=1` (that value exactly) installs, with the sha256 alone and a note;
  an unpinned one is refused even with it. `install.sh` takes at most 9 digits a version part, pinned or picked as the newest, so
  the shell arithmetic that tells a signed release cannot fail and read as unsigned. Before that version, which no tool there could check,
  they refuse it unless `TERMOTE_VERSION` names it, then print that the signature was not checked:
  unpinned, a fresh tag below `FIRST_SSHSIG_VERSION` (`v2.13.99`) made the newest stable would go in
  with only its publisher's sha256. Both check the archive's line in the verified `checksums.txt`; `install.ps1` writes it
  to `ssh-keygen`'s stdin byte for byte (`Invoke-Native`: `Start-Process` rewrites its lines).
  `container up` runs the image by that digest,
  and only from a signed list that names the version's own archives (`listsVersion`:
  `termote-<version>-<os>-<arch>.tar.gz|.zip`, a pre-release's not counting for its stable), so a
  genuine list and image of another release copied into a version's assets run nothing.
  Whoever can publish a release picks the unpinned target, so neither lets it skip the signature:
  without `--version`, `update` refuses a release before 1.10.0 on an install already on a signed
  one (`releaseSigned`, `server/cli_update.go`), and without `TERMOTE_VERSION`, `install.sh` and
  `install.ps1` refuse a release before 1.10.0. Nor older than the install: marking the newer
  releases as pre-releases or drafts would pick one with a fixed flaw, so without `--version`
  `update` refuses any release older than the running one, except from a pre-release (going back to
  the newest stable is how its user leaves it); named, it warns and goes back. The `docker` job pins the binfmt (QEMU) and
  BuildKit images it builds with by digest, like the actions; a Renovate `customManagers` entry
  updates both tags and digests. `docker-tags`, which holds the registry tokens, runs buildx with
  the `docker` driver, so it starts no BuildKit container at all (`imagetools` only talks to the
  registries).
  The `homebrew` job (after `publish`, stable releases only, never a dry run) writes
  `Formula/termote.rb` only from a `checksums.txt` whose `.sig` verifies with the key `install.sh`
  pins, since brew checks nothing but the hash the formula names; it pushes with
  `HOMEBREW_TAP_DEPLOY_KEY`, a deploy key that can write to `lamngockhuong/homebrew-tap` only,
  held in the `release` environment, through ssh with GitHub's host keys from `gh api meta`
  (`StrictHostKeyChecking=yes`), and never replaces a newer version in the tap.
  `homebrew-verify` installs the pushed formula on macOS and Linux with no secret.
  The `docker` job pushes the image to GHCR by digest only, with no tag; `docker-tags`, which needs
  the release job, moves `x.y.z`, `x.y` and `latest` on GHCR and Docker Hub to that digest and fails
  when a tag names another one, and `publish` makes the draft public only after it. So a run of
  another ref moves no tag users pull through this workflow. It does not stop a
  writer: any workflow run from a ref a writer pushes (a branch or a tag, any workflow file; the
  `protect` ruleset covers `main` and `release/*` only) gets the repository's `DOCKERHUB_*` secrets
  and can ask for `packages: write`, so it can move image tags on both registries (residual risk
  accepted by the Tech Lead, 2026-10-23).
  Immutable releases are on for the repo, so assets and tags cannot change after publishing.
  `release-please.yml` starts `release.yml` with `workflow_dispatch` on `main`, naming the
  version of the tag it made, never as a called workflow: a `workflow_call` job does not get the environment's secret (actions/runner#1490).
  Dependencies: `pnpm-workspace.yaml`'s `allowBuilds` keeps install scripts to `esbuild` and
  `sharp`, the Build PWA job runs `pnpm audit --prod --audit-level high` (known vulnerabilities),
  and `malware-scan.yml` (pull requests, pushes to `main` and daily, `contents: read`, osv-scanner
  pinned by sha256 with a Renovate `customManagers` entry) fails when any package in
  `pnpm-lock.yaml`, dev ones included, matches a malicious-package advisory: an OSV `MAL-` ID or
  an alias of one (GitHub's recent malware advisories, `chalk@5.6.1`, arrive so), or an older
  GitHub-reviewed malware advisory, which reaches OSV as a `GHSA-` ID with no `MAL-` alias
  (`coa@2.0.3`, `ua-parser-js@0.7.29`, read from the OSV API on 2026-11-14) and is recognised by
  `CWE-506` (Embedded Malicious Code) in its `database_specific.cwe_ids`; it ignores every other
  advisory, leaving those to `pnpm audit`. The step sets `pipefail`, so a jq error fails it rather
  than leaving the list empty. It only knows
  versions already reported. A false positive goes in a root `osv-scanner.toml` `[[IgnoredVulns]]`
  entry with its reason.
  The website (`deploy-website.yml`) serves `install.sh` and `install.ps1`, which pin the release
  key, so they are the root of this trust, `/agents.md` (`server/agent-guide.md`), which
  `llms.txt` and the install docs tell a coding agent to follow, with the install commands in it,
  and `/llms.txt` (`website/llms.txt`, which CI's `check-website` compares with the one the build
  makes of `astro.config.mjs`), which sends a coding agent there, and `/llms-full.txt` and
  `/llms-small.txt` (`website/llms-full.txt`, `website/llms-small.txt`, the docs as text a coding
  agent reads, committed with `make llms`, which runs the build's dependencies on the machine of
  whoever regenerates them, the result reviewed in the pull request; `check-website` compares them
  with the build, so a docs change carries them).
  Its `build` job runs the site's and the PWA's dependencies and uploads the built site as a plain
  artifact, naming its id as a job output. The Pages artifact is made and deployed by `deploy`, one
  job that runs no dependency code, after the `github-pages` approval and with no wait between the
  upload and the deploy (a sparse checkout of the tag's `scripts/`, `server/agent-guide.md`, `website/llms.txt`,
  `website/llms-full.txt`, `website/llms-small.txt`, `website/astro.config.mjs`, `website/src/` and
  `website/public/` without credentials, a download of the built site by id, upload, deploy): it fails
  when the build's `llms-full.txt` or `llms-small.txt` differs from the tag's (committed ones gone
  stale are not served), then copies those six files from the tag over whatever the build left and compares them byte for byte, then runs the
  tag's `scripts/check-site-installs.mjs` on every other file but scripts, style sheets and binary
  types (pages, sitemaps and SVG files as markup, captions and
  `.md .txt .vtt .json .webmanifest` files as text, line by line; a file with no extension,
  served as a download that a page can point an agent at, as plain text; the PDF viewer's character
  maps and fonts are not read; any other type,
  a link in the artifact, an `xml-stylesheet` instruction, a `<foreignObject>` or `xml:base` in an
  XML file is an error; an XML file's element is read by its local name, `h:base` as `base`, an HTML
  page's by its whole name; a text file's prose, its code taken out, is read as HTML too, its
  a reference it does not decode refused only with its `;`, and held to the same refusals; a
  paragraph that may start an HTML block is read both as markdown and whole as HTML, and a
  `<pre>`, `<script>`, `<style>` or `<textarea>` block whole to its end tag),
  against the tag's sources. A page is read as the HTML specification tokenizes it (a tag only at
  `<` and a letter, HTML whitespace only, attributes after whitespace, `/` or a quote, an end tag's
  too, comments; only `<script>` and `<style>` skipped as raw text (their bodies read for install
  links and downloads like an attribute's text), ended by their own end tag, and
  not inside `<svg>`/`<math>` or in an XML file; `<template>` read as markup; `<textarea>` and
  `<title>` as text; whitespace collapsed outside `<pre>`, a line broken by `<br>`, at a block's start and at
  the end of a block that is open), and what the check does not model is refused: a `<base>` off the site,
  `<plaintext>`, `<xmp>`, `<listing>`, `<iframe>`, `<noscript>`, `<noembed>`, `<noframes>`,
  `<object>`, `<embed>`, `<frame>`, `<frameset>`, `<portal>`, `<fencedframe>`, CDATA, a DOCTYPE other
  than `<!DOCTYPE html>`, a processing instruction other than the XML declaration, a charset or XML
  encoding other than UTF-8, a script holding `<!--`, a `<style>`, `<script>` or HTML integration
  point (`foreignObject`, `annotation-xml`, `mi`…), an HTML element that ends them there (`p`,
  `div`, `span`, `pre`…), or an element inside an svg `<title>` or `<desc>` (text only)
  or a `<textarea>` inside
  `<svg>`/`<math>` of a page, a `</svg>` or `</math>` that closes no open one, inside code a `hidden`
  attribute, a `style` setting anything but custom properties (`--0:#fff`), or any element but `span div code pre br wbr b i em strong mark kbd samp var a sub sup
  small s u del ins` (an `<img alt>`, an `<input value>`, a `<ruby>` show other text), code holding a line break
  it does not split at (U+2028, U+2029, U+0085, a vertical tab, a form feed, DEL, a carriage
  return written as a reference), a named
  character reference
  other than `&amp; &lt; &gt; &quot; &nbsp; &AMP; &LT; &GT; &QUOT;` (with their `;` or without) and
  `&apos;` (numeric ones are decoded as a browser does).
  Then two allow lists: every line of code a file shows (a `<pre>` or `<code>`, a copy button's
  `data-code`, a markdown fence, read both at the top level and after any indent, quote marks or
  list marker, ended with its list item or quote (its lines read by their quote marks and the
  item's indent in columns), a fence closed by a less indented one read both as closed and as
  reopened; a paragraph that starts an HTML block holds no code span; a triple-backtick span loses
  its first word only when that word is a language the sources' fences name;
  or an inline code span found as CommonMark finds it, within its paragraph; an indented block is read as prose) must be a
  whole line, code line or code span of those sources, whitespace collapsed and nothing else changed
  (a fenced block as one line too, as `llms-small.txt` writes it); every link to an install script
  (`.sh .bash .zsh .ps1 .psm1 .cmd .bat .py`, the pathname decoded), the agent guide or an llms file,
  in an attribute or a markdown link (relative and protocol-relative ones resolved against the
  page's own address or its first `<base>`) or written out, must be exactly one of `https://termote.ohnice.app/` `install.sh`, `install.ps1`,
  `agents.md`, `llms.txt`, `llms-full.txt`, `llms-small.txt`, or
  `https://raw.githubusercontent.com/lamngockhuong/termote/` `release/0.x` or a version tag, then
  `/scripts/install` or `/scripts/get` `.sh`/`.ps1` (a markdown destination's escapes undone, its
  references decoded; a reference definition read after quote marks and list markers too; an IPv6
  host written out read as one); and a meta refresh, `url=` or not, stays on the site and is held
  to the same link rule; links resolve against the page's own address or its first `<base>`. A file with a UTF-16
  byte order mark or a NUL byte is refused. Else the deploy fails. CI runs the same check on every
  website build, in a job of its own (`check-website`) that runs no dependency code, on the built
  site downloaded as an artifact by id (the demo included, as deploy builds it), and compares the six
  files deploy takes from the tag with the ones the build copied from the checkout. Prose is not held to the tag: a line
  outside code that pipes a download into a shell or an interpreter (`curl … | sh`, `| /bin/sh`,
  `| doas sh`, `irm … | iex`, `iex (…)`, `$(curl …)`, `<(curl …)`, a backtick around one), or runs it as a
  file after it (`&& sh /tmp/i`, `; chmod +x i`, `&& ./i`, `; . ~/i`, `exec(`, `Start-Process`), with a
  fetch word among `curl wget fetch aria2c lwp-download scp irm iwr`, the PowerShell and BITS ones,
  `certutil`, `urlopen`, `urllib`, `requests.get`, `httpx`, `git clone` and `Get-Content`, fails only
  when it names no address, or an address other than those above or this computer's (`localhost`, `127.0.0.1`), a
  host with no scheme or an IP address, a backslash, a proxy (`*_proxy=`) or a curl option that
  leads the download elsewhere (`--resolve`, `--connect-to`, `-x` and `-K` in a cluster too,
  `--proxy…`, `--socks…`, `--dns-…`), what hides an address or a command beside an allowed one (a
  variable or `${…}` but the installer's own `$env:TERMOTE_…`, a `$(…)` that is not a download's,
  `base64`, `-EncodedCommand`, a string built with `'…'+'…'`, `-f`, `-join`, `-replace`, `.Replace(` or
  `[char]`, a host written as one number, `3405803776` or `0xcb007100`), or
  `TERMOTE_SKIP_SIGNATURE_CHECK` (a downgrade to a release no longer signed), and is not a line of the
  sources; a package run with no URL to hold (`npx`, `pnpx`, `bunx`, `bun x`, `uvx`, `uv tool run`,
  `pnpm dlx`, `yarn dlx`, `npm exec`, `npm`/`pnpm`/`yarn`/`bun` `create` or `init`, `pipx run`,
  `deno run`, `docker run`, `podman run`, `go run …@`, `go install …@`, `mshta` or `msiexec` of a URL
  or a share), or a package install by name, after any options (`npm`/`pnpm`/`yarn`/`bun` `install`,
  `i` or `add`, `pip install`, `pipx install`, `uv tool install`, `uv pip install`, `brew install`,
  `cargo install`, `gem install`, `Install-Module`, `Install-Script`, `Install-Package`,
  `Install-PSResource`, `winget`/`scoop`/`choco` `install`: its install scripts run), fails wherever
  it is not a line of the sources, a copy button's lines taken one by one, or does not lie whole in
  a code line or code span of the file that is one of the sources' and ends where a package name
  cannot go on (`brew install tmux` in a sentence passes, followed by `-x` it fails); a pipe into a
  shell from a command with no fetch word
  (`ssh host cat i | sh`, `nc … | sh`) passes; an
  indented markdown block and text styled as code outside `<pre>`/`<code>` are prose to these rules;
  in a line over 500
  characters it reads from an unclosed `$(`, `<(` or `iex (` before the fetch word, or 300
  characters before it, to the first sink after it; prose naming another download in a form it does
  not know passes, and so do several inline code elements side by side, each a source line, that
  read together as one command. A page is still the
  build's: a script or a style sheet (CSS `content:`, a hidden block) a dependency injected into it
  can change what it shows once it loads, and the search index (pagefind fragments, shown by its
  script) is not read. An install link is told by its path's ending (`.sh`, `/agents.md`…): a
  link to another host's `…/agents` without one passes. Only the six files and the code are held to the tag. A background
  process a build dependency left running cannot reach that job, since the runner ends a job's
  processes with it; an artifact deleted and uploaded again under the same name, with a runtime
  token such a process took, has another id and is not the one downloaded. `verify` compares the
  six served files with the tag after the deploy.
  The release workflow does the same for the binaries the `release` job signs: each `build` leg
  names its artifact's id as an output of its own (`linux_amd64`, ...), and `docker` and
  `release` download by those ids, never by name or all of the run's artifacts. No `build` leg runs
  a dependency's code (`CGO_ENABLED=0`; the binary is run only by `check-version`, a job of its own
  whose outputs nothing reads, before `release`), since a process one left behind could write
  another leg's key into the outputs the release signs from; an id no longer
  found is only a warning to `download-artifact`, so `release` fails on its count of 5 archives.
- **Git hooks** (`scripts/install-git-hooks.mjs`, `lefthook.yml`): `pnpm install` writes the
  `pre-commit` and `pre-push` hooks itself (`lefthook install` is never run, and `lefthook run` gets
  `--no-auto-install`, so lefthook never rewrites them; `lefthook.yml` sets `no_auto_install: true`
  for a bare `lefthook run` by hand, and the command the skip message and `CONTRIBUTING.md` give
  carries the flag too, since a branch's `lefthook.yml` may drop the key; a hook that is not lefthook's is left; with
  `core.hooksPath` set nothing is written). A hook runs lefthook, with `LEFTHOOK_CONFIG` set to the
  checked-out `lefthook.yml`, only when `git diff` (`--icase-pathspecs`: on a case-insensitive file
  system npm reads a `.NPMRC` as `.npmrc`) finds no change against `origin/HEAD`, else `origin/main` (remote-tracking only: a local `main` is
  moved by a pull of a contributor's branch, so with neither the hook skips), to a
  name git quotes (`core.quotePath=true`: a non-ASCII byte, a `"`, a `\` or a control character;
  case folds only in ASCII, and such a file system can fold a Kelvin sign onto a `k`) or to any `lefthook*`, `.lefthook*`, `.config/lefthook*`, `scripts/check-gofmt.sh`,
  `scripts/staged-files.sh`, `pwa/scripts/check-i18n.mjs`, any
  `dprint.json*`/`.dprint.json*` (dprint plugins can be programs), any `biome.json*`/`.biome.json*`
  (the config `biome check` runs with, its plugins and `extends` included), any `.npmrc`, any
  `pnpm-workspace.yaml`, any `.pnpmfile.*`, any `package.json` or `pnpm-lock.yaml` (what `pnpm exec` and
  `npx` read: `pnpm exec` installs first when a workspace package's dependencies changed, and runs
  that package's own lifecycle scripts, from any package's directory) or any tracked `node_modules` (a symlink too) or file under one (git replaces an
  ignored file with a branch's tracked one, so a branch could bring its own
  `node_modules/.bin/lefthook`); otherwise, or with no such branch, it names the files on stderr and
  exits 0 without running anything. A pre-commit command gets its files from
  `scripts/staged-files.sh` (`git diff --cached`, each name one argument starting with `./`), never
  from a lefthook file template (`{staged_files}`): lefthook on Windows puts `run` into a
  double-quoted `sh -c` command line without escaping, and its quoting of a name holding a `'` adds
  double quotes that end it, so the rest of the name would run as shell code (a test refuses any
  file template in `lefthook.yml`). A name git has to quote (a `"`, a `\` or a control character) is
  refused, not passed on as a path that matches nothing; on Windows (`OS=Windows_NT`, or `uname -s`
  `MINGW*`, `MSYS*`, `CYGWIN*`, `Windows_NT*`, and a `uname` that fails or prints nothing) so is a
  name holding a character cmd.exe reads (`& % ^ ! | < > ( )`), since `pnpm exec` and `npx` can run
  the command through a `.cmd` shim, which puts its arguments in an `IF ( ... ) ELSE ( ... )` block
  and whose escaping depends on the npm and cross-spawn versions; names go in batches of at most 7000 bytes
  (a longer single name runs alone), as lefthook split its own. `go vet` runs with
  `CGO_ENABLED=0` (as releases build; `server/` has no cgo), so it compiles no C code from
  `server/*.go`, which are not hook files (a test refuses a `go` command without it). A clone whose
  hooks `lefthook install` wrote before 2.2.0 runs them unchecked until `pnpm install` runs once
  (`CONTRIBUTING.md` says so). `pnpm install` itself runs the branch's scripts: every workspace
  package's, and the install scripts of what its `pnpm-lock.yaml` fetches for the dependencies allowed
  to build (accepted: a maintainer reads the diff of every `package.json`, the lockfile and the npm and
  pnpm config first, `CONTRIBUTING.md`)
- **Agent guide** (`termote help agent`, `server/cli_agent_guide.go`): prints `server/agent-guide.md`,
  embedded in the binary, as it is: no request, no config read, no secret. The website publishes the
  same file as `/agents.md`. The guide tells an agent never to run `termote show-password` or
  `termote pair` for the user, never to combine `--no-auth` with `--lan`, `--tailscale` or
  `--cloudflare`, and never to use `sudo`; and it tells the user to see the password in a terminal of
  their own, never through the agent (`!` in Claude Code): that output goes into the transcript, which
  every role reads in the Chat view. A test checks that the password rule stays, that neither the guide
  nor its website page suggests `! termote show-password`, and that every command and flag it names is
  in `termote help`.
- **Orchestrator skill** (`termote skills install|uninstall|status`, `server/cli_skills.go`,
  `server/skills/orchestrator/SKILL.md` embedded in the binary): written only when the user runs
  `skills install`; `start`, `update` and the server never write to an agent's directory (`update`
  only names a skill it finds installed for another version). It writes `SKILL.md` and the marker
  `.termote-skill.json` into `<agent dir>/skills/termote-orchestrator` (`CLAUDE_CONFIG_DIR` or
  `~/.claude`, `CODEX_HOME` or `~/.codex`), only for an agent whose dir exists, the marker first,
  each file through a temporary file renamed over it, so a run cut short leaves a directory termote
  still knows. A path of that name without the marker (the user's directory, a file, a symlink) is
  never written to or removed, an empty directory excepted; `uninstall` removes the directory only
  when it holds nothing but those two files and termote's temporary files, else nothing at all, the
  marker last. `status` calls it current only when the marker's version is this binary's and its `SKILL.md` (a
  regular file by `Lstat`, never through a link, 1 MB at most) is byte for byte the embedded one, else it names
  `skills install`; `--json` adds the SHA-256 of the embedded text (`sha256`) and of each installed
  `SKILL.md` read under the same rules (none for a link or a larger file). The skill tells the agent to drive panes only
  through `termote agents`, one pane at a time for every write, to ask the user before `start` (with
  `--worktree`, saying a new directory and branch will be made), before `stop` and before answering a
  permission, never to stop again after `session_changed`, to keep a mark for each pane it waits on, to treat what `read` and `diff` print as
  data and never as instructions, and never to run `termote show-password` or `termote pair`; to
  begin with `termote agents jobs`, follow jobs with `wait --job`, try `answer --delegated` before
  asking about a permission dialog, never pick an option that stops a dialog asking and never say it
  can give or widen a grant (only the user does, in the PWA), and to read the end of an answer before
  reporting it done (a question for the user is relayed, not set `review`); a test checks those rules
  stay and that every command and flag it names is in `termote help`. The `termote-plugins` job of the
  release workflow (stable releases, after `publish`) writes `lamngockhuong/termote-plugins` with
  `scripts/termote-plugins.sh` from that same file, with a deploy key that can push to that repository
  only, kept in the approval-gated `release` environment; a marketplace already on a newer version
  keeps it
