// When the sun and moon next show in this window, from each site: the worker
// steps ahead through time and asks, at each step, whether the body is up,
// clear of the skyline and inside the frame, skipping ahead while it is far. All clock reading, arithmetic
// and formatting goes through @northguild/gmt, in the visitor's own time zone.

import {
  addUnix,
  endOfUnix,
  areUnixEqualBy,
  formatCalendarUnix,
  formatUnix,
  roundUnix,
  totalDuration,
} from "@northguild/gmt";
import type { Site } from "./aurora.sites";
import { sunAndMoon, type Vec3 } from "./aurora.sky";

/** One body's next spell in view, as text: `now` when it is in view already. */
export type BodyTimes = { now: boolean; when: string };
/** The moon also brings its phase at that time, and its age (0 new, π full)
 * for the icon. */
export type MoonTimes = BodyTimes & { phase: string; age: number };
/** The sun, its halo or pillar (which can show while the disc is behind the
 * mountains), and the moon. */
export type SiteTimes = { sun: BodyTimes; halo: BodyTimes; moon: MoonTimes };

/** What one site's view shows on a screen this size. Each test returns 0
 * when the thing shows, otherwise a lower bound on the angle (radians) the
 * sky must still turn through before it can, or a tiny positive number when
 * it is close. */
export type Seer = {
  /** Any part of a disc (centre d, angular radius r) in frame and clear of
   * the skyline, while its centre is above `above` (radians). */
  disc: (d: Vec3, r: number, above: number) => number;
  /** The sun's pillar where it is drawn at half strength or more (a sun
   * below about 4°, the 2° above it; 1° of that at least), or a quarter of
   * its 22° halo while its disc (radius r) shows too: in frame and clear of
   * the skyline, while the sun is up (as the sky draws them). */
  halo: (sun: Vec3, r: number) => number;
};

const LOCAL = { timeZone: "local" } as const;
/** An ISO 8601 duration (a constant, so always valid) in milliseconds. */
const ms = (iso: string) => totalDuration(iso, "milliseconds")!;
const HOUR = ms("PT1H");
// No point on the sky moves faster than 15° an hour as the earth turns; the
// moon adds about half a degree. So a body this far from the frame cannot
// reach it sooner than angle / RATE, and the search skips ahead that much.
const RATE = (16 * Math.PI) / 180 / HOUR;
// Near the frame, a step a minute, so even the briefest spell (the sun
// peeking between peaks) is caught; each edge is then refined by halving.
const STEP = ms("PT1M");
const EDGE = ms("PT10S");
// Steps per slice, so the sky keeps drawing while we look.
const SLICE = 1500;
// How high the sun must be seen to count: the sky fades the sun, its halo
// and its pillar in as its seen height (y, lifted by refraction) goes from
// -0.0047 to 0.0347 (sun() in aurora.shaders.ts), and they count from half
// strength, y = 0.015, about 0.86° up. Lower, they are drawn too faintly.
export const SUN_UP = Math.asin(0.015);

/** The first moment in (a, b] that seen() holds, given it fails at a and
 * holds at b. */
function edge(seen: (ms: number) => boolean, a: number, b: number): number {
  while (b - a > EDGE) {
    const mid = Math.floor((a + b) / 2);
    if (seen(mid)) b = mid;
    else a = mid;
  }
  return b;
}

/** The next spell in view from `from`: [start, end], with start = from when
 * already in view and end null when it lasts longer than `longest`; null
 * when none starts before `until`. Yields between slices. */
function* spell(
  away: (ms: number) => number,
  from: number,
  until: number,
  longest: number,
): Generator<void, [number, number | null] | null> {
  const seen = (ms: number) => away(ms) === 0;
  let n = 0;
  let t = from;
  let far = away(t);
  if (far > 0) {
    for (;;) {
      const next = t + Math.max(STEP, Math.ceil(far / RATE));
      if (next > until) return null;
      const then = away(next);
      if (then === 0) {
        t = edge(seen, t, next);
        break;
      }
      [t, far] = [next, then];
      if (++n % SLICE === 0) yield;
    }
  }
  const start = t;
  const gone = (ms: number) => !seen(ms);
  const cap = start + longest;
  while (t < cap) {
    const next = t + STEP;
    if (gone(next)) return [start, edge(gone, t, next)];
    t = next;
    if (++n % SLICE === 0) yield;
  }
  return [start, null];
}

