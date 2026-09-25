import fs from 'fs';
import path from 'path';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

// One-off asset step (`npm run generate:icons`), not part of `build`.
// Renders public/assets/icon.svg into the raster files the app serves:
//   public/assets/icon.png  1000x1000, referenced by ICON_NAME (manifest,
//                           apple-touch-icon, OG image, push icon, watermark)
//   public/favicon.ico      16, 32 and 48 px frames
const ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets');
const SVG_PATH = path.join(ASSETS_DIR, 'icon.svg');
const PNG_PATH = path.join(ASSETS_DIR, 'icon.png');
const ICO_PATH = path.join(__dirname, '..', 'public', 'favicon.ico');
const ICO_SIZES = [16, 32, 48];

async function main() {
  const svg = fs.readFileSync(SVG_PATH);

  await sharp(svg).resize(1000, 1000).png().toFile(PNG_PATH);
  console.log(`Wrote ${path.relative(process.cwd(), PNG_PATH)}`);

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
