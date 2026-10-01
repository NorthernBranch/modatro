// Development-only snapshot for the explicitly labelled browser preview.
// Desktop builds always use the main-process repository and verified local data.
import { writeFile } from 'node:fs/promises';
const folders = [
  'Blazingulag@Prism',
  'Aikoyori@Aikoyoris-Shenanigans',
  'Steamodded@smods',
  'BakersDozenBagels@Bakery',
  'Aure@SixSuits',
  'DigitalDetective47@NextAntePreview',
  'AmazinDooD@ScrollableDescriptions',
  'CeruleanK@SharpCards',
  'Breezebuilder@SystemClock',
  'CampfireCollective@ExtraCredit',
  'ECLA17@PixelPerfect',
  'ABGamma@Brainstorm-Rerolled',
];
const mods = await Promise.all(
  folders.map(async (folder) => {
    const base = `https://raw.githubusercontent.com/skyline69/balatro-mod-index/main/mods/${encodeURIComponent(folder)}`;
    const response = await fetch(`${base}/meta.json`);
    if (!response.ok) throw Error(`${folder}: ${response.status}`);
    const metadata = await response.json();
    return { folder, metadata };
  }),
);
await writeFile(
  'src/preview-catalogue.json',
  JSON.stringify({ fetchedAt: new Date().toISOString(), mods }, null, 2),
);
console.log(`Saved ${mods.length} actual index entries for browser preview.`);
