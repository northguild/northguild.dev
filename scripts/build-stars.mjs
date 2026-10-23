// Builds apps/site/public/stars.bin from the Yale Bright Star Catalogue,
// 5th revised edition (Hoffleit & Warren 1991, CDS V/50): naked-eye stars
// (V <= 5.5), J2000 positions. Precession to the current date happens at
// runtime in the aurora worker.
//
// Run: node scripts/build-stars.mjs
// Record, 6 bytes little-endian: ra uint16 (0..65536 = 0..360°),
// dec int16 (±32767 = ±90°), vmag uint8 ((V + 2) × 20), b-v int8 (× 50).
//
// Also builds apps/site/public/star-names.json for the sky's tooltips, one
// entry for every star kept above, sorted by record index:
// - [index, name, constellation] for a star in the IAU Catalog of Star Names
//   (WGSN), matched by HR number: "Sarin", "Hercules".
// - [index, designation, constellation, 0] for any other star with a Bayer
//   letter or Flamsteed number in the catalogue: "ζ Herculis", "Hercules".
//   The 0 says the label already names the constellation.
// - [index, "HR n"] for the rest, by Bright Star number alone.

import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { CONSTELLATIONS, GENITIVES } from "./constellation-names.mjs";

const SOURCE = "http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz";
const LIMIT = 5.5;
const NAMES = "https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt";
const OUT = new URL("../apps/site/public/stars.bin", import.meta.url);
const NAMES_OUT = new URL(
  "../apps/site/public/star-names.json",
  import.meta.url,
);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`catalogue: HTTP ${res.status}`);
const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString(
  "latin1",
);

// Byte ranges from the catalogue ReadMe (1-based, inclusive).
const field = (line, from, to) => line.slice(from - 1, to).trim();

// Bayer letters as the catalogue abbreviates them.
const GREEK = {
  Alp: "α",
  Bet: "β",
  Gam: "γ",
  Del: "δ",
  Eps: "ε",
  Zet: "ζ",
  Eta: "η",
  The: "θ",
  Iot: "ι",
  Kap: "κ",
  Lam: "λ",
  Mu: "μ",
  Nu: "ν",
  Xi: "ξ",
  Omi: "ο",
  Pi: "π",
  Rho: "ρ",
  Sig: "σ",
  Tau: "τ",
  Ups: "υ",
  Phi: "φ",
  Chi: "χ",
  Psi: "ψ",
  Ome: "ω",
};
const SUPERSCRIPT = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

const stars = [];
/** Record index by HR (Bright Star) number. */
const byHr = new Map();
/** Fallback label for each record, by index: designation or HR number. */
const designations = [];
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
  const hr = Number(field(line, 1, 4));
  // Name field: Flamsteed number, Bayer letter, its superscript, constellation.
  const [flamsteed, bayer, index, con] = [
    field(line, 5, 7),
    field(line, 8, 10),
    field(line, 11, 11),
    field(line, 12, 14),
  ];
  const genitive = GENITIVES[con];
  const letter = GREEK[bayer];
  designations.push(
    genitive && (letter || flamsteed)
      ? [
          `${letter ? letter + (index ? SUPERSCRIPT[Number(index)] : "") : flamsteed} ${genitive}`,
          CONSTELLATIONS[con],
          0,
        ]
      : [`HR ${hr}`],
  );
  byHr.set(hr, stars.length);
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

// Fixed-width columns, located from the header row.
const namesRes = await fetch(NAMES);
if (!namesRes.ok) throw new Error(`star names: HTTP ${namesRes.status}`);
const lines = (await namesRes.text()).split("\n");
const header = lines.find((l) => l.startsWith("#Name/ASCII")) ?? "";
const col = (label) => header.indexOf(label);
const [nameAt, designAt, conAt] = [
  col("Name/Diacritics"),
  col("Designation"),
  col("Con"),
];
const names = [];
for (const line of lines) {
  if (line.startsWith("#") || line.startsWith("$") || !line.trim()) continue;
  const hr = /^HR (\d+)/.exec(line.slice(designAt, conAt).trim());
  const index = hr && byHr.get(Number(hr[1]));
  if (index === undefined || index === null) continue;
  const name = line.slice(nameAt, designAt).trim();
  const con = line.slice(conAt, conAt + 3).trim();
  names.push([index, name, CONSTELLATIONS[con] ?? con]);
}
const proper = new Set(names.map(([index]) => index));
designations.forEach((label, index) => {
  if (!proper.has(index)) names.push([index, ...label]);
});
names.sort((a, b) => a[0] - b[0]);
const json = JSON.stringify(names);
writeFileSync(NAMES_OUT, json);
console.log(
  `${proper.size} star names, ${names.length - proper.size} designations, ${json.length} bytes`,
);
