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

// ---- Music: 124 BPM, A minor, 68 bars (about 132 s) ----
// A pop-house cue in sections, so two minutes do not loop one idea: an intro
// whose arpeggio opens up, a groove (four-on-the-floor kick, claps on 2 and
// 4, a syncopated bass, the pad pumping under the kick), choruses with a lead
// hook and its echo, a breakdown and a snare build into the drop, a half-time
// bridge, and an outro. It must last as long as the longest composition
// (TermoteIntro, about 126 s), or the rest of the video plays without it; the
// composition fades it in and out.
const music = () => {
  const BEAT = 60 / 124;
  const BAR = BEAT * 4;
  const STEP = BEAT / 4;
  const BARS = 68;
  const out = buffers(BARS * BAR + 2);
  const noise = rng(7);
  const n = () => noise() * 2 - 1;

  // Sections, by first bar: what plays in each
  const SECTIONS = [
    { from: 0, name: "intro" },
    { from: 4, name: "groove" },
    { from: 12, name: "chorus" },
    { from: 20, name: "groove" },
    { from: 28, name: "chorus" },
    { from: 36, name: "break" },
    { from: 40, name: "drop" },
    { from: 56, name: "half" },
    { from: 60, name: "drop" },
    { from: 66, name: "outro" },
  ];
  const section = (bar) => SECTIONS.findLast((x) => x.from <= bar);
  const sectionStart = (bar) => section(bar).from === bar;

  // Am F C G in the verses, F G Em Am in the choruses: root and pad voicing
  const VERSE = [
    { root: 45, pad: [57, 60, 64, 67] },
    { root: 41, pad: [57, 60, 64, 65] },
    { root: 48, pad: [55, 60, 64, 67] },
    { root: 43, pad: [55, 59, 62, 67] },
  ];
  const CHORUS = [
    { root: 41, pad: [57, 60, 65, 69] },
    { root: 43, pad: [55, 59, 62, 67] },
    { root: 40, pad: [55, 59, 64, 67] },
    { root: 45, pad: [57, 60, 64, 69] },
  ];
  const chordsOf = (name) => (["chorus", "drop", "break"].includes(name) ? CHORUS : VERSE);

  // The hook: four bars of eighths over F G Em Am (null rests, 0 holds)
  const HOOK = [
    [72, 0, 69, 72, null, 74, 72, null],
    [71, 0, 67, 71, 74, 0, 72, 71],
    [67, 0, 71, 0, 76, 74, 71, null],
    [69, 0, 72, 74, 76, 0, 0, null],
  ];

  // Sidechain: how far the pad and bass dip under a kick at time t
  const kicksAt = (bar) => ["groove", "chorus", "drop", "outro"].includes(section(bar).name);
  const pump = (t) => {
    const bar = Math.floor(t / BAR);
    if (bar < 0 || bar >= BARS) return 1;
    const name = section(bar).name;
    if (kicksAt(bar)) return 1 - 0.55 * Math.exp(-((t % BEAT) / BEAT) * 7);
    if (name === "half") return 1 - 0.55 * Math.exp(-((t % (BEAT * 2)) / BEAT) * 5);
    return 1;
  };

  const kick = (at, amp = 0.6) =>
    add(out, at, 0.4, 0, (t) => {
      const phase = 2 * Math.PI * (48 * t + (80 / 32) * (1 - Math.exp(-t * 32)));
      return Math.sin(phase) * Math.exp(-t * 8) * amp + n() * Math.exp(-t * 400) * 0.08;
    });
  // Three quick noise bursts through a band around 1.5 kHz
  const clap = (at, amp = 0.32) => {
    const lo = lowpass(2400);
    const hi = lowpass(900);
    add(out, at, 0.3, 0.1, (t) => {
      const x = n();
      const band = lo(x) - hi(x);
      const env = t < 0.03 ? Math.exp(-(t % 0.01) * 300) : Math.exp(-(t - 0.03) * 22);
      return band * env * amp;
    });
  };
  const hat = (at, amp, open = false) => {
    const lp = lowpass(7000);
    add(out, at, open ? 0.25 : 0.05, 0.35, (t) => {
      const x = n();
      return (x - lp(x)) * Math.exp(-t * (open ? 18 : 90)) * amp;
    });
  };
  const snare = (at, amp) => {
    const lp = lowpass(5000);
    add(out, at, 0.15, -0.1, (t) => {
      const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.5;
      return (lp(n()) + body) * Math.exp(-t * 26) * amp;
    });
  };
  const crash = (at) => {
    const lp = lowpass(5000);
    add(out, at, 2.2, 0, (t) => {
      const x = n();
      return (x - lp(x)) * Math.exp(-t * 2.2) * 0.16;
    });
  };
  // Noise rising through an opening filter over `length`, into the next bar
  const riser = (at, length) => {
    let y = 0;
    add(out, at, length, 0, (t) => {
      const p = t / length;
      const a = 1 - Math.exp((-2 * Math.PI * (200 + 7800 * p * p)) / RATE);
      y += a * (n() - y);
      return y * p * p * 0.35;
    });
  };
  // A plucked lead: two detuned saws through a closing filter, and its echo
  // three sixteenths later on the other side
  const lead = (at, note, length, amp = 0.11, octave = 0) => {
    for (const [delay, pan, gain] of [
      [0, -0.15, 1],
      [STEP * 3, 0.5, 0.35],
      [STEP * 6, -0.5, 0.15],
    ]) {
      for (const detune of [-0.08, 0.08]) {
        const f = hz(note + 12 * octave + detune);
        const lp = lowpass(3800);
        add(out, at + delay, length + 0.2, pan, (t) => {
          const env = Math.min(t / 0.005, 1) * Math.exp(-t * 3.2) * Math.min(Math.max((length + 0.2 - t) / 0.08, 0), 1);
          return lp(softSaw(2 * Math.PI * f * t, 6)) * env * amp * gain;
        });
      }
    }
  };

  for (let bar = 0; bar < BARS; bar++) {
    const { name } = section(bar);
    const chords = chordsOf(name);
    const c = chords[bar % 4];
    const t0 = bar * BAR;
    const intro = name === "intro";

    // Pad: two detuned soft saws a voice, pumping under the kick
    const padCut = name === "break" ? 700 : name === "outro" ? 600 : 1500;
    for (const [v, note] of c.pad.entries()) {
      for (const detune of [-0.08, 0.08]) {
        const f = hz(note + detune);
        const lp1 = lowpass(padCut);
        const lp2 = lowpass(padCut * 1.5);
        const len = BAR + 0.5;
        add(out, t0, len, detune < 0 ? -0.55 : 0.55, (t) => {
          const env = Math.min(t / 0.25, 1) * Math.min(Math.max((len - t) / 0.5, 0), 1);
          return lp2(lp1(softSaw(2 * Math.PI * f * t))) * env * 0.045 * (v === 0 ? 1.1 : 1) * pump(t0 + t);
        });
      }
    }

    // Arpeggio in sixteenths an octave up; in the intro its filter opens
    if (name !== "outro") {
      const notes = [...c.pad, c.pad[1] + 12].map((x) => x + 12);
      const order = [0, 2, 4, 1, 3, 2, 4, 3, 0, 2, 4, 1, 3, 4, 2, 1];
      const cut = intro ? 600 + (bar / 4) * 2600 : name === "break" ? 1400 : 3600;
      const amp = name === "break" || name === "half" ? 0.05 : 0.06;
      for (let i = 0; i < 16; i++) {
        const f = hz(notes[order[i]]);
        const lp = lowpass(cut);
        add(out, t0 + i * STEP, 0.22, i % 2 ? 0.5 : -0.5, (t) => {
          const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * t));
          return lp(tri) * Math.exp(-t * 14) * amp * (i % 4 === 0 ? 1.2 : 0.85);
        });
      }
    }

    // Drums
    if (kicksAt(bar)) {
      const last = name === "outro";
      for (let b = 0; b < 4; b++) {
        kick(t0 + b * BEAT, last ? 0.5 : 0.6);
        if (!last && (b === 1 || b === 3)) clap(t0 + b * BEAT);
      }
      if (!last) {
        const busy = name === "chorus" || name === "drop";
        for (let i = 0; i < 16; i++) {
          if (i % 4 === 2) hat(t0 + i * STEP, busy && i % 8 === 6 ? 0.13 : 0.12, busy && i % 8 === 6);
          else if (busy && i % 2 === 1) hat(t0 + i * STEP, 0.05);
        }
      }
    }
    if (name === "half") {
      kick(t0);
      kick(t0 + BEAT * 2.5, 0.45);
      clap(t0 + BEAT * 2);
      for (let i = 0; i < 8; i++) hat(t0 + i * BEAT / 2 + BEAT / 4, 0.07);
    }
    if (name === "intro" && bar >= 2) kick(t0 + BEAT * 3.5, 0.35);

    // Bass: sixteenths on a syncopated pattern, octave jumps, ducked
    if (!intro && name !== "break" && name !== "outro") {
      const pattern = [0, 0, 1, 0, 0, 0, 1, 2, 0, 0, 1, 0, 0, 2, 1, 0];
      for (let i = 0; i < 16; i++) {
        if (!pattern[i]) continue;
        const f = hz(c.root + (pattern[i] === 2 ? 12 : 0));
        const lp = lowpass(name === "half" ? 500 : 900);
        add(out, t0 + i * STEP, STEP * 1.6, 0, (t) => {
          const env = Math.min(t / 0.004, 1) * Math.exp(-t * 7);
          const x = softSaw(2 * Math.PI * f * t, 5) + 0.6 * Math.sin(Math.PI * f * t);
          return Math.tanh(lp(x) * 2) * env * 0.2 * pump(t0 + i * STEP + t);
        });
      }
    }

    // The hook, in the choruses and drops (an octave up in the drops' second
    // half), and quietly behind the breakdown's filter
    if (name === "chorus" || name === "drop" || name === "break") {
      const line = HOOK[bar % 4];
      const octave = name === "drop" && bar % 16 >= 8 ? 1 : 0;
      for (let i = 0; i < 8; i++) {
        const note = line[i];
        if (!note) continue;
        let len = 1;
        while (i + len < 8 && line[i + len] === 0) len++;
        lead(t0 + i * (BEAT / 2), note, len * (BEAT / 2), name === "break" ? 0.06 : 0.1, octave);
      }
    }

    // Fills: a crash on each new section, a riser into the groove and the
    // drops, a snare roll building into the drop
    if (sectionStart(bar) && bar > 0 && name !== "break" && name !== "outro") crash(t0);
    if (bar === 2) riser(t0, BAR * 2);
    if (bar === 38 || bar === 58) riser(t0, BAR * 2);
    if (bar === 38 || bar === 39) {
      const steps = bar === 38 ? 8 : 16;
      for (let i = 0; i < steps; i++) {
        const p = (bar - 38 + i / steps) / 2;
        snare(t0 + i * (BAR / steps), 0.08 + 0.22 * p);
      }
    }
  }
  // Glue: gentle saturation
  for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i] * 1.4);
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
