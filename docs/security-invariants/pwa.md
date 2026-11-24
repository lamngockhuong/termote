# Security invariants: PWA

Part of the [security invariants](README.md): notifications, settings proposals and the interactive demo.

- **Notifications / Web Push** (`/api/mux/push/*`, `caps.push`): the setting "Notify when an
  agent needs me" notifies when an agent becomes `blocked` or ends a turn (`working` →
  `done`/`idle`; a missing or `unknown` status keeps the last known one, a pane without an
  agent forgets it (tmux answers a slow lookup with the last agents found, not none), a first
  sighting never notifies; the PWA and `server/push_watch.go` share `server/testdata/agent-transitions.json`).
  `GET push/key` (auth, `hostGuard`) returns only the public key; `POST`/`DELETE push/subscribe`
  go through `writeGuard` (same-site JSON), `requireWriteRole` (a view-only client
  gets 403 `view_only`) and the 8 KB body limit, answer 200 `{ok}` (400 `invalid_endpoint`/`invalid_keys`,
  503 `push_unavailable`), and no route lists or echoes a subscription. Endpoints must be HTTPS
  on 443 at `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`,
  `*.push.apple.com` or `*.notify.windows.com` (no IP literal, no userinfo, 2048 bytes), checked
  at subscribe, at load and before each send; the dialled address must be public (`Dialer.Control`
  after DNS: no loopback, private, link-local, CGNAT, ULA, unspecified, multicast or IPv4-mapped),
  no proxy, no redirects. The payload is ids only (`{groupId, tabId, paneId, kind}`, aes128gcm,
  VAPID ES256 with `sub` `https://termote.ohnice.app` and 12 h tokens, stdlib only); `Topic` is an
  HMAC of pane and kind under a random key and `Urgency` is `high` for both kinds, so the push
  service learns neither. The service worker reads the names from the snapshot (3 s) and strips
  the characters `visibleUnsafe` marks (64 characters max); the pane's name (`Pane.Name`), when
  it has one, goes before the agent's; `Pane.Title` is never used; a workspace hidden on this
  browser (`/__hidden` in the `termote-prefs` cache, written by `hooks/use-hidden-workspaces.ts`,
  keyed on the push's `machineId` and the group's name trimmed, as `hiddenKey` builds it) loses
  its name, and every one does when that entry is there but cannot be read (none is hidden
  without it); the page's own notifications do the same, shown for a while or not; every push
  shows a notification (Safari revokes silent ones). State: `<stateDir>/push` (0700; `vapid.json` and
  `subscriptions.json` 0600, owner-only ACL on Windows, `%LOCALAPPDATA%` so it does not roam, no
  DPAPI), already on the Files deny list; at most 20 subscriptions, the least recently subscribed
  evicted; each bound to `gen` = HMAC(bindKey, user + password), so `start --fresh` or a new
  password drops every device until it signs in again (its page re-subscribes). One made by a
  paired device carries its id and goes when the device ends (revoke, expiry, a cascade, a reload
  that no longer finds it), and at start for a device no longer live. One made by a browser signed
  in with the password carries its session id and goes when the session ends (revoked, signed out,
  expired, pushed out), and at start, since sessions live in memory; the watcher sends to none whose
  session has ended or whose device is revoked or past its `validUntil` (`pushStore.sendable`,
  `sessionAlive`/`deviceAlive`, the expiry on the wall clock), and reads no pane and polls no
  machine while only such ones are left (`anySendable`), since the timers that remove them run
  on the monotonic clock and fire late after the host slept; the store asks whether the session or
  device is still alive under its own lock when it adds one (the device store's lock taken after the
  push store's, never the reverse), so a subscribe racing its end is refused (401 `signed_out`)
  rather than left behind its removal; one made with Basic auth
  carries neither and stays, like one subscribed before session ids were recorded. One a
  device made before this (no id) reads as the password's until its page subscribes again (on load,
  and every 10 minutes while visible), so a device revoked before that keeps receiving pushes. Only 404/410
  drop a subscription; 401/403 are logged and kept ("check the server clock" when all fail); a log
  line names the push service's host, never the endpoint's path (`sendPush` returns a `*url.Error`'s
  cause, not the error that quotes the URL);
  429 and timeouts back the push service off (`Retry-After`, at most 1 h). The watcher runs only
  from `runServer`, every 5 s and only with a subscription, reading tmux through `peekSnapshot`,
  which reads the sessions there and never recreates the default one; the service worker names a
  push from `snapshot?peek=1`, which reads the same way. The PWA subscribes only while the active
  worker answers version 2 (`notify-sw.js` has the push handler), and repeats the subscribe POST
  on load, every 10 minutes while shown and when shown again. Log out deletes this device's subscription first.
  A click follows only a pane link (`#/s/...`): the worker keeps it in Cache Storage
  (`termote-notify`, for iOS, which drops the message to a resumed home screen app) and the page
  takes it once, kept since the page was last hidden and at most 60 s old, through
  `parseDeepLink`, and opens it as any deep link. Neither `focus()` nor `openWindow()` waits on it.
  The CSP is unchanged: the server, not the page, talks to push services. **App badge** (setting
  `appBadge`, on by default, `pwa/src/utils/app-badge.ts`): the page sets the Badging API count to the
  panes whose agent is `blocked` or `done` after every poll and when shown again; the service worker
  sets it on a push from the same `snapshot?peek=1` read it names the push from, never from the
  payload, which stays ids only: a revoked device's push gets 401/403 and clears the badge, an
  offline read keeps it, a visible page is left to set its own, and the setting is read from
  Cache Storage (`termote-prefs`, `/__badge`, on when unreadable). Log out and any 401 of the
  snapshot or health read clear it. The container opens
  `/home/termote/.local/state` 1777 like `.cache`/`.config`
