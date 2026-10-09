// Draws the extension icon (white flame on an orange rounded tile) without image libraries.
import fs from "node:fs";
import zlib from "node:zlib";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function inFlame(x, y) {
  // Teardrop: a circle at the bottom plus a tapering tip curving up and slightly right.
  const cx = 0.5, cy = 0.62, r = 0.2;
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  if (y < cy && y > 0.18) {
    const t = (cy - y) / (cy - 0.18);
    const mid = cx + 0.06 * Math.sin(t * Math.PI);
    return Math.abs(x - mid) <= r * (1 - t) ** 1.3;
  }
  return false;
}

function draw(size) {
  const S = 4; // supersampling
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = [0];
    for (let px = 0; px < size; px++) {
      let a = 0, f = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
        const rr = 0.22, dx = Math.max(0, Math.abs(x - 0.5) - (0.5 - rr)), dy = Math.max(0, Math.abs(y - 0.5) - (0.5 - rr));
        if (dx * dx + dy * dy <= rr * rr) { a++; if (inFlame(x, y)) f++; }
      }
      const cov = a / (S * S), fl = a ? f / a : 0;
      const t = (px + py) / (2 * size);
      const bg = [255, Math.round(90 + 64 * t), Math.round(31 + 0 * t)];
      const c = bg.map((v) => Math.round(v * (1 - fl) + 255 * fl));
      row.push(...c, Math.round(cov * 255));
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const s of [16, 48, 128]) fs.writeFileSync(new URL(`../extension/icons/${s}.png`, import.meta.url), draw(s));
console.log("icons written");
