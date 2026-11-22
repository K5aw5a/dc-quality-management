'use strict';

// Minimal image encoders so scanned-PDF page images can be handed to an OCR
// engine as ordinary files: PNG for raw pixels, TIFF for CCITT fax data.

const zlib = require('node:zlib');

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

// pixels: packed rows (each row byte-aligned), as in PDF. colorType 0 = gray, 2 = RGB.
function encodePng({ width, height, bitDepth, colorType, pixels }) {
  const channels = colorType === 2 ? 3 : 1;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter: none
    pixels.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, Math.min(pixels.length, (y + 1) * rowBytes));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Wrap a CCITT G3/G4 stream (from a PDF CCITTFaxDecode image) in a one-strip TIFF.
function ccittToTiff({ data, width, height, k = 0, byteAlign = false, inverted = false, dpi = 200 }) {
  const entries = [];
  const add = (tag, type, value) => entries.push({ tag, type, value });
  const SHORT = 3; const LONG = 4; const RATIONAL = 5;
  add(256, LONG, width);
  add(257, LONG, height);
  add(258, SHORT, 1);
  add(259, SHORT, k < 0 ? 4 : 3); // 4 = CCITT G4, 3 = CCITT G3
  add(262, SHORT, inverted ? 1 : 0); // 0 = WhiteIsZero
  add(273, LONG, 0); // StripOffsets, patched below
  add(277, SHORT, 1);
  add(278, LONG, height);
  add(279, LONG, data.length);
  add(282, RATIONAL, dpi);
  add(283, RATIONAL, dpi);
  if (k >= 0) add(292, LONG, (k > 0 ? 1 : 0) | (byteAlign ? 4 : 0)); // T4Options
  else add(293, LONG, 0); // T6Options
  add(296, SHORT, 2); // inches
  entries.sort((a, b) => a.tag - b.tag);

  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const rationalsOffset = ifdOffset + ifdSize;
  const rationals = entries.filter((e) => e.type === RATIONAL);
  const dataOffset = rationalsOffset + rationals.length * 8;

  const head = Buffer.alloc(dataOffset);
  head.write('II', 0, 'latin1'); head.writeUInt16LE(42, 2); head.writeUInt32LE(ifdOffset, 4);
  head.writeUInt16LE(entries.length, ifdOffset);
  let r = 0;
  entries.forEach((e, i) => {
    const p = ifdOffset + 2 + i * 12;
    head.writeUInt16LE(e.tag, p); head.writeUInt16LE(e.type, p + 2); head.writeUInt32LE(1, p + 4);
    if (e.tag === 273) head.writeUInt32LE(dataOffset, p + 8);
    else if (e.type === RATIONAL) {
      const off = rationalsOffset + r++ * 8;
      head.writeUInt32LE(e.value, off); head.writeUInt32LE(1, off + 4);
      head.writeUInt32LE(off, p + 8);
    } else if (e.type === SHORT) head.writeUInt16LE(e.value, p + 8);
    else head.writeUInt32LE(e.value, p + 8);
  });
  head.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12); // no next IFD
  return Buffer.concat([head, data]);
}

// Convert decoded PDF image samples to 8-bit gray or RGB (or keep 1/2/4/8-bit gray).
function pixelsToPng({ width, height, bpc, colorSpace, pixels, decodeInvert }) {
  const cs = colorSpace;
  if (cs.kind === 'gray' && [1, 2, 4, 8].includes(bpc)) {
    let px = pixels;
    if (decodeInvert) { px = Buffer.from(pixels); for (let i = 0; i < px.length; i++) px[i] = ~px[i] & 0xff; }
    return encodePng({ width, height, bitDepth: bpc, colorType: 0, pixels: px });
  }
  if (cs.kind === 'rgb' && bpc === 8) return encodePng({ width, height, bitDepth: 8, colorType: 2, pixels });

  // Generic path: read samples and convert to 8-bit RGB.
  const comps = cs.kind === 'cmyk' ? 4 : cs.kind === 'rgb' ? 3 : 1;
  const rowBits = width * comps * bpc;
  const rowBytes = Math.ceil(rowBits / 8);
  const out = Buffer.alloc(width * height * 3);
  const max = (1 << bpc) - 1;
  const sample = (row, idx) => {
    if (bpc === 8) return pixels[row * rowBytes + idx];
    if (bpc === 16) return pixels[row * rowBytes + idx * 2];
    const bit = idx * bpc;
    const byte = pixels[row * rowBytes + (bit >> 3)] || 0;
    return (byte >> (8 - bpc - (bit & 7))) & max;
  };
  const scale = bpc === 16 ? 1 : 255 / max;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (cs.kind === 'indexed') {
        const i = Math.min(sample(y, x), cs.hival);
        const base = cs.base === 'cmyk' ? 4 : cs.base === 'rgb' ? 3 : 1;
        const e = cs.lookup.subarray(i * base, i * base + base);
        if (base === 3) { out[o] = e[0]; out[o + 1] = e[1]; out[o + 2] = e[2]; }
        else if (base === 4) { const kk = 255 - e[3]; out[o] = ((255 - e[0]) * kk) / 255; out[o + 1] = ((255 - e[1]) * kk) / 255; out[o + 2] = ((255 - e[2]) * kk) / 255; }
        else { out[o] = out[o + 1] = out[o + 2] = e[0]; }
      } else if (cs.kind === 'cmyk') {
        const c = sample(y, x * 4) * scale; const m = sample(y, x * 4 + 1) * scale;
        const yy = sample(y, x * 4 + 2) * scale; const kk = 255 - sample(y, x * 4 + 3) * scale;
        out[o] = ((255 - c) * kk) / 255; out[o + 1] = ((255 - m) * kk) / 255; out[o + 2] = ((255 - yy) * kk) / 255;
      } else if (cs.kind === 'rgb') {
        out[o] = sample(y, x * 3) * scale; out[o + 1] = sample(y, x * 3 + 1) * scale; out[o + 2] = sample(y, x * 3 + 2) * scale;
      } else {
        let g = sample(y, x) * scale; if (decodeInvert) g = 255 - g;
        out[o] = out[o + 1] = out[o + 2] = g;
      }
    }
  }
  return encodePng({ width, height, bitDepth: 8, colorType: 2, pixels: out });
}

module.exports = { encodePng, ccittToTiff, pixelsToPng };
