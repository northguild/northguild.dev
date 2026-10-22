// Builds apps/site/public/stars.bin from the Yale Bright Star Catalogue,
// 5th revised edition (Hoffleit & Warren 1991, CDS V/50): naked-eye stars
// (V <= 5.5), J2000 positions. Precession to the current date happens at
// runtime in the aurora worker.
//
// Run: node scripts/build-stars.mjs
// Record, 6 bytes little-endian: ra uint16 (0..65536 = 0..360°),
// dec int16 (±32767 = ±90°), vmag uint8 ((V + 2) × 20), b-v int8 (× 50).
//
// Also builds apps/site/public/star-names.json for the sky's tooltips: the
// IAU Catalog of Star Names (WGSN), matched by HR number, as
// [record index, name, constellation] for each named star kept above.

import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

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

const stars = [];
/** Record index by HR (Bright Star) number. */
const byHr = new Map();
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
  byHr.set(Number(field(line, 1, 4)), stars.length);
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

// The 88 constellations by IAU abbreviation.
const CONSTELLATIONS = {
  And: "Andromeda",
  Ant: "Antlia",
  Aps: "Apus",
  Aqr: "Aquarius",
  Aql: "Aquila",
  Ara: "Ara",
  Ari: "Aries",
  Aur: "Auriga",
  Boo: "Boötes",
  Cae: "Caelum",
  Cam: "Camelopardalis",
  Cnc: "Cancer",
  CVn: "Canes Venatici",
  CMa: "Canis Major",
  CMi: "Canis Minor",
  Cap: "Capricornus",
  Car: "Carina",
  Cas: "Cassiopeia",
  Cen: "Centaurus",
  Cep: "Cepheus",
  Cet: "Cetus",
  Cha: "Chamaeleon",
  Cir: "Circinus",
  Col: "Columba",
  Com: "Coma Berenices",
  CrA: "Corona Australis",
  CrB: "Corona Borealis",
  Crv: "Corvus",
  Crt: "Crater",
  Cru: "Crux",
  Cyg: "Cygnus",
  Del: "Delphinus",
  Dor: "Dorado",
  Dra: "Draco",
  Equ: "Equuleus",
  Eri: "Eridanus",
  For: "Fornax",
  Gem: "Gemini",
  Gru: "Grus",
  Her: "Hercules",
  Hor: "Horologium",
  Hya: "Hydra",
  Hyi: "Hydrus",
  Ind: "Indus",
  Lac: "Lacerta",
  Leo: "Leo",
  LMi: "Leo Minor",
  Lep: "Lepus",
  Lib: "Libra",
  Lup: "Lupus",
  Lyn: "Lynx",
  Lyr: "Lyra",
  Men: "Mensa",
  Mic: "Microscopium",
  Mon: "Monoceros",
  Mus: "Musca",
  Nor: "Norma",
  Oct: "Octans",
  Oph: "Ophiuchus",
  Ori: "Orion",
  Pav: "Pavo",
  Peg: "Pegasus",
  Per: "Perseus",
  Phe: "Phoenix",
  Pic: "Pictor",
  Psc: "Pisces",
  PsA: "Piscis Austrinus",
  Pup: "Puppis",
  Pyx: "Pyxis",
  Ret: "Reticulum",
  Sge: "Sagitta",
  Sgr: "Sagittarius",
  Sco: "Scorpius",
  Scl: "Sculptor",
  Sct: "Scutum",
  Ser: "Serpens",
  Sex: "Sextans",
  Tau: "Taurus",
  Tel: "Telescopium",
  Tri: "Triangulum",
  TrA: "Triangulum Australe",
  Tuc: "Tucana",
  UMa: "Ursa Major",
  UMi: "Ursa Minor",
  Vel: "Vela",
  Vir: "Virgo",
  Vol: "Volans",
  Vul: "Vulpecula",
};

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
names.sort((a, b) => a[0] - b[0]);
const json = JSON.stringify(names);
writeFileSync(NAMES_OUT, json);
console.log(`${names.length} star names, ${json.length} bytes`);
