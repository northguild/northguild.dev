// Builds the skyline seen from each site in aurora.sites.ts. For each azimuth
// it marches outward over the Copernicus DEM GLO-30 surface model (terrain,
// trees and buildings), optionally adds OpenStreetMap building heights, and
// keeps the highest elevation angle, allowing for Earth curvature and standard
// refraction. Where the site looks over water it also records the far shore,
// so the page can draw the water below it.
// Writes apps/site/src/scripts/skylines/<site id>.ts.
//
// Run: node scripts/build-skyline.mjs [site id ...]   (default: all sites)
// Terrain: Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and
// Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
// Buildings: © OpenStreetMap contributors (ODbL).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromFile } from "geotiff";
import { SITES } from "../apps/site/src/scripts/aurora.sites.ts";

const SPAN = 100; // degrees either side of the camera heading
const AZ_STEP = 0.2;
const FAR = 80_000;
const BUILDINGS_FAR = 12_000; // OSM buildings beyond this are below a pixel
const LAND = 1.5; // metres above sea level that count as land, not water
const NO_SHORE = -40; // degrees: the strip runs below the frame
const R_EARTH = 6_371_000;
const R_EFF = (R_EARTH * 7) / 6; // standard refraction
const OUT = new URL("../apps/site/src/scripts/skylines/", import.meta.url);
const DEG = 180 / Math.PI;

const cache = join(tmpdir(), "northguild-dem");
mkdirSync(cache, { recursive: true });
mkdirSync(OUT, { recursive: true });

const tileName = (lat, lon) =>
  `${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}_00_` +
  `${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}_00`;

