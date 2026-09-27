import fs from 'fs';
import path from 'path';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';
import { APP_ICON_SIZES, appIconFile } from '../src/web/app-icon';

// One-off asset step (`npm run generate:icons`), not part of `build`.
// Renders public/assets/icon.svg into the raster files the app serves:
//   public/assets/icon.png      1000x1000, the default ICON_NAME: Open Graph
//                               image and share-link watermark
//   public/assets/icon-192.png  the manifest's icons (the first is the one
//   public/assets/icon-512.png  the install dialog shows) and apple-touch-icon
//   public/favicon.ico          16, 32 and 48 px frames
const ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets');
const SVG_PATH = path.join(ASSETS_DIR, 'icon.svg');
const ICON_NAME = 'icon.png';
const ICO_PATH = path.join(__dirname, '..', 'public', 'favicon.ico');
const ICO_SIZES = [16, 32, 48];

async function writePng(svg: Buffer, size: number, file: string) {
  const target = path.join(ASSETS_DIR, file);
  await sharp(svg).resize(size, size).png().toFile(target);
  console.log(`Wrote ${path.relative(process.cwd(), target)} (${size} px)`);
}

async function main() {
  const svg = fs.readFileSync(SVG_PATH);

  await writePng(svg, 1000, ICON_NAME);
  for (const size of APP_ICON_SIZES) {
    await writePng(svg, size, appIconFile(ICON_NAME, size));
  }

  const frames = await Promise.all(
    ICO_SIZES.map((size) => sharp(svg).resize(size, size).png().toBuffer()),
  );
  fs.writeFileSync(ICO_PATH, await pngToIco(frames));
  console.log(
    `Wrote ${path.relative(process.cwd(), ICO_PATH)} (${ICO_SIZES.join(', ')} px)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
