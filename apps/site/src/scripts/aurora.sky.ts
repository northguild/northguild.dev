// What the real sky looks like from a site right now: sidereal time,
// precession, and the sun and moon. Vectors use the scene's world frame:
// x east, y up, z north. Angles in radians unless named *Deg.
// Moon and sun follow Meeus, "Astronomical Algorithms" (2nd ed.), ch. 25 and
// 47, with the full periodic tables (moon good to about 10″, which eclipses
// need). The planets use JPL's mean Keplerian elements (good to a few arcminutes over
// 1800–2050) and Meeus ch. 41 for their brightness.

import { convertUnixToUtc, getUnixNow, totalDuration } from "@northguild/gmt";
import { taiMinusUtc } from "@northguild/gmt/timescale";
import type { Site } from "./aurora.sites";

export type Mat3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;
const ARCSEC = RAD / 3600;

// Julian day from epoch milliseconds: day 2440587.5 began at the epoch.
const DAY = totalDuration("P1D", "milliseconds")!;
const julian = (ms: number) => ms / DAY + 2440587.5;
// Terrestrial time runs ahead of the clock (UTC) by 32.184 s plus the leap
// seconds so far (TAI − UTC, from gmt's table; read once, as none is due
// within the year we look ahead). The moon moves half an arcsecond a second,
// so the orbit formulas need it. In days.
const DELTA_T =
  (32.184 + (taiMinusUtc(convertUnixToUtc(getUnixNow() ?? 0)) ?? 37)) /
  totalDuration("P1D", "seconds")!;

/** Row-major 3×3 product a·b. */
function mul(a: Mat3, b: Mat3): Mat3 {
  return Array.from({ length: 9 }, (_, k) => {
    const i = Math.floor(k / 3) * 3;
    const j = k % 3;
    return a[i]! * b[j]! + a[i + 1]! * b[3 + j]! + a[i + 2]! * b[6 + j]!;
  }) as Mat3;
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Column-major copy for gl.uniformMatrix3fv. */
export const columns = (m: Mat3) =>
  new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);

/** J2000 equatorial to mean equator of date (IAU 1976 precession). */
function precession(t: number): Mat3 {
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) * ARCSEC;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) * ARCSEC;
  const th = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) * ARCSEC;
  const [cz, sz] = [Math.cos(zeta), Math.sin(zeta)];
  const [cZ, sZ] = [Math.cos(z), Math.sin(z)];
  const [ct, st] = [Math.cos(th), Math.sin(th)];
  return [
    cz * cZ * ct - sz * sZ,
    -sz * cZ * ct - cz * sZ,
    -cZ * st,
    cz * sZ * ct + sz * cZ,
    -sz * sZ * ct + cz * cZ,
    -sZ * st,
    cz * st,
    -sz * st,
    ct,
  ];
}

/** Equatorial of date to the world frame, for local sidereal time lst. */
function horizon(lat: number, lst: number): Mat3 {
  const [cl, sl] = [Math.cos(lst), Math.sin(lst)];
  const [cp, sp] = [Math.cos(lat), Math.sin(lat)];
  return [-sl, cl, 0, cp * cl, cp * sl, sp, -sp * cl, -sp * sl, cp];
}

const ecliptic = (lon: number, lat: number, eps: number): Vec3 => {
  const [cb, sb] = [Math.cos(lat), Math.sin(lat)];
  const [cl, sl] = [Math.cos(lon), Math.sin(lon)];
  const [ce, se] = [Math.cos(eps), Math.sin(eps)];
  return [cb * cl, cb * sl * ce - sb * se, cb * sl * se + sb * ce];
};

