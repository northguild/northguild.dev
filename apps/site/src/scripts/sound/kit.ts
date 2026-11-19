// The helpers every voice is built from: the GMT docs' kit
// (gmt apps/dox/src/lib/sound/kit.ts) and the wing strokes from
// context/reference/huginn-sound-audition.html. Every time is a time on the
// audio clock (`AudioContext.currentTime`); nothing here reads a wall clock.
// Shared effects and buffers are built once per context.

export function randomBetween(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

const masters = new WeakMap<AudioContext, AudioNode>();
const shared = new WeakMap<AudioContext, Map<string, unknown>>();

/** Name the bus the shared effects feed. */
export function setMaster(c: AudioContext, node: AudioNode): void {
  masters.set(c, node);
}

/** Build `key` once per context. */
function sharedFx<T>(
  c: AudioContext,
  key: string,
  build: (c: AudioContext, out: AudioNode) => T,
): T {
  let fx = shared.get(c);
  if (!fx) {
    fx = new Map();
    shared.set(c, fx);
  }
  if (!fx.has(key)) fx.set(key, build(c, masters.get(c) ?? c.destination));
  return fx.get(key) as T;
}

/** The loudest the bus lets out: −12 dBFS. */
const CEILING = 0.25;
/** Below this the bus passes the signal unchanged. */
const KNEE = 0.18;

/** The safety ceiling between the master bus and the speakers: a fixed curve
 * that bends loud samples softly toward `CEILING`, never past it. */
export function ceiling(c: AudioContext): WaveShaperNode {
  const points = 4097;
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const m = Math.abs(x);
    const y =
      m <= KNEE
        ? m
        : KNEE + (CEILING - KNEE) * Math.tanh((m - KNEE) / (CEILING - KNEE));
    curve[i] = Math.sign(x) * y;
  }
  const shaper = c.createWaveShaper();
  shaper.curve = curve;
  return shaper;
}

/**
 * White noise for anything held: 11.3 s, not a round number, so no two held
 * layers loop in step. A one-second loop under a low filter is heard: its
 * pattern comes round every second, like an alarm. Built once per context.
 */
