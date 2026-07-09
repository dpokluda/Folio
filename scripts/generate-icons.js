// Generates all app-icon formats from build/icons/icon.svg:
//   - build/icons/icon.png  (1024x1024, Linux + generic)
//   - build/icons/icon.ico  (Windows)
//   - build/icons/icon.icns (macOS)
// Run via `npm run icons`. Requires the dev-only `sharp` and `png2icons`
// packages (installed on demand — see the npm script).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const dir = path.join(__dirname, '..', 'build', 'icons');
const svg = path.join(dir, 'icon.svg');

async function main() {
  if (!fs.existsSync(svg)) {
    throw new Error(`Missing source icon: ${svg}`);
  }

  // Master PNG at 1024 for the sharpest downscales.
  const master = await sharp(svg).resize(1024, 1024).png().toBuffer();
  fs.writeFileSync(path.join(dir, 'icon.png'), master);

  // .ico and .icns are built from the master PNG. BICUBIC keeps edges clean.
  const ico = png2icons.createICO(master, png2icons.BICUBIC, 0, false);
  if (!ico) throw new Error('Failed to build icon.ico');
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico);

  const icns = png2icons.createICNS(master, png2icons.BICUBIC, 0);
  if (!icns) throw new Error('Failed to build icon.icns');
  fs.writeFileSync(path.join(dir, 'icon.icns'), icns);

  console.log('[icons] wrote icon.png, icon.ico, icon.icns');
}

main().catch((err) => {
  console.error(`[icons] ${err.message}`);
  process.exit(1);
});
