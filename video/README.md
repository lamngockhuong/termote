# Termote intro video

The feature intro of Termote, made with [Remotion](https://www.remotion.dev/). Three
compositions share the same scenes (`src/scenes/`):

| Composition            | Size      | Length | For                                        |
| ---------------------- | --------- | ------ | ------------------------------------------ |
| `TermoteIntro`         | 1920×1080 | ~75 s  | README, website                            |
| `TermoteHero`          | 1920×1080 | 15 s   | Website hero: no words, loops              |
| `TermoteIntroVertical` | 1080×1920 | ~32 s  | Social: the phone scenes with big captions |
| `TermotePoster`        | 1920×1080 | still  | README and website: the intro's picture    |
| `ReadmePhones`         | 1800×1260 | still  | README screenshot: phones                  |
| `ReadmeDesktop`        | 1800×1120 | still  | README screenshot: desktop                 |
| `ReadmeStyles`         | 1800×2200 | still  | README screenshot: interface styles        |

`render` writes the intro, the hero and their pictures (`.jpg`) into
`website/public/video/`, which is committed: the homepage plays them
(`website/src/components/HeroVideo.astro`, `IntroVideo.astro`) and every
README shows the poster, linking to the homepage's video. The vertical cut
goes to `out/` (not committed) for posting by hand.

Every idea is also on screen, so the videos work muted (README, website).
`TermoteHero` is rendered without sound; the other two carry music and sound
effects, kept low enough for a voice-over later.

## Sound

`audio/make-audio.mjs` synthesizes every sound from oscillators and noise
into `public/audio/*.wav` (not committed; `dev` and `render` make them first):
the music (120 BPM, so a beat is 15 frames), key typing, a tap, the push's
ping, the owl's chime and the whoosh of a cut. Nothing is sampled or
downloaded, so the sound is the project's own, under its license.
`src/components/sfx.tsx` places them (`<Sfx>`) and sets their levels; the
mix measures about -18 LUFS. To use a licensed track instead, keep its file
out of git (most stock licenses forbid passing the file on by itself) and
point `<Music>` at it.

## Commands

From the repo root (`video` is a pnpm workspace package):

```sh
pnpm install
pnpm --filter @termote/video dev      # Remotion Studio
pnpm --filter @termote/video render   # website/public/video/*, out/*.mp4
pnpm --filter @termote/video audio    # public/audio/*.wav only
pnpm --filter @termote/video screenshots  # docs/images/screenshots/*.png
pnpm --filter @termote/video lint     # eslint + tsc
```

## The screens

`public/ui/*.png` are captures of the real PWA, taken against a throwaway
server with demo content: a git repo `acme-api` with uncommitted edits, three
workspaces (or tmux sessions), and the Claude Code stand-in
(`tests/fixtures/fake-claude.sh`) holding a finished conversation. Most
screens are taken on Herdr; tmux takes `desktop-tmux.png`, shown beside
Herdr's to say both backends work, and the phone's terminal
(`phone-terminal.png`), since tmux sizes the window to the phone while a
headless Herdr's pane keeps its own width and its text comes out tiny. tmux
also takes the Chat view's working row (`phone-chat-working.png`): it reads
the stand-in's status from its session file, where a headless Herdr never
sees it work. Each
interface style is taken in the light and the dark theme on the sessions sheet
(`phone-style-<style>-<theme>.png`), where the styles differ the most. Every
capture runs with reduced motion and waits for the page to settle, so none is
taken mid-transition. The README's screenshots are stills of these captures
(`src/readme-shots.tsx`, `pnpm screenshots`). Under Herdr the stand-in reports its state and session id to
Herdr (`herdr pane report-agent`), which is what gives its pane a Chat view.
Nothing in them is mocked up, and no real user, host or project name appears.
Linux only; needs `herdr`, `tmux` and `jq`. To take them again after the UI
changed:

```sh
make build
cd pwa
# Most screens, on Herdr (port 7686)
../video/capture/demo-env.sh start /tmp/dev herdr   # the path shows in Files/Changes
DEMO_MUX=herdr TERMOTE_PORT=7686 TERMOTE_PASS="$(cat /tmp/dev/pass)" \
  pnpm exec playwright test capture-video --workers=1
../video/capture/demo-env.sh stop /tmp/dev
# desktop-tmux.png and the phone's terminals, on tmux (port 7685)
../video/capture/demo-env.sh start /tmp/dev tmux
DEMO_MUX=tmux TMUX_SOCKET=/tmp/termote-demo-$(id -u)-7685.sock TERMOTE_PORT=7685 \
  TERMOTE_PASS="$(cat /tmp/dev/pass)" pnpm exec playwright test capture-video --workers=1
../video/capture/demo-env.sh stop /tmp/dev
```

The spec is `pwa/e2e/capture-video.spec.ts`; CI leaves it out with the other
"Capture screenshots" specs. The demo runs its own Herdr server (socket,
HOME and XDG dirs under `/tmp`), never the one you use.

## Brand

The owl is the path of `assets/branding/termote/logo/symbol.svg` (its eyes
drawn apart so they can blink, never reshaped); colours are the brand's ink
and white plus the PWA's dark accent (`src/theme.ts`). See
[`docs/brand-identity.md`](../docs/brand-identity.md).

Remotion is free for individuals and companies of up to three people; larger
organisations need a [company license](https://www.remotion.dev/license).
