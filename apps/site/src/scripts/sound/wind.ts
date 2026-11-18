// The air of the place: a very light breeze under the sky, there whether
// Huginn is near, far off or gone, so the scene never drops to silence
// between his flights. The skies are gentle weather, so the air is too: never
// a gust that pushes, only soft rises and falls. Each sky has its own, as the
// two places do:
//
// - Ísafjörður, a fjord between steep mountains on the North Atlantic: a
//   light, cool breeze off the water, a touch deeper, and the sea lapping
//   softly in the fjord now and then, on one side or the other.
// - Helsinki, low and sheltered on the Baltic: a lighter, stiller breeze,
//   over the faint far murmur of the city.
//
// Real air never repeats, so nothing here runs on a cycle: each layer picks
// its next change at a random moment and eases toward it slowly. Nor does its
// grain: each layer's noise is a long buffer (kit.ts) started anywhere in it,
// with its speed wandering a little, so the loop never comes round in step. A
// short loop under a low filter is heard as a pattern every time it repeats,
// like an alarm. The air is kept dark and soft, well clear of the hiss of
// static. Switching sky crossfades one place's air into the other's.

import { biquad, brownNoiseBuffer, heldNoise, randomBetween } from "./kit";

/** How far a layer's playback speed wanders, either way: enough that its
 * noise never lines up with itself, too little to hear as a change of pitch. */
const WANDER = 0.06;

/** Let a layer's noise wander a little in speed from `at`, over `ease`. */
function wander(src: AudioBufferSourceNode, at: number, ease: number): void {
  src.playbackRate.setTargetAtTime(
    randomBetween(1 - WANDER, 1 + WANDER),
    at,
    ease,
  );
}

export type Place = "isafjordur" | "helsinki";

/** How often the scheduler looks ahead, ms: a tick, never a clock read. */
const TICK_MS = 250;
/** How far ahead of the audio clock changes are planned, seconds. */
const AHEAD = 0.6;
/** How long one place's air takes to give way to another's, seconds. */
const CROSSFADE = 2.5;
/** How loud each place's air sits: a light breeze, under everything. */
const LEVEL: Record<Place, number> = { isafjordur: 0.04, helsinki: 0.035 };

/** One layer of a place's air: when it next changes, and how. */
type Layer = {
  next: number;
  shift(t: number): void;
  sources: AudioScheduledSourceNode[];
};

type BreezeOptions = {
  side: number;
  level: number;
  /** Seconds between changes. */
  gap: [number, number];
  /** How still it mostly is: the higher, the rarer a stronger breath. */
  calm: number;
  /** The least it falls to, as a share of its strongest. */
  floor: number;
  /** Its darkest and brightest, Hz: a stronger breath is a little brighter. */
  lo: number;
  hi: number;
};

/** A breeze: soft, dark air rising and falling a little, at random. */
function breeze(
  c: AudioContext,
  out: AudioNode,
  t: number,
  o: BreezeOptions,
): Layer {
  const src = heldNoise(c, t);
  const tone = biquad(c, "lowpass", o.lo, 0.5);
  const air = c.createGain();
  air.gain.value = o.floor * o.level;
  const pan = c.createStereoPanner();
  pan.pan.value = o.side;
  src
    .connect(biquad(c, "lowpass", 1000, 0.5))
    .connect(tone)
    .connect(air)
    .connect(pan)
    .connect(out);
  const layer: Layer = {
    next: t,
    sources: [src],
    shift(at) {
      const gap = randomBetween(...o.gap);
      const strength = Math.random() ** o.calm;
      // Ease over longer than the gap: no change ever lands as a push.
      const ease = gap * randomBetween(0.7, 1.1);
      air.gain.setTargetAtTime(
        o.level * (o.floor + (1 - o.floor) * strength),
        at,
        ease,
      );
      tone.frequency.setTargetAtTime(o.lo + (o.hi - o.lo) * strength, at, ease);
      wander(src, at, ease);
      layer.next = at + gap;
    },
  };
  layer.shift(t);
  return layer;
}

/** The sea in the fjord: now and then a small, slow lap, rising and falling
 * away. */
