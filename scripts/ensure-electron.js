// Ensures Electron's platform binary is actually unpacked into
// node_modules/electron/dist.
//
// Why: Electron installs its runtime via a `postinstall` script that downloads a
// per-platform zip and unpacks it with the `extract-zip` (yauzl) library. On some
// newer/bleeding-edge Node.js releases that extractor silently no-ops (it neither
// resolves nor rejects, and the process exits 0), so `node_modules/electron` ends
// up with no `path.txt` and an empty `dist/`. Then `electron .` throws
// "Electron failed to install correctly, please delete node_modules/electron and
// try installing again". The zip itself downloads fine and is cached — only the
// extraction step is broken.
//
// Fix: if Electron isn't already unpacked, locate the cached zip (downloading it
// via Electron's own installer if needed) and extract it ourselves using the
// platform's native unzip tool (ditto/unzip/Expand-Archive), then write
// `path.txt`. This is a no-op when Electron is already installed correctly (the
// normal case on supported Node LTS versions), so it's safe to run on every
// platform and every install.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');

function log(msg) {
  console.log(`[ensure-electron] ${msg}`);
}

function getPlatformPath() {
  switch (process.platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error('Electron builds are not available on platform: ' + process.platform);
  }
}

// Mirrors electron/install.js: on macOS running under Rosetta, an x64 process
// should still fetch the arm64 build.
function getArch() {
  let arch = process.env.npm_config_arch || process.arch;
  if (
    process.platform === 'darwin' &&
    arch === 'x64' &&
    process.env.npm_config_arch === undefined
  ) {
    try {
      if (execSync('sysctl -in sysctl.proc_translated').toString().trim() === '1') {
        arch = 'arm64';
      }
    } catch {
      /* ignore */
    }
  }
  return arch;
}

function isInstalled(version, platformPath) {
  try {
    if (
      fs.readFileSync(path.join(electronDir, 'dist', 'version'), 'utf-8').replace(/^v/, '') !==
      version
    ) {
      return false;
    }
    if (fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf-8') !== platformPath) {
      return false;
    }
  } catch {
    return false;
  }
  return fs.existsSync(path.join(electronDir, 'dist', platformPath));
}

// Default @electron/get cache locations (env-paths, suffix removed), plus any
// overrides, searched recursively for the expected zip.
function candidateCacheRoots() {
  const roots = [];
  if (process.env.electron_config_cache) roots.push(process.env.electron_config_cache);
  if (process.env.ELECTRON_CACHE) roots.push(process.env.ELECTRON_CACHE);
  const home = os.homedir();
  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Caches', 'electron'));
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    roots.push(path.join(local, 'electron', 'Cache'));
  } else {
    roots.push(process.env.XDG_CACHE_HOME || path.join(home, '.cache', 'electron'));
  }
  return roots.filter((r, i) => r && roots.indexOf(r) === i);
}

function findZip(roots, zipName) {
  const stack = roots.filter((r) => fs.existsSync(r));
  const seen = new Set();
  while (stack.length) {
    const dir = stack.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === zipName) {
        return full;
      }
    }
  }
  return null;
}

function extractZip(zip, dist) {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  let res;
  if (process.platform === 'darwin') {
    // ditto preserves the .app bundle's symlinks and permissions.
    res = spawnSync('ditto', ['-x', '-k', zip, dist], { stdio: 'inherit' });
  } else if (process.platform === 'win32') {
    res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dist}' -Force`,
      ],
      { stdio: 'inherit' }
    );
  } else {
    res = spawnSync('unzip', ['-o', '-q', zip, '-d', dist], { stdio: 'inherit' });
  }

  if (!res || res.status !== 0) {
    throw new Error(
      `Native unzip failed (exit ${res && res.status}). ` +
        (res && res.error ? res.error.message : '')
    );
  }
}

function main() {
  const pkgPath = path.join(electronDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    log('electron is not installed (run `npm install` first) — nothing to do.');
    return;
  }
  const { version } = require(pkgPath);
  const platformPath = getPlatformPath();

  if (isInstalled(version, platformPath)) {
    log(`electron ${version} already installed — nothing to do.`);
    return;
  }

  const arch = getArch();
  const zipName = `electron-v${version}-${process.platform}-${arch}.zip`;
  log(`electron ${version} binary missing; looking for ${zipName} in the cache…`);

  let zip = findZip(candidateCacheRoots(), zipName);

  if (!zip) {
    // Not cached yet — let Electron's own installer download it. On the affected
    // Node versions this populates the cache even though its own extraction fails.
    log('not cached — running electron installer to download it…');
    spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
    zip = findZip(candidateCacheRoots(), zipName);
  }

  if (!zip) {
    throw new Error(
      `Could not find or download ${zipName}. Check your network connection and re-run.`
    );
  }

  const dist = path.join(electronDir, 'dist');
  log(`extracting ${zip} → dist/ with the native unzip tool…`);
  extractZip(zip, dist);

  // Match electron/install.js: hoist the bundled type defs and write path.txt.
  const srcTypeDef = path.join(dist, 'electron.d.ts');
  if (fs.existsSync(srcTypeDef)) {
    fs.renameSync(srcTypeDef, path.join(electronDir, 'electron.d.ts'));
  }
  fs.writeFileSync(path.join(electronDir, 'path.txt'), platformPath);

  if (!isInstalled(version, platformPath)) {
    throw new Error(`Extraction did not produce ${path.join('dist', platformPath)}.`);
  }
  log(`ready: electron ${version} unpacked.`);
}

try {
  main();
} catch (err) {
  console.error(`[ensure-electron] ${err.message}`);
  process.exit(1);
}
