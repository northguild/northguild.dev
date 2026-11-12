// Huginn: a raven that now and then flies across the view, through the same
// 3D world as the sky. Units: metres and seconds. World frame: x east, y up,
// z north, the viewer's eye at the origin.
//
// The first flight is a fly-in: he comes in over the viewer's shoulder from
// just past the top edge (at its left, middle or right) or either side,
// close enough to fill a good part of the screen, glides out over the page,
// swoops low toward the far bottom corner and leaves, on out of frame or
// into the distance, a little differently every time. His flight draws in
// the page's header, title and cards (see aurora.worker.ts).
//
// Coming back to the page from one of its own (the GMT or worktree docs),
// the fly-in runs the other way: a speck far off against the sky, he flies
// home toward the viewer and sweeps past close by, out through any edge of
// the frame. Everything but the header waits for him then.
//
// After that each flight is planned in the camera's frame so that it crosses
// the window: usually a pass along a gentle curve 20 to 65 m away, often
// soaring, sometimes a few lazy circles farther out, low over the horizon
// where the aurora lights the sky. The bird is a small mesh posed every
// frame. He rides the rising air and glides most of the time, flapping in
// short bouts at about 3.4 beats a second (the hand folding back on the
// upstroke) and whenever he has to climb or pick up speed. It banks into its turns and now and then rolls onto
// its back for a moment, as ravens do. Proportions follow the common raven:
// about 64 cm long, a 1.2 m span, a heavy head and bill held well forward, a
// wedge-shaped tail and five fingered primaries at each wing tip.

type V = [number, number, number];

export type RavenView = {
  /** Camera basis as columns (right, up, forward), as camera() in the worker. */
  cam: Float32Array;
  /** Tangent of half the vertical field of view. */
  tanY: number;
  /** Width over height. */
  aspect: number;
  /** Eye height above the ground or sea, metres. */
  eye: number;
  /** Skyline elevation by azimuth (degrees), radians. */
  ridge: (az: number) => number;
  /** The highest a flight's middle goes on screen (-1 bottom, 1 top): clear
   * of the page's cards. */
  ceiling: number;
  /** The page's cards on screen (-1 to 1, y up), in page order: the first
   * fly-in dives through the first. Empty for the usual place. */
  cards: ScreenBox[];
  /** The card for the page the visitor came back from, or null: the
   * homecoming starts out behind it. */
  from: ScreenBox | null;
};

/** A box on screen: left, bottom, right, top, each -1 to 1, y up. */
export type ScreenBox = [number, number, number, number];

export type RavenTiming = {
  /** Seconds before the fly-in, once the sky is up. */
  entrance: [number, number];
  /** Seconds between flights. */
  gap: [number, number];
};

/** The fly-in as the sky fades in, then a new flight 15 to 20 s after each
 * ends. */
export const RAVEN_TIMING: RavenTiming = {
  entrance: [0.5, 0.8],
  gap: [15, 20],
};

const G = 9.81;
/** Metres over which the bird fades in at a flight's start and out at its
 * end: unseen when the ends are out of frame, as most are. */
const FADE = 12;
/** The homecoming's quicker fade-in (metres): he starts near enough to be
 * seen as a bird, so he shows almost at once. */
const HOMECOMING_FADE = 4;
const RAD = Math.PI / 180;