- **Settings proposals** (`termote settings schema|propose`, `server/cli_settings.go`,
  `server/pwa_settings.go`, `server/pwa_settings_schema.json`, `server/settings_proposal*.go`,
  `caps.settingsProposals`; PWA `pwa/src/utils/settings-registry.ts`,
  `hooks/use-settings-proposal.ts`, `settings-proposal-bar.tsx`, `settings-diff-dialog.tsx`,
  `settings-transfer-section.tsx`): an agent proposes PWA settings and each browser decides for
  itself; the server never learns a device's settings and never applies anything.
  `POST /api/mux/settings/proposal` checks `isLocalSocket` first: TCP and the machine bridge get 403
  `cli_only` with or without sign-in, `--no-auth` included. `writeGuard` lets it by (the CLI sends
  JSON from `termote.local-socket`) and `requireWriteRole` adds nothing: only processes of the
  server's OS user open that socket, and they are `authLocal`, full. The body is at most 32 KiB
  (413 `too_large`) and is checked again with the CLI's validator (`validateSettingsProposal`, every
  key in the schema, values in its ranges; 400 `invalid_settings` with `problems: [{key, reason}]`);
  the CLI's own check is never trusted. Free text (`terminalFont`) and each `findExcludes` name refuse
  control characters and characters that show nothing (`hiddenRune`, as prompt templates), so the
  before/after table hides nothing; a name is one directory name (the PWA's `findExcludeProblem`
  rules), and a chord must be in normal form and not one every platform refuses. The server keeps
  only the newest proposal, in memory, for 15 minutes on the wall clock (`Round(0)`, so a machine
  that slept compares as the PWA does), and writes one `audit: settings_proposed` line with the id
  and the key names, never a value. `GET` of the same path (every role: a view-only browser applies
  its own settings too) goes through `crossSiteRejection` with `no-store`; 404 `not_found` without
  one. A new proposal queues one Web Push `{"kind":"settings"}` (no id, no value) at most every 5
  minutes, on a topic of its own; the service worker shows it without reading anything and opens
  the server's own page, never a window open on a machine. The PWA reads `GET` from `LOCAL_API`
  only while no machine is open, applies nothing until Apply in the before/after table, applies only
  the proposal the dialog opened on (a newer id turns Apply off), and keeps the ids applied or
  dismissed in `termote-settings-proposal-seen` (the last 10). The settings that need a permission in
  a click (`notifyAgents`, `appBadge`) and the device's own markers (`welcomeSeenVersion`,
  `languageNoticeSeen`, `hasSeenLocalhostNotice`) are `deviceOnly` in the schema and
  `DEVICE_ONLY_KEYS` in the PWA: never proposed (the CLI and the server refuse them), never exported,
  never imported, never written by `applySettings`. Import reads at most 64 KiB, and every value goes
  through the setting's resolver: one the resolver would change, or with a hidden character, shows as
  skipped, never replaced by a default. Limits: the container has no local socket, so `settings
  propose` refuses there; a proposal is lost when the server restarts; every browser open on the
  server sees it, and one Dismiss there is enough
- **Interactive demo** (`pwa/src/demo/`, `pnpm --filter termote build:demo`, published at `/demo/`
  of the website by `deploy-website.yml`): the PWA built with `--mode demo` answers its own
  requests in the browser from fixtures. It talks to no termote server and holds no credential.
  Vite replaces `import.meta.env.MODE` at build time, so the release build drops the branch that
  loads it (`pwa/src/main.tsx`) and its chunk; CI's build (`ci.yml`) fails when the non-demo
  build holds its marker (`DEMO_MARKER`, `termote-demo-mode`); `release.yml` does not repeat that
  check. `isDemo` (`pwa/src/utils/demo.ts`) only turns off the install offer and notifications,
  never a check. The fake `fetch` answers only `/api/mux/*` on
  the page's own origin and the fake WebSocket only the stream path; anything else goes to the
  browser's own. The demo build has its own CSP (`pwa/demo-csp.json`, a meta tag put in by
  `demoPolicy`, `connect-src 'self' https://api.github.com`), no manifest and no service worker
  (`VitePWA` disabled)
