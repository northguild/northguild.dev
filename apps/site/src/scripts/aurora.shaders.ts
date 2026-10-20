// GLSL for the aurora worker. Units: kilometres and seconds. World frame:
// x east, y up, z north, viewer at the origin.
//
// The aurora follows Lawlor & Genetti: a thin emissive sheet whose ground
// track (the "footprint") is a 2D map, times a height profile. Each curtain's
// track is a curve z(x), so the footprint pass writes one texture row per
// curtain: its path, brightness along the arc and ray height. The sky pass
// marches altitudes from the lower border up and measures the distance to
// that path at each step.

export const MAP_W = 2048;
export const MAP_H = 4;
export const CURTAINS = 2;

export const COMMON = `
precision highp float;
#define MAP_W ${MAP_W}.0
#define MAP_H ${MAP_H}.0
#define CURTAINS ${CURTAINS}
uniform float uT;
uniform vec3 uSpring, uCyan, uPurple;
// Ground shift per km of altitude along a field line (toward magnetic south).
uniform vec2 uTilt;
const float H0 = 100.0;   // lower border, km
const float RE = 6371.0;  // Earth radius, km
const float SIG = 8.0;    // sheet half-thickness (gaussian sigma), km
float tt;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
}
// Per site, per curtain: base distance north, then the x range drawn
// (centre, half-width), all km.
uniform vec3 uC0, uC1;
vec3 curtain(float k) { return k < 0.5 ? uC0 : uC1; }
vec2 span(float k) { return curtain(k).yz; }
// Ground distance north of the viewer: a base plus folds at three scales.
float path(float x, float k) {
  float s = 1.0 + 0.6 * k;
  float z = curtain(k).x;
  z += 90.0 * s * (noise(vec2(x / 420.0 + k * 7.0, tt * 0.0012 + k)) - 0.5);
  z += 35.0 * s * (noise(vec2(x / 140.0 + k * 3.0, tt * 0.003 + 2.0 * k)) - 0.5);
  z += 10.0 * (noise(vec2(x / 45.0 + k * 11.0, tt * 0.008)) - 0.5);
  return z;
}
// Long bright stretches and dark gaps; a faint arc is always left.
float lit(float x, float k) {
  vec2 q = vec2(x / 260.0 - tt * 0.002, k * 9.0 + tt * 0.003);
  float n = 0.62 * noise(q) + 0.31 * noise(q * 2.03 + 17.0);
  return 0.08 + 0.92 * smoothstep(0.38, 0.62, n);
}
float knots(float x, float k) {
  return 0.45 + 0.55 * noise(vec2(x / 55.0 + tt * 0.004, k * 5.0 + tt * 0.01));
}
// How rayed (rather than smooth) this stretch of the arc is.
float rayed(float x, float k) {
  return smoothstep(0.3, 0.7, noise(vec2(x / 180.0 + k * 4.0, tt * 0.003 + k)));
}
// Fine striations along the arc, drifting about 0.5 km/s.
float rays(float x, float k, float c) {
  float r = 0.6 * noise(vec2(x / 3.5 + tt * 0.15, k * 13.0 + tt * 0.02))
    + 0.4 * noise(vec2(x / 1.6 - tt * 0.1, k * 17.0));
  return mix(1.0, r * 1.4, c);
}
float rayHeight(float x, float k) {
  return rayed(x, k) * (0.3 + 0.7 * noise(vec2(x / 90.0 + k, tt * 0.002)));
}
// Colour by altitude: bright spring-cyan at the border, cyan to blue above,
// faint purple at the top.
vec3 ramp(float h) {
  vec3 blue = mix(uCyan, uPurple, 0.5);
  vec3 c = mix(mix(uSpring, uCyan, 0.55), uCyan, smoothstep(100.0, 125.0, h));
  c = mix(c, blue, smoothstep(125.0, 180.0, h));
  return mix(c, uPurple, smoothstep(180.0, 260.0, h));
}
`;

export const QUAD_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// Rows 2k: path z as ±200 km around the base (two bytes), sqrt of fine
// brightness, ray height.
// Rows 2k+1: sqrt of coarse brightness (no rays), for far-away pixels.
export const FOOT_FS = `${COMMON}
varying vec2 vUv;
void main() {
  tt = uT;
  float row = floor(vUv.y * MAP_H);
  float k = floor(row / 2.0);
  vec2 sp = span(k);
  float x = sp.x + (vUv.x * 2.0 - 1.0) * sp.y;
  float fade = smoothstep(0.0, 0.08 * sp.y, sp.y - abs(x - sp.x));
  float zn = clamp((path(x, k) - curtain(k).x + 200.0) / 400.0, 0.0, 1.0);
  float coarse = lit(x, k) * knots(x, k) * fade;
  if (row - 2.0 * k < 0.5) {
    float fine = coarse * rays(x, k, rayed(x, k));
    gl_FragColor = vec4(floor(zn * 255.0) / 255.0, fract(zn * 255.0),
      sqrt(min(fine / 1.5, 1.0)), rayHeight(x, k));
  } else {
    gl_FragColor = vec4(sqrt(coarse), 0.0, 0.0, 1.0);
  }
}
`;

