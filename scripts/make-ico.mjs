// Builds a proper multi-resolution Windows .ico directly with `sharp`
// (already a project devDependency) — no external ico library, no network
// call to electron-builder's icon-conversion tool (which hits an EXDEV
// cross-device rename error on this machine's cache directory). Modern
// Windows/Explorer happily accepts PNG-compressed frames inside an .ico
// container, so this just needs a correct ICONDIR + ICONDIRENTRY header
// around sharp-resized PNG buffers, per the documented ICO format.
//
// One-off tool for the Electron desktop build (see electron/main.cjs) —
// not part of any Android icon pipeline. Ported as-is from Nexus-Dashboard's
// scripts/make-ico.mjs (same problem, same fix, both desktop editions).
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const [, , sourcePng, outIco] = process.argv;
if (!sourcePng || !outIco) {
  console.error('Usage: node make-ico.mjs <source.png> <out.ico>');
  process.exit(1);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const images = await Promise.all(
  SIZES.map((size) =>
    sharp(sourcePng)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
      .then((buf) => ({ size, buf })),
  ),
);

// ICONDIR: reserved(2)=0, type(2)=1 (icon), count(2)
const dirHeader = Buffer.alloc(6);
dirHeader.writeUInt16LE(0, 0);
dirHeader.writeUInt16LE(1, 2);
dirHeader.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16; // header + one 16-byte ICONDIRENTRY per image
const entries = [];
const dataChunks = [];

for (const { size, buf } of images) {
  const entry = Buffer.alloc(16);
  // width/height: 0 means 256 in the ICO spec
  entry.writeUInt8(size === 256 ? 0 : size, 0);
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // color palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(buf.length, 8); // size of image data
  entry.writeUInt32LE(offset, 12); // offset of image data
  entries.push(entry);
  dataChunks.push(buf);
  offset += buf.length;
}

const ico = Buffer.concat([dirHeader, ...entries, ...dataChunks]);
await writeFile(outIco, ico);
console.log(`Wrote ${outIco} (${images.length} sizes: ${SIZES.join(', ')}), ${ico.length} bytes`);
