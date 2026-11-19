// Huginn's flight, heard: the owner's picks from
// context/reference/huginn-sound-audition.html.
//
// - Wingbeat I, "Heavy · Two wings": each downstroke pushes air under each
//   wing, a little apart left and right, with a deep push of air beneath.
// - Glide D, "Faint hush", and soar B, "Open sky": held air that follows his
//   airspeed, the soar swelling and ebbing like a thermal.
// - Roll D, "Tuck breath": one soft breath as he turns over.
// - Slow motion B, "Slowed tape": near the camera his time slows, and all of
//   his sounds drop in pitch by the square root of the time scale.
// - Distance C, "Air in 3D": an HRTF panner at his place in the camera's
//   frame, the air taking the highs as he goes away, and his level falling
//   steeply with distance (`distanceGain`).
//
// The worker flies him and tells the page each beat as it starts (when, how
// far into the downstroke, how fast the wing turns), and his place, speed
// and time scale about 15 times a second (aurora.worker.ts). Each time is a
// wall-clock moment; `audioTimeOf` puts it on the audio clock at the moment
// the frame that drew it is on screen, so each stroke is heard with the wing.

import type { HuginnSound } from "../aurora.worker";
import { airStroke, biquad, heldNoise, noise, randomBetween } from "./kit";

/** Where in a beat the downstroke ends (aurora.raven.ts `DOWN`). */
const DOWN = 0.55;
/** About one frame: a frame drawn at its stamp is on screen this much later. */
const ON_SCREEN = 0.017;
/** A sound starts at least this far ahead of the clock, so no attack is cut. */
const LEAD = 0.005;
/** How quickly held air follows a new reading, seconds. */
const FOLLOW = 0.05;

export type HuginnVoice = {
  hear(event: HuginnSound): void;
};

/** The audio-clock time at which wall-clock moment `at` (ms since the epoch,
 * as `performance.timeOrigin + performance.now()`) is heard, one frame on. */
function audioTimeOf(c: AudioContext, at: number): number {
  const since = at - performance.timeOrigin;
  try {
    const stamp = c.getOutputTimestamp();
    if (stamp.contextTime && stamp.performanceTime) {
      return (
        stamp.contextTime + (since - stamp.performanceTime) / 1000 + ON_SCREEN
      );
    }
  } catch {
    // Fall through to the estimate below.
  }
  return (
    c.currentTime +
    (since - performance.now()) / 1000 +
    ON_SCREEN -
    (c.outputLatency || 0)
  );
}

/** Where the air dulls him to at `distance` metres: crisp close, muffled far. */
function airCutoff(distance: number): number {
  return Math.min(
    18000,
    Math.max(700, 18000 * (3 / Math.max(distance, 3)) ** 1.1),
  );
}

/** Within this many metres he is at full level: the fly-in's close sweep. */
const NEAR = 4;
/**
 * How steeply he fades past `NEAR`: his level is (NEAR / distance) to this
 * power, so 2 takes 12 dB off each time the distance doubles. That is twice
 * the free-air law, on purpose: a wingbeat that is plain at 4 m is a whisper
 * at 16 m (−24 dB) and all but gone on a pass 40 m out (−40 dB).
 */
const FALLOFF = 2;
/** Past this he is not heard at all; he fades out over the last quarter. */
const FARTHEST = 80;

/** His level at `distance` metres, 1 close up. */
function distanceGain(distance: number): number {
  const d = Math.max(distance, NEAR);
  const edge = Math.min(1, Math.max(0, (FARTHEST - d) / (FARTHEST * 0.25)));
  return (NEAR / d) ** FALLOFF * edge;
}

/** Slowed tape: a quarter of real time sounds an octave down. */
function pitchOf(scale: number): number {
  return Math.sqrt(Math.min(1, Math.max(0.25, scale)));
}

/** Wingbeat I, "Heavy · Two wings": the part of a downstroke from `from`
 * (0 to 1) on, over `dur` seconds. No two beats are quite the same. */
