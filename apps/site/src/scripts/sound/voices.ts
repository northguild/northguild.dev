// The site's one-shot sounds. The press and the draw-in are the
// owner's picks from context/reference/huginn-sound-audition.html; the panel's
// voices are the GMT docs' own (gmt apps/dox/src/lib/sound/voices.ts).
// `t` is a time on the audio clock; `out` is the master bus.

import type { CueExtra, CueName } from "./cue";
import { airStroke, crackleBuffer, noise, space, tone } from "./kit";

export type Voice = (
  c: AudioContext,
  out: AudioNode,
  t: number,
  rank: number,
  extra?: CueExtra,
) => void;

export const VOICES: Record<CueName, Voice> = {
  // Press I, "Distant sonar": a ping heard from far off through the water,
  // almost all space and very little of the ping itself. Every link and
  // button: the header's, the cards' Docs and GitHub, the sky's info.
  click(c, out, t) {
    const note = { freq: 1050, peak: 0.012, attack: 0.01, release: 0.35 };
    tone(c, out, t, note);
    const send = c.createGain();
    send.gain.value = 1.2;
    send.connect(space(c));
    tone(c, send, t, note);
  },
  // GMT open O, "Felt slide": a soft low slide rising, and the faintest
  // settle at the end. A panel opening.
  open(c, out, t) {
    noise(c, out, t, {
      freq: 420,
      to: 560,
      q: 1.4,
      peak: 0.08,
      attack: 0.05,
      decay: 0.12,
    });
    tone(c, out, t + 0.12, {
      freq: 170,
      to: 140,
      peak: 0.03,
      attack: 0.004,
      release: 0.06,
    });
  },
  // GMT close O: the Felt slide in reverse, a little lower and sooner.
  close(c, out, t) {
    noise(c, out, t, {
      freq: 560,
      to: 400,
      q: 1.4,
      peak: 0.07,
      attack: 0.03,
      decay: 0.11,
    });
    tone(c, out, t + 0.1, {
      freq: 150,
      to: 120,
      peak: 0.03,
      attack: 0.004,
      release: 0.06,
    });
  },
  // GMT toggle C, "Ice snap": a hiss-click, a glassy tick and a tiny thump.
  // The mute button.
  toggle(c, out, t) {
    noise(c, out, t, {
      type: "highpass",
      freq: 4500,
      peak: 0.12,
      attack: 0.001,
      decay: 0.012,
    });
    tone(c, out, t + 0.004, {
      freq: 2800,
      peak: 0.06,
      attack: 0.001,
      release: 0.02,
    });
    tone(c, out, t, {
      freq: 150,
      to: 100,
      peak: 0.1,
      attack: 0.002,
      release: 0.03,
    });
  },
  // GMT detent B, "Glass tick": one step of the volume fader.
  detent(c, out, t) {
    tone(c, out, t, {
      freq: 3200,
      to: 2600,
      peak: 0.07,
      attack: 0.001,
      release: 0.012,
    });
    tone(c, out, t, {
      freq: 900,
      to: 700,
      peak: 0.05,
      attack: 0.002,
      release: 0.03,
    });
  },
  // Draw-in G, "Silk rustle": the sound people under strong aurora describe
  // most, a faint rustle like silk or dry grass, swelling and fading as the
  // light crosses the box, panned to the box and drifting the way it sweeps.
  brush(c, out, t, _rank, extra) {
    if (!extra) return;
    const header = extra.kind === "header";
    const pan = c.createStereoPanner();
    pan.pan.setValueAtTime(clampPan(extra.pan - 0.12 * extra.drift), t);
    pan.pan.linearRampToValueAtTime(
      clampPan(extra.pan + 0.12 * extra.drift),
      t + extra.duration,
    );
    pan.connect(out);
    airStroke(c, pan, t, extra.duration, {
      type: "bandpass",
      lo: header ? 2400 : 3000,
      hi: header ? 4200 : 5200,
      q: 0.7,
      peak: 0.035,
      buffer: crackleBuffer(c),
    });
  },
};

function clampPan(value: number): number {
  return Math.min(1, Math.max(-1, value));
}
