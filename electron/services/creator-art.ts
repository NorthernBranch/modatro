import { PNG } from 'pngjs';
import { inflateSync } from 'node:zlib';
import { cropRectangle, type CreatorDraft } from '../../src/shared/creator';
import { UserError } from './errors';

export function decodeArtwork(bytes: Buffer) {
  if (
    bytes.length > 8 * 1024 * 1024 ||
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new UserError('Choose a PNG file no larger than 8 MiB.');
  const w = bytes.readUInt32BE(16),
    h = bytes.readUInt32BE(20);
  if (!w || !h || w > 2048 || h > 2048 || w * h > 4 * 1024 * 1024)
    throw new UserError('PNG artwork must be between 1×1 and 2048×2048 pixels.');
  try {
    const idat: Buffer[] = [];
    let chunks = 0;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      if (++chunks > 8192) throw new Error('PNG has too many chunks');
      const size = bytes.readUInt32BE(offset);
      if (size > bytes.length - offset - 12) throw new Error('Truncated PNG chunk');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') throw new Error('Animated PNG is unsupported');
      if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + size));
      offset += size + 12;
    }
    // pngjs bounds ordinary PNG inflation, but its Adam7 path uses plain zlib.
    // Check that stream with an explicit bound before allowing a second decode.
    if (bytes[28] === 1)
      inflateSync(Buffer.concat(idat), { maxOutputLength: w * h * 8 + (w + h) * 8 + 128 });
    const image = PNG.sync.read(bytes, { checkCRC: true });
    if (image.width !== w || image.height !== h) throw new Error('Invalid dimensions');
    return image;
  } catch {
    throw new UserError('The PNG file could not be decoded. Choose a valid, static PNG.');
  }
}
export function placeholderArtwork(deck: boolean) {
  const image = new PNG({ width: 71, height: 95 });
  for (let y = 0; y < 95; y++)
    for (let x = 0; x < 71; x++) {
      const border = x < 3 || y < 3 || x >= 68 || y >= 92;
      const pattern = deck
        ? (Math.floor(x / 7) + Math.floor(y / 7)) % 2 === 0 && x > 7 && x < 64 && y > 7 && y < 88
        : Math.abs(x - 35) + Math.abs(y - 40) < 19;
      const glyph =
        !deck &&
        ((y >= 22 && y <= 25 && x >= 26 && x <= 44) ||
          (x >= 39 && x <= 43 && y >= 22 && y <= 49) ||
          (y >= 47 && y <= 51 && x >= 28 && x <= 43) ||
          (x >= 26 && x <= 29 && y >= 42 && y <= 49));
      const color =
        border || glyph
          ? [231, 235, 218]
          : pattern
            ? deck
              ? [60, 118, 111]
              : [113, 86, 154]
            : deck
              ? [30, 64, 64]
              : [53, 41, 76];
      const i = (y * 71 + x) * 4;
      image.data.set([...color, 255], i);
    }
  return image;
}
export function cardArtwork(original: PNG, crop: CreatorDraft['crop'], scale: 1 | 2) {
  const output = new PNG({ width: 71 * scale, height: 95 * scale });
  const rect = cropRectangle(original.width, original.height, crop);
  for (let y = 0; y < output.height; y++)
    for (let x = 0; x < output.width; x++) {
      const sx = Math.min(
        original.width - 1,
        Math.floor(rect.x + ((x + 0.5) * rect.width) / output.width),
      );
      const sy = Math.min(
        original.height - 1,
        Math.floor(rect.y + ((y + 0.5) * rect.height) / output.height),
      );
      original.data.copy(
        output.data,
        (y * output.width + x) * 4,
        (sy * original.width + sx) * 4,
        (sy * original.width + sx) * 4 + 4,
      );
    }
  return PNG.sync.write(output);
}