export function noiseBuffer(c: AudioContext): AudioBuffer {
  return sharedFx(c, "noise", (cc) => {
    const length = Math.round(cc.sampleRate * 11.3);
    const buffer = cc.createBuffer(1, length, cc.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  });
}

/** Brown noise, 12.7 s: each sample a small random step from the last, so
 * its energy lies low and it rumbles, as far traffic and surf do. */
export function brownNoiseBuffer(c: AudioContext): AudioBuffer {
  return sharedFx(c, "brown", (cc) => {
    const length = Math.round(cc.sampleRate * 12.7);
    const buffer = cc.createBuffer(1, length, cc.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    return buffer;
  });
}

/** One second of sparse clicks: feather barbs catching and letting go, or the
 * aurora's faint rustle. */
export function crackleBuffer(c: AudioContext): AudioBuffer {
  return sharedFx(c, "crackle", (cc) => {
    const buffer = cc.createBuffer(1, cc.sampleRate, cc.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < 700; i++) {
      const at = Math.floor(Math.random() * (data.length - 32));
      const amp = (Math.random() * 2 - 1) * (0.3 + 0.7 * Math.random() ** 2);
      for (let k = 0; k < 24; k++) {
        data[at + k]! += amp * Math.exp(-k / 5) * (k % 2 ? -1 : 1);
      }
    }
    return buffer;
  });
}

/** Looping noise from `t`, starting anywhere in the buffer. */
export function heldNoise(
  c: AudioContext,
  t: number,
  buffer = noiseBuffer(c),
): AudioBufferSourceNode {
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start(t, Math.random() * buffer.duration);
  return src;
}

/** Silence, a linear attack, a hold, an exponential release. */
export function envelope(
  c: AudioContext,
  t: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return g;
}

export function biquad(
  c: AudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 0.7,
): BiquadFilterNode {
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

export type ToneOptions = {
  freq: number;
  to?: number;
  peak: number;
  attack?: number;
  hold?: number;
  release: number;
};

/** A dark space of water: a decaying noise impulse 2.6 s long, through a
 * low-pass, on the master bus. Built once per context; returns the send. */
export function space(c: AudioContext): ConvolverNode {
  return sharedFx(c, "space", (cc, out) => {
    const length = Math.ceil(cc.sampleRate * 2.6);
    const impulse = cc.createBuffer(2, length, cc.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        d[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
      }
    }
    const verb = cc.createConvolver();
    verb.buffer = impulse;
    const wet = cc.createGain();
    wet.gain.value = 0.5;
    verb
      .connect(biquad(cc, "lowpass", 3000))
      .connect(wet)
      .connect(out);
    return verb;
  });
}

/** One sine note. */
export function tone(
  c: AudioContext,
  out: AudioNode,
  t: number,
  o: ToneOptions,
): void {
  const attack = o.attack ?? 0.004;
  const hold = o.hold ?? 0;
  const end = t + attack + hold + o.release;
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, end);
  osc.connect(envelope(c, t, o.peak, attack, hold, o.release)).connect(out);
  osc.start(t);
  osc.stop(end + 0.03);
}

export type NoiseOptions = {
  type?: BiquadFilterType;
  freq: number;
  to?: number;
  q?: number;
  peak: number;
  attack?: number;
  hold?: number;
  decay: number;
};

/** A burst of filtered noise; `to` sweeps the filter over it. */
export function noise(
  c: AudioContext,
  out: AudioNode,
  t: number,
  o: NoiseOptions,
): void {
  const attack = o.attack ?? 0.004;
  const hold = o.hold ?? 0;
  const end = t + attack + hold + o.decay;
  const f = biquad(c, o.type ?? "bandpass", o.freq, o.q ?? 1);
  // Anchor the sweep at t, or a burst scheduled ahead arrives already swept.
  f.frequency.setValueAtTime(o.freq, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, end);
  const src = heldNoise(c, t);
  src
    .connect(f)
    .connect(envelope(c, t, o.peak, attack, hold, o.decay))
    .connect(out);
  src.stop(end + 0.03);
}

/**
 * `lo + (hi - lo) * sin(pi x)^pow` over x from `from` to 1: the wing's speed
 * through a stroke, or the light's edge crossing a box. `from` cuts the curve
 * to the part still to come, for a stroke already under way.
 */
export function strokeCurve(
  lo: number,
  hi: number,
  pow: number,
  from = 0,
): Float32Array<ArrayBuffer> {
  const n = 64;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = from + ((1 - from) * i) / (n - 1);
    curve[i] = lo + (hi - lo) * Math.sin(Math.PI * x) ** pow;
  }
  return curve;
}

export type StrokeOptions = {
  type?: BiquadFilterType;
  /** The filter at the ends of the stroke and at its fastest. */
  lo: number;
  hi: number;
  q?: number;
  peak: number;
  /** How sharply the level peaks (default 2: the wing's speed squared). */
  pow?: number;
  buffer?: AudioBuffer;
  /** The part of the stroke already gone, 0 to 1. */
  from?: number;
};

/**
 * Air pushed through a stroke: noise whose level and brightness both follow
 * the stroke's speed, from `t` for `dur` seconds. Unpitched, as real wing
 * noise is.
 */
export function airStroke(
  c: AudioContext,
  out: AudioNode,
  t: number,
  dur: number,
  o: StrokeOptions,
): void {
  if (dur < 0.01 || o.peak <= 0) return;
  const from = o.from ?? 0;
  const f = biquad(c, o.type ?? "lowpass", o.lo, o.q ?? 0.7);
  f.frequency.setValueCurveAtTime(strokeCurve(o.lo, o.hi, 1.5, from), t, dur);
  const g = c.createGain();
  g.gain.value = 0;
  const level = strokeCurve(0, o.peak, o.pow ?? 2, from);
  level[level.length - 1] = 0;
  g.gain.setValueCurveAtTime(level, t, dur);
  const src = heldNoise(c, t, o.buffer);
  src.connect(f).connect(g).connect(out);
  src.stop(t + dur + 0.05);
}
