// Builds apps/site/public/constellations.json for the sky's hover lines: the
// stick figures of the 88 constellations from d3-celestial (Olaf Frohn,
// BSD-3-Clause), with each vertex matched to the nearest star in stars.bin.
// Run after scripts/build-stars.mjs, since it reads the stars it wrote.
//
// Run: node scripts/build-constellations.mjs
// Output: by constellation name, as the star names give it, a flat list of
// star record index pairs, one pair per line: [a, b, c, d] is the lines a–b
// and c–d.

import { readFileSync, writeFileSync } from "node:fs";
import { CONSTELLATIONS } from "./constellation-names.mjs";

// Pinned to the commit that last changed the file.
const SOURCE =
  "https://raw.githubusercontent.com/ofrohn/d3-celestial/d2e20e104b86429d90ac8227a5b021262b45d75a/data/constellations.lines.json";
const STARS = new URL("../apps/site/public/stars.bin", import.meta.url);
const OUT = new URL("../apps/site/public/constellations.json", import.meta.url);
// A vertex further than this from every star in stars.bin is a star fainter
// than the catalogue's limit; lines to it are left out.
const MATCH = 0.2;
const RAD = Math.PI / 180;

const unit = (ra, dec) => [
  Math.cos(dec * RAD) * Math.cos(ra * RAD),
  Math.cos(dec * RAD) * Math.sin(ra * RAD),
  Math.sin(dec * RAD),
];

// Record layout as scripts/build-stars.mjs writes it.
const buf = readFileSync(STARS);
const stars = [];
for (let o = 0; o + 6 <= buf.length; o += 6) {
  stars.push(
    unit(
      (buf.readUInt16LE(o) / 65536) * 360,
      (buf.readInt16LE(o + 2) / 32767) * 90,
    ),
  );
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`constellations: HTTP ${res.status}`);
const { features } = await res.json();

const nearest = (ra, dec) => {
  const [x, y, z] = unit(ra, dec);
  let best = -1;
  let dot = Math.cos(MATCH * RAD);
  stars.forEach(([sx, sy, sz], i) => {
    const d = x * sx + y * sy + z * sz;
    if (d > dot) {
      dot = d;
      best = i;
    }
  });
  return best;
};

// Serpens comes as two features, head and tail; they share one figure.
const figures = new Map();
let dropped = 0;
for (const { id, geometry } of features) {
  const pairs = figures.get(id) ?? [];
  const seen = new Set();
  for (let k = 0; k < pairs.length; k += 2) {
    seen.add(`${pairs[k]}-${pairs[k + 1]}`);
  }
  for (const line of geometry.coordinates) {
    const ids = line.map(([ra, dec]) => nearest(ra, dec));
    for (let k = 1; k < ids.length; k++) {
      const [a, b] = [ids[k - 1], ids[k]];
      if (a < 0 || b < 0) {
        dropped++;
        continue;
      }
      if (a === b || seen.has(`${a}-${b}`) || seen.has(`${b}-${a}`)) continue;
      seen.add(`${a}-${b}`);
      pairs.push(a, b);
    }
  }
  figures.set(id, pairs);
}

const json = JSON.stringify(
  Object.fromEntries(
    [...figures].map(([id, pairs]) => [CONSTELLATIONS[id] ?? id, pairs]),
  ),
);
writeFileSync(OUT, json);
const lines = [...figures.values()].reduce((n, p) => n + p.length / 2, 0);
console.log(
  `${figures.size} figures, ${lines} lines (${dropped} to fainter stars left out), ${json.length} bytes`,
);