const PRINCIPAL = ["New moon", "First quarter", "Full moon", "Last quarter"];
const BETWEEN = [
  "Waxing crescent",
  "Waxing gibbous",
  "Waning gibbous",
  "Waning crescent",
];

/** Phase name and how much is lit, e.g. "Waxing gibbous, 78% lit". The
 * principal phases hold within 7° of elongation, about half a day. */
function phaseText(age: number, lit: number): string {
  const deg = (age * 180) / Math.PI;
  const quarter = Math.round(deg / 90);
  const name =
    Math.abs(deg - quarter * 90) < 7
      ? PRINCIPAL[quarter % 4]!
      : BETWEEN[Math.floor(deg / 90) % 4]!;
  return `${name}, ${Math.round(lit * 100)}% lit`;
}

const capital = (text: string) =>
  text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** "today at 21:40", "tomorrow at 02:10", "in 3 days at …", then a date. */
const day = (ms: number, now: number) =>
  formatCalendarUnix(ms, undefined, { ...LOCAL, reference: now });

/** The time alone when it falls on the same local day as `ref`. */
const until = (ms: number, ref: number, now: number) =>
  areUnixEqualBy(ms, ref, "day", LOCAL)
    ? formatUnix(ms, undefined, { ...LOCAL, timeStyle: "short" })
    : day(ms, now);

function describe(
  found: [number, number | null] | null,
  now: number,
): BodyTimes {
  if (!found) return { now: false, when: "Not in view in the coming year" };
  const minute = (ms: number) =>
    roundUnix(ms, { smallestUnit: "minute", ...LOCAL }) ?? ms;
  const [start, end] = found;
  if (start === now) {
    return {
      now: true,
      when: end
        ? `In view now, until ${until(minute(end), now, now)}`
        : "In view now",
    };
  }
  const from = minute(start);
  return {
    now: false,
    when: end
      ? `${capital(day(from, now))} – ${until(minute(end), from, now)}`
      : capital(day(from, now)),
  };
}

/** For each site, when the sun and moon are next in view; returns the times
 * and the moment they next need working out again: when a spell starts or
 * ends, just after local midnight (so "today" and "tomorrow" stay true), and
 * at least hourly. Yields between slices of the search. */
export function* lookAhead(
  sites: Site[],
  seers: Seer[],
  now: number,
): Generator<void, { times: SiteTimes[]; next: number }> {
  // A year ahead on the calendar; on bad input, no search at all.
  const year = addUnix(now, { years: 1 }, LOCAL) ?? now;
  const longest = ms("P2D");
  const midnight = (endOfUnix(now, "day", LOCAL) ?? now + HOUR) + 1;
  let next = Math.min(now + HOUR, midnight);
  const times: SiteTimes[] = [];
  for (const [i, site] of sites.entries()) {
    const see = seers[i]!;
    const sun = yield* spell(
      (ms) => {
        const at = sunAndMoon(site, ms);
        return see.disc(at.sun, at.sunRadius, SUN_UP);
      },
      now,
      year,
      longest,
    );
    const halo = yield* spell(
      (ms) => {
        const at = sunAndMoon(site, ms);
        return see.halo(at.sun, at.sunRadius);
      },
      now,
      year,
      longest,
    );
    const moon = yield* spell(
      (ms) => {
        const at = sunAndMoon(site, ms);
        return see.disc(at.moon, at.moonRadius, -Math.PI / 2);
      },
      now,
      year,
      longest,
    );
    for (const found of [sun, halo, moon]) {
      for (const ms of found ?? []) {
        if (ms !== null && ms > now && ms < next) next = ms;
      }
    }
    const { age, lit } = sunAndMoon(site, moon?.[0] ?? now);
    times.push({
      sun: describe(sun, now),
      halo: describe(halo, now),
      moon: { ...describe(moon, now), phase: phaseText(age, lit), age },
    });
  }
  return { times, next };
}