// Meeus table 47.A: D, M, M', F, longitude (1e-6°), distance (1e-3 km).
const MOON_LR: number[][] = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322],
  [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950],
  [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0],
  [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616],
  [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117],
  [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0],
  [4, 0, 1, 0, 549, -1423],
  [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571],
  [1, 0, -2, 0, -487, -1739],
  [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0],
  [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0],
  [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0],
  [2, 0, 3, 0, 294, 0],
  [2, 0, -1, -2, 0, 8752],
];
// Meeus table 47.B: D, M, M', F, latitude (1e-6°).
const MOON_B: number[][] = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344],
  [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021],
  [4, 0, -1, 1, 833],
  [0, 0, 1, -3, 777],
  [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607],
  [2, 0, 2, -1, 596],
  [2, -1, 1, -1, 491],
  [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439],
  [2, 0, 2, 1, 422],
  [2, 0, -3, -1, 421],
  [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351],
  [4, 0, 0, 1, 331],
  [2, -1, 1, 1, 315],
  [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283],
  [2, 1, 1, -1, -229],
  [1, 1, 0, -1, 223],
  [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220],
  [2, 1, -1, -1, -220],
  [1, 0, 1, 1, -185],
  [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177],
  [4, 0, -2, -1, 176],
  [4, -1, -1, -1, 166],
  [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132],
  [1, 0, -1, -1, -119],
  [4, -1, 0, -1, 115],
  [2, -2, 0, 1, 107],
];

/** Geocentric ecliptic longitude, latitude (radians) and distance (km). */
export function moonEcliptic(t: number): [number, number, number] {
  const Lp = 218.3164477 + 481267.88123421 * t;
  const D = (297.8501921 + 445267.1114034 * t) * RAD;
  const M = (357.5291092 + 35999.0502909 * t) * RAD;
  const Mp = (134.9633964 + 477198.8675055 * t) * RAD;
  const F = (93.272095 + 483202.0175233 * t) * RAD;
  const A1 = (119.75 + 131.849 * t) * RAD;
  const A2 = (53.09 + 479264.29 * t) * RAD;
  const A3 = (313.45 + 481266.484 * t) * RAD;
  const E = 1 - 0.002516 * t;
  let sl = 0;
  let sr = 0;
  let sb = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) {
    const arg = d! * D + m! * M + mp! * Mp + f! * F;
    const e = E ** Math.abs(m!);
    sl += l! * e * Math.sin(arg);
    sr += r! * e * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of MOON_B) {
    sb +=
      b! * E ** Math.abs(m!) * Math.sin(d! * D + m! * M + mp! * Mp + f! * F);
  }
  const L = Lp * RAD;
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(L - F) + 318 * Math.sin(A2);
  sb +=
    -2235 * Math.sin(L) +
    382 * Math.sin(A3) +
    175 * Math.sin(A1 - F) +
    175 * Math.sin(A1 + F) +
    127 * Math.sin(L - Mp) -
    115 * Math.sin(L + Mp);
  return [(Lp + sl / 1e6) * RAD, (sb / 1e6) * RAD, 385000.56 + sr / 1000];
}

/** Apparent geocentric ecliptic longitude of the sun (radians), less the
 * nutation the moon also leaves out. */
function sunLongitude(t: number): number {
  const L0 = 280.46646 + 36000.76983 * t;
  const M = (357.52911 + 35999.05029 * t) * RAD;
  const C =
    (1.914602 - 0.004817 * t) * Math.sin(M) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * M) +
    0.000289 * Math.sin(3 * M);
  // Aberration: the sun appears 20.5″ behind where it is.
  return (L0 + C - 20.4898 / 3600 + perturbation(t) / 3600) * RAD;
}

/** The pull of the moon, Venus, Mars and Jupiter on the earth (and the
 * formula's own drift), in arcseconds of solar longitude. Fitted to VSOP87
 * via astronomy-engine over 1990–2060: the formula above alone is out by up
 * to 39″, this leaves 14″ over 1900–2100, which keeps eclipses right. */
function perturbation(t: number): number {
  const e = (100.464 + 35999.372 * t) * RAD;
  const v = e - (181.979 + 58517.815 * t) * RAD;
  const j = e - (34.396 + 3034.746 * t) * RAD;
  const ma = e - (-4.553 + 19140.303 * t) * RAD;
  const d = (297.8501921 + 445267.1114034 * t) * RAD;
  const m = (357.5291 + 35999.0503 * t) * RAD;
  const om = (125.04 - 1934.136 * t) * RAD;
  return (
    -8.51 +
    6.46 * Math.sin(d) -
    4.82 * Math.sin(v) +
    5.51 * Math.sin(2 * v) +
    0.64 * Math.sin(3 * v) -
    7.37 * Math.sin(j) +
    2.73 * Math.sin(2 * j) -
    2.12 * Math.sin(2 * ma) -
    2.1 * Math.sin(om) -
    0.68 * Math.sin(j - m) -
    2.53 * Math.cos(j - m) -
    3.01 * Math.sin(m) -
    1.19 * Math.cos(m)
  );
}

