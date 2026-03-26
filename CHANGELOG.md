# Changelog

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