function twoWings(
  c: AudioContext,
  out: AudioNode,
  t: number,
  dur: number,
  from: number,
  pitch: number,
): void {
  const level = randomBetween(0.85, 1.08);
  const p = pitch * randomBetween(0.92, 1.08);
  // The air pressed down under the wing: a deep push with no note in it.
  airStroke(c, out, t, dur, {
    type: "lowpass",
    lo: 55 * p,
    hi: 130 * p,
    q: 1.2,
    peak: 0.18 * level,
    pow: 3,
    from,
  });
  const wings: [number, number][] = [
    [-0.4, 0],
    [0.4, 0.004],
  ];
  for (const [side, lag] of wings) {
    const pan = c.createStereoPanner();
    pan.pan.value = side;
    pan.connect(out);
    const each = level * randomBetween(0.9, 1.1);
    airStroke(c, pan, t + lag, dur, {
      type: "lowpass",
      lo: 220 * p,
      hi: 1100 * p,
      q: 0.9,
      peak: 0.13 * each,
      from,
    });
    // The wing's hollow body. Held near one place and broad: a resonance
    // that swept with each stroke rose and fell in pitch every beat, and a
    // bout of beats sang like a siren.
    airStroke(c, pan, t + lag, dur, {
      type: "bandpass",
      lo: 150 * p,
      hi: 185 * p,
      q: 1.1,
      peak: 0.12 * each,
      from,
    });
  }
}

type HeldAir = {
  glide: GainNode;
  glideTone: BiquadFilterNode;
  soar: GainNode;
  soarTone: BiquadFilterNode;
  sources: AudioScheduledSourceNode[];
};

/** Glide D and soar B, held through a flight and set by each reading. */
function startHeldAir(c: AudioContext, out: AudioNode, t: number): HeldAir {
  const src = heldNoise(c, t);
  const glideTone = biquad(c, "lowpass", 380, 0.5);
  const glide = c.createGain();
  glide.gain.value = 0;
  src.connect(glideTone).connect(glide).connect(out);
  // The soar's air opens and closes as the thermal lifts him: at random
  // (`hearAir`), never on a cycle, which would wail like a siren.
  const soarTone = biquad(c, "lowpass", 550, 0.7);
  const soar = c.createGain();
  soar.gain.value = 0;
  src.connect(soarTone).connect(soar).connect(out);
  return { glide, glideTone, soar, soarTone, sources: [src] };
}

/** The thermal under a soar: a slow random drift, -1 to 1. */
type Thermal = { now: number; target: number; next: number };

/** Move the drift on by one reading (about 15 a second); every 2 to 5 s of
 * audio time it heads somewhere new. */
function driftThermal(thermal: Thermal, t: number): number {
  if (t >= thermal.next) {
    thermal.target = randomBetween(-1, 1);
    thermal.next = t + randomBetween(2, 5);
  }
  thermal.now += (thermal.target - thermal.now) * 0.06;
  return thermal.now;
}

