// Synthesizes the video's music and sound effects into public/audio/*.wav.
// Everything is made here from oscillators and noise, so the sound is the
// project's own (MIT) and no audio file sits in git. Seeded: every run writes
// the same bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");

// Deterministic noise (mulberry32)
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// One-pole low-pass, coefficient from a cutoff in Hz
const lowpass = (cutoff) => {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE);
  let y = 0;
  return (x) => (y += a * (x - y));
};

// Writes stereo 16-bit PCM, normalized to `peak`
const writeWav = (name, left, right, peak = 0.89) => {
  let max = 1e-9;
  for (let i = 0; i < left.length; i++) max = Math.max(max, Math.abs(left[i]), Math.abs(right[i]));
  const gain = peak / max;
  const data = Buffer.alloc(left.length * 4);
  for (let i = 0; i < left.length; i++) {
    data.writeInt16LE(Math.round(left[i] * gain * 32767), i * 4);
    data.writeInt16LE(Math.round(right[i] * gain * 32767), i * 4 + 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(join(OUT, name), Buffer.concat([head, data]));
};

const buffers = (seconds) => {
  const n = Math.round(seconds * RATE);
  return [new Float64Array(n), new Float64Array(n)];
};

// Adds `fn(t)` (mono) from `start` seconds for `length` seconds, panned -1..1
const add = ([l, r], start, length, pan, fn) => {
  const s = Math.round(start * RATE);
  const n = Math.round(length * RATE);
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n && s + i < l.length; i++) {
    const v = fn(i / RATE);
    l[s + i] += v * gl;
    r[s + i] += v * gr;
  }
};

// Band-limited enough for a soft pad: a saw from its first harmonics
const softSaw = (phase, harmonics = 8) => {
  let v = 0;
  for (let k = 1; k <= harmonics; k++) v += Math.sin(phase * k) / k;
  return v * 0.55;
};

// ---- Music: 120 BPM (a beat is 15 frames at 30 fps), A minor, 66 s ----
// Bars 1-2 pad alone under the hook, then bass and kick, then hats and the
// arpeggio from bar 5. The composition fades it in and out.
const music = () => {
  const BEAT = 0.5;
  const BAR = BEAT * 4;
  const BARS = 33;
  const out = buffers(BARS * BAR);
  const noise = rng(7);
  // Am7, Fmaj7, Cmaj7, G6: root (bass) and pad voicing
  const chords = [
    { root: 45, pad: [57, 60, 64, 67] },
    { root: 41, pad: [57, 60, 64, 65] },
    { root: 48, pad: [55, 59, 60, 64] },
    { root: 43, pad: [55, 59, 62, 64] },
  ];

  for (let bar = 0; bar < BARS; bar++) {
    const c = chords[bar % 4];
    const t0 = bar * BAR;
    const groove = bar >= 2;
    const full = bar >= 4;

    // Pad: two detuned soft saws a voice, low-passed, slow attack
    for (const [v, note] of c.pad.entries()) {
      for (const detune of [-0.07, 0.07]) {
        const f = hz(note + detune);
        const lp1 = lowpass(900);
        const lp2 = lowpass(1400);
        const len = BAR + 0.6;
        add(out, t0, len, detune < 0 ? -0.5 : 0.5, (t) => {
          const env = Math.min(t / 0.35, 1) * Math.min(Math.max((len - t) / 0.6, 0), 1);
          return lp2(lp1(softSaw(2 * Math.PI * f * t))) * env * 0.05 * (v === 0 ? 1.1 : 1);
        });
      }
    }

    if (groove) {
      for (let beat = 0; beat < 4; beat++) {
        const tb = t0 + beat * BEAT;
        // Kick: a sine falling from 110 Hz to 45 Hz (its phase integrated)
        add(out, tb, 0.35, 0, (t) => {
          const phase = 2 * Math.PI * (45 * t + (65 / 30) * (1 - Math.exp(-t * 30)));
          return Math.sin(phase) * Math.exp(-t * 9) * 0.55;
        });
        // Bass on the off-beat eighths, ducked under the kick
        add(out, tb + BEAT / 2, BEAT / 2, 0, (t) => {
          const f = hz(c.root);
          const env = Math.min(t / 0.01, 1) * Math.exp(-t * 5);
          const x = Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t);
          return Math.tanh(x * 1.5) * env * 0.22;
        });
        if (full) {
          // Closed hat on the off-beat
          const hp = lowpass(6000);
          add(out, tb + BEAT / 2, 0.05, 0.3, (t) => {
            const n = noise() * 2 - 1;
            return (n - hp(n)) * Math.exp(-t * 90) * 0.12;
          });
        }
      }
    }

    if (full) {
      // Arpeggio in eighths over the pad's notes an octave up, ping-ponged
      const notes = [...c.pad, c.pad[2] + 12].map((n) => n + 12);
      for (let i = 0; i < 8; i++) {
        const note = notes[[0, 2, 1, 3, 2, 4, 3, 1][i]];
        const f = hz(note);
        const lp = lowpass(3200);
        add(out, t0 + i * (BEAT / 2), 0.4, i % 2 ? 0.45 : -0.45, (t) => {
          const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * t));
          return lp(tri) * Math.exp(-t * 11) * 0.07;
        });
      }
    }
  }
  // Glue: gentle saturation
  for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i] * 1.3);
  writeWav("music.wav", ...out, 0.8);
};

