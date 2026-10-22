// Places the sky can be seen from. The worker picks one per visit from the
// browser's time zone (or at random) and the visitor can switch in the info
// popover; the popover shows the same site's details. Plain data only: the page's own
// script and scripts/build-skyline.mjs both import this.

/** One aurora curtain: its ground distance north and the x range it spans. */
export type Curtain = {
  /** Typical distance north of the viewer, km. */
  base: number;
  /** Centre and half-width of the east–west range drawn, km. */
  centre: number;
  half: number;
};

export type Site = {
  id: string;
  /** Short place name, then the country. */
  name: string;
  country: string;
  /** Where the viewer stands, in a few words. */
  spot: string;
  lat: number;
  lon: number;
  /** Eye height above the ground (above the sea for a site over water), metres. */
  eye: number;
  /** Camera heading from north toward east, degrees. */
  heading: number;
  /** Camera pitch and vertical field of view, degrees. The frame's bottom
   * edge sits at pitch − fov / 2, just below the horizon. */
  pitch: number;
  fov: number;
  /** Magnetic dip and declination, degrees (approximate, for ray tilt). */
  dip: number;
  decl: number;
  /** The near and far curtain. Farther south, the aurora sits farther north. */
  curtains: [Curtain, Curtain];
  /** City light on the sky near the horizon, 0 (none) to 1 (a capital). */
  glow: number;
  /** Faintest star magnitude visible on a moonless night. */
  limit: number;
  /** What stands between the viewer and the sky, for the popover text. */
  ground: string;
  /** Water in front reflects the sky (the skyline script finds the shore). */
  water: boolean;
  /** Add OpenStreetMap building heights to the skyline. */
  buildings: boolean;
  /** Lit windows and streets on the skyline, 0 (none) to 1 (a capital). */
  lights: number;
  /** Credits for the data behind this site's skyline. */
  credits: [string, string][];
  /** Browser time zones that start a visit at this site. */
  zones: string[];
};

const COPERNICUS: [string, string] = [
  "Terrain",
  "Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.",
];
const OSM: [string, string] = [
  "Buildings",
  "© OpenStreetMap contributors (ODbL).",
];

export const SITES: Site[] = [
  {
    id: "isafjordur",
    name: "Ísafjörður",
    country: "Iceland",
    spot: "Sólgata, by the church",
    lat: 66.075075,
    lon: -23.124175,
    eye: 2,
    heading: 20,
    pitch: 32,
    fov: 70,
    dip: 77,
    decl: -11,
    curtains: [
      { base: 170, centre: 250, half: 650 },
      { base: 420, centre: 500, half: 1400 },
    ],
    glow: 0.1,
    limit: 5.5,
    ground: "mountains",
    water: false,
    buildings: false,
    lights: 0,
    credits: [COPERNICUS],
    zones: ["Atlantic/Reykjavik"],
  },
  {
    id: "helsinki",
    name: "Helsinki",
    country: "Finland",
    spot: "the main pier on Suomenlinna, across the water to the city",
    lat: 60.1493,
    lon: 24.9848,
    eye: 3,
    heading: -25,
    pitch: 25,
    fov: 60,
    dip: 74,
    decl: 11,
    curtains: [
      { base: 750, centre: -350, half: 1300 },
      { base: 1000, centre: -470, half: 1800 },
    ],
    glow: 1,
    limit: 4.2,
    ground: "skyline",
    water: true,
    buildings: true,
    lights: 1,
    credits: [COPERNICUS, OSM],
    zones: ["Europe/Helsinki", "Europe/Mariehamn"],
  },
];

/** Credits that hold for every site. */
export const SKY_CREDITS: [string, string][] = [
  ["Stars", "Yale Bright Star Catalogue, 5th revised edition (CDS V/50)."],
  ["Moon", "NASA's Scientific Visualization Studio."],
  [
    "Planets",
    "JPL Keplerian elements for approximate positions (E. M. Standish).",
  ],
];

const POINTS = [
  "north",
  "north-northeast",
  "northeast",
  "east-northeast",
  "east",
  "east-southeast",
  "southeast",
  "south-southeast",
  "south",
  "south-southwest",
  "southwest",
  "west-southwest",
  "west",
  "west-northwest",
  "northwest",
  "north-northwest",
];

/** Heading in degrees as a 16-point compass word, e.g. "north-northeast". */
export const compass = (deg: number) =>
  POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] ?? "north";

/** Latitude and longitude as "66.0751° N, 23.1242° W". */
export const coords = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(4)}° ${lon < 0 ? "W" : "E"}`;
