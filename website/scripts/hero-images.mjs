// The homepage hero image in the sizes and formats HeroImage.astro offers:
// AVIF and WebP at 760 and 1520 px wide, from the JPEG that video/ renders
// (`remotion still TermoteHero`). Run after that still changes:
//   node website/scripts/hero-images.mjs
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const dir = fileURLToPath(new URL("../public/video/", import.meta.url));
const source = `${dir}termote-hero.jpg`;

for (const width of [760, 1520]) {
  const image = sharp(source).resize({ width });
  await image.clone().avif({ quality: 55, effort: 9 }).toFile(`${dir}termote-hero-${width}.avif`);
  await image.clone().webp({ quality: 78, effort: 6 }).toFile(`${dir}termote-hero-${width}.webp`);
}
