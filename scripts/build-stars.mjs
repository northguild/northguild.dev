// Builds apps/site/public/stars.bin from the Yale Bright Star Catalogue,
// 5th revised edition (Hoffleit & Warren 1991, CDS V/50): naked-eye stars
// (V <= 5.5), J2000 positions. Precession to the current date happens at
// runtime in the aurora worker.
//
// Run: node scripts/build-stars.mjs
// Record, 6 bytes little-endian: ra uint16 (0..65536 = 0..360°),
// dec int16 (±32767 = ±90°), vmag uint8 ((V + 2) × 20), b-v int8 (× 50).

import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const SOURCE = "http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz";
const LIMIT = 5.5;
const OUT = new URL("../apps/site/public/stars.bin", import.meta.url);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`catalogue: HTTP ${res.status}`);
const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString(
  "latin1",
);

// Byte ranges from the catalogue ReadMe (1-based, inclusive).
const field = (line, from, to) => line.slice(from - 1, to).trim();

const stars = [];
for (const line of text.split("\n")) {
  const raH = field(line, 76, 77);
  const vmag = field(line, 103, 107);
  // Blank coordinates are entries removed from the catalogue (novae, clusters).
  if (!raH || !vmag) continue;
  const v = Number(vmag);
  if (v > LIMIT) continue;
  const ra =
    (Number(raH) +
      Number(field(line, 78, 79)) / 60 +
      Number(field(line, 80, 83)) / 3600) *
    15;
  const sign = field(line, 84, 84) === "-" ? -1 : 1;
  const dec =
    sign *
    (Number(field(line, 85, 86)) +
      Number(field(line, 87, 88)) / 60 +
      Number(field(line, 89, 90)) / 3600);
  const bv = Number(field(line, 110, 114) || "0.6");
  stars.push({ ra, dec, v, bv });
}

const buf = Buffer.alloc(stars.length * 6);
stars.forEach(({ ra, dec, v, bv }, i) => {
  const o = i * 6;
  buf.writeUInt16LE(Math.round((ra / 360) * 65536) % 65536, o);
  buf.writeInt16LE(Math.round((dec / 90) * 32767), o + 2);
  buf.writeUInt8(Math.max(0, Math.min(255, Math.round((v + 2) * 20))), o + 4);
  buf.writeInt8(Math.max(-127, Math.min(127, Math.round(bv * 50))), o + 5);
});
writeFileSync(OUT, buf);
console.log(`${stars.length} stars, ${buf.length} bytes`);