// JPL, "Approximate Positions of the Planets" (E. M. Standish), table 1:
// a (au), e, I, L, long. perihelion, long. node (degrees) at J2000, then
// their rates per Julian century. J2000 ecliptic and equinox.
const ORBITS: Record<string, number[]> = {
  mercury: [
    0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593,
    0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689,
    -0.12534081,
  ],
  venus: [
    0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255,
    0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418,
  ],
  earth: [
    1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0,
  ],
  mars: [
    1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088,
    -0.29257343,
  ],
  jupiter: [
    5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
    -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668,
    0.20469106,
  ],
  saturn: [
    9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
    -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216,
    -0.28867794,
  ],
};

/** Heliocentric J2000 ecliptic position (au) from ORBITS. */
function heliocentric(el: number[], t: number): Vec3 {
  const [a, e, i, l, peri, node] = [0, 1, 2, 3, 4, 5].map(
    (k) => el[k]! + el[k + 6]! * t,
  ) as [number, number, number, number, number, number];
  const m = ((((l - peri) % 360) + 540) % 360) - 180;
  const w = (peri - node) * RAD;
  const M = m * RAD;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 6; k++) {
    E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const [cw, sw] = [Math.cos(w), Math.sin(w)];
  const [cn, sn] = [Math.cos(node * RAD), Math.sin(node * RAD)];
  const [ci, si] = [Math.cos(i * RAD), Math.sin(i * RAD)];
  return [
    (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
    (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

// Saturn's north pole (J2000 equatorial), for the tilt of its rings.
const SATURN_POLE: Vec3 = [0.0855, 0.0732, 0.9936];

/** Apparent magnitude from distances to the sun (r) and earth (d), the
 * phase angle i (degrees) and, for Saturn, the ring tilt (Meeus 41). */
const MAGNITUDE: Record<string, (i: number, ring: number) => number> = {
  mercury: (i) => -0.42 + 0.038 * i - 0.000273 * i * i + 0.000002 * i ** 3,
  venus: (i) => -4.4 + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i ** 3,
  mars: (i) => -1.52 + 0.016 * i,
  jupiter: (i) => -9.4 + 0.005 * i,
  saturn: (i, ring) =>
    -8.88 + 0.044 * i - 2.6 * Math.abs(ring) + 1.25 * ring * ring,
};
// B − V colour index, as in the star catalogue.
const COLOUR: Record<string, number> = {
  mercury: 0.93,
  venus: 0.82,
  mars: 1.36,
  jupiter: 0.83,
  saturn: 1.04,
};
const EPS0 = 23.43928 * RAD;

/** Planet names in the order planets() lists them. */
export const PLANETS = ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"];

/** The naked-eye planets as star records: J2000 equatorial direction, then
 * magnitude and colour (see starData in the worker). */
export function planets(t: number): Float32Array {
  const earth = heliocentric(ORBITS.earth!, t);
  const sunDist = Math.hypot(...earth);
  const names = PLANETS.map((name) => name.toLowerCase());
  const out = new Float32Array(names.length * 5);
  names.forEach((name, k) => {
    const p = heliocentric(ORBITS[name]!, t);
    const g: Vec3 = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
    const r = Math.hypot(...p);
    const d = Math.hypot(...g);
    const i =
      Math.acos(
        Math.min(
          1,
          Math.max(-1, (r * r + d * d - sunDist * sunDist) / (2 * r * d)),
        ),
      ) / RAD;
    const [ce, se] = [Math.cos(EPS0), Math.sin(EPS0)];
    const eq: Vec3 = [
      g[0] / d,
      (ce * g[1] - se * g[2]) / d,
      (se * g[1] + ce * g[2]) / d,
    ];
    const ring = -(
      eq[0] * SATURN_POLE[0] +
      eq[1] * SATURN_POLE[1] +
      eq[2] * SATURN_POLE[2]
    );
    const mag = MAGNITUDE[name]!(i, ring) + 5 * Math.log10(r * d);
    out.set([...eq, mag, COLOUR[name]!], k * 5);
  });
  return out;
}

const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** Fraction of a disc of radius a left uncovered by a disc of radius b whose
 * centre is d away (small angles, so flat geometry). */
function uncovered(a: number, b: number, d: number): number {
  if (d >= a + b) return 1;
  if (d <= b - a) return 0;
  if (d <= a - b) return 1 - (b * b) / (a * a);
  const p = Math.acos((d * d + a * a - b * b) / (2 * d * a));
  const q = Math.acos((d * d + b * b - a * a) / (2 * d * b));
  const lens =
    a * a * (p - Math.sin(p) * Math.cos(p)) +
    b * b * (q - Math.sin(q) * Math.cos(q));
  return 1 - lens / (Math.PI * a * a);
}

/** Atmospheric refraction (degrees) for a geometric altitude (degrees):
 * how much the air lifts what is seen there. NOAA's solar calculator formula
 * (after Saemundsson and Bennett), about 34′ at the horizon, 9′ at 5°, 0′ at
 * the zenith; the same one baldurpan.com uses for the sun over Ísafjörður. */
export function refraction(alt: number): number {
  if (alt > 85) return 0;
  const t = Math.tan(alt * RAD);
  const arcsec =
    alt > 5
      ? 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5
      : alt > -0.575
        ? 1735 + alt * (-518.2 + alt * (103.4 + alt * (-12.79 + alt * 0.711)))
        : -20.774 / t;
  return arcsec / 3600;
}

/** A world direction as it is seen: lifted by refraction, same azimuth.
 * Everything drawn in the sky goes through this (stars and planets in the
 * star shader's copy); orbits and eclipses keep the true directions. */
export function lift(d: Vec3): Vec3 {
  const alt = Math.asin(Math.min(1, Math.max(-1, d[1]))) / RAD;
  const h = Math.hypot(d[0], d[2]);
  if (alt > 85 || h < 1e-9) return d;
  const seen = (alt + refraction(alt)) * RAD;
  const c = Math.cos(seen) / h;
  return [d[0] * c, Math.sin(seen), d[2] * c];
}

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

export type Sky = {
  /** J2000 equatorial to world, for the star catalogue. */
  stars: Mat3;
  /** Unit vector to the moon (topocentric) and its angular radius. */
  moon: Vec3;
  moonRadius: number;
  /** Lunar north (ecliptic pole is within 1.5° of it). */
  moonNorth: Vec3;
  sun: Vec3;
  /** Sun's angular radius, and the fraction of its disc the moon leaves
   * uncovered (1 outside a solar eclipse). */
  sunRadius: number;
  sunVisible: number;
  /** Earth's shadow at the moon, in moon radii: the shadow axis relative to
   * the moon's centre (world frame), then the umbra and penumbra radii. */
  shadow: Vec3;
  umbra: number;
  penumbra: number;
  /** 0..1: how much the moon lights the sky (phase, altitude, eclipse). */
  moonlight: number;
  /** The planets as star records, drawn with the stars matrix. */
  planets: Float32Array;
};

/** The clock and the world frame for a site at a moment: Julian day,
 * Julian centuries of terrestrial time (for the orbits; sidereal time uses
 * the clock), local sidereal time, latitude, the equatorial-to-world matrix
 * and the obliquity. */
function frame(site: Site, ms: number) {
  const jd = julian(ms);
  const t = (jd + DELTA_T - 2451545) / 36525;
  const gmst =
    (280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t) *
    RAD;
  const lst = gmst + site.lon * RAD;
  const lat = site.lat * RAD;
  const hor = horizon(lat, lst);
  const eps = (23.4392911 - 0.0130042 * t) * RAD;
  return { t, lst, lat, hor, eps };
}

/** Topocentric moon (km, equatorial of date): the geocentric position less
 * the observer's. */
function topocentric(geo: Vec3, lat: number, lst: number): Vec3 {
  const u = Math.atan(0.99664719 * Math.tan(lat));
  const rc = 6378.14 * Math.cos(u);
  const rs = 6378.14 * 0.99664719 * Math.sin(u);
  return [
    geo[0] - rc * Math.cos(lst),
    geo[1] - rc * Math.sin(lst),
    geo[2] - rs,
  ];
}

/** Just the sun and moon, for looking ahead: world directions, the moon's
 * age as its elongation east of the sun in ecliptic longitude (0 new, π
 * full, radians in 0..2π), and the fraction of its disc lit. */
/** The sun's angular radius (radians) from its distance. */
function sunRadiusAt(t: number): number {
  const m = (357.52911 + 35999.05029 * t) * RAD;
  const au = 1.00014 - 0.01671 * Math.cos(m) - 0.00014 * Math.cos(2 * m);
  return (959.63 / au) * ARCSEC;
}

export function sunAndMoon(
  site: Site,
  ms: number,
): {
  sun: Vec3;
  sunRadius: number;
  moon: Vec3;
  moonRadius: number;
  age: number;
  lit: number;
} {
  const { t, lst, lat, hor, eps } = frame(site, ms);
  const [ml, mb, dist] = moonEcliptic(t);
  const sl = sunLongitude(t);
  const geo = ecliptic(ml, mb, eps).map((c) => c * dist) as Vec3;
  const topo = topocentric(geo, lat, lst);
  const age = (((ml - sl) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return {
    sun: lift(normalize(apply(hor, ecliptic(sl, 0, eps)))),
    sunRadius: sunRadiusAt(t),
    moon: lift(normalize(apply(hor, topo))),
    moonRadius: Math.asin(1737.4 / Math.hypot(...topo)),
    age,
    lit: (1 - Math.cos(mb) * Math.cos(age)) / 2,
  };
}

export function sky(site: Site, ms: number): Sky {
  const { t, lst, lat, hor, eps } = frame(site, ms);

  // Topocentric moon: subtract the observer's position from the geocentric one.
  const [ml, mb, dist] = moonEcliptic(t);
  const geo = ecliptic(ml, mb, eps).map((c) => c * dist) as Vec3;
  const topo = topocentric(geo, lat, lst);
  const range = Math.hypot(...topo);
  const moon = normalize(apply(hor, topo));
  const sun = normalize(apply(hor, ecliptic(sunLongitude(t), 0, eps)));
  const moonNorth = normalize(apply(hor, [0, -Math.sin(eps), Math.cos(eps)]));

  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const moonRadius = Math.asin(1737.4 / range);

  // Solar eclipse: how much of the sun's disc the moon leaves showing.
  const m = (357.52911 + 35999.05029 * t) * RAD;
  const au = 1.00014 - 0.01671 * Math.cos(m) - 0.00014 * Math.cos(2 * m);
  const sunRadius = (959.63 / au) * ARCSEC;
  const sunVisible = uncovered(
    sunRadius,
    moonRadius,
    Math.acos(Math.min(1, dot(sun, moon))),
  );

  // Lunar eclipse: Earth's shadow cone where the moon crosses it. The
  // atmosphere widens the earth by 1/85 (Danjon's rule, as eclipse tables use).
  const mw = apply(hor, geo);
  const behind = -dot(mw, sun);
  const shadow = mw.map((c, i) => (sun[i]! * -behind - c) / 1737.4) as Vec3;
  const sunKm = au * 149597870.7;
  // Radii below zero: the moon is on the sun's side, out of the shadow.
  const earth = 6367.5 * (1 + 1 / 85);
  const umbra =
    behind > 0 ? (earth - (behind * (696000 - 6367.5)) / sunKm) / 1737.4 : -2;
  const penumbra =
    behind > 0 ? (earth + (behind * (696000 + 6367.5)) / sunKm) / 1737.4 : -1;
  // Sunlight left at the centre of the moon's face.
  const q = moon.map((c, i) => -c - shadow[i]!) as Vec3;
  const off = q.map((c, i) => c - sun[i]! * dot(q, sun)) as Vec3;
  const sunlit = smoothstep(umbra, penumbra, Math.hypot(...off));

  // Illuminated fraction from the sun–moon angle, faded by moon altitude.
  const lit = (1 - dot(sun, moon)) / 2;
  const alt = Math.asin(moon[1]) / RAD;
  const up = Math.min(1, Math.max(0, (alt + 2) / 17));
  // Drawn where they are seen: lifted by refraction. The eclipse geometry
  // above keeps the true directions.
  return {
    stars: mul(hor, precession(t)),
    moon: lift(moon),
    moonRadius,
    moonNorth,
    sun: lift(sun),
    sunRadius,
    sunVisible,
    shadow,
    umbra,
    penumbra,
    moonlight: lit ** 1.5 * up * up * (3 - 2 * up) * sunlit,
    planets: planets(t),
  };
}
