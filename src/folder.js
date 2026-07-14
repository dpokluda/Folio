// Folder-mode helpers: scanning a directory into an explorer tree, choosing a
// folder's entry document, and resolving an in-document link / explorer click
// into a concrete navigation target. Pure (fs + path + url) so it can be unit
// tested without booting Electron.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.markdn', '.mdtext', '.mdtxt']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.vscode', '.idea']);
const MAX_TREE_DEPTH = 16;

function isMarkdownFile(p) {
  return MD_EXTS.has(path.extname(p).toLowerCase());
}

// Recursively build a tree of subfolders + markdown files under `dir`. Folders
// are included only if they (transitively) contain markdown, so the explorer
// stays focused on navigable content. Hidden entries and heavy/asset dirs are
// skipped; a depth cap guards against pathological trees / symlink loops.
function scanFolder(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(name) || depth >= MAX_TREE_DEPTH) continue;
      const children = scanFolder(full, depth + 1);
      if (children.length) dirs.push({ name, path: full, type: 'dir', children });
    } else if (ent.isFile() && isMarkdownFile(name)) {
      files.push({ name, path: full, type: 'file' });
    }
  }
  const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  dirs.sort(cmp);
  files.sort(cmp);
  return [...dirs, ...files];
}

function firstMarkdownIn(nodes) {
  for (const n of nodes) if (n.type === 'file') return n.path;
  for (const n of nodes) {
    if (n.type === 'dir') {
      const hit = firstMarkdownIn(n.children);
      if (hit) return hit;
    }
  }
  return null;
}

// First markdown file to show when a folder is opened: a directory index
// (_index.md / README.md / index.md) at the top level, else the first
// markdown file found walking the tree depth-first.
function entryDocFor(tree) {
  const preferred = ['_index.md', 'readme.md', 'index.md'];
  for (const pref of preferred) {
    const hit = tree.find((n) => n.type === 'file' && n.name.toLowerCase() === pref);
    if (hit) return hit.path;
  }
  return firstMarkdownIn(tree);
}

// The markdown file that represents a folder link target (a folder "renders"
// its index document). Returns null if the folder has no index doc.
function folderIndexDoc(dir) {
  for (const name of ['_index.md', 'README.md', 'readme.md', 'index.md']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Resolve a navigation request into a concrete action. `payload` is either
// { path } (an explorer click, absolute) or { href, fromPath } (a clicked
// in-document link, relative to the source doc). Returns an object with a
// `kind`: 'markdown' | 'folder-empty' | 'external' | 'missing', or null when
// there is nothing to do (e.g. a pure "#anchor" or an unresolvable relative
// link from an untitled document).
function resolveNavTarget(payload = {}) {
  let targetPath = null;
  let anchor = null;

  if (payload.path) {
    targetPath = payload.path;
  } else if (payload.href != null) {
    let href = String(payload.href);
    const hashIdx = href.indexOf('#');
    if (hashIdx >= 0) {
      anchor = href.slice(hashIdx + 1);
      href = href.slice(0, hashIdx);
    }
    if (!href) return null; // pure "#anchor" — handled entirely in the renderer
    if (/^file:\/\//i.test(href)) {
      try {
        targetPath = fileURLToPath(href);
      } catch (_) {
        return null;
      }
    } else {
      let decoded = href;
      try {
        decoded = decodeURIComponent(href);
      } catch (_) {
        /* use raw */
      }
      decoded = decoded.replace(/\//g, path.sep);
      if (path.isAbsolute(decoded)) targetPath = decoded;
      else if (payload.fromPath) targetPath = path.resolve(path.dirname(payload.fromPath), decoded);
      else return null;
    }
  } else {
    return null;
  }

  let st;
  try {
    st = fs.statSync(targetPath);
  } catch (_) {
    return { kind: 'missing', path: targetPath };
  }
  if (st.isDirectory()) {
    const idx = folderIndexDoc(targetPath);
    return idx ? { kind: 'markdown', path: idx, anchor } : { kind: 'folder-empty', path: targetPath };
  }
  if (isMarkdownFile(targetPath)) return { kind: 'markdown', path: targetPath, anchor };
  return { kind: 'external', path: targetPath };
}

module.exports = {
  MD_EXTS,
  isMarkdownFile,
  scanFolder,
  entryDocFor,
  folderIndexDoc,
  resolveNavTarget,
};
