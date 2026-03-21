# Changelog

## [0.1.4](https://github.com/lamngockhuong/termote/compare/termote-v0.1.3...termote-v0.1.4) (2026-03-21)


### Features

* **pwa:** add favicon and banner assets ([f06a793](https://github.com/lamngockhuong/termote/commit/f06a7933e992f4c8ed118b9d989c89b7be36806b))


### Bug Fixes

* **ci:** add continue-on-error for Docker Hub README sync ([1cff17e](https://github.com/lamngockhuong/termote/commit/1cff17e92384affceea75c5ffff347f19519e940))

## [0.1.3](https://github.com/lamngockhuong/termote/compare/termote-v0.1.2...termote-v0.1.3) (2026-03-21)


### Features

* **ci:** sync README to Docker Hub on release ([0ed1738](https://github.com/lamngockhuong/termote/commit/0ed17384ec373da861c038db6cc9f5e6b0747f45))


### Bug Fixes

* **ci:** skip sync-version job when called by release-please ([00caf5b](https://github.com/lamngockhuong/termote/commit/00caf5bca5c7a8141c308a14e1a66544c0f6fad0))
* **ci:** use paths-filter v4 (v5 doesn't exist) ([2bd4ef5](https://github.com/lamngockhuong/termote/commit/2bd4ef5f367a8d3de09954ca4bef33d54b54fec5))

## [0.1.2](https://github.com/lamngockhuong/termote/compare/termote-v0.1.1...termote-v0.1.2) (2026-03-21)


### Bug Fixes

* **ci:** detect workflow_call by inputs.version instead of event_name ([1d1cdc0](https://github.com/lamngockhuong/termote/commit/1d1cdc0cc23088ce42c25d31f2b417d2bc9b7c93))

## [0.1.1](https://github.com/lamngockhuong/termote/compare/termote-v0.1.0...termote-v0.1.1) (2026-03-21)


### Features

* add --lan flag, test suite, and Makefile ([5282fa1](https://github.com/lamngockhuong/termote/commit/5282fa1d1edba10e724248aa3563f040d339da66))
* add --no-auth option to disable basic authentication ([fcbbd09](https://github.com/lamngockhuong/termote/commit/fcbbd098aa782f7743dee4a8a61a04558b15f3f1))
* add hybrid deployment mode and Go tmux-api ([e543e5c](https://github.com/lamngockhuong/termote/commit/e543e5c78ed2042e6774be362bccb39826bda173))
* change default port to 7680, upgrade deps, add --port option ([4356853](https://github.com/lamngockhuong/termote/commit/43568538abdaa5ca8cd8c07ae62b73c32bde4407))
* **ci:** add auto-release workflow with Release Please ([#8](https://github.com/lamngockhuong/termote/issues/8)) ([0c02464](https://github.com/lamngockhuong/termote/commit/0c024644bba96228696e2903a8b34ee6afed4208))
* initial Termote implementation ([709794f](https://github.com/lamngockhuong/termote/commit/709794f5b4d8a0899a37b4ef606f9b1c9c85a25f))
* **pwa:** add dynamic Ctrl+key input and help modal ([c42b46c](https://github.com/lamngockhuong/termote/commit/c42b46c0e77ba63ffd42910d24d428dc58c91880))
* **pwa:** add Enter key to keyboard toolbar ([0eb49db](https://github.com/lamngockhuong/termote/commit/0eb49db1545f577eb053357cbf2e50a604b809e8))
* **pwa:** add IME input mode for Vietnamese/CJK support ([0da3887](https://github.com/lamngockhuong/termote/commit/0da38872ecdd78fb0192bb7dab28e3c641416297))
* **pwa:** add settings, themes, font controls, and UI improvements ([b86c4f0](https://github.com/lamngockhuong/termote/commit/b86c4f003e067e72f6294485b30f118ee9648407))
* **pwa:** add terminal theme switching for dark/light mode ([8e05608](https://github.com/lamngockhuong/termote/commit/8e0560833436663313d93a352be5c8bf809f57cd))
* **pwa:** improve session management UX ([5122532](https://github.com/lamngockhuong/termote/commit/51225328e592a4286c204f5bfcfb1b3bb2b5fc03))


### Bug Fixes

* **ci:** add packages write permission for workflow_call ([8037f22](https://github.com/lamngockhuong/termote/commit/8037f2293c11842fd9f6f7fb82945a9060d1f1b4))
* **ci:** add push trigger and remove misleading dry_run ([c33b085](https://github.com/lamngockhuong/termote/commit/c33b08579e695bd086fdf2672cd71c96da651544))
* **ci:** only run docker-build when both artifacts exist ([9acc90a](https://github.com/lamngockhuong/termote/commit/9acc90a532305edbdd51eff90d46d6331664db8a))
* **ci:** respect dry_run flag in release-please action ([b30df0a](https://github.com/lamngockhuong/termote/commit/b30df0ae0ee491abfa38be954c3333d0ac0d9465))
* **ci:** use correct inputs syntax in job-level if condition ([a0bf3f9](https://github.com/lamngockhuong/termote/commit/a0bf3f9f56990a9071d59f8429d0f91fc1c3ae63))
* **ci:** use simple release-type and remove invalid inputs ([fa486e6](https://github.com/lamngockhuong/termote/commit/fa486e62d850fbe5e9a4072525e155d12d4ca934))
* **deploy:** stop system ttyd.service before starting hybrid mode ([1bda1b5](https://github.com/lamngockhuong/termote/commit/1bda1b5e952571455452e43ace633833fdab0a85))


### Performance Improvements

* **ci:** add path filtering to skip unnecessary builds ([#9](https://github.com/lamngockhuong/termote/issues/9)) ([4cbaf53](https://github.com/lamngockhuong/termote/commit/4cbaf5388fec99a6a53f0d70cc6ccf1b35b6df2d))
