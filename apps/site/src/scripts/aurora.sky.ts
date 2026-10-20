// What the real sky looks like from a site right now: sidereal time,
// precession, and the sun and moon. Vectors use the scene's world frame:
// x east, y up, z north. Angles in radians unless named *Deg.
// Moon and sun follow Meeus, "Astronomical Algorithms" (2nd ed.), ch. 25 and
// 47, with the larger periodic terms only (moon good to about 0.05°).

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

const julian = (ms: number) => ms / 86400000 + 2440587.5;

/** Row-major 3×3 product a·b. */
function mul(a: Mat3, b: Mat3): Mat3 {
  return Array.from({ length: 9 }, (_, k) => {
    const i = Math.floor(k / 3) * 3;
    const j = k % 3;
    return a[i]! * b[j]! + a[i + 1]! * b[3 + j]! + a[i + 2]! * b[6 + j]!;
  }) as Mat3;
}

function apply(m: Mat3, v: Vec3): Vec3 {
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

/** Geocentric ecliptic longitude of the sun (radians). */
function sunLongitude(t: number): number {
  const L0 = 280.46646 + 36000.76983 * t;
  const M = (357.52911 + 35999.05029 * t) * RAD;
  const C =
    (1.914602 - 0.004817 * t) * Math.sin(M) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * M) +
    0.000289 * Math.sin(3 * M);
  return (L0 + C) * RAD;
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
  /** 0..1: how much the moon lights the sky (phase and altitude). */
  moonlight: number;
};

export function sky(site: Site, ms: number): Sky {
  const jd = julian(ms);
  const t = (jd - 2451545) / 36525;
  const gmst =
    (280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t) *
    RAD;
  const lst = gmst + site.lon * RAD;
  const lat = site.lat * RAD;
  const hor = horizon(lat, lst);
  const eps = (23.4392911 - 0.0130042 * t) * RAD;

  // Topocentric moon: subtract the observer's position from the geocentric one.
  const [ml, mb, dist] = moonEcliptic(t);
  const geo = ecliptic(ml, mb, eps).map((c) => c * dist) as Vec3;
  const u = Math.atan(0.99664719 * Math.tan(lat));
  const rc = 6378.14 * Math.cos(u);
  const rs = 6378.14 * 0.99664719 * Math.sin(u);
  const topo: Vec3 = [
    geo[0] - rc * Math.cos(lst),
    geo[1] - rc * Math.sin(lst),
    geo[2] - rs,
  ];
  const range = Math.hypot(...topo);
  const moon = normalize(apply(hor, topo));
  const sun = normalize(apply(hor, ecliptic(sunLongitude(t), 0, eps)));
  const moonNorth = normalize(apply(hor, [0, -Math.sin(eps), Math.cos(eps)]));

  // Illuminated fraction from the sun–moon angle, faded by moon altitude.
  const lit =
    (1 - (sun[0] * moon[0] + sun[1] * moon[1] + sun[2] * moon[2])) / 2;
  const alt = Math.asin(moon[1]) / RAD;
  const up = Math.min(1, Math.max(0, (alt + 2) / 17));
  return {
    stars: mul(hor, precession(t)),
    moon,
    moonRadius: Math.asin(1737.4 / range),
    moonNorth,
    sun,
    moonlight: lit ** 1.5 * up * up * (3 - 2 * up),
  };
}