async function load(tile) {
  const name = `Copernicus_DSM_COG_10_${tile}_DEM`;
  const file = join(cache, `${name}.tif`);
  if (!existsSync(file)) {
    const res = await fetch(
      `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`,
    );
    // Open sea has no tile: treat it as sea level.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${tile}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const image = await (await fromFile(file)).getImage();
  const [west, south, east, north] = image.getBoundingBox();
  const [data] = await image.readRasters();
  return {
    west,
    south,
    east,
    north,
    width: image.getWidth(),
    height: image.getHeight(),
    data,
  };
}

/** OSM building footprints with a height, cached per bounding box. */
async function osmBuildings([south, west, north, east]) {
  const file = join(cache, `osm-${south}-${west}-${north}-${east}.json`);
  if (!existsSync(file)) {
    const query = `[out:json][timeout:120];(way["building"](${south},${west},${north},${east}););out tags geom;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "User-Agent": "northguild-skyline/1.0" },
      body: new URLSearchParams({ data: query }),
    });
    if (!res.ok) throw new Error(`overpass: HTTP ${res.status}`);
    writeFileSync(file, await res.text());
  }
  const { elements } = JSON.parse(readFileSync(file, "utf8"));
  return elements
    .filter((e) => e.geometry?.length)
    .map((e) => {
      const t = e.tags ?? {};
      const levels = Number.parseFloat(t["building:levels"]);
      const height =
        Number.parseFloat(t.height) ||
        (Number.isFinite(levels) ? levels * 3.2 + 1 : 10);
      return { height, points: e.geometry };
    });
}

async function build(site) {
  const latRad = site.lat / DEG;
  const dLat = (FAR / R_EARTH) * DEG;
  const dLon = dLat / Math.cos(latRad);
  const names = [];
  for (
    let la = Math.floor(site.lat - dLat);
    la <= Math.floor(site.lat + dLat);
    la++
  ) {
    for (
      let lo = Math.floor(site.lon - dLon);
      lo <= Math.floor(site.lon + dLon);
      lo++
    ) {
      names.push(tileName(la, lo));
    }
  }
  const tiles = (await Promise.all(names.map(load))).filter(Boolean);

  const height = (lat, lon) => {
    for (const t of tiles) {
      if (lon < t.west || lon >= t.east || lat <= t.south || lat > t.north) {
        continue;
      }
      const x = ((lon - t.west) / (t.east - t.west)) * t.width - 0.5;
      const y = ((t.north - lat) / (t.north - t.south)) * t.height - 0.5;
      const x0 = Math.max(0, Math.min(t.width - 2, Math.floor(x)));
      const y0 = Math.max(0, Math.min(t.height - 2, Math.floor(y)));
      const fx = Math.min(1, Math.max(0, x - x0));
      const fy = Math.min(1, Math.max(0, y - y0));
      const at = (i, j) => t.data[(y0 + j) * t.width + x0 + i];
      const top = at(0, 0) * (1 - fx) + at(1, 0) * fx;
      const bottom = at(0, 1) * (1 - fx) + at(1, 1) * fx;
      return Math.max(0, top * (1 - fy) + bottom * fy);
    }
    return 0;
  };

  // Local metres east (x) and north (y) of the viewer.
  const toLocal = (lat, lon) => [
    ((lon - site.lon) / DEG) * R_EARTH * Math.cos(latRad),
    ((lat - site.lat) / DEG) * R_EARTH,
  ];

  const from = site.heading - SPAN;
  const count = Math.round((2 * SPAN) / AZ_STEP) + 1;
  // On a pier the eye height is above the sea; the model there may show a building.
  const h0 = site.water ? site.eye : height(site.lat, site.lon) + site.eye;
  const angleTo = (top, r) => Math.atan2(top - h0 - (r * r) / (2 * R_EFF), r);
  // Over water the viewer's own pier may be in the model; start just past it.
  const near = site.water ? 15 : 300;

  const best = new Float64Array(count).fill(-Infinity);
  const bestR = new Float64Array(count).fill(FAR);
  const shore = new Float64Array(count).fill(NO_SHORE / DEG);

  for (let i = 0; i < count; i++) {
    const az = (from + i * AZ_STEP) / DEG;
    let landAt = 0;
    // Step grows with distance: 15 m near, about 130 m far.
    for (let r = near; r <= FAR; r += Math.max(15, r / 600)) {
      const lat = site.lat + (r * Math.cos(az) * DEG) / R_EARTH;
      const lon =
        site.lon + (r * Math.sin(az) * DEG) / (R_EARTH * Math.cos(latRad));
      const z = height(lat, lon);
      if (!landAt && z > LAND) landAt = r;
      const angle = angleTo(z, r);
      if (angle > best[i]) {
        best[i] = angle;
        bestR[i] = r;
      }
    }
    // Over water the strip stops at the first land, however near: the
    // island's own shore curves down toward the frame.
    if (site.water && landAt) shore[i] = angleTo(0, landAt);
  }

  if (site.buildings) {
    const box = [
      site.lat - 0.11,
      site.lon - 0.22,
      site.lat + 0.11,
      site.lon + 0.22,
    ].map((v) => Math.round(v * 1000) / 1000);
    const buildings = await osmBuildings(box);
    let used = 0;
    for (const { height: tall, points } of buildings) {
      const local = points.map((p) => toLocal(p.lat, p.lon));
      const dists = local.map(([x, y]) => Math.hypot(x, y));
      const r = Math.min(...dists);
      if (r < 50 || r > BUILDINGS_FAR) continue;
      // Ground under the building: the lowest surface-model value at its corners.
      const ground = Math.min(...points.map((p) => height(p.lat, p.lon)));
      const angle = angleTo(ground + tall, r);
      const azs = local.map(([x, y]) => Math.atan2(x, y) * DEG);
      const lo = Math.min(...azs);
      const hi = Math.max(...azs);
      if (hi - lo > 90) continue; // straddles the bearing behind the viewer
      for (
        let i = Math.max(0, Math.ceil((lo - from) / AZ_STEP));
        i <= Math.min(count - 1, Math.floor((hi - from) / AZ_STEP));
        i++
      ) {
        if (angle > best[i]) {
          best[i] = angle;
          bestR[i] = r;
        }
      }
      used++;
    }
    console.log(
      `${site.id}: ${used} OSM buildings within ${BUILDINGS_FAR / 1000} km`,
    );
  }

  const elev = Int16Array.from(best, (a) => Math.round(a * DEG * 100));
  const dist = Uint16Array.from(bestR, (r) =>
    Math.min(65535, Math.round(r / 10)),
  );
  const base = Int16Array.from(shore, (a) => Math.round(a * DEG * 100));

  const b64 = (a) => Buffer.from(a.buffer).toString("base64");
  writeFileSync(
    new URL(`${site.id}.ts`, OUT),
    `// Generated by scripts/build-skyline.mjs. Do not edit.
// ${site.name}: ${site.lat} N, ${site.lon} E, eye ${site.eye} m above ground (${h0.toFixed(1)} m).
// elev: Int16 little-endian, hundredths of a degree above the horizontal.
// dist: Uint16 little-endian, tens of metres to the ridge.
// base: Int16, hundredths of a degree: the far shore over water, or ${NO_SHORE}°.
export const SKYLINE = {
  from: ${from},
  step: ${AZ_STEP},
  elev: "${b64(elev)}",
  dist: "${b64(dist)}",
  base: "${b64(base)}",
};
`,
  );

  const deg = Array.from(elev, (v) => v / 100);
  console.log(
    `${site.id}: ground ${h0.toFixed(1)} m, ${tiles.length} tiles, ${count} azimuths, ` +
      `elevation ${Math.min(...deg)}° to ${Math.max(...deg)}°`,
  );
  for (let az = from; az <= from + 2 * SPAN; az += 10) {
    const i = Math.round((az - from) / AZ_STEP);
    console.log(
      `  ${String(az).padStart(4)}°  ${deg[i].toFixed(2).padStart(6)}°  ` +
        `${(dist[i] / 100).toFixed(1).padStart(5)} km  shore ${(base[i] / 100).toFixed(2)}°`,
    );
  }
}

const wanted = process.argv.slice(2);
for (const site of SITES) {
  if (!wanted.length || wanted.includes(site.id)) await build(site);
}