export const skyFs = (steps: number, top: number) => `${COMMON}
#define STEPS ${steps}
uniform sampler2D uMap, uMoonTex;
uniform vec3 uVoid, uTeal, uIce;
uniform mat3 uCam;
uniform vec2 uTan;
uniform float uPxAng;
uniform vec4 uMoon;       // direction, angular radius
uniform vec3 uMoonN, uSun;
uniform float uMoonlight;
uniform float uGlow;      // city light near the horizon, 0..1
uniform float uLights;    // lit windows and streets, 0..1
varying vec2 vUv;
const float H1 = ${top}.0;
const float PI = 3.14159265;

// Path of curtain k at x: (z, dz/dx, fine brightness, ray height). Two
// fetches and a manual lerp, since the two-byte z cannot be filtered.
vec4 fetchPath(float x, float k) {
  vec2 sp = span(k);
  float u = clamp((x - sp.x + sp.y) / (2.0 * sp.y), 0.0, 1.0) * MAP_W - 0.5;
  float i = floor(u), f = u - i;
  float v = (2.0 * k + 0.5) / MAP_H;
  vec4 a = texture2D(uMap, vec2((i + 0.5) / MAP_W, v));
  vec4 b = texture2D(uMap, vec2((i + 1.5) / MAP_W, v));
  float z0 = curtain(k).x - 200.0;
  float za = z0 + 400.0 * (a.r + a.g / 255.0);
  float zb = z0 + 400.0 * (b.r + b.g / 255.0);
  float bf = mix(a.b, b.b, f);
  return vec4(mix(za, zb, f), (zb - za) * MAP_W / (2.0 * sp.y), 1.5 * bf * bf,
    mix(a.a, b.a, f));
}
float fetchCoarse(float x, float k) {
  vec2 sp = span(k);
  float c = texture2D(uMap, vec2((x - sp.x + sp.y) / (2.0 * sp.y),
    (2.0 * k + 1.5) / MAP_H)).r;
  return c * c;
}
// Sharp lower border, then an exponential tail whose height grows with g.
float profile(float h, float g) {
  return smoothstep(94.0, 106.0, h) * exp(-max(h - 106.0, 0.0) / (25.0 + 45.0 * g));
}
vec3 moon(vec3 rd) {
  float cm = dot(rd, uMoon.xyz);
  if (cm < cos(uMoon.w * 3.0) || uMoon.y < -0.02) return vec3(0.0);
  vec3 o = (rd - uMoon.xyz * cm) / sin(uMoon.w);
  float r = length(o);
  float px = uPxAng / uMoon.w;
  float cover = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);
  vec3 n = o - uMoon.xyz * sqrt(max(0.0, 1.0 - r * r));
  vec3 north = normalize(uMoonN - uMoon.xyz * dot(uMoonN, uMoon.xyz));
  vec3 west = cross(north, uMoon.xyz);
  float lat = asin(clamp(dot(n, north), -1.0, 1.0));
  float lon = atan(dot(n, west), dot(n, -uMoon.xyz));
  float alb = texture2D(uMoonTex, vec2(0.5 + lon / (2.0 * PI), 0.5 - lat / PI)).r;
  float day = max(dot(n, uSun), 0.0);
  float halo = exp(-(1.0 - cm) / (uMoon.w * uMoon.w * 6.0)) * 0.06;
  float full = 0.5 - 0.5 * dot(uSun, uMoon.xyz);
  return uIce * (cover * alb * (2.2 * day + 0.03) + halo * full);
}
// Sky seen along rd (above the horizon): background, city glow, moonlight,
// the aurora and the moon. Before tone mapping. j is the step jitter.
vec3 skyColour(vec3 rd, float j) {
  float c2 = dot(rd.xz, rd.xz);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    float s = (float(i) + j) / float(STEPS);
    float h = H0 - 6.0 + (H1 - H0 + 6.0) * s * s;
    float dh = (H1 - H0 + 6.0) * (2.0 * s + 1.0 / float(STEPS)) / float(STEPS);
    // Distance along the ray to altitude h over a curved Earth.
    float t = min(2.0 * h / (rd.y + sqrt(rd.y * rd.y + 2.0 * c2 * h / RE)), 2500.0);
    float dt = dh / max(rd.y + c2 * t / RE, 0.03);
    vec2 g = rd.xz * t - uTilt * (h - H0);
    vec2 dg = rd.xz * dt - uTilt * dh;
    float pxKm = t * uPxAng;
    float dens = 0.0, gh = 0.0;
    for (int k = 0; k < CURTAINS; k++) {
      float fk = float(k);
      vec4 m = fetchPath(g.x, fk);
      vec2 n = normalize(vec2(-m.y, 1.0));
      float d = (g.y - m.x) * n.y;
      // Widen the sheet by this step's travel across it, keeping its integral.
      float dn = abs(dot(dg, n)) + pxKm;
      float s2 = SIG * SIG + dn * dn / 12.0;
      float bc = fetchCoarse(g.x, fk);
      float b = mix(m.z, bc, smoothstep(1.5, 4.0, pxKm / 3.0));
      dens += b * exp(-0.5 * d * d / s2) * SIG * inversesqrt(s2)
        + bc * 0.1 * exp(-0.5 * d * d / (16.0 * SIG * SIG));
      gh = max(gh, m.w);
    }
    acc += ramp(h) * dens * profile(h, gh) * dt;
  }
  float e = max(rd.y, 0.0);
  float air = exp(-0.12 * (1.0 / (e + 0.04) - 1.0));
  vec3 col = uVoid + uTeal * 0.05 * exp(-e * 8.0)
    + uGlow * (uTeal * 0.09 * exp(-e * 9.0) + uIce * 0.035 * exp(-e * 22.0))
    + uMoonlight * (uIce * 0.02 + uTeal * 0.05) * (0.5 + 0.5 * exp(-e * 3.0));
  return col + (acc * 0.035 + moon(rd)) * air;
}
// City lights along the shore, by azimuth bin: on or off, and how bright.
float shoreLight(float az) {
  float cell = floor(az * 950.0);
  float h = hash(vec2(cell, 3.7));
  float f = fract(az * 950.0) - 0.5;
  return step(1.0 - 0.16 * uLights, h) * fract(h * 41.3) * max(0.0, 1.0 - abs(f) * 2.4);
}
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCam * vec3(ndc * uTan, 1.0));
  // Static per-pixel jitter: breaks banding without shimmer.
  float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 col;
  if (rd.y >= 0.0) {
    col = skyColour(rd, j);
  } else {
    // Water: the sky mirrored and broken by slow ripples that crowd toward
    // the horizon; strongest at grazing angles (Fresnel).
    float d = -rd.y;
    float az = atan(rd.x, rd.z);
    vec2 q = vec2(az * 700.0, 0.06 / d);
    float w = noise(q + vec2(0.0, uT * 0.35)) + 0.5 * noise(q * 2.3 - vec2(0.0, uT * 0.25)) - 0.75;
    vec3 rr = normalize(vec3(rd.x, d * max(0.15, 1.0 + 0.9 * w), rd.z));
    float fresnel = 0.02 + 0.98 * pow(1.0 - d, 5.0);
    col = uVoid * 0.5 + skyColour(rr, j) * fresnel * 0.85;
    // City lights stretched into broken vertical streaks.
    float streak = shoreLight(az + w * 0.0004) * exp(-d * 45.0)
      * smoothstep(0.35, 0.75, noise(vec2(az * 900.0, d * 260.0 - uT * 0.6)));
    col += uIce * streak * 0.35;
  }
  col = 1.0 - exp(-col * 1.7);
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

const PROJECT = `
uniform mat3 uCam;
uniform vec2 uTan;
// Camera space is (right, up, forward); clip w is the forward distance, so
// anything behind the viewer is clipped.
vec4 project(vec3 p) {
  vec3 c = p * uCam;
  return vec4(c.xy / uTan, 0.0, c.z);
}
`;

// Electrons spiralling down field lines and flaring where they reach the
// lower border. Each lands at the curtain's shape at its landing time, so it
// stays put while the curtain drifts on.
export const SPARK_VS = `${COMMON}${PROJECT}
attribute vec4 aSeed;
uniform float uPx;
varying vec3 vCol;
void main() {
  float k = aSeed.z < 0.6 ? 0.0 : 1.0;
  float life = 10.0 + 10.0 * fract(aSeed.z * 7.13);
  float ph = fract(uT / life + aSeed.y);
  vec2 sp = span(k);
  float x0 = sp.x + (aSeed.x * 2.0 - 1.0) * sp.y * 0.9;
  float lift = 1.0 + 12.0 * pow(fract(aSeed.w * 13.7), 2.0);
  tt = uT + (0.4 - ph) * life;
  float z0 = path(x0, k) + (fract(aSeed.w * 5.3) - 0.5) * 2.0 * SIG;
  float bright = lit(x0, k) * knots(x0, k);
  tt = uT;
  float hit = H0 + lift;
  float h = mix(420.0, hit, smoothstep(0.0, 0.4, ph));
  float spin = uT * (2.0 + 3.0 * aSeed.w) + aSeed.y * 40.0;
  vec2 g = vec2(x0, z0) + uTilt * (h - H0)
    + 0.03 * (h - hit) * vec2(cos(spin), sin(spin));
  vec4 c = project(vec3(g.x, h - dot(g, g) / (2.0 * RE), g.y));
  float glow = smoothstep(0.45, 0.65, ph) * (1.0 - smoothstep(0.75, 1.0, ph));
  vCol = mix(uCyan, ramp(hit), glow) * 0.3 * glow * bright;
  gl_PointSize = 1.3 * clamp(250.0 / max(c.w, 1.0), 0.6, 2.0) * uPx;
  gl_Position = c;
}
`;

// Catalogue stars: J2000 directions turned into the sky of date. Fainter
// near the horizon (extinction) and when the moon brightens the sky. They
// twinkle; they never move except with the sky itself.
export const STAR_VS = `
precision highp float;
${PROJECT}
attribute vec3 aDir;
attribute vec2 aMag;
uniform mat3 uStars;
uniform vec3 uIce, uCyan;
uniform float uPx, uT, uLimit, uFade;
varying vec3 vCol;
void main() {
  vec3 w = uStars * aDir;
  float alt = w.y;
  float m = aMag.x + 0.12 * (1.0 / (max(alt, 0.0) + 0.04) - 1.0);
  float b = pow(2.512, -m);
  float a = min(2.6 * sqrt(b), 1.6) * smoothstep(uLimit + 0.3, uLimit - 0.6, m) * uFade;
  float seed = fract(sin(dot(aDir.xy, vec2(91.7, 37.3)) + aDir.z * 11.1) * 4375.85);
  float amp = 0.1 + 0.3 * (1.0 - smoothstep(0.05, 0.5, alt));
  float tw = 1.0 + amp * sin(uT * (1.1 + 2.0 * seed) + seed * 60.0)
    * sin(uT * 0.37 + seed * 17.0);
  vCol = mix(uIce, uCyan, 0.35 * smoothstep(0.4, -0.1, aMag.y)) * a * tw;
  gl_PointSize = uPx * (1.6 + 1.4 * min(sqrt(b), 1.2));
  gl_Position = alt > 0.0 ? project(w) : vec4(0.0, 0.0, 2.0, 1.0);
}
`;

export const POINT_FS = `
precision mediump float;
varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float m = max(0.0, 1.0 - dot(q, q));
  gl_FragColor = vec4(vCol * m * m, 1.0);
}
`;

// The skyline as a strip of directions from the ridge down below the frame,
// drawn last so it hides sky, stars and sparks.
export const RIDGE_VS = `
precision highp float;
${PROJECT}
attribute vec4 aRidge;   // direction, haze 0..1 (negative on the bottom edge)
varying float vHaze, vDown;
varying vec3 vDir;
void main() {
  vDown = step(aRidge.w, -0.5);
  vHaze = mix(aRidge.w, -1.0 - aRidge.w, vDown);
  vDir = aRidge.xyz;
  gl_Position = project(aRidge.xyz);
}
`;

export const RIDGE_FS = `
precision highp float;
uniform vec3 uVoid, uTeal, uIce;
uniform float uMoonlight, uLights;
varying float vHaze, vDown;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  // Distant ridges are paler at the top, fading within a degree or so.
  float rim = vHaze * exp(-vDown * 60.0);
  vec3 col = uVoid * 0.45 + (uTeal * 0.035 + uIce * 0.006) * rim
    + uIce * 0.02 * uMoonlight;
  // A scatter of lit windows and street lights on a city skyline.
  vec3 d = normalize(vDir);
  vec2 g = vec2(atan(d.x, d.z) * 950.0, asin(d.y) * 1100.0);
  float h = hash(floor(g));
  vec2 f = fract(g) - 0.5;
  // Only past the first kilometre: the viewer's own surroundings stay dark.
  float on = step(1.0 - 0.13 * uLights, h) * step(0.02, vDown) * step(0.003, vHaze);
  col += uIce * on * exp(-dot(f, f) * 14.0) * (0.25 + 0.5 * fract(h * 37.0));
  gl_FragColor = vec4(1.0 - exp(-col * 1.7), 1.0);
}
`;