/** Huginn's voice on `out`, built once per audio context. */
export function huginnVoice(c: AudioContext, out: AudioNode): HuginnVoice {
  // How much of him shows (he fades in and out at a flight's ends), then the
  // air between him and the viewer, then where he is.
  const input = c.createGain();
  input.gain.value = 0;
  const air = biquad(c, "lowpass", 18000, 0.5);
  const far = c.createGain();
  far.gain.value = 0;
  // The panner only places him; how loud he is at a distance is `far`'s, as
  // its own models fall off too gently for a bird's wings.
  const panner = c.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "linear";
  panner.rolloffFactor = 0;
  input.connect(air).connect(far).connect(panner).connect(out);

  let held: HeldAir | null = null;
  const thermal: Thermal = { now: 0, target: 0, next: 0 };
  let placed = false;
  let scale = 1;
  // The beat under way, so a rest can end it.
  let beat: GainNode | null = null;

  function place(t: number, [x, y, z]: [number, number, number]): void {
    // The listener faces -z; the camera looks along +z.
    const target: [AudioParam, number][] = [
      [panner.positionX, x],
      [panner.positionY, y],
      [panner.positionZ, -z],
    ];
    for (const [param, value] of target) {
      if (placed) param.setTargetAtTime(value, t, FOLLOW);
      else param.setValueAtTime(value, t);
    }
    placed = true;
  }

  function hearAir(event: Extract<HuginnSound, { kind: "air" }>): void {
    const t = Math.max(c.currentTime, audioTimeOf(c, event.at));
    held ??= startHeldAir(c, input, c.currentTime);
    scale = event.scale;
    const pitch = pitchOf(scale);
    const { speed, soar } = event;
    held.glide.gain.setTargetAtTime(
      0.1 * (speed / 10) ** 2 * (1 - soar),
      t,
      FOLLOW,
    );
    const lift = driftThermal(thermal, t);
    held.soar.gain.setTargetAtTime(
      0.11 * (speed / 9) ** 2 * soar * (1 + 0.25 * lift),
      t,
      FOLLOW,
    );
    held.glideTone.frequency.setTargetAtTime(380 * pitch, t, FOLLOW);
    held.soarTone.frequency.setTargetAtTime(
      550 * pitch * (1 + 0.4 * lift),
      t,
      FOLLOW,
    );
    input.gain.setTargetAtTime(event.alpha, t, FOLLOW);
    const distance = Math.hypot(...event.pos);
    air.frequency.setTargetAtTime(airCutoff(distance), t, FOLLOW);
    // A new flight starts where he is, not faded in from the last one's end.
    if (placed) far.gain.setTargetAtTime(distanceGain(distance), t, FOLLOW);
    else far.gain.setValueAtTime(distanceGain(distance), t);
    place(t, event.pos);
  }

  function hearBeat(event: Extract<HuginnSound, { kind: "beat" }>): void {
    if (event.from >= DOWN || event.rate <= 0) return;
    const now = c.currentTime + LEAD;
    let t = audioTimeOf(c, event.at);
    let from = event.from / DOWN;
    // Heard late: start now, the stroke already that far through.
    if (t < now) {
      from += ((now - t) * event.rate) / DOWN;
      t = now;
    }
    const dur = ((1 - from) * DOWN) / event.rate;
    if (from >= 1 || dur < 0.02) return;
    const gate = c.createGain();
    gate.connect(input);
    // A bout that starts mid-stroke eases in, as the drawn wing does.
    if (event.from > 0) {
      gate.gain.setValueAtTime(0, t);
      gate.gain.linearRampToValueAtTime(1, t + 0.15);
    }
    beat = gate;
    twoWings(c, gate, t, dur, from, pitchOf(event.scale));
  }

  function hearRest(event: Extract<HuginnSound, { kind: "rest" }>): void {
    if (!beat) return;
    // The wing stops at the glide pose and eases out over 0.12 s.
    const t = Math.max(c.currentTime, audioTimeOf(c, event.at));
    beat.gain.cancelScheduledValues(t);
    beat.gain.setValueAtTime(1, t);
    beat.gain.linearRampToValueAtTime(0, t + 0.12);
    beat = null;
  }

  function hearRoll(event: Extract<HuginnSound, { kind: "roll" }>): void {
    const t = Math.max(c.currentTime + LEAD, audioTimeOf(c, event.at));
    const k = event.seconds / 1.3;
    const pitch = pitchOf(scale);
    noise(c, input, t, {
      type: "lowpass",
      freq: 700 * pitch,
      to: 300 * pitch,
      q: 0.7,
      peak: 0.07,
      attack: 0.25 * k,
      decay: 0.65 * k,
    });
  }

  function hearGone(): void {
    const t = c.currentTime;
    input.gain.setTargetAtTime(0, t, 0.1);
    const ending = held;
    held = null;
    placed = false;
    beat = null;
    if (ending) for (const src of ending.sources) src.stop(t + 0.6);
  }

  return {
    hear(event) {
      if (event.kind === "air") hearAir(event);
      else if (event.kind === "beat") hearBeat(event);
      else if (event.kind === "rest") hearRest(event);
      else if (event.kind === "roll") hearRoll(event);
      else hearGone();
    },
  };
}
