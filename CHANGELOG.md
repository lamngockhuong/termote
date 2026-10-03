# Changelog

## [1.7.1](https://github.com/lamngockhuong/termote/compare/v1.7.0...v1.7.1) (2026-10-03)


### Bug Fixes

* harden the server, CLI, PWA and release pipeline found by a security review ([#306](https://github.com/lamngockhuong/termote/issues/306)) ([ac3fd35](https://github.com/lamngockhuong/termote/commit/ac3fd35f890955626676bc22c463bb3a17d552db))
* **server:** log failed logins and rate-limit each IPv6 /64 ([#309](https://github.com/lamngockhuong/termote/issues/309)) ([daf0551](https://github.com/lamngockhuong/termote/commit/daf0551c79a26203fbff797bbea7ba3f64c5856a))

## [1.7.0](https://github.com/lamngockhuong/termote/compare/v1.6.0...v1.7.0) (2026-10-03)


### Features

* send a Content-Security-Policy and other security headers ([#303](https://github.com/lamngockhuong/termote/issues/303)) ([1ee6560](https://github.com/lamngockhuong/termote/commit/1ee656075eaf597bb458a7ab340990aa1c883120)), closes [#247](https://github.com/lamngockhuong/termote/issues/247)


### Bug Fixes

* read a permission dialog's No drawn over a wrapped row ([#302](https://github.com/lamngockhuong/termote/issues/302)) ([8c5582d](https://github.com/lamngockhuong/termote/commit/8c5582d832ddc55932af0e17217511cb773a616e))
* **server:** read a permission dialog's No drawn over a wrapped row ([8c5582d](https://github.com/lamngockhuong/termote/commit/8c5582d832ddc55932af0e17217511cb773a616e)), closes [#300](https://github.com/lamngockhuong/termote/issues/300) [#299](https://github.com/lamngockhuong/termote/issues/299)
* show a long dialog whole on its card instead of cutting it ([#298](https://github.com/lamngockhuong/termote/issues/298)) ([e6ebe3b](https://github.com/lamngockhuong/termote/commit/e6ebe3b173b7c15dcd5f1981644932b147447b82))

## [1.6.0](https://github.com/lamngockhuong/termote/compare/v1.5.1...v1.6.0) (2026-10-02)


### Features

* configurable Basic auth username ([3fddb81](https://github.com/lamngockhuong/termote/commit/3fddb814cc5298647632c5c90cccec90dbbfacc0))
* configurable Basic auth username ([#236](https://github.com/lamngockhuong/termote/issues/236)) ([#283](https://github.com/lamngockhuong/termote/issues/283)) ([3fddb81](https://github.com/lamngockhuong/termote/commit/3fddb814cc5298647632c5c90cccec90dbbfacc0))
* read-only Chat view for Codex panes ([#286](https://github.com/lamngockhuong/termote/issues/286)) ([7e5e5e5](https://github.com/lamngockhuong/termote/commit/7e5e5e51ceca2f5d168d2a316ac28b3026980149))
* send messages and answer approval dialogs in Codex panes ([#287](https://github.com/lamngockhuong/termote/issues/287)) ([cfee36b](https://github.com/lamngockhuong/termote/commit/cfee36bbe2de11be0f1ce2137affda6528f59a89))

## [1.5.1](https://github.com/lamngockhuong/termote/compare/v1.5.0...v1.5.1) (2026-10-02)


### Bug Fixes

* **herdr-plugin:** find termote outside Herdr's PATH and show why it fails ([#281](https://github.com/lamngockhuong/termote/issues/281)) ([eb4005b](https://github.com/lamngockhuong/termote/commit/eb4005b067e1257a2aa6ac66ba566796e07b9bb1))

## [1.5.0](https://github.com/lamngockhuong/termote/compare/v1.4.0...v1.5.0) (2026-10-02)


### Features

* Herdr plugin for Termote ([#235](https://github.com/lamngockhuong/termote/issues/235)) ([#279](https://github.com/lamngockhuong/termote/issues/279)) ([257247f](https://github.com/lamngockhuong/termote/commit/257247fa53ae82199e360de2b0a746b8da41e0f0))

## [1.4.0](https://github.com/lamngockhuong/termote/compare/v1.3.0...v1.4.0) (2026-10-02)


### Features

* answer AskUserQuestion options with previews and keep the terminal size under the Chat view ([#257](https://github.com/lamngockhuong/termote/issues/257)) ([8517548](https://github.com/lamngockhuong/termote/commit/851754808c1a12a7ecd80a197132d401a5cc4aac))
* answer AskUserQuestion with free text from the Chat view ([#267](https://github.com/lamngockhuong/termote/issues/267)) ([5c4ccb1](https://github.com/lamngockhuong/termote/commit/5c4ccb1e16ef2e72ecce0da0790cc72f65e98c02))
* answer multi-question AskUserQuestion wizards from the Chat view ([#254](https://github.com/lamngockhuong/termote/issues/254)) ([89521b2](https://github.com/lamngockhuong/termote/commit/89521b2e4a81386746df92e368d75a6638c664eb))
* **pwa:** Files and Changes views of a pane's directory ([#261](https://github.com/lamngockhuong/termote/issues/261)) ([2924cd7](https://github.com/lamngockhuong/termote/commit/2924cd776c05b34b1b8c31c09ebc845cc0637168))
* **pwa:** Markdown preview in the Files and Changes views ([adc6772](https://github.com/lamngockhuong/termote/commit/adc67728d345adaa8262417643bcefce1e49c794)), closes [#265](https://github.com/lamngockhuong/termote/issues/265)
* **pwa:** Markdown preview in the Files and Changes views ([#265](https://github.com/lamngockhuong/termote/issues/265)) ([#273](https://github.com/lamngockhuong/termote/issues/273)) ([adc6772](https://github.com/lamngockhuong/termote/commit/adc67728d345adaa8262417643bcefce1e49c794))
* **pwa:** one view menu button in the mobile header ([#269](https://github.com/lamngockhuong/termote/issues/269)) ([470c587](https://github.com/lamngockhuong/termote/commit/470c587e441232944126f393ef8d4d038cd28e2e))
* **pwa:** resize the desktop side panel, or maximize it over the main view ([dec2b27](https://github.com/lamngockhuong/termote/commit/dec2b27368965061d16ce087e27964a36fefdbe7)), closes [#272](https://github.com/lamngockhuong/termote/issues/272)
* **pwa:** resize the desktop side panel, or maximize it over the main view ([#272](https://github.com/lamngockhuong/termote/issues/272)) ([#277](https://github.com/lamngockhuong/termote/issues/277)) ([dec2b27](https://github.com/lamngockhuong/termote/commit/dec2b27368965061d16ce087e27964a36fefdbe7))
* **server:** list plugin commands and symlinked skills in slash suggestions ([4fde30d](https://github.com/lamngockhuong/termote/commit/4fde30d786cb69a944e6af27d478e3395a53c131)), closes [#271](https://github.com/lamngockhuong/termote/issues/271)
* **server:** list plugin commands and symlinked skills in slash suggestions ([#271](https://github.com/lamngockhuong/termote/issues/271)) ([#278](https://github.com/lamngockhuong/termote/issues/278)) ([4fde30d](https://github.com/lamngockhuong/termote/commit/4fde30d786cb69a944e6af27d478e3395a53c131))
* **server:** read-only files and git changes API for a pane's directory ([#260](https://github.com/lamngockhuong/termote/issues/260)) ([3b39893](https://github.com/lamngockhuong/termote/commit/3b39893ad654bc5324ea7e32071b0c14dc5400b0))
* slash command suggestions in the Chat composer ([#266](https://github.com/lamngockhuong/termote/issues/266)) ([#270](https://github.com/lamngockhuong/termote/issues/270)) ([2730577](https://github.com/lamngockhuong/termote/commit/27305774c667c5565f05ef36f43f4b7dab6d4aa2))


### Bug Fixes

* **pwa:** Markdown preview keeps its place, drops highlights no longer needed ([#276](https://github.com/lamngockhuong/termote/issues/276)) ([845ec8e](https://github.com/lamngockhuong/termote/commit/845ec8eed879cb394a9acdd8995999d8fa420aea)), closes [#274](https://github.com/lamngockhuong/termote/issues/274)
* **pwa:** Markdown preview keeps its place, drops highlights no longer needed ([#276](https://github.com/lamngockhuong/termote/issues/276)) ([4ed6ec5](https://github.com/lamngockhuong/termote/commit/4ed6ec5164a81cf98f24f27fbba9f5094912aab2)), closes [#274](https://github.com/lamngockhuong/termote/issues/274)
* **pwa:** sessions sheet, More menu toggle, font size only in the terminal ([#268](https://github.com/lamngockhuong/termote/issues/268)) ([5112498](https://github.com/lamngockhuong/termote/commit/51124986a3f02608006d42cd0c74346d8d0dbee0))

## [1.3.0](https://github.com/lamngockhuong/termote/compare/v1.2.0...v1.3.0) (2026-10-01)


### Features

* close a pane from the pane strip ([#253](https://github.com/lamngockhuong/termote/issues/253)) ([053a72d](https://github.com/lamngockhuong/termote/commit/053a72dd76e601aed6cab32c72a1a309a1d90b25))
* **pwa:** ask for confirmation before closing a session ([#251](https://github.com/lamngockhuong/termote/issues/251)) ([f58dad8](https://github.com/lamngockhuong/termote/commit/f58dad87daea7419f7c6f870c12bfb570587156e))
* **pwa:** filter the session sidebar by agent status ([#248](https://github.com/lamngockhuong/termote/issues/248)) ([e66eb4d](https://github.com/lamngockhuong/termote/commit/e66eb4da5cc8368a0131178f5e9d710940d623b1))


### Bug Fixes

* **pwa:** make the desktop sidebar open and close smoothly ([#250](https://github.com/lamngockhuong/termote/issues/250)) ([9f9bb56](https://github.com/lamngockhuong/termote/commit/9f9bb56ce968faf46e82a9821019e9135ade138d))

## [1.2.0](https://github.com/lamngockhuong/termote/compare/v1.1.0...v1.2.0) (2026-10-01)


### Features

* add a Chat view for panes running Claude Code ([#245](https://github.com/lamngockhuong/termote/issues/245)) ([d0247c7](https://github.com/lamngockhuong/termote/commit/d0247c732f3ed3d9c633b79f9b4de9eeacc3a9d7)), closes [#233](https://github.com/lamngockhuong/termote/issues/233)
* **pwa:** redesign the PWA interface with three selectable styles ([#239](https://github.com/lamngockhuong/termote/issues/239)) ([6de5c72](https://github.com/lamngockhuong/termote/commit/6de5c725338c34bff661f2e059bc1da3bcef1a3e)), closes [#232](https://github.com/lamngockhuong/termote/issues/232)
* zoom the font on herdr panes and let the PWA fit them to the device ([#243](https://github.com/lamngockhuong/termote/issues/243)) ([0bae739](https://github.com/lamngockhuong/termote/commit/0bae73944e8a7447a33f334606e14fde0e4cb9be))


### Bug Fixes

* **pwa:** make sheets, menus and native keys render correctly on iOS ([#242](https://github.com/lamngockhuong/termote/issues/242)) ([c5b9a7b](https://github.com/lamngockhuong/termote/commit/c5b9a7bdb2f423870c845f6a1b0f71ebd711c973))
* **pwa:** make touch scrolling follow the finger ([#244](https://github.com/lamngockhuong/termote/issues/244)) ([78ef5dc](https://github.com/lamngockhuong/termote/commit/78ef5dcad62cdf7c22cd0098b126330030fa6582))

## [1.1.0](https://github.com/lamngockhuong/termote/compare/v1.0.1...v1.1.0) (2026-09-29)


### Features

* run the herdr backend inside the container ([#231](https://github.com/lamngockhuong/termote/issues/231)) ([9bd1250](https://github.com/lamngockhuong/termote/commit/9bd12505494db1b8e9d998c90cb3817dc7fc932c))
* **server:** support the herdr backend on native Windows ([#229](https://github.com/lamngockhuong/termote/issues/229)) ([d464343](https://github.com/lamngockhuong/termote/commit/d464343af0610afac370c2c0dac77660ef9f5875))

## [1.0.1](https://github.com/lamngockhuong/termote/compare/v1.0.0...v1.0.1) (2026-09-28)


### Bug Fixes

* **pwa:** hide tmux-only settings and help on the herdr backend ([#224](https://github.com/lamngockhuong/termote/issues/224)) ([a3daf39](https://github.com/lamngockhuong/termote/commit/a3daf393443e2bdcf81f922f71a1f08e664001bf))
* **pwa:** keep the agent status badge a round circle on the session icon ([#226](https://github.com/lamngockhuong/termote/issues/226)) ([6c1455a](https://github.com/lamngockhuong/termote/commit/6c1455a9b6500cc77ca33e8cf2da4f0eb20ec18b))
* **server:** require auth for encoded paths that only look like workbox scripts ([#228](https://github.com/lamngockhuong/termote/issues/228)) ([5045668](https://github.com/lamngockhuong/termote/commit/5045668d6a2462f2da5a2ecfce9b3a3e1e60e63c))

## [1.0.0](https://github.com/lamngockhuong/termote/compare/v0.1.0...v1.0.0) (2026-09-28)


### ⚠ BREAKING CHANGES

* config and logs move to XDG paths, release assets are renamed, the shims no longer run installed releases, and 1.0 does not upgrade a 0.x install in place.
* release assets, the log service name and the pid/log file names change, and install no longer stops a 0.x server started from tmux-api/tmux-api.
* termote streams the terminal itself over /api/mux/stream (no ttyd), install/update logic moves into the Go CLI with thin termote.sh/termote.ps1 shims, and requests pass a Host allowlist plus Origin/Content-Type and stream-token guards. Uninstall 0.x, then install 1.0 (see "Upgrading from 0.x" in the README).
* the container image no longer contains ttyd, and the interactive menu no longer uses gum.
* **api:** /terminal/ is gone; terminals stream over /api/mux/stream.
* **api:** All /api/tmux routes removed; use /api/mux instead

### Features

* **api:** add herdr backend behind the Mux interface ([6d7c8f5](https://github.com/lamngockhuong/termote/commit/6d7c8f5a48c4ba7f4928285e880cf82525d955de))
* **api:** drop the ttyd proxy; /terminal/ returns 410 ([5567adc](https://github.com/lamngockhuong/termote/commit/5567adc59eda0922b48137b5f3711345cccb143c))
* **api:** replace /api/tmux with /api/mux behind a Mux interface ([6a5fe94](https://github.com/lamngockhuong/termote/commit/6a5fe94c7580f3b174eada65f7a4a47b483a190e))
* **api:** stream terminals over /api/mux/stream WebSocket ([5e39bb9](https://github.com/lamngockhuong/termote/commit/5e39bb9db4d1534ecd0448a1d09d62b69749cac2))
* **cli:** add termote subcommands to the tmux-api binary ([83c074b](https://github.com/lamngockhuong/termote/commit/83c074b21dfc665502352e30b07e68106d876404))
* install with two commands and run the server as an OS service ([#216](https://github.com/lamngockhuong/termote/issues/216)) ([45a3126](https://github.com/lamngockhuong/termote/commit/45a3126623b54e8bcf14d8d157c677981ea52c8c))
* **pwa:** group tabs by workspace and show herdr agent status ([dfa8878](https://github.com/lamngockhuong/termote/commit/dfa88788ac1c0d110d0ad1ba8ac2c01c97952681))
* **pwa:** render Nerd Font icons in the terminal ([#221](https://github.com/lamngockhuong/termote/issues/221)) ([e28f29a](https://github.com/lamngockhuong/termote/commit/e28f29abea583e0ad4b1e9fe46105e87c58436d7))
* **pwa:** render the terminal with xterm.js over /api/mux/stream ([6ab9d10](https://github.com/lamngockhuong/termote/commit/6ab9d10bb9cef99a04075da62b0907160d13233f))
* **pwa:** use /api/mux client and update session handling ([278b467](https://github.com/lamngockhuong/termote/commit/278b467463055f84dfa4c29fe5aa44832bb1115f))
* Termote 1.0 ([#210](https://github.com/lamngockhuong/termote/issues/210)) ([bf72c10](https://github.com/lamngockhuong/termote/commit/bf72c100f548b2ab4471a0ec48806f1e215d7742))
* turn termote.sh and termote.ps1 into shims over the Go CLI and drop ttyd from the container ([05307a7](https://github.com/lamngockhuong/termote/commit/05307a782a64434a9bd85b10d961419ea4c1261d))


### Bug Fixes

* **api:** create the tmux session when it is missing ([3c17d6e](https://github.com/lamngockhuong/termote/commit/3c17d6e95bbf5d94842394dad0dff711164514e9))
* **api:** keep the password out of terminal environments ([4e55abd](https://github.com/lamngockhuong/termote/commit/4e55abdec2b4cb4d50e61be59a6eb8cef7c204ac))
* **api:** keep the Secure cookie behind a container proxy and rate-limit host rejection logs ([72abcc1](https://github.com/lamngockhuong/termote/commit/72abcc1fe0a3abef16ca2588ca81fdbd3639e80e))
* **api:** remove legacy /api/tmux handlers left after the mux migration ([7a828a2](https://github.com/lamngockhuong/termote/commit/7a828a2725d6cda5aea4aa70d694d2a6c44a9ad1))
* **cli:** print one line when relinking and match Windows 8.3 install paths ([83578c9](https://github.com/lamngockhuong/termote/commit/83578c9374904164c34cb0478436cfc680ce1d7f))
* **herdr:** scroll the pane's history with the mouse wheel ([#220](https://github.com/lamngockhuong/termote/issues/220)) ([2430aff](https://github.com/lamngockhuong/termote/commit/2430affd9f4e848b84f6e5ad0d3e0869feae24c7))
* **pwa:** scroll with swipes and keep the terminal visible with the keyboard open ([#222](https://github.com/lamngockhuong/termote/issues/222)) ([30e8180](https://github.com/lamngockhuong/termote/commit/30e8180950b64ead2dba9e18206f3f04e45e45b2))


### Code Refactoring

* rename tmux-api to server and its binary to termote ([#215](https://github.com/lamngockhuong/termote/issues/215)) ([1ed0fc9](https://github.com/lamngockhuong/termote/commit/1ed0fc94c244298afe4a363f59150c83524e7efe))

## [0.1.0](https://github.com/lamngockhuong/termote/compare/v0.0.16...v0.1.0) (2026-07-13)


### Features

* **windows:** CLI parity — update, logs follow, menu, help/docs ([#114](https://github.com/lamngockhuong/termote/issues/114)–[#117](https://github.com/lamngockhuong/termote/issues/117)) ([#194](https://github.com/lamngockhuong/termote/issues/194)) ([df909ae](https://github.com/lamngockhuong/termote/commit/df909ae7bf2181b94a3c87a2530fea170f8dbdb7))


### Bug Fixes

* **deps:** update dependency @astrojs/starlight to v0.41.3 ([#188](https://github.com/lamngockhuong/termote/issues/188)) ([3426096](https://github.com/lamngockhuong/termote/commit/3426096041577fc5ffaf688991a1aa829eb66016))
* **windows:** fix interactive menu rendering and Ctrl+C handling ([#184](https://github.com/lamngockhuong/termote/issues/184)) ([13d6855](https://github.com/lamngockhuong/termote/commit/13d6855c56670683e368088322549c89657d47f8))


### Miscellaneous Chores

* release 0.1.0 ([#196](https://github.com/lamngockhuong/termote/issues/196)) ([1a8b7af](https://github.com/lamngockhuong/termote/commit/1a8b7af5bb3ed36c0633b4bdee03aacbac023928))

## [0.0.16](https://github.com/lamngockhuong/termote/compare/v0.0.15...v0.0.16) (2026-07-12)


### Features

* **windows:** ttyd source selection (official vs fork) for native installer ([#178](https://github.com/lamngockhuong/termote/issues/178)) ([3a794fa](https://github.com/lamngockhuong/termote/commit/3a794fa56959fdba2fb2e9bd627ed0855cbad781))


### Bug Fixes

* **deps:** update astro monorepo to v6.4.8 ([ed29ec7](https://github.com/lamngockhuong/termote/commit/ed29ec76e387329f994b4928c3f89e68e39965ce))
* **deps:** update dependency astro to v6.1.7 ([#129](https://github.com/lamngockhuong/termote/issues/129)) ([170046d](https://github.com/lamngockhuong/termote/commit/170046d4006d5fa05f27658cea019bb04a05222e))
* **deps:** update dependency astro to v6.4.8 ([#161](https://github.com/lamngockhuong/termote/issues/161)) ([ed29ec7](https://github.com/lamngockhuong/termote/commit/ed29ec76e387329f994b4928c3f89e68e39965ce))
* **deps:** update dependency lucide-react to v1.24.0 ([#168](https://github.com/lamngockhuong/termote/issues/168)) ([15de057](https://github.com/lamngockhuong/termote/commit/15de057149681fe41b2e7eb1ca1e29d7857f235d))
* **deps:** update dependency sharp to v0.35.3 ([#177](https://github.com/lamngockhuong/termote/issues/177)) ([45c29b3](https://github.com/lamngockhuong/termote/commit/45c29b3c41b8e43ee03b12049ab535ef69513ec0))
* **deps:** update react monorepo ([#175](https://github.com/lamngockhuong/termote/issues/175)) ([081c267](https://github.com/lamngockhuong/termote/commit/081c267e2246c12f5174f718883bdf29a10a48e3))

## [0.0.15](https://github.com/lamngockhuong/termote/compare/v0.0.14...v0.0.15) (2026-04-11)


### Features

* **pwa:** add 5 simple features for improved UX ([#145](https://github.com/lamngockhuong/termote/issues/145)) ([bedbdde](https://github.com/lamngockhuong/termote/commit/bedbdde7f4a89204cb84a767640d93a7c05c9e07))

## [0.0.14](https://github.com/lamngockhuong/termote/compare/v0.0.13...v0.0.14) (2026-04-11)


### Features

* add sponsor buttons (MoMo, GitHub Sponsors, Buy Me a Coffee) ([#142](https://github.com/lamngockhuong/termote/issues/142)) ([209fa6f](https://github.com/lamngockhuong/termote/commit/209fa6ffbba49ee226d12ca31e1ec9a306c994f5))


### Bug Fixes

* **website:** approve pnpm v10 build scripts via pnpm-workspace.yaml ([#144](https://github.com/lamngockhuong/termote/issues/144)) ([5ad4b4a](https://github.com/lamngockhuong/termote/commit/5ad4b4aca898bc64e3bb19cdac8d5b8f4e93d13b))

## [0.0.13](https://github.com/lamngockhuong/termote/compare/v0.0.12...v0.0.13) (2026-04-10)


### Features

* **pwa:** replace emoji with lucide icons in help modal ([#139](https://github.com/lamngockhuong/termote/issues/139)) ([cf6d35e](https://github.com/lamngockhuong/termote/commit/cf6d35ee02acdb541b24c9dd8dfd8e843fb3b10d))

## [0.0.12](https://github.com/lamngockhuong/termote/compare/v0.0.11...v0.0.12) (2026-04-04)


### Features

* **cli:** add version command ([#126](https://github.com/lamngockhuong/termote/issues/126)) ([c264103](https://github.com/lamngockhuong/termote/commit/c2641030d72e2db49010ba03bd5b9464ce9ceb37))
* **cli:** add version command to show installed version ([c264103](https://github.com/lamngockhuong/termote/commit/c2641030d72e2db49010ba03bd5b9464ce9ceb37))
* **pwa:** add configurable session poll interval setting ([#123](https://github.com/lamngockhuong/termote/issues/123)) ([d3794b7](https://github.com/lamngockhuong/termote/commit/d3794b769d041fb3ffe3b0971c6cfbba2385f91c))
* **pwa:** add gesture hints overlay and configurable paste source ([#125](https://github.com/lamngockhuong/termote/issues/125)) ([2ba1a97](https://github.com/lamngockhuong/termote/commit/2ba1a97d0c4b6cf2a7366f5bfedccc8aebfc47eb))

## [0.0.11](https://github.com/lamngockhuong/termote/compare/v0.0.10...v0.0.11) (2026-04-03)


### Features

* **cli:** add termote update self-update command ([#112](https://github.com/lamngockhuong/termote/issues/112)) ([ec1e856](https://github.com/lamngockhuong/termote/commit/ec1e856f7c736b7d06e354f523cfffc6e7803400))
* **pwa:** add tmux paste button and vi mode config ([#119](https://github.com/lamngockhuong/termote/issues/119)) ([39fc559](https://github.com/lamngockhuong/termote/commit/39fc559c96932113eefcdee456b2e5b988758878))


### Bug Fixes

* **api:** allow Unicode and spaces in session/window names ([#118](https://github.com/lamngockhuong/termote/issues/118)) ([fec53ef](https://github.com/lamngockhuong/termote/commit/fec53ef3845a4c7a00190aa1b8e95144b2ae1d41))
* **deps:** update dependency astro to v6.1.3 ([#110](https://github.com/lamngockhuong/termote/issues/110)) ([f762978](https://github.com/lamngockhuong/termote/commit/f7629787131589b17991cac5d79be557d75a0eea))
* **pwa:** fix settings menu z-index overlap with terminal states ([#121](https://github.com/lamngockhuong/termote/issues/121)) ([e85b51a](https://github.com/lamngockhuong/termote/commit/e85b51ade2672e8750ecc6d327ac09605e9a070a))

## [0.0.10](https://github.com/lamngockhuong/termote/compare/v0.0.9...v0.0.10) (2026-03-31)


### Features

* commits only bump patch version while version &lt; 1.0.0. ([0223120](https://github.com/lamngockhuong/termote/commit/0223120fd3e59dc80f5493761241ee9ac178d7a0))
* **pwa:** add context menu disable setting with toggle in preferences ([#105](https://github.com/lamngockhuong/termote/issues/105)) ([db8c34e](https://github.com/lamngockhuong/termote/commit/db8c34e94cae53196645a2ab14da61de1bdf1140))


### Bug Fixes

* **deps:** update dependency astro to v6.1.2 ([#104](https://github.com/lamngockhuong/termote/issues/104)) ([d8e363a](https://github.com/lamngockhuong/termote/commit/d8e363a00b4fbe8c5e3369eb71366cee4d308046))

## [0.0.9](https://github.com/lamngockhuong/termote/compare/v0.0.8...v0.0.9) (2026-03-29)


### Features

* **pwa:** clear session cookie on Clear Cache & Reload ([#97](https://github.com/lamngockhuong/termote/issues/97)) ([0da8114](https://github.com/lamngockhuong/termote/commit/0da8114702a089775038a8e3144e518c5484f3d9))
* **website:** add custom footer with author credit ([#95](https://github.com/lamngockhuong/termote/issues/95)) ([e99258d](https://github.com/lamngockhuong/termote/commit/e99258d4068868f7d7c8d528b5762b571adc228e))


### Bug Fixes

* **auth:** add session cookie to prevent double basic auth on mobile ([#96](https://github.com/lamngockhuong/termote/issues/96)) ([a79dda5](https://github.com/lamngockhuong/termote/commit/a79dda5d4afe2df9505f0f2cf1995f49b0d664e5))
* **e2e:** auto-detect auth credentials and improve test isolation ([#99](https://github.com/lamngockhuong/termote/issues/99)) ([3de2d91](https://github.com/lamngockhuong/termote/commit/3de2d91dd896c21506ff6380b96f25b48d38e995))
* **pwa:** add safe-area-inset-top to prevent iOS status bar overlap ([#100](https://github.com/lamngockhuong/termote/issues/100)) ([a4c7f95](https://github.com/lamngockhuong/termote/commit/a4c7f95207f2731541c69e39f6f54b7149a71372))
* **pwa:** terminal theme in-place switching + unit test suite ([#98](https://github.com/lamngockhuong/termote/issues/98)) ([0f1e32f](https://github.com/lamngockhuong/termote/commit/0f1e32fb3ad92ac73c3e130c0d250b17d8ca5555))
* skip cross-compile in release mode when pre-built binary exists ([#92](https://github.com/lamngockhuong/termote/issues/92)) ([0496008](https://github.com/lamngockhuong/termote/commit/0496008d554186b7bb990940e4b61ebf07065935))

## [0.0.8](https://github.com/lamngockhuong/termote/compare/v0.0.7...v0.0.8) (2026-03-28)


### Features

* **cli:** add link/unlink commands for global termote command ([#79](https://github.com/lamngockhuong/termote/issues/79)) ([23f87f9](https://github.com/lamngockhuong/termote/commit/23f87f9a7fd278884423152b2eef6255fca407a1))
* **pwa:** add settings panel with preferences ([#73](https://github.com/lamngockhuong/termote/issues/73)) ([1f3f63e](https://github.com/lamngockhuong/termote/commit/1f3f63e667bb726fe870c08d2008061e0596811c))
* **windows:** add Windows support with psmux ([#53](https://github.com/lamngockhuong/termote/issues/53)) ([68179ee](https://github.com/lamngockhuong/termote/commit/68179eedfd039b968a04a92161a80cc80b4e419e))


### Bug Fixes

* clean up redundant pwa-dist folder after release install ([#86](https://github.com/lamngockhuong/termote/issues/86)) ([e1e720b](https://github.com/lamngockhuong/termote/commit/e1e720b9c071aa473fa5618aebaeadd390021a7a))
* **cli:** resolve symlinks for global termote command ([#80](https://github.com/lamngockhuong/termote/issues/80)) ([cf06e0c](https://github.com/lamngockhuong/termote/commit/cf06e0cf5e2b63129cf804b168022cc7f45dd231))
* **cli:** skip Tailscale reset when not configured ([#78](https://github.com/lamngockhuong/termote/issues/78)) ([d91b814](https://github.com/lamngockhuong/termote/commit/d91b81492b15194f51dd703092d405ab652aff45))
* **deps:** update dependency astro to v6.1.0 ([#72](https://github.com/lamngockhuong/termote/issues/72)) ([9ac3a34](https://github.com/lamngockhuong/termote/commit/9ac3a340ced4c0e71d1f91e22789144788013897))
* **deps:** update dependency astro to v6.1.1 ([#77](https://github.com/lamngockhuong/termote/issues/77)) ([3688b02](https://github.com/lamngockhuong/termote/commit/3688b028a655d4a4bc250b2825ba68e381852f90))
* detect release mode by checking pwa/package.json absence ([#87](https://github.com/lamngockhuong/termote/issues/87)) ([702e38d](https://github.com/lamngockhuong/termote/commit/702e38d1aabbe8d3a1957bea4ac314f9449a6970))
* **pwa:** retry button unresponsive on mobile ([#76](https://github.com/lamngockhuong/termote/issues/76)) ([acf09f5](https://github.com/lamngockhuong/termote/commit/acf09f5a15893b2ce86236f9105e8acc23fb08a6))
* **pwa:** retry button unresponsive on mobile due to gesture overlay ([acf09f5](https://github.com/lamngockhuong/termote/commit/acf09f5a15893b2ce86236f9105e8acc23fb08a6))
* **pwa:** toolbar Enter button now reconnects disconnected terminal ([#75](https://github.com/lamngockhuong/termote/issues/75)) ([1034663](https://github.com/lamngockhuong/termote/commit/103466376a2dbf515667c1bb6bf6c83be4175d05))
* **windows:** change default port to 7690 to avoid DoSvc conflict ([#85](https://github.com/lamngockhuong/termote/issues/85)) ([24cae73](https://github.com/lamngockhuong/termote/commit/24cae73d25af6be84d364720c65d0dc1c6ccdab7))
* **windows:** enable LAN access for container mode via netsh portproxy ([#90](https://github.com/lamngockhuong/termote/issues/90)) ([975d2d1](https://github.com/lamngockhuong/termote/commit/975d2d1cf1c104c1790a91dee966ad34c87aa50c))
* **windows:** fix installer warnings and add auto-versioning ([#84](https://github.com/lamngockhuong/termote/issues/84)) ([bb6c355](https://github.com/lamngockhuong/termote/commit/bb6c3559d1ce9a375029ecd2edb5a29e10e2c994))
* **windows:** fix version detection and update config forwarding in get.ps1 ([#88](https://github.com/lamngockhuong/termote/issues/88)) ([54a66c0](https://github.com/lamngockhuong/termote/commit/54a66c0d9efb7ca3cef8000b64e9d4375777bbf3))
* **windows:** prevent get.ps1 from closing PowerShell tab on exit ([#89](https://github.com/lamngockhuong/termote/issues/89)) ([d90c1f3](https://github.com/lamngockhuong/termote/commit/d90c1f3415d0d508ff25a20ee2603a23fb3208f2))
* **windows:** qualify tmux targets with session name for psmux ([#82](https://github.com/lamngockhuong/termote/issues/82)) ([cd4413a](https://github.com/lamngockhuong/termote/commit/cd4413abe22a7b07ff1d02044d5008e42e248ea3))
* **windows:** resolve container build errors on Windows ([#81](https://github.com/lamngockhuong/termote/issues/81)) ([63126c6](https://github.com/lamngockhuong/termote/commit/63126c61c812e88d74d1fc9952e610a31a33781c))
* **windows:** use pre-built binary for container mode on release installs ([#83](https://github.com/lamngockhuong/termote/issues/83)) ([70a90bf](https://github.com/lamngockhuong/termote/commit/70a90bf8818c58d19e0b992e11d3521c74a6258c))

## [0.0.7](https://github.com/lamngockhuong/termote/compare/v0.0.6...v0.0.7) (2026-03-26)


### Features

* **cli:** config persistence, version pinning, and auto-update ([#57](https://github.com/lamngockhuong/termote/issues/57)) ([fdc8896](https://github.com/lamngockhuong/termote/commit/fdc88960fc8bc9c48ac745d2c363bf5324d33171))
* **pwa:** add Clear Cache & Reload button to settings menu ([#67](https://github.com/lamngockhuong/termote/issues/67)) ([d111775](https://github.com/lamngockhuong/termote/commit/d111775b415833f95414d0ca44d9a43e7cf0b16f))


### Bug Fixes

* **cli:** display correct version for RC releases ([#61](https://github.com/lamngockhuong/termote/issues/61)) ([5359710](https://github.com/lamngockhuong/termote/commit/53597103b2654b89ed8934015600d7bf4bedc1fc))
* **cli:** pre-cache sudo credentials for uninterrupted tailscale operations ([#64](https://github.com/lamngockhuong/termote/issues/64)) ([41caa11](https://github.com/lamngockhuong/termote/commit/41caa111500df9794bdcc12476a0673e1f7623d2))
* **cli:** stop all services before binary copy to avoid "Text file busy" ([29fcc62](https://github.com/lamngockhuong/termote/commit/29fcc62ee2e1c9199c3a294f4ef9420b52eeb945))
* **cli:** stop services before binary copy on reinstall ([#60](https://github.com/lamngockhuong/termote/issues/60)) ([29fcc62](https://github.com/lamngockhuong/termote/commit/29fcc62ee2e1c9199c3a294f4ef9420b52eeb945))
* **deps:** update dependency lucide-react to v1.7.0 ([#62](https://github.com/lamngockhuong/termote/issues/62)) ([53fcc34](https://github.com/lamngockhuong/termote/commit/53fcc3497a9fb87cd70fa509e0af5e767a403996))
* **server:** allow missing Sec-Fetch-Dest for mobile browser compatibility ([#65](https://github.com/lamngockhuong/termote/issues/65)) ([1b255c2](https://github.com/lamngockhuong/termote/commit/1b255c2dc20a44c415b7ccd0c03738d9f35b70fe))
* **server:** allow missing Sec-Fetch-Dest header for mobile browser compatibility ([1b255c2](https://github.com/lamngockhuong/termote/commit/1b255c2dc20a44c415b7ccd0c03738d9f35b70fe))
* **server:** bypass auth for PWA manifest/sw.js to fix Chrome LAN 401 error ([#69](https://github.com/lamngockhuong/termote/issues/69)) ([5cd0bed](https://github.com/lamngockhuong/termote/commit/5cd0beda19513a662f5a6581e3ff7035ddd5168d))

## [0.0.6](https://github.com/lamngockhuong/termote/compare/v0.0.5...v0.0.6) (2026-03-25)


### Features

* **pwa:** collapsible sidebar and fullscreen toggle ([#56](https://github.com/lamngockhuong/termote/issues/56)) ([3115d03](https://github.com/lamngockhuong/termote/commit/3115d035c5cbd36dc1138f2eb9bb984bb7a88e9a))


### Bug Fixes

* **deps:** update dependency lucide-react to v1.6.0 ([#50](https://github.com/lamngockhuong/termote/issues/50)) ([46241b8](https://github.com/lamngockhuong/termote/commit/46241b8d23e449374a00e63ae52584726d84e9cc))
* **pwa:** add vite-env.d.ts to fix TypeScript type check ([#55](https://github.com/lamngockhuong/termote/issues/55)) ([810608d](https://github.com/lamngockhuong/termote/commit/810608dab1c870442167dd3ed3792ceef21c90fb))
* **security:** enforce auth on /terminal/ endpoint ([#49](https://github.com/lamngockhuong/termote/issues/49)) ([42b9731](https://github.com/lamngockhuong/termote/commit/42b9731ac5dff2da298be78633e7edd6d8f18f6f))
* **security:** server hardening and security audit ([#52](https://github.com/lamngockhuong/termote/issues/52)) ([1b54be5](https://github.com/lamngockhuong/termote/commit/1b54be583a141516e621ef730e731e56c1ca7493))

## [0.0.5](https://github.com/lamngockhuong/termote/compare/v0.0.4...v0.0.5) (2026-03-24)


### Features

* **keyboard:** add Shift modifier and expand/collapse mode ([#40](https://github.com/lamngockhuong/termote/issues/40)) ([4cbdf85](https://github.com/lamngockhuong/termote/commit/4cbdf85e087f087e3a25afcdb551c547721d60c0))


### Bug Fixes

* **deps:** update dependency lucide-react to v1 ([#46](https://github.com/lamngockhuong/termote/issues/46)) ([6637010](https://github.com/lamngockhuong/termote/commit/66370102232db274ac0ceb0fd977fdc7cc977013))
* **deps:** update dependency lucide-react to v1.0.1 ([#47](https://github.com/lamngockhuong/termote/issues/47)) ([7a4598a](https://github.com/lamngockhuong/termote/commit/7a4598a3942964721a45c499f6abd099ea4d5fd0))
* **gestures:** enable swipe scroll in IME input mode ([#42](https://github.com/lamngockhuong/termote/issues/42)) ([8064077](https://github.com/lamngockhuong/termote/commit/80640777fd33fbce1a66dd7af66ae0db6b11090f))

## [0.0.4](https://github.com/lamngockhuong/termote/compare/v0.0.3...v0.0.4) (2026-03-22)


### Bug Fixes

* **installer:** read from /dev/tty for piped script input ([#37](https://github.com/lamngockhuong/termote/issues/37)) ([bcc927a](https://github.com/lamngockhuong/termote/commit/bcc927a97a1424f66571e8935de96d9989aa8cc9))

## [0.0.3](https://github.com/lamngockhuong/termote/compare/v0.0.2...v0.0.3) (2026-03-22)


### Features

* add logging support for native services ([#34](https://github.com/lamngockhuong/termote/issues/34)) ([3d2a662](https://github.com/lamngockhuong/termote/commit/3d2a6627a9af1dd5d45b930b69e9e859ab1b9119))
* **installer:** add version check and update prompts ([#35](https://github.com/lamngockhuong/termote/issues/35)) ([eb97b5a](https://github.com/lamngockhuong/termote/commit/eb97b5a778c94e92529f22c0866d54b121315340))


### Bug Fixes

* format code blocks in native installation docs ([3f32ce2](https://github.com/lamngockhuong/termote/commit/3f32ce21557a71b295a9c3afc78f324465949805))

## [0.0.2](https://github.com/lamngockhuong/termote/compare/v0.0.1...v0.0.2) (2026-03-22)


### Bug Fixes

* add Darwin binaries for native mode on macOS ([#28](https://github.com/lamngockhuong/termote/issues/28)) ([b411a37](https://github.com/lamngockhuong/termote/commit/b411a37724f941444d050ba97ba02f77eb1c9df3))
* improve security and enable auto version bumping ([#25](https://github.com/lamngockhuong/termote/issues/25)) ([854c205](https://github.com/lamngockhuong/termote/commit/854c2058be573f39625631b4c8b63c1ba9385981))
* improve security and health check output ([#23](https://github.com/lamngockhuong/termote/issues/23)) ([5e8e21d](https://github.com/lamngockhuong/termote/commit/5e8e21d39b751034de26dc560729758b5835f7a1))
* resolve empty LAN IP on macOS ([#29](https://github.com/lamngockhuong/termote/issues/29)) ([d084391](https://github.com/lamngockhuong/termote/commit/d0843914cd23949f1011b4ff6c4a141f365cac5f))
* resolve empty LAN IP on macOS in container mode ([d084391](https://github.com/lamngockhuong/termote/commit/d0843914cd23949f1011b4ff6c4a141f365cac5f))
* resolve macOS shell compatibility and terminal artifacts ([#27](https://github.com/lamngockhuong/termote/issues/27)) ([ecc4062](https://github.com/lamngockhuong/termote/commit/ecc4062bf377e01998da76e07b3ba464582875e8))

## 0.0.1 (2026-03-22)


### Features

* Termote - Terminal + Remote PWA ([f373d9d](https://github.com/lamngockhuong/termote/commit/f373d9d024e51f4d473c6d103b4d388e38996a41))
