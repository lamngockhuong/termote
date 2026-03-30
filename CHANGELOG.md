# Changelog

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