function addVectors(a: V, b: V): V {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtractVectors(a: V, b: V): V {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVector(a: V, k: number): V {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dotProduct(a: V, b: V): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossProduct(a: V, b: V): V {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** The vector scaled to length 1 (a zero vector stays zero). */
function normalize(a: V): V {
  return scaleVector(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
}

/** The point k of the way from a to b. */
function lerpVectors(a: V, b: V, k: number): V {
  return addVectors(a, scaleVector(subtractVectors(b, a), k));
}

/** The number k of the way from a to b. */
function lerpNumber(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function randomBetween(lo: number, hi: number): number {
  return lo + (hi - lo) * Math.random();
}

/** Eases from 0 to 1 as x goes from 0 to 1, flat at both ends. */
function smoothstep(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

// ---------------------------------------------------------------------------
// The bird, in its own frame: x right, y up, z forward, metres, the centre of
// lift at the origin.

/** Body stations from the tail to the bill tip: z, centre height, half
 * width, half height. */
const BODY: [number, number, number, number][] = [
  [-0.15, 0.0, 0.04, 0.024],
  [-0.09, 0.0, 0.056, 0.04],
  [-0.02, -0.004, 0.066, 0.056],
  [0.05, 0.0, 0.062, 0.056],
  [0.11, 0.01, 0.04, 0.042],
  [0.16, 0.016, 0.038, 0.04],
  [0.2, 0.012, 0.03, 0.036],
  [0.245, 0.006, 0.014, 0.018],
  [0.28, -0.002, 0.003, 0.004],
];
const SIDES = 8;

/** One body station as a ring of points, in the bird's frame. */
function bodyRing(i: number): V[] {
  return Array.from({ length: SIDES }, (_, j): V => {
    const [z, y, rx, ry] = BODY[i]!;
    const a = (2 * Math.PI * j) / SIDES;
    return [rx * Math.cos(a), y + ry * Math.sin(a), z];
  });
}

/** The body's triangles, in the bird's frame. */
function bodyTriangles(): V[] {
  const out: V[] = [];
  const rings = BODY.map((_, i) => bodyRing(i));
  for (let i = 0; i + 1 < rings.length; i++) {
    const [r0, r1] = [rings[i]!, rings[i + 1]!];
    for (let j = 0; j < SIDES; j++) {
      const k = (j + 1) % SIDES;
      out.push(r0[j]!, r0[k]!, r1[j]!, r1[j]!, r0[k]!, r1[k]!);
    }
  }
  // Close the tail end (the tail itself hides most of it).
  const [z0, y0] = BODY[0]!;
  for (let j = 0; j < SIDES; j++) {
    out.push([0, y0, z0], rings[0]![(j + 1) % SIDES]!, rings[0]![j]!);
  }
  return out;
}

/** The body is rigid: its triangles are built once. */
const BODY_TRIS = bodyTriangles();

/** Right wing, flat: the arm from the shoulder to the wrist, then the hand.
 * x outward, z forward, at the height of the shoulder. */
const WING_Y = 0.02;
const SHOULDER: V = [0.045, WING_Y, 0];
const ARM: V[] = [
  [0.045, WING_Y, 0.06], // root, leading edge
  [0.045, WING_Y, -0.13], // root, trailing edge
  [0.17, WING_Y, 0.075],
  [0.17, WING_Y, -0.15], // the broad inner wing (secondaries)
  [0.29, WING_Y, 0.075], // wrist
  [0.29, WING_Y, -0.14],
];
const WRIST = ARM[4]!;
const HAND: V[] = [
  [0.46, WING_Y, 0.04], // leading edge where the fingers start
  [0.42, WING_Y, -0.11], // trailing edge where the fingers start
  [0.36, WING_Y, -0.14], // inner primaries
];
/** The five long primaries that stand apart at the tip, front to back:
 * where along the hand's outer edge they start, angle from straight out
 * (forward positive) and length. */
const FINGERS: [number, number, number][] = [
  [0.1, 6 * RAD, 0.125],
  [0.3, -4 * RAD, 0.15],
  [0.5, -14 * RAD, 0.15],
  [0.7, -24 * RAD, 0.135],
  [0.9, -34 * RAD, 0.11],
];
const FINGER_MEAN = -14 * RAD;

/** The tail, flat, as a fan from its root: a wedge, the middle feathers
 * longest. Right half from the root's edge to the middle tip. */
const TAIL_ROOT: V = [0, 0.004, -0.12];
const TAIL: [number, number][] = [
  [0.04, -0.12],
  [0.05, -0.22],
  [0.056, -0.27],
  [0.03, -0.32],
  [0, -0.35],
];

const TRIS =
  BODY_TRIS.length / 3 +
  2 * (4 + 3 + FINGERS.length * 3) +
  (TAIL.length - 1) * 2;
/** Floats per vertex: position, then the face normal. */
export const RAVEN_STRIDE = 6;

type Pose = {
  /** Arm raised (rad), and the hand raised further from it. */
  arm: number;
  hand: number;
  /** Arm and hand swept back (rad). */
  armBack: number;
  handBack: number;
  /** Arm span, 1 fully out, less with the elbow bent. */
  reach: number;
  /** How far the fingers fan, 1 as at rest. */
  spread: number;
  /** Wing tips bent up under load. */
  curl: number;
  /** How far the tail fans, 1 as at rest, and its tilt down (rad). */
  tail: number;
  tailDown: number;
};

const GLIDE: Pose = {
  arm: 0.08,
  hand: -0.05,
  armBack: 0,
  handBack: 0.12,
  reach: 1,
  spread: 1,
  curl: 1,
  tail: 1.1,
  tailDown: 0,
};
/** Soaring, on rising air or circling: wings out, fingers and tail spread
 * wide. */
const SOAR: Pose = {
  arm: 0.14,
  hand: 0.03,
  armBack: -0.03,
  handBack: 0,
  reach: 1,
  spread: 1.35,
  curl: 1.4,
  tail: 1.6,
  tailDown: 0.05,
};
/** Diving or rolling: wings half closed. */
const TUCK: Pose = {
  arm: 0.05,
  hand: -0.1,
  armBack: 0.12,
  handBack: 0.6,
  reach: 0.88,
  spread: 0.6,
  curl: 0.3,
  tail: 0.85,
  tailDown: -0.03,
};

/** The pose k of the way from a to b. */
function blendPoses(a: Pose, b: Pose, k: number): Pose {
  return {
    arm: lerpNumber(a.arm, b.arm, k),
    hand: lerpNumber(a.hand, b.hand, k),
    armBack: lerpNumber(a.armBack, b.armBack, k),
    handBack: lerpNumber(a.handBack, b.handBack, k),
    reach: lerpNumber(a.reach, b.reach, k),
    spread: lerpNumber(a.spread, b.spread, k),
    curl: lerpNumber(a.curl, b.curl, k),
    tail: lerpNumber(a.tail, b.tail, k),
    tailDown: lerpNumber(a.tailDown, b.tailDown, k),
  };
}

// One wingbeat from the top: the downstroke takes a little over half of it,
// the wing fully out and the tip bending up under load; on the upstroke the
// wrist bends, the hand sweeps back and the tip trails.
const DOWN = 0.55;
const TOP = 0.75;
const BOTTOM = -0.65;
/** Where in the beat the wing passes the glide pose, going down. */
const LEVEL_PHASE = 0.26;

function beat(p: number): Pose {
  const down = p < DOWN;
  const x = down ? p / DOWN : (p - DOWN) / (1 - DOWN);
  const ease = (1 - Math.cos(Math.PI * x)) / 2;
  const bump = Math.sin(Math.PI * x);
  const fold = down ? 0 : bump;
  return {
    arm: down ? lerpNumber(TOP, BOTTOM, ease) : lerpNumber(BOTTOM, TOP, ease),
    hand: down ? 0.3 * bump : -0.4 * bump,
    armBack: down ? -0.12 * bump : 0.2 * fold,
    handBack: 0.95 * fold,
    reach: 1 - 0.2 * fold,
    spread: 1 - 0.6 * fold,
    curl: down ? 0.6 + 0.8 * bump : 0.3,
    tail: 1,
    tailDown: 0,
  };
}

/** Raise by a about the forward axis (positive lifts a right-hand point). */
function raiseAboutForward(v: V, a: number): V {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/** Sweep back by a about the up axis (positive moves a right-hand point
 * toward the tail). */
function sweepAboutUp(v: V, a: number): V {
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/** The right wing's triangles for a pose, in the bird's frame. */
function wing(pose: Pose, out: V[]): void {
  function turnWithArm(v: V): V {
    return raiseAboutForward(sweepAboutUp(v, pose.armBack), pose.arm);
  }
  function placeOnArm(v: V): V {
    const q = subtractVectors(v, SHOULDER);
    return addVectors(SHOULDER, turnWithArm([q[0] * pose.reach, q[1], q[2]]));
  }
  const wrist = placeOnArm(WRIST);
  // A point given relative to the wrist, in the hand's flat frame.
  function placeOnHand(q: V): V {
    return addVectors(
      wrist,
      turnWithArm(raiseAboutForward(sweepAboutUp(q, pose.handBack), pose.hand)),
    );
  }
  const a = ARM.map(placeOnArm);
  const h = HAND.map((v) => placeOnHand(subtractVectors(v, WRIST)));
  out.push(a[0]!, a[1]!, a[2]!, a[2]!, a[1]!, a[3]!);
  out.push(a[2]!, a[3]!, a[4]!, a[4]!, a[3]!, a[5]!);
  out.push(a[4]!, h[0]!, h[1]!, a[4]!, h[1]!, h[2]!, a[4]!, h[2]!, a[5]!);
  const [e0, e1] = [
    subtractVectors(HAND[0]!, WRIST),
    subtractVectors(HAND[1]!, WRIST),
  ];
  for (const [at, angle, length] of FINGERS) {
    const phi = FINGER_MEAN + (angle - FINGER_MEAN) * pose.spread;
    const d: V = [Math.cos(phi), 0, Math.sin(phi)];
    const n: V = [-Math.sin(phi), 0, Math.cos(phi)];
    // Start a little inside the hand so the finger overlaps it.
    const base = subtractVectors(
      lerpVectors(e0, e1, at),
      scaleVector(d, 0.035),
    );
    // How far the finger bends up at fraction f of its length, under load.
    function curlLift(f: number): V {
      return [0, pose.curl * 0.03 * f * f, 0];
    }
    // A point on the finger: distance along it from the base, and across it.
    function fingerPoint(along: number, across: number): V {
      return placeOnHand(
        addVectors(
          addVectors(
            base,
            addVectors(scaleVector(d, along), scaleVector(n, across)),
          ),
          curlLift(along / length),
        ),
      );
    }
    const [b0, b1] = [fingerPoint(0, 0.013), fingerPoint(0, -0.013)];
    const [t0, t1] = [
      fingerPoint(length, 0.0055),
      fingerPoint(length, -0.0055),
    ];
    const tip = fingerPoint(length + 0.012, 0);
    out.push(b0, b1, t0, t0, b1, t1, t0, t1, tip);
  }
}

/** The tail's triangles for a pose, in the bird's frame. */
function tail(pose: Pose, out: V[]): void {
  const [c, s] = [Math.cos(pose.tailDown), Math.sin(pose.tailDown)];
  // A point of the flat tail, fanned and tilted for the pose.
  function tailPoint(x: number, z: number): V {
    const dz = z - TAIL_ROOT[2];
    return [x * pose.tail, TAIL_ROOT[1] - dz * s, TAIL_ROOT[2] + dz * c];
  }
  const root = tailPoint(0, TAIL_ROOT[2]);
  for (const side of [1, -1]) {
    for (let i = 0; i + 1 < TAIL.length; i++) {
      const [x0, z0] = TAIL[i]!;
      const [x1, z1] = TAIL[i + 1]!;
      out.push(root, tailPoint(side * x0, z0), tailPoint(side * x1, z1));
    }
  }
}

// ---------------------------------------------------------------------------
// Flight paths.

type Path = {
  /** Points along the curve, and the distance flown to each. */
  points: V[];
  dist: number[];
  length: number;
  /** Airspeed, m/s. */
  speed: number;
  /** For a flown path (see fly()), the speed at each point; null for
   * `speed` all the way. */
  speeds: number[] | null;
  /** For a flown path, whether he had to flap at each point to keep his
   * speed or climb; null for a drawn path. */
  working: boolean[] | null;
  /** Slow motion near the viewer, as wildlife film does it: time runs
   * slower the nearer he is (see timeScaleAt), so up close he is big and
   * unhurried and his speed across the screen stays calm. */
  slowNear: boolean;
  /** Metres to fade in over at the start (0 for none: not at an end out of
   * frame and close by), and whether to fade out over the last FADE. */
  fadeIn: number;
  fadeOut: boolean;
  soar: boolean;
  /** Distance along the path at which to roll over, or -1 for none. */
  rollAt: number;
};

/** Centripetal Catmull–Rom through p1 and p2, at t from 0 to 1. */
function catmull(p0: V, p1: V, p2: V, p3: V, t: number): V {
  // The centripetal knot spacing: the square root of the distance.
  function knotInterval(a: V, b: V): number {
    return Math.max(Math.sqrt(Math.hypot(...subtractVectors(b, a))), 1e-4);
  }
  const t1 = knotInterval(p0, p1);
  const t2 = t1 + knotInterval(p1, p2);
  const t3 = t2 + knotInterval(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const a1 = lerpVectors(p0, p1, u / t1);
  const a2 = lerpVectors(p1, p2, (u - t1) / (t2 - t1));
  const a3 = lerpVectors(p2, p3, (u - t2) / (t3 - t2));
  const b1 = lerpVectors(a1, a2, u / t2);
  const b2 = lerpVectors(a2, a3, (u - t1) / (t3 - t1));
  return lerpVectors(b1, b2, (u - t1) / (t2 - t1));
}

function curve(through: V[], speed: number, soar: boolean, roll: number): Path {
  const n = through.length;
  // The i-th point to pass through, mirrored past either end so the curve
  // reaches the first and last.
  function controlPoint(i: number): V {
    return i < 0
      ? subtractVectors(scaleVector(through[0]!, 2), through[1]!)
      : i >= n
        ? subtractVectors(scaleVector(through[n - 1]!, 2), through[n - 2]!)
        : through[i]!;
  }
  const points: V[] = [];
  for (let i = 0; i + 1 < n; i++) {
    for (let k = 0; k < 40; k++) {
      points.push(
        catmull(
          controlPoint(i - 1),
          controlPoint(i),
          controlPoint(i + 1),
          controlPoint(i + 2),
          k / 40,
        ),
      );
    }
  }
  points.push(through[n - 1]!);
  const dist = [0];
  for (let i = 1; i < points.length; i++) {
    dist.push(
      dist[i - 1]! + Math.hypot(...subtractVectors(points[i]!, points[i - 1]!)),
    );
  }
  const length = dist[dist.length - 1]!;
  const rollAt = Math.random() < roll ? length * randomBetween(0.35, 0.6) : -1;
  return {
    points,
    dist,
    length,
    speed,
    speeds: null,
    working: null,
    slowNear: false,
    fadeIn: FADE,
    fadeOut: true,
    soar,
    rollAt,
  };
}

/** The airspeed a distance s along the path. */
function speedAt(path: Path, s: number): number {
  const { speeds, dist } = path;
  if (!speeds) return path.speed;
  const [lo, hi, k] = bracket(path, s);
  return lerpNumber(speeds[lo]!, speeds[hi]!, dist[hi] === dist[lo] ? 0 : k);
}

/** Whether, on a flown path, he has to flap a distance s along it. */
function workingAt(path: Path, s: number): boolean {
  if (!path.working) return false;
  const [lo] = bracket(path, s);
  return path.working[lo]!;
}

/** Within NEAR_SLOW metres time runs slower, in step with his distance,
 * down to NEAR_SLOWEST of real time (at 3 m). */
const NEAR_SLOW = 12;
const NEAR_SLOWEST = 0.25;

/** How fast time runs for him a distance s along the path. */
function timeScaleAt(path: Path, s: number): number {
  if (!path.slowNear) return 1;
  const d = Math.hypot(...along(path, s));
  return Math.min(1, Math.max(NEAR_SLOWEST, d / NEAR_SLOW));
}

/** The two points either side of a distance along the path, and how far
 * between them it is. */
function bracket(path: Path, s: number): [number, number, number] {
  const { dist } = path;
  const c = Math.min(Math.max(s, 0), path.length);
  let [lo, hi] = [0, dist.length - 1];
  for (let step = 0; step < 32 && hi - lo > 1; step++) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! <= c) lo = mid;
    else hi = mid;
  }
  const span = dist[hi]! - dist[lo]! || 1;
  return [lo, hi, (c - dist[lo]!) / span];
}

/** Where along the path, by distance flown. */
function along(path: Path, s: number): V {
  const [lo, hi, k] = bracket(path, s);
  return lerpVectors(path.points[lo]!, path.points[hi]!, k);
}

/** The view's axes, and whether a point is within the frame (with a margin). */
function frame(view: RavenView) {
  const c = view.cam;
  const right: V = [c[0]!, c[1]!, c[2]!];
  const up: V = [c[3]!, c[4]!, c[5]!];
  const fwd: V = [c[6]!, c[7]!, c[8]!];
  const tanX = view.tanY * view.aspect;
  function isInFrame(p: V, margin = 1.1): boolean {
    const z = dotProduct(p, fwd);
    if (z < 1) return false;
    return (
      Math.abs(dotProduct(p, right) / (z * tanX)) < margin &&
      Math.abs(dotProduct(p, up) / (z * view.tanY)) < margin
    );
  }
  // The direction through a point on screen (-1 to 1 on each axis).
  function rayThroughScreen(nx: number, ny: number): V {
    return normalize(
      addVectors(
        fwd,
        addVectors(
          scaleVector(right, nx * tanX),
          scaleVector(up, ny * view.tanY),
        ),
      ),
    );
  }
  // Where the horizon straight ahead crosses the screen (-1 bottom, 1 top).
  const level = normalize([fwd[0], 0, fwd[2]]);
  const horizon = dotProduct(level, up) / (dotProduct(level, fwd) * view.tanY);
  // A height on screen from lo to hi above the horizon, kept clear of the
  // page's cards: the band where the aurora and a city's glow light the sky
  // from behind, so the black bird shows against them.
  function randomHeightAboveHorizon(lo: number, hi: number): number {
    return randomBetween(
      horizon + lo,
      Math.max(horizon + lo, Math.min(horizon + hi, view.ceiling)),
    );
  }
  // The point at a depth (metres along the view) behind a point on screen.
  function pointAtDepth(nx: number, ny: number, depth: number): V {
    return addVectors(
      scaleVector(fwd, depth),
      addVectors(
        scaleVector(right, nx * tanX * depth),
        scaleVector(up, ny * view.tanY * depth),
      ),
    );
  }
  return {
    right,
    up,
    fwd,
    tanX,
    horizon,
    isInFrame,
    rayThroughScreen,
    pointAtDepth,
    randomHeightAboveHorizon,
  };
}

/** The least height above the ground or sea, metres. */
const GROUND = 4;

/** Clear of the ground and seen against the sky rather than the skyline. */
function skyward(p: V, view: RavenView): boolean {
  if (p[1] < GROUND - view.eye) return false;
  const el = Math.asin(p[1] / Math.hypot(...p));
  return el > view.ridge(Math.atan2(p[0], p[2]) / RAD) + 1.2 * RAD;
}

/** From p along d until just out of frame, or 100 m on, whichever is
 * first: a path that runs nearly along the line of sight would otherwise
 * start or end hundreds of metres off, the bird a dot for many seconds.
 * The planners prefer paths that do leave the frame; the bird fades in and
 * out at the ends of those that do not (see FADE). */
function leave(p: V, d: V, isInFrame: (p: V) => boolean): V {
  for (let s = 0; s < 100; s += 2) {
    const q = addVectors(p, scaleVector(d, s));
    if (!isInFrame(q)) return addVectors(q, scaleVector(d, 6));
  }
  return addVectors(p, scaleVector(d, 100));
}

/** Degrees either side of a bearing over which the skyline is taken at its
 * highest, so that a path kept clear of it does not follow every notch. */
const SKYLINE_SPREAD = 4;
/** How far above the skyline a path keeps (rad): seen against the sky, never
 * in front of the mountains (Ísafjörður's fill the left of its view). */
const SKYLINE_CLEARANCE = 2.5 * RAD;

/** The highest the skyline stands within SKYLINE_SPREAD of a bearing
 * (degrees), radians above the horizontal. */
function skylineNear(view: RavenView, az: number): number {
  let top = -Math.PI / 2;
  for (let d = -SKYLINE_SPREAD; d <= SKYLINE_SPREAD; d++) {
    top = Math.max(top, view.ridge(az + d));
  }
  return top;
}

/** The point raised, if need be, so that it is seen against the sky clear
 * of the skyline. (Every ridge is far beyond his flights, so he is never
 * behind one, only ever in front.) */
function clearOfSkyline(p: V, view: RavenView, extra = 0): V {
  const flat = Math.hypot(p[0], p[2]);
  if (flat < 0.5) return p;
  const az = Math.atan2(p[0], p[2]) / RAD;
  const least =
    flat * Math.tan(skylineNear(view, az) + SKYLINE_CLEARANCE + extra * RAD);
  return p[1] >= least ? p : [p[0], least, p[2]];
}

/** Metres either side over which a lift clear of the skyline is eased. */
const LIFT_EASE = 4;
/** Close by he fills enough of the screen to show against the mountains
 * too: no lift within LIFT_NEAREST metres, the full lift from LIFT_FULL,
 * eased between. Lifting him that close would bend his line sharply, right
 * where every bend shows. */
const LIFT_NEAREST = 4;
const LIFT_FULL = 12;

/** The path with every point kept clear of the skyline. */
function keptClearOfSkyline(path: Path, view: RavenView): Path {
  // How far each point must rise, then eased along the path (the most
  // within a few metres either side, then averaged) so that lifting him
  // clear never puts a kink in his line.
  const rise = path.points.map(
    (p) =>
      (clearOfSkyline(p, view)[1] - p[1]) *
      smoothstep(
        (Math.hypot(...p) - LIFT_NEAREST) / (LIFT_FULL - LIFT_NEAREST),
      ),
  );
  if (!rise.some((r) => r > 0)) return path;
  function near(i: number, f: (j: number) => void): void {
    const { dist } = path;
    for (let j = i; j >= 0 && dist[i]! - dist[j]! <= LIFT_EASE; j--) f(j);
    for (
      let j = i + 1;
      j < rise.length && dist[j]! - dist[i]! <= LIFT_EASE;
      j++
    ) {
      f(j);
    }
  }
  const most = rise.map((_, i) => {
    let m = 0;
    near(i, (j) => (m = Math.max(m, rise[j]!)));
    return m;
  });
  const points = path.points.map((p, i): V => {
    let [sum, n] = [0, 0];
    near(i, (j) => {
      sum += most[j]!;
      n++;
    });
    return [p[0], p[1] + Math.max(rise[i]!, sum / n), p[2]];
  });
  const dist = [0];
  for (let i = 1; i < points.length; i++) {
    dist.push(
      dist[i - 1]! + Math.hypot(...subtractVectors(points[i]!, points[i - 1]!)),
    );
  }
  const length = dist[dist.length - 1]!;
  return {
    ...path,
    points,
    dist,
    length,
    rollAt: Math.min(path.rollAt, length),
  };
}

/** The point raised, if need be, to the least height above the ground. */
function keepAboveGround(p: V, view: RavenView, least = GROUND): V {
  return [p[0], Math.max(p[1], least - view.eye), p[2]];
}

/** A pass across the view along a gentle curve, flapping or soaring. */
function pass(view: RavenView): Path | null {
  const { fwd, isInFrame, rayThroughScreen, randomHeightAboveHorizon } =
    frame(view);
  const yaw = Math.atan2(fwd[0], fwd[2]);
  const ahead: V = [Math.sin(yaw), 0, Math.cos(yaw)];
  const across: V = [Math.cos(yaw), 0, -Math.sin(yaw)];
  // A path whose ends are still in frame, in case no other turns up.
  let spare: Path | null = null;
  for (let tries = 0; tries < 16; tries++) {
    // 20 to 65 m away, more often near the nearer end.
    const d = 20 + 45 * Math.random() ** 1.5;
    const mid = scaleVector(
      rayThroughScreen(
        randomBetween(-0.5, 0.5),
        randomHeightAboveHorizon(0.06, 0.6),
      ),
      d,
    );
    if (!skyward(mid, view)) continue;
    const side = Math.random() < 0.5 ? -1 : 1;
    const flat = normalize(
      addVectors(
        scaleVector(across, side),
        scaleVector(ahead, randomBetween(-0.55, 0.55)),
      ),
    );
    const dir = normalize([flat[0], randomBetween(-0.06, 0.1), flat[2]]);
    const a = leave(mid, scaleVector(dir, -1), isInFrame);
    const b = leave(mid, dir, isInFrame);
    const length = Math.hypot(...subtractVectors(b, a));
    const aside = normalize([-dir[2], 0, dir[0]]);
    // The point nudged a little to one side and up or down, for a gentle bend.
    function nudgeAside(p: V): V {
      return keepAboveGround(
        addVectors(
          p,
          addVectors(scaleVector(aside, randomBetween(-0.08, 0.08) * length), [
            0,
            randomBetween(-3, 3),
            0,
          ]),
        ),
        view,
      );
    }
    const through = [
      keepAboveGround(a, view),
      nudgeAside(lerpVectors(a, mid, 0.5)),
      mid,
      nudgeAside(lerpVectors(mid, b, 0.5)),
      keepAboveGround(b, view),
    ];
    // Half the time riding the air on spread wings, unhurried.
    const soaring = Math.random() < 0.5;
    const path = curve(
      through,
      soaring ? randomBetween(8.5, 10) : randomBetween(10, 12.5),
      soaring,
      0.25,
    );
    if (!isInFrame(a) && !isInFrame(b)) return path;
    spare ??= path;
  }
  return spare;
}

/** Points every 30 degrees round a level circle, for so many turns, climbing
 * by `climb` metres a turn: x is r cos a and z is r sin a, from angle `start`,
 * turning one way or the other by `sense`. */
function ringAround(
  centre: V,
  r: number,
  turns: number,
  sense: number,
  climb: number,
  start: number,
): V[] {
  const steps = Math.ceil(turns * 12);
  return Array.from({ length: steps + 1 }, (_, k): V => {
    const a = start + (sense * k * Math.PI) / 6;
    return addVectors(centre, [
      r * Math.cos(a),
      (climb * k) / 12,
      r * Math.sin(a),
    ]);
  });
}

/** A few slow circles on still air, then away. */
function circles(view: RavenView): Path | null {
  const { isInFrame, rayThroughScreen, randomHeightAboveHorizon } = frame(view);
  for (let tries = 0; tries < 16; tries++) {
    const centre = scaleVector(
      rayThroughScreen(
        randomBetween(-0.35, 0.35),
        randomHeightAboveHorizon(0.15, 0.55),
      ),
      randomBetween(50, 90),
    );
    const r = randomBetween(12, 22);
    const turns = randomBetween(1.25, 2.5);
    const sense = Math.random() < 0.5 ? -1 : 1;
    const climb = randomBetween(-4, 4);
    const start = randomBetween(0, 2 * Math.PI);
    const ring = ringAround(centre, r, turns, sense, climb, start);
    const steps = ring.length - 1;
    if (!ring.every((p) => skyward(p, view) && isInFrame(p, 0.95))) continue;
    // Join and leave the circle where the tangent leaves the frame soonest,
    // within its first and last turn, keeping at least three quarters of a
    // turn between: a tangent pointing away from the camera can stay in
    // frame for far longer than the 100 m leave() goes.
    // The direction of flight along the circle at its k-th point.
    function tangentAt(k: number): V {
      return normalize(subtractVectors(ring[k + 1]!, ring[k]!));
    }
    // Leaving the circle at its k-th point along d: where the bird goes out
    // of frame, and how far that is (far more if it never does).
    function exitFrom(k: number, d: V) {
      const p = leave(ring[k]!, d, isInFrame);
      return {
        k,
        p,
        s:
          Math.hypot(...subtractVectors(p, ring[k]!)) +
          (isInFrame(p) ? 1e3 : 0),
      };
    }
    function soonestExit(list: ReturnType<typeof exitFrom>[]) {
      return list.reduce((best, o) => (o.s < best.s ? o : best));
    }
    const first = soonestExit(
      Array.from({ length: Math.min(12, steps - 9) }, (_, k) =>
        exitFrom(k, scaleVector(tangentAt(k), -1)),
      ),
    );
    const last = soonestExit(
      Array.from({ length: Math.min(12, steps - first.k - 8) }, (_, i) =>
        exitFrom(steps - i, tangentAt(steps - i - 1)),
      ),
    );
    return curve(
      [
        keepAboveGround(first.p, view),
        ...ring.slice(first.k, last.k + 1),
        keepAboveGround(last.p, view),
      ],
      randomBetween(8.5, 10),
      true,
      0.12,
    );
  }
  return null;
}

/** The least height of a fly-in, metres above the ground or sea: he skims
 * low over the water as he dives past the cards. */
const LOW = 0.5;

// ---------------------------------------------------------------------------
// Flying a path: rather than following a drawn curve, the fly-in is flown by
// a simple glider steered through its waypoints, so its speed, turns and
// pull-outs are what a raven's wings could really do.

/** A raven's best glide: at about this speed (m/s), some 9 m on for each
 * metre down. Slower or faster costs more. */
const BEST_GLIDE = 8.5;
const LIFT_TO_DRAG = 9;
/** The most lift his wings bear in a turn or pull-out, in g. */
const MOST_LOAD = 2;
/** Below this speed (m/s) he flaps to hold it, and how hard (m/s²). */
const SLOWEST = 6;
const THRUST = 3;
/** Air rising off the slopes and the water, m/s: a little more than he
 * sinks at his best glide, so on it he holds his speed without a wingbeat,
 * as ravens ride the wind along a ridge. */
const UPDRAFT = 1.2;
/** Climbing steeper than this (the sine of his climb) the rising air no
 * longer carries him: he trades speed for height, and once down to his
 * best glide speed he flaps. */
const SOARING_CLIMB = 0.12;
/** Once he starts flapping he keeps at it this long (s) at least: a bout
 * of wingbeats, not a single one each time he slows. */
const FLAP_BOUT = 0.8;
/** About how long (s) he takes to swing onto a new heading. */
const STEER = 0.9;
/** The step the flight is worked out in (s), and the longest it may run. */
const FLY_STEP = 1 / 60;
const FLY_LONGEST = 40;

/** Beyond this (metres) he is a speck, and a flown path ends. */
const FLY_FARTHEST = 110;

/** Fly through the waypoints from the first, setting off toward the second
 * at `speed`: gravity, drag on a raven's glide polar, rising air under him,
 * lift up to MOST_LOAD steering him at each waypoint in turn (easing toward
 * the one after as he nears it), and flapping only when he is slow or
 * climbing more steeply than the rising air carries him. `floor` is the
 * lowest he goes (y, metres). It ends once he has been in view and left
 * it, or is FLY_FARTHEST off. Each step's position and speed, and whether
 * he flapped. */
function fly(
  through: V[],
  speed: number,
  floor: number,
  isInFrame: (p: V, margin?: number) => boolean,
): { points: V[]; speeds: number[]; working: boolean[] } {
  let p = through[0]!;
  let v = scaleVector(normalize(subtractVectors(through[1]!, p)), speed);
  const points: V[] = [p];
  const speeds = [speed];
  const working = [false];
  // Seconds left of the bout of flapping under way.
  let bout = 0;
  let k = 1;
  let seen = false;
  for (let i = 0; i < FLY_LONGEST / FLY_STEP && k < through.length; i++) {
    const shown = isInFrame(p, 1.2);
    seen ||= shown;
    if ((seen && !shown) || Math.hypot(...p) > FLY_FARTHEST) break;
    const vNow = Math.hypot(...v);
    const dir = scaleVector(v, 1 / vNow);
    const to = subtractVectors(through[k]!, p);
    const away = Math.hypot(...to);
    // Reached (or flown past) this waypoint: on to the next.
    if (away < Math.max(1.5, vNow * 0.4) || dotProduct(to, dir) < 0) {
      k++;
      continue;
    }
    let aim = scaleVector(to, 1 / away);
    const next = through[k + 1];
    if (next) {
      const ease = 0.6 * smoothstep(1 - away / (vNow * 2));
      aim = normalize(
        lerpVectors(aim, normalize(subtractVectors(next, p)), ease),
      );
    }
    // Low over the water, he pulls up.
    if (p[1] < floor + 1.5) {
      aim = normalize(addVectors(aim, [0, (floor + 1.5 - p[1]) * 0.6, 0]));
    }
    // Lift holds him up across his line and turns him toward his aim,
    // within what his wings bear.
    const across = subtractVectors(aim, scaleVector(dir, dotProduct(aim, dir)));
    const angle = Math.acos(Math.min(1, Math.max(-1, dotProduct(aim, dir))));
    const turn =
      Math.hypot(...across) > 1e-6
        ? scaleVector(normalize(across), (vNow * angle) / STEER)
        : ([0, 0, 0] as V);
    let lift = addVectors(
      subtractVectors([0, G, 0], scaleVector(dir, G * dir[1])),
      turn,
    );
    const load = Math.hypot(...lift);
    if (load > MOST_LOAD * G) lift = scaleVector(lift, (MOST_LOAD * G) / load);
    // Drag on the glide polar: least at the best glide speed.
    const ratio = (vNow / BEST_GLIDE) ** 2;
    const drag = ((G / LIFT_TO_DRAG) * (ratio + 1 / ratio)) / 2;
    // The rising air lifts him: its work on him, as a push along his line.
    const carried = (G * UPDRAFT) / vNow;
    // Flapping, in bouts: to get his speed back when slow, and up a climb
    // steeper than the rising air carries him once his speed is spent.
    if (vNow < SLOWEST || (dir[1] > SOARING_CLIMB && vNow < BEST_GLIDE)) {
      bout = FLAP_BOUT;
    }
    const thrust =
      bout > 0
        ? Math.max(
            THRUST + Math.max(0, SLOWEST - vNow) * 2,
            dir[1] > 0 ? G * dir[1] * 0.9 : 0,
          )
        : 0;
    bout -= FLY_STEP;
    const accel = addVectors(
      addVectors(lift, [0, -G, 0]),
      scaleVector(dir, thrust + carried - drag),
    );
    v = addVectors(v, scaleVector(accel, FLY_STEP));
    p = addVectors(p, scaleVector(v, FLY_STEP));
    points.push(p);
    speeds.push(Math.hypot(...v));
    working.push(thrust > 0);
  }
  return { points, speeds, working };
}

/** A path along flown points. */
function flownPath(points: V[], speeds: number[], working: boolean[]): Path {
  const dist = [0];
  for (let i = 1; i < points.length; i++) {
    dist.push(
      dist[i - 1]! + Math.hypot(...subtractVectors(points[i]!, points[i - 1]!)),
    );
  }
  return {
    points,
    dist,
    length: dist[dist.length - 1]!,
    speed: speeds[0]!,
    speeds,
    working,
    slowNear: false,
    fadeIn: FADE,
    fadeOut: true,
    soar: false,
    rollAt: -1,
  };
}

/** Where the first card usually sits on screen, for a fly-in with no cards
 * given. */
const USUAL_CARD: ScreenBox = [-0.62, -0.25, 0.62, 0.35];

/** The variations on a fly-in: a plain swoop, a roll while he is still
 * close, a steeper and lower dive, a few wide circles in the distance, or an
 * S-bend on the way down. */
type Flourish = "swoop" | "roll" | "stoop" | "spiral" | "weave";
const FLOURISHES: Flourish[] = ["swoop", "roll", "stoop", "spiral", "weave"];

/** Where a fly-in comes in, close by over the viewer's shoulder: over the
 * top edge at its left, middle or right, or in from either side about
 * halfway up. */
type Entry = "top-left" | "top" | "top-right" | "left" | "right";
const ENTRIES: Entry[] = ["top-left", "top", "top-right", "left", "right"];

/** A way in other than the last one, so two fly-ins running do not repeat. */
function nextEntry(last: Entry | null): Entry {
  const choices = ENTRIES.filter((e) => e !== last);
  return choices[Math.floor(Math.random() * choices.length)]!;
}

/** Where on screen (-1 to 1) a fly-in starts, `near` metres off: his middle
 * just past the edge, so that his wings are in view from the start and he
 * comes into it big on the screen. And which way across he then flies, 1
 * to the right and -1 to the left: away from the side he came in on. */
function entryPoint(
  entry: Entry,
  near: number,
  tanX: number,
  tanY: number,
): { at: [number, number]; way: number } {
  const top = 1 + 0.4 / (near * tanY);
  const side = 1 + 0.4 / (near * tanX);
  switch (entry) {
    case "top-left":
      return { at: [randomBetween(-0.85, -0.65), top], way: 1 };
    case "top-right":
      return { at: [randomBetween(0.65, 0.85), top], way: -1 };
    case "top":
      return {
        at: [randomBetween(-0.2, 0.2), top],
        way: Math.random() < 0.5 ? -1 : 1,
      };
    case "left":
      return { at: [-side, randomBetween(0.05, 0.5)], way: 1 };
    case "right":
      return { at: [side, randomBetween(0.05, 0.5)], way: -1 };
  }
}

/** Which way a fly-in leaves after the swoop, taken the way he is flying
 * across the screen: circling back into the distance toward the side he
 * came in on, on into the background more or less straight ahead, off past
 * the far side, or rising on the air out past the far side, high. Each is
 * listed as often as it should come up: circling back is the rarest. */
type Exit = "back" | "away" | "on" | "up";
const EXITS: Exit[] = ["back", "away", "away", "on", "on", "up", "up"];

/** For each way out: where on screen (x, -1 to 1, the way he flies) he
 * turns and where he heads, how high above the horizon that is (and the
 * most, on screen), and how far off (metres; nearer on a tall screen, where
 * he is close as he comes out of the swoop). On and up he head out of
 * frame. */
const EXIT_SHAPES: Record<
  Exit,
  {
    turnX: [number, number];
    farX: [number, number];
    rise: [number, number];
    highest: number;
    depth: [number, number];
    tallDepth: [number, number];
  }
> = {
  back: {
    turnX: [0.5, 0.85],
    farX: [-0.7, -0.25],
    rise: [0.08, 0.2],
    highest: 0.6,
    depth: [70, 110],
    tallDepth: [45, 70],
  },
  away: {
    turnX: [0.3, 0.55],
    farX: [-0.15, 0.3],
    rise: [0.08, 0.2],
    highest: 0.6,
    depth: [90, 130],
    tallDepth: [55, 80],
  },
  on: {
    turnX: [0.75, 0.95],
    farX: [1.15, 1.4],
    rise: [0.08, 0.2],
    highest: 0.6,
    depth: [35, 55],
    tallDepth: [18, 30],
  },
  up: {
    turnX: [0.55, 0.8],
    farX: [0.9, 1.15],
    rise: [0.3, 0.5],
    highest: 0.8,
    depth: [45, 65],
    tallDepth: [25, 40],
  },
};

/** The point moved to one side of the line from a to b (sideways and level),
 * by k times the line's length. */
function besideLine(p: V, a: V, b: V, k: number): V {
  const d = subtractVectors(b, a);
  const aside = normalize([-d[2], 0, d[0]]);
  return addVectors(p, scaleVector(aside, k * Math.hypot(...d)));
}

/** The fly-in: from just past the top edge (left, middle or right) or
 * either side, close enough to fill a good part of the screen, a long swoop
 * down past the header and cards to low over the water toward the far
 * bottom corner, then away: on past the far side, rising out of frame,
 * into the background, or now and then circling back. */
function entrance(view: RavenView, entry: Entry): Path {
  const { fwd, tanX, horizon, isInFrame, pointAtDepth } = frame(view);
  const card = view.cards[0] ?? USUAL_CARD;
  const flourish = FLOURISHES[Math.floor(Math.random() * FLOURISHES.length)]!;
  const stoop = flourish === "stoop";
  const side = Math.random() < 0.5 ? -1 : 1;

  // A point at a depth behind a point on screen, brought nearer if need be
  // so that it stays above the water (below the horizon a far point would
  // be under it), but no nearer than `least`: past that it is raised.
  function lowPoint(nx: number, ny: number, depth: number, least = 4): V {
    const slope = pointAtDepth(nx, ny, 1)[1];
    const floor = LOW - view.eye;
    const most = slope < 0 && floor < 0 ? floor / slope : Infinity;
    return keepAboveGround(
      pointAtDepth(nx, ny, Math.min(depth, Math.max(most, least))),
      view,
      LOW,
    );
  }

  // In over an edge, close over the viewer's shoulder, wings at full span,
  // while still under 2 m off. Never wider than about half the screen (his
  // span is 1.2 m), so on a narrow screen he comes in a little farther off.
  const near = Math.max(randomBetween(1.25, 1.45), 1.2 / (2 * tanX * 0.5));
  const { at, way } = entryPoint(entry, near, tanX, view.tanY);
  const start = keepAboveGround(pointAtDepth(...at, near), view, LOW);
  // He swoops down and away over the title and through the first card to
  // the bottom of his dive, low over the water.
  const tall = horizon > -0.3;
  const [x0, y0, x1, y1] = card;
  const dip = lowPoint(
    lerpNumber(x0, x1, randomBetween(0.3, 0.7)),
    tall
      ? lerpNumber(y0, y1, randomBetween(0.1, 0.4))
      : Math.max(horizon + 0.03, -0.85),
    randomBetween(9, 13),
  );
  // Then the long swoop: down past the cards and low over the water toward
  // the far bottom corner. On a wide screen the horizon is near the
  // bottom, so he stays just above it; on a tall one the cards are over
  // the water and he comes down close, skimming it, to pass below them.
  const lowY = Math.max(-0.92, randomBetween(-0.88, -0.6) - (stoop ? 0.08 : 0));
  const low = lowPoint(
    way * randomBetween(0.35, 0.75),
    tall ? lowY : Math.max(lowY, horizon + 0.04),
    randomBetween(14, 20) * (stoop ? 0.75 : 1),
    // Always on away from the viewer, never back toward him.
    dotProduct(dip, fwd) + 3,
  );
  // Then out of the swoop, still low, banking the way he leaves...
  const exit = EXITS[Math.floor(Math.random() * EXITS.length)]!;
  const shape = EXIT_SHAPES[exit];
  const turning = lowPoint(
    way * randomBetween(...shape.turnX),
    (tall ? lowY : Math.max(lowY, horizon + 0.04)) + randomBetween(0.05, 0.15),
    // On a tall screen he is close down there; a nearer turn keeps him
    // from shooting up toward the horizon as he draws away.
    tall ? randomBetween(7, 11) : randomBetween(22, 32),
    dotProduct(low, fwd) + 3,
  );
  // ...and on into the distance, against the sky above the skyline: rising
  // only as the distance lifts him toward the horizon, or on the way up,
  // climbing on the rising air.
  function distantPoint(): V {
    let p: V = [0, 0, 0];
    for (let tries = 0; tries < 10; tries++) {
      p = pointAtDepth(
        way * randomBetween(...shape.farX),
        Math.min(
          shape.highest,
          horizon + randomBetween(...shape.rise) + tries * 0.05,
        ),
        randomBetween(...(tall ? shape.tallDepth : shape.depth)),
      );
      if (skyward(p, view)) return p;
    }
    return keepAboveGround(p, view);
  }
  const far = distantPoint();

  const through: V[] = [start, dip];
  if (flourish === "weave") {
    through.push(besideLine(lerpVectors(dip, low, 0.5), dip, low, side * 0.2));
  }
  through.push(low, turning, far);

  const flat = normalize([far[0] - turning[0], 0, far[2] - turning[2]]);
  // A few wide circles around a centre beside the distant point, joined
  // where he arrives there and turning the way he is going.
  function spiral(): V[] | null {
    const r = randomBetween(10, 16);
    const centre = besideLine(far, [0, 0, 0], flat, side * r);
    const a0 = Math.atan2(far[2] - centre[2], far[0] - centre[0]);
    const tangent: V = [-Math.sin(a0), 0, Math.cos(a0)];
    const sense = dotProduct(tangent, flat) >= 0 ? 1 : -1;
    const ring = ringAround(
      centre,
      r,
      randomBetween(1, 1.75),
      sense,
      randomBetween(2, 5),
      a0,
    ).slice(1);
    return ring.every((p) => skyward(p, view) && isInFrame(p, 0.98))
      ? ring
      : null;
  }
  const ring = flourish === "spiral" ? spiral() : null;
  if (ring) {
    through.push(...ring);
  } else {
    // Gliding on the way he is going, a little higher.
    through.push(
      addVectors(
        far,
        addVectors(scaleVector(flat, randomBetween(25, 35)), [
          0,
          randomBetween(1, 3),
          0,
        ]),
      ),
    );
  }
  const last = through[through.length - 1]!;
  const before = through[through.length - 2]!;
  through.push(
    keepAboveGround(
      leave(last, normalize(subtractVectors(last, before)), isInFrame),
      view,
    ),
  );

  // Flown, not drawn: his speed comes from gravity and his height, his
  // turns from what his wings bear. Every waypoint but the first is kept
  // clear of the skyline first, so his line does not need lifting after.
  const { points, speeds, working } = fly(
    [start, ...through.slice(1).map((q) => clearOfSkyline(q, view, 1.5))],
    randomBetween(6.5, 7.2),
    LOW - view.eye,
    isInFrame,
  );
  const path = flownPath(points, speeds, working);
  path.slowNear = true;
  path.fadeIn = 0;
  // The roll comes as he pulls out of the dive.
  if (flourish === "roll") {
    path.rollAt =
      Math.hypot(...subtractVectors(dip, start)) + randomBetween(2, 5);
  }
  return path;
}

/** Where a homecoming leaves the frame (-1 to 1 on each axis): over the top
 * or out either side, no lower than a quarter of the way up. Never out the
 * bottom: diving away under the viewer looks wrong for a bird coming home. */
function randomPointOnEdge(): [number, number] {
  const side = Math.floor(Math.random() * 3);
  if (side === 0) return [randomBetween(-1, 1), 1];
  return [side === 1 ? 1 : -1, randomBetween(-0.5, 1)];
}

/** The fly-in run the other way, on coming back to the page: a speck far off
 * against the sky, anywhere across the view or just past its sides, he
 * flies home toward the viewer, growing as he nears, across the cards (so
 * his passing draws them in) and sweeps past close by out through any edge
 * of the frame. */
function plannedHomecoming(view: RavenView, close: boolean): Path {
  const { right, up, fwd, tanX, horizon, pointAtDepth } = frame(view);
  // How near he comes is planned by how big he looks, the same on any
  // screen: the share of its width his 1.2 m span fills as he closes in.
  // Each stage of his approach is then at least that far off.
  const size = close ? randomBetween(0.34, 0.46) : randomBetween(0.15, 0.26);
  const closest = 1.2 / (2 * tanX * size);
  const middleDepth = Math.max(randomBetween(5, 7), closest * 1.6);
  const farDepth = Math.max(randomBetween(9, 12), middleDepth * 1.7);

  // Across the screen he starts anywhere, or back from one of the cards'
  // pages, out beyond that card: from its middle toward its own side.
  function startAcross(): number {
    if (!view.from) return randomBetween(-1.25, 1.25);
    const middle = (view.from[0] + view.from[2]) / 2;
    const side = Math.abs(middle) > 0.1 ? Math.sign(middle) : 0;
    return Math.min(
      0.95,
      Math.max(-0.95, middle + side * randomBetween(0, 0.35)),
    );
  }
  // Far off and above the skyline, where the aurora lights the sky behind
  // him; and where that is on screen, to draw the rest of his line from.
  function farPoint(): { p: V; at: [number, number] } {
    let found: { p: V; at: [number, number] } = { p: [0, 0, 0], at: [0, 0] };
    for (let tries = 0; tries < 10; tries++) {
      const at: [number, number] = [
        startAcross(),
        Math.min(0.9, horizon + randomBetween(0.06, 0.4) + tries * 0.05),
      ];
      found = { p: pointAtDepth(...at, farDepth), at };
      if (skyward(found.p, view)) return found;
    }
    return { ...found, p: keepAboveGround(found.p, view) };
  }
  const far = farPoint();

  // On his way, behind some part of the cards: anywhere over the whole
  // spread of them, not only one card's middle.
  const spread = view.cards.length ? view.cards : [USUAL_CARD];
  const [x0, y0, x1, y1] = [
    Math.min(...spread.map((c) => c[0])),
    Math.min(...spread.map((c) => c[1])),
    Math.max(...spread.map((c) => c[2])),
    Math.max(...spread.map((c) => c[3])),
  ];
  const middle = keepAboveGround(
    pointAtDepth(
      lerpNumber(x0, x1, randomBetween(0.15, 0.85)),
      lerpNumber(y0, y1, randomBetween(0.15, 0.85)),
      middleDepth,
    ),
    view,
    LOW,
  );
  // Whether any of him still shows: his middle within the frame widened by
  // his half-span on screen (with a little to spare), so that he ends only
  // once his wing tips are out of view too.
  function stillShowing(p: V): boolean {
    const z = dotProduct(p, fwd);
    if (z < 0.3) return false;
    const reach = 0.9 / z;
    return (
      Math.abs(dotProduct(p, right) / z) < tanX + reach &&
      Math.abs(dotProduct(p, up) / z) < view.tanY + reach
    );
  }
  // Out past an edge he can reach: not under the water or below the
  // ground, which would leave him gliding along the bottom of the frame.
  function exitPoint(): { closing: V; out: V; beyond: V } {
    let found = {
      closing: [0, 0, 0] as V,
      out: [0, 0, 0] as V,
      beyond: [0, 0, 0] as V,
    };
    for (let tries = 0; tries < 8; tries++) {
      const [ex, ey] =
        tries < 7 ? randomPointOnEdge() : [Math.sign(far.at[0]) || 1, 0];
      // Closing in at the size planned, heading for the edge, then out
      // past it a little nearer, and on out sideways rather than into the
      // lens.
      const depth = closest * randomBetween(0.7, 0.85);
      found = {
        closing: keepAboveGround(
          pointAtDepth(ex * 0.6, ey * 0.6, closest),
          view,
          LOW,
        ),
        out: keepAboveGround(
          pointAtDepth(ex * 1.5, ey * 1.5, depth),
          view,
          LOW,
        ),
        beyond: keepAboveGround(pointAtDepth(ex * 3, ey * 3, depth), view, LOW),
      };
      if (!stillShowing(found.beyond)) return found;
    }
    return found;
  }
  const { closing, out, beyond } = exitPoint();

  // Flown like the first fly-in. Only the far waypoints are kept clear of
  // the skyline: close by he shows against the mountains too.
  const { points, speeds, working } = fly(
    [far.p, clearOfSkyline(middle, view, 1.5), closing, out, beyond],
    // About his best glide: a raven's own unhurried pace.
    randomBetween(7, 8),
    LOW - view.eye,
    stillShowing,
  );
  // Should his line still end in view, he glides on straight until he is
  // out of it, rather than vanish.
  const last = points[points.length - 1]!;
  const heading = normalize(
    subtractVectors(last, points[Math.max(0, points.length - 2)]!),
  );
  for (let i = 1; i <= 300 && stillShowing(points[points.length - 1]!); i++) {
    points.push(addVectors(last, scaleVector(heading, i * 0.1)));
    speeds.push(speeds[speeds.length - 1]!);
    working.push(false);
  }
  const path = flownPath(points, speeds, working);
  path.slowNear = true;
  // He comes out of the distance and leaves out of frame close by.
  path.fadeIn = HOMECOMING_FADE;
  path.fadeOut = false;
  return path;
}

/** How often a homecoming is a close pass, sweeping by as near as the
 * first fly-in comes in, and how big he gets: the most of the screen's
 * width his wingspan fills while he is in view. A close pass matches the
 * first fly-in (about a third to a half); the others stay smaller. */
const CLOSE_PASSES = 0.4;
const CLOSE_PASS_SIZE: [number, number] = [0.3, 0.5];
const USUAL_SIZE: [number, number] = [0.1, 0.3];
/** The longest a homecoming may take, seconds, slow motion and all. The
 * page is drawn in well before he is gone (see the worker). */
const HOMECOMING_LONGEST = 5;
/** Seconds before a homecoming, once the sky is up: he sets off at once. */
const HOMECOMING_WAIT: [number, number] = [0.1, 0.3];

/** How long the path takes to fly, seconds, slow motion and all. */
function flightSeconds(path: Path): number {
  let seconds = 0;
  for (let i = 1; i < path.points.length; i++) {
    const s = path.dist[i]!;
    const ds = s - path.dist[i - 1]!;
    seconds += ds / (speedAt(path, s) * timeScaleAt(path, s) || 1);
  }
  return seconds;
}

/** A homecoming of the size wanted and no longer than HOMECOMING_LONGEST:
 * his momentum can carry him nearer or farther than planned, so a few are
 * planned and the first that fits is flown, or failing that the nearest
 * fit. He never waits on a plan. */
function homecoming(view: RavenView): Path {
  const { fwd, tanX, isInFrame } = frame(view);
  const close = Math.random() < CLOSE_PASSES;
  const [least, most] = close ? CLOSE_PASS_SIZE : USUAL_SIZE;
  // The most of the screen's width his wingspan fills while in view.
  function biggest(path: Path): number {
    return Math.max(
      0,
      ...path.points
        .filter((p) => isInFrame(p, 1))
        .map((p) => 1.2 / (2 * tanX * dotProduct(p, fwd))),
    );
  }
  // How far a plan is from fitting: 0 when it fits.
  function misfit(path: Path): number {
    const size = biggest(path);
    return (
      Math.max(0, least - size, size - most) * 10 +
      Math.max(0, flightSeconds(path) - HOMECOMING_LONGEST) +
      (path.length > 6 ? 0 : 100)
    );
  }
  let best = plannedHomecoming(view, close);
  let bestMisfit = misfit(best);
  for (let tries = 1; tries < 12 && bestMisfit > 0; tries++) {
    const path = plannedHomecoming(view, close);
    const off = misfit(path);
    if (off < bestMisfit) [best, bestMisfit] = [path, off];
  }
  return best;
}

// ---------------------------------------------------------------------------

/** Which fly-in starts the page: "first", in over the viewer's shoulder, or
 * "return", the homecoming. */
export type FlyIn = "first" | "return";

export type Raven = {
  /** Fly on by dt seconds, planning a new flight in this view when one is
   * due. */
  step(dt: number, view: RavenView): void;
  /** Land: no bird until the next flight is due, after `wait` seconds (a
   * fresh gap if not given). */
  reset(wait?: number): void;
  /** Land, and make the next flight a fly-in, after `wait` seconds. */
  enter(wait: number): void;
  /** Whether the flight under way is a fly-in. */
  entering: boolean;
  /** The flight under way, in world space: its points and the distance
   * flown to each. Null between flights. */
  flight: { points: V[]; dist: number[]; fadeIn: number } | null;
  /** How far along the flight he is, metres. */
  flown: number;
  /** Where the bird is, in world space. */
  position: V;
  /** The bird's triangles in world space (RAVEN_STRIDE floats a vertex). */
  mesh: Float32Array;
  /** Vertices to draw, 0 when there is no bird. */
  count: number;
  /** How much of the bird shows, fading in and out at a flight's ends. */
  alpha: number;
};

export function raven(
  timing: RavenTiming = RAVEN_TIMING,
  flyIn: FlyIn = "first",
): Raven {
  const mesh = new Float32Array(TRIS * 3 * RAVEN_STRIDE);
  let wait =
    flyIn === "return"
      ? randomBetween(...HOMECOMING_WAIT)
      : randomBetween(...timing.entrance);
  let entranceDue = true;
  let lastEntry: Entry | null = null;
  // The fly-in; a first one in over a different edge from the last.
  function flyInPath(view: RavenView): Path {
    if (flyIn === "return") return homecoming(view);
    lastEntry = nextEntry(lastEntry);
    return entrance(view, lastEntry);
  }
  let path: Path | null = null;
  let s = 0;
  let size = 1;
  let rate = 3.4;
  // Flapping: the beat's phase, how far into it the pose is (eased), whether
  // the bird wants to flap and for how much longer.
  let phase = LEVEL_PHASE;
  let flap = 0;
  let flapTarget = 0;
  let wantFlap = true;
  let bout = 0;
  // Roll: seconds since it started, or -1.
  let rolled = false;
  let rollT = -1;
  let up: V | null = null;

  const bird: Raven = {
    mesh,
    count: 0,
    alpha: 0,
    entering: false,
    flight: null,
    flown: 0,
    position: [0, 0, 0],
    reset(next) {
      path = null;
      bird.flight = null;
      bird.count = 0;
      bird.entering = false;
      wait = next ?? randomBetween(...timing.gap);
    },
    enter(next) {
      bird.reset(next);
      entranceDue = true;
    },
    step(dt, view) {
      if (!path) {
        wait -= dt;
        if (wait > 0) return;
        path = entranceDue
          ? flyInPath(view)
          : Math.random() < 0.4
            ? circles(view)
            : pass(view);
        // No flight fits this view: try again shortly rather than leave the
        // sky empty for a whole gap.
        if (!path) return bird.reset(randomBetween(1, 2));
        path = keptClearOfSkyline(path, view);
        bird.entering = entranceDue;
        bird.flight = {
          points: path.points,
          dist: path.dist,
          fadeIn: path.fadeIn,
        };
        entranceDue = false;
        s = 0;
        size = randomBetween(0.94, 1.08);
        // Slower, deeper wingbeats on the fly-in.
        rate = bird.entering ? randomBetween(2.7, 3) : randomBetween(3.2, 3.6);
        phase = LEVEL_PHASE;
        // The fly-in opens with a few slow, deep wingbeats, then a long
        // glide. Other flights set off gliding about as often as flapping,
        // and soaring ones glide.
        wantFlap = !path.soar && (bird.entering || Math.random() < 0.5);
        flap = flapTarget = wantFlap ? 1 : 0;
        bout = path.soar
          ? randomBetween(3, 7)
          : bird.entering
            ? randomBetween(1, 2.6)
            : wantFlap
              ? randomBetween(0.8, 1.6)
              : randomBetween(1.5, 4);
        rolled = false;
        rollT = -1;
        up = null;
      }
      dt *= timeScaleAt(path, s);
      const speed = speedAt(path, s);
      s += speed * dt;
      if (s >= path.length) return bird.reset();
      bird.flown = s;
      bird.alpha =
        (path.fadeIn ? smoothstep(s / path.fadeIn) : 1) *
        (path.fadeOut ? smoothstep((path.length - s) / FADE) : 1);

      // Heading and bank. The lift must carry the bird's weight and turn it,
      // so it leans along gravity plus the turn's acceleration (a coordinated
      // turn); eased so the bank never snaps.
      const ds = 2;
      const p = along(path, s);
      const ahead = along(path, s + ds);
      const behind = along(path, s - ds);
      bird.position = p;
      const fwd = normalize(subtractVectors(ahead, behind));
      const k = (speed / ds) ** 2;
      const accel = scaleVector(
        subtractVectors(addVectors(ahead, behind), scaleVector(p, 2)),
        k,
      );
      let lift = addVectors(accel, [0, G, 0]);
      lift = normalize(
        subtractVectors(lift, scaleVector(fwd, dotProduct(lift, fwd))),
      );
      const eased = up
        ? normalize(lerpVectors(up, lift, 1 - Math.exp(-dt / 0.3)))
        : lift;
      up = normalize(
        subtractVectors(eased, scaleVector(fwd, dotProduct(eased, fwd))),
      );

      // Rolling onto its back and over again, once, in a glide.
      if (!rolled && path.rollAt >= 0 && s >= path.rollAt) {
        wantFlap = false;
        if (flap === 0 && rollT < 0) rollT = 0;
      }
      let roll = 0;
      if (rollT >= 0) {
        rollT += dt;
        const half = 0.55;
        roll =
          Math.PI * smoothstep(rollT / half) +
          Math.PI * smoothstep((rollT - half - 0.2) / half);
        if (rollT > 2 * half + 0.2) {
          rollT = -1;
          rolled = true;
          bout = randomBetween(0.4, 1);
        }
      }
      const rolling = rollT >= 0;

      // Bouts of flapping and gliding; always flapping to climb, never to
      // dive. A beat ends where the wing passes the glide pose.
      if (!rolling && (rolled || path.rollAt < 0 || s < path.rollAt)) {
        bout -= dt;
        if (bout <= 0) {
          wantFlap = !wantFlap;
          bout = path.soar
            ? wantFlap
              ? randomBetween(0.6, 1.2)
              : randomBetween(5, 10)
            : bird.entering
              ? wantFlap
                ? randomBetween(0.6, 1.2)
                : randomBetween(4, 8)
              : wantFlap
                ? randomBetween(0.8, 1.6)
                : randomBetween(2.5, 5);
        }
      }
      let flapping = wantFlap && !rolling;
      // On a flown path he flaps wherever he needed the thrust; on a drawn
      // one, climbing more steeply than the rising air carries him.
      if (
        !rolling &&
        (path.working ? workingAt(path, s) : fwd[1] > SOARING_CLIMB)
      ) {
        flapping = true;
      }
      if (fwd[1] < -0.07) flapping = false;
      if (flapping && flap === 0) phase = LEVEL_PHASE;
      if (flapping) flapTarget = 1;
      // Once the last beat reaches the glide pose, hold it there and ease out.
      if (flap > 0 && flapTarget > 0) {
        const last = phase;
        phase = (phase + rate * dt) % 1;
        const passed =
          last <= phase
            ? last < LEVEL_PHASE && phase >= LEVEL_PHASE
            : last < LEVEL_PHASE || phase >= LEVEL_PHASE;
        if (!flapping && passed) flapTarget = 0;
      }
      flap =
        flapTarget > flap
          ? Math.min(1, flap + dt / 0.15)
          : Math.max(0, flap - dt / 0.12);

      let rest = path.soar ? SOAR : GLIDE;
      const tuck = Math.max(
        smoothstep((-fwd[1] - 0.06) / 0.14),
        rolling ? 0.6 : 0,
      );
      // On the fly-in's swoop the wings stay half open, broad on screen.
      rest = blendPoses(rest, TUCK, tuck * (bird.entering ? 0.3 : 1));
      const pose =
        flap > 0 ? blendPoses(rest, beat(phase), smoothstep(flap)) : rest;

      // Body axes: nose up a few degrees to the airflow, then the roll.
      const aoa = (flap > 0 ? 3 : 4.5) * RAD;
      let u = up;
      let f = fwd;
      [f, u] = [
        addVectors(
          scaleVector(f, Math.cos(aoa)),
          scaleVector(u, Math.sin(aoa)),
        ),
        subtractVectors(
          scaleVector(u, Math.cos(aoa)),
          scaleVector(f, Math.sin(aoa)),
        ),
      ];
      if (roll)
        u = addVectors(
          scaleVector(u, Math.cos(roll)),
          scaleVector(crossProduct(f, u), Math.sin(roll)),
        );
      const r = crossProduct(u, f);

      const local: V[] = [...BODY_TRIS];
      const right: V[] = [];
      wing(pose, right);
      local.push(...right, ...right.map((v): V => [-v[0], v[1], v[2]]));
      tail(pose, local);
      let o = 0;
      for (let i = 0; i < local.length; i += 3) {
        const w = [local[i]!, local[i + 1]!, local[i + 2]!].map((v): V =>
          addVectors(
            p,
            scaleVector(
              addVectors(
                addVectors(scaleVector(r, v[0]), scaleVector(u, v[1])),
                scaleVector(f, v[2]),
              ),
              size,
            ),
          ),
        ) as [V, V, V];
        const n = normalize(
          crossProduct(
            subtractVectors(w[1], w[0]),
            subtractVectors(w[2], w[0]),
          ),
        );
        for (const q of w) {
          mesh.set([q[0], q[1], q[2], n[0], n[1], n[2]], o);
          o += RAVEN_STRIDE;
        }
      }
      bird.count = o / RAVEN_STRIDE;
    },
  };
  return bird;
}
