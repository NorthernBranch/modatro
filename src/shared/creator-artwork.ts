export const artworkColours = ['Amethyst', 'Ocean', 'Forest', 'Rose', 'Amber'] as const;
const palettes = [
  [62, 43, 93],
  [24, 66, 99],
  [30, 78, 57],
  [112, 40, 63],
  [103, 65, 20],
];
const letters = {
  joker: ['11111', '00010', '00010', '00010', '10010', '10010', '01100'],
  deck: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  voucher: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
};
export function builtinPixels(id: string) {
  const match = /^(joker|deck|voucher)-([1-5])$/.exec(id);
  if (!match) throw new Error('Unknown built-in artwork.');
  const type = match[1] as keyof typeof letters,
    variant = Number(match[2]) - 1;
  const base = palettes[variant]!;
  const pixels = new Uint8Array(71 * 95 * 4);
  for (let y = 0; y < 95; y++)
    for (let x = 0; x < 71; x++) {
      const edge = x < 3 || x >= 68 || y < 3 || y >= 92;
      const inner =
        ((x === 7 || x === 63) && y >= 7 && y <= 87) ||
        ((y === 7 || y === 87) && x >= 7 && x <= 63);
      const glyphX = Math.floor((x - 23) / 5),
        glyphY = Math.floor((y - 29) / 5);
      const glyph =
        glyphX >= 0 &&
        glyphX < 5 &&
        glyphY >= 0 &&
        glyphY < 7 &&
        letters[type][glyphY]![glyphX] === '1';
      const frame = type === 'voucher' && (y === 19 || y === 75) && x > 13 && x < 57;
      const pattern = (x + y * (variant + 1)) % 13 === 0;
      const colour =
        glyph || edge
          ? [248, 241, 215]
          : inner || frame
            ? base.map((v) => Math.min(255, v + 65))
            : pattern
              ? base.map((v) => Math.min(255, v + 18))
              : base;
      pixels.set([...colour, 255], (y * 71 + x) * 4);
    }
  return pixels;
}