// ---- Sound effects ----

// Keys typed for 4 s: short filtered clicks at uneven intervals
const typing = () => {
  const out = buffers(4);
  const r = rng(11);
  for (let t = 0.02; t < 3.9; t += 0.055 + r() * 0.06) {
    const amp = 0.5 + r() * 0.5;
    const tone = 1800 + r() * 1400;
    const lp = lowpass(tone);
    const pan = (r() - 0.5) * 0.4;
    add(out, t, 0.03, pan, (u) => {
      const n = r() * 2 - 1;
      const thump = Math.sin(2 * Math.PI * 180 * u) * Math.exp(-u * 300) * 0.6;
      return (lp(n) * Math.exp(-u * 260) + thump) * amp;
    });
  }
  writeWav("typing.wav", ...out, 0.7);
};

// A finger on glass: a short soft tick
const tap = () => {
  const out = buffers(0.12);
  const r = rng(3);
  const lp = lowpass(2500);
  add(out, 0, 0.12, 0, (t) => {
    const f = 700 - 250 * Math.min(t / 0.03, 1);
    const tone = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 60);
    return tone + lp(r() * 2 - 1) * Math.exp(-t * 400) * 0.5;
  });
  writeWav("tap.wav", ...out, 0.8);
};

// A bell: a sine with an inharmonic partial
const bell = (f, decay) => (t) =>
  (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 4)) *
  Math.min(t / 0.004, 1) *
  Math.exp(-t * decay);

// The push arriving: two rising notes (E6, A6)
const ping = () => {
  const out = buffers(1.6);
  add(out, 0, 1.5, -0.1, bell(hz(88), 3.2));
  add(out, 0.11, 1.45, 0.1, bell(hz(93), 2.8));
  writeWav("ping.wav", ...out);
};

// The owl appearing: an A minor chime, a note at a time
const chime = () => {
  const out = buffers(2.4);
  [81, 84, 88, 93].forEach((n, i) => add(out, i * 0.07, 2.2, -0.3 + i * 0.2, (t) => bell(hz(n), 2)(t) * 0.6));
  writeWav("chime.wav", ...out);
};

// A cut or a swipe: noise swept through a resonant band
const whoosh = () => {
  const out = buffers(0.7);
  const r = rng(5);
  let lo = 0;
  let band = 0;
  add(out, 0, 0.7, 0, (t) => {
    const p = t / 0.7;
    const cutoff = 300 + 2600 * Math.sin(Math.PI * Math.min(p * 1.2, 1));
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE);
    const n = r() * 2 - 1;
    lo += a * (n - lo);
    band += a * (lo - band);
    return (lo - band) * Math.sin(Math.PI * p) ** 2;
  });
  writeWav("whoosh.wav", ...out, 0.7);
};

mkdirSync(OUT, { recursive: true });
music();
typing();
tap();
ping();
chime();
whoosh();
console.log(`audio: wrote ${OUT}`);
