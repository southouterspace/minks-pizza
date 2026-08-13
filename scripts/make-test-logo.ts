/**
 * Writes a small PNG used by the logo-upload e2e (a green disc with a gold
 * ring) so the test doesn't depend on any binary checked into the repo.
 *
 * Usage: npx tsx scripts/make-test-logo.ts <outfile>
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 256;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// RGBA rows, each prefixed with a zero filter byte.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let p = 0;
const c = (SIZE - 1) / 2;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0;
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - c, y - c);
    let rgba: [number, number, number, number];
    if (d > SIZE / 2) rgba = [0, 0, 0, 0];
    else if (d > SIZE / 2 - 14) rgba = [212, 175, 55, 255]; // gold ring
    else rgba = [11, 82, 46, 255]; // green field
    raw[p++] = rgba[0];
    raw[p++] = rgba[1];
    raw[p++] = rgba[2];
    raw[p++] = rgba[3];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = process.argv[2] ?? "/tmp/test-logo.png";
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