function lapping(
  c: AudioContext,
  out: AudioNode,
  t: number,
  side: number,
  level: number,
): Layer {
  // Brown noise: its weight is low, as surf's is.
  const src = heldNoise(c, t, brownNoiseBuffer(c));
  const tone = biquad(c, "lowpass", 340, 0.5);
  const wave = c.createGain();
  wave.gain.value = 0;
  const pan = c.createStereoPanner();
  pan.pan.value = side;
  src
    .connect(biquad(c, "highpass", 80, 0.5))
    .connect(tone)
    .connect(wave)
    .connect(pan)
    .connect(out);
  const layer: Layer = {
    next: t + randomBetween(2, 6),
    sources: [src],
    shift(at) {
      const rise = randomBetween(1.5, 3);
      const fall = randomBetween(3, 5);
      const size = randomBetween(0.3, 0.8);
      wave.gain.setTargetAtTime(level * size, at, rise / 3);
      tone.frequency.setTargetAtTime(340 + 260 * size, at, rise / 3);
      wave.gain.setTargetAtTime(level * size * 0.05, at + rise, fall / 3);
      tone.frequency.setTargetAtTime(320, at + rise, fall / 3);
      wander(src, at, rise + fall);
      layer.next =
        at + rise + fall * randomBetween(0.8, 1.3) + randomBetween(1, 5);
    },
  };
  return layer;
}

/** The far city: a low murmur, almost still, drifting a little at random. */
function murmur(
  c: AudioContext,
  out: AudioNode,
  t: number,
  level: number,
): Layer {
  // Brown noise: a deep, soft rumble, as far traffic is.
  const src = heldNoise(c, t, brownNoiseBuffer(c));
  const hum = c.createGain();
  hum.gain.value = level;
  src
    .connect(biquad(c, "lowpass", 220, 0.5))
    .connect(hum)
    .connect(out);
  const layer: Layer = {
    next: t,
    sources: [src],
    shift(at) {
      const gap = randomBetween(4, 8);
      hum.gain.setTargetAtTime(level * randomBetween(0.75, 1), at, gap / 2);
      wander(src, at, gap / 2);
      layer.next = at + gap;
    },
  };
  return layer;
}

/** A place's air, every layer on `out`. */
function placeAir(
  c: AudioContext,
  out: AudioNode,
  place: Place,
  t: number,
): Layer[] {
  if (place === "helsinki") {
    const still: Omit<BreezeOptions, "side"> = {
      level: 0.7,
      gap: [2, 5],
      calm: 3,
      floor: 0.45,
      lo: 340,
      hi: 600,
    };
    return [
      breeze(c, out, t, { ...still, side: -0.5 }),
      breeze(c, out, t, { ...still, side: 0.5 }),
      murmur(c, out, t, 0.1),
    ];
  }
  const offTheWater: Omit<BreezeOptions, "side"> = {
    level: 0.8,
    gap: [1.5, 4.5],
    calm: 2.4,
    floor: 0.4,
    lo: 280,
    hi: 560,
  };
  return [
    breeze(c, out, t, { ...offTheWater, side: -0.5 }),
    breeze(c, out, t, { ...offTheWater, side: 0.5 }),
    lapping(c, out, t, -0.7, 0.13),
    lapping(c, out, t, 0.6, 0.1),
  ];
}

export type Air = {
  /** Crossfade to another place's air. */
  moveTo(place: Place): void;
};

/** Start the air of `place` on `out`, rising over `fadeIn` seconds. */
export function startAir(
  c: AudioContext,
  out: AudioNode,
  place: Place,
  fadeIn: number,
): Air {
  let here: Place = place;
  let gain: GainNode | null = null;
  let layers: Layer[] = [];

  function begin(next: Place, over: number): void {
    const t = c.currentTime;
    gain = c.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(LEVEL[next], t + over);
    gain.connect(out);
    layers = placeAir(c, gain, next, t);
    here = next;
  }

  begin(place, fadeIn);
  // Each tick plans what falls within the next AHEAD seconds. A suspended
  // context's clock stands still, so nothing piles up in a hidden tab.
  setInterval(() => {
    const horizon = c.currentTime + AHEAD;
    for (const layer of layers) {
      if (layer.next < horizon) {
        layer.shift(Math.max(layer.next, c.currentTime));
      }
    }
  }, TICK_MS);

  return {
    moveTo(next) {
      if (next === here || !gain) return;
      const t = c.currentTime;
      const leaving = gain;
      leaving.gain.cancelScheduledValues(t);
      leaving.gain.setValueAtTime(leaving.gain.value, t);
      leaving.gain.linearRampToValueAtTime(0, t + CROSSFADE);
      for (const layer of layers) {
        for (const src of layer.sources) src.stop(t + CROSSFADE + 0.1);
      }
      begin(next, CROSSFADE);
    },
  };
}
