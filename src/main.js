const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { buildMenu } = require('./menu');

const store = new Store();

// ---------------------------------------------------------------------------
// Per-window session state
//
// Folio supports multiple windows, each viewing its own document/folder. All
// per-document state lives on a Session bound to one BrowserWindow; IPC handlers
// resolve the sender's Session via sessionFor(), and menu actions act on the
// focused window's Session. App-wide preferences (theme, appearance, page width,
// recent files, window size) stay in the shared `store`.
// ---------------------------------------------------------------------------
class Session {
  constructor(win) {
    this.win = win;
    this.id = win.webContents.id; // stable window id, captured while webContents is alive
    this.currentPath = null; // absolute path of the open file, or null for an untitled doc
    this.currentName = 'Welcome'; // display name when untitled
    this.isDirty = false;
    this.forceClose = false;
    this.currentFolder = null; // root of the open folder (file-explorer mode), or null
    this.pendingOpenPath = null; // file to open once the renderer is ready
    this.pendingOpenFolder = null; // folder to open in explorer mode once the renderer is ready
    this.watchedPath = null; // file currently watched for external changes, or null
    this.lastMtimeMs = 0; // last-seen mtime of the watched file, to ignore our own writes
    this.history = []; // visited file docs [{ path, anchor }], oldest -> newest
    this.historyIndex = -1; // position within history; -1 when empty
  }
}

const sessions = new Map(); // webContents.id -> Session
let lastFocusedSession = null;

// Resolve the Session that owns a given webContents (an IPC sender).
function sessionFor(webContents) {
  return webContents ? sessions.get(webContents.id) ?? null : null;
}

// The Session for the currently focused window, falling back to the most
// recently focused one (menu actions can fire on macOS with no window focused).
function focusedSession() {
  const win = BrowserWindow.getFocusedWindow();
  if (win && sessions.has(win.webContents.id)) {
    return sessions.get(win.webContents.id);
  }
  if (lastFocusedSession && !lastFocusedSession.win.isDestroyed()) {
    return lastFocusedSession;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function themesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'themes')
    : path.join(__dirname, '..', 'themes');
}

// Bundled documents (welcome, formatting tour) live in samples/ and are packed
// into the app (app.asar). __dirname-relative resolution works both in dev and
// when packaged — Electron reads files inside app.asar transparently.
function builtinDocPath(file) {
  return path.join(__dirname, '..', 'samples', file);
}

// ---------------------------------------------------------------------------
// Folder mode: file-explorer tree + internal link navigation
// ---------------------------------------------------------------------------
const {
  scanFolder,
  entryDocFor,
  resolveNavTarget,
  searchInFolder,
  invalidateSearchCache,
} = require('./folder');

// Built-in documents shown from the Help menu. Opened as *untitled* so they are
// viewable and editable, but Save becomes Save As and never overwrites the
// bundled copy.
const BUILTIN_DOCS = {
  welcome: { file: 'welcome.md', name: 'Welcome' },
  'formatting-tour': { file: 'formatting-tour.md', name: 'Markdown Formatting Tour' },
};

// Window/taskbar icon. On Windows the packaged app uses the icon embedded in
// the .exe by electron-builder; setting it here mainly gives `npm start` (dev)
// and Linux a proper icon. Returns undefined if the asset is missing.
function appIconPath() {
  const base = path.join(__dirname, '..', 'build', 'icons');
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const p = path.join(base, file);
  return fs.existsSync(p) ? p : undefined;
}

// ---------------------------------------------------------------------------
// Three-axis theming: Style family × Appearance × Page width.
//
// A selection is composed at runtime into an ordered stack of theme
// stylesheets, layered base foundation → family overlay → width overlay (later
// files override earlier ones). The `themes/` folder is laid out symmetrically:
//
//   themes/
//     base.css              shared foundation (also the Fluent look)
//     fluent/  a4.css  dynamic.css  us-letter.css
//     github/  github.css  a4.css  dynamic.css  us-letter.css
//     word/    word.css    a4.css  dynamic.css  us-letter.css  fonts/
//
// Fluent adds no family overlay — base.css already carries the Fluent palette —
// so its folder holds only the page-width overlays. Appearance (light/dark) is
// handled separately by flipping Chromium's prefers-color-scheme through
// Electron's nativeTheme, which activates the dark palettes the stylesheets
// already carry behind @media (prefers-color-scheme: dark).
// ---------------------------------------------------------------------------
const STYLE_FAMILIES = ['fluent', 'github', 'word'];
const APPEARANCES = ['light', 'dark'];
const PAGE_WIDTHS = ['dynamic', 'a4', 'letter'];

// Family look overlays on top of base.css. Fluent needs none (base is Fluent).
function familyLayers(family) {
  switch (family) {
    case 'github':
      return ['base.css', 'github/github.css'];
    case 'word':
      return ['base.css', 'word/word.css'];
    case 'fluent':
    default:
      return ['base.css'];
  }
}

// Per-family page-width overlay, e.g. 'github/a4.css'. Every family folder
// carries its own dynamic/a4/us-letter files, so the path is uniform.
function widthLayer(family, width) {
  const name = { a4: 'a4.css', letter: 'us-letter.css', dynamic: 'dynamic.css' };
  return `${family}/${name[width] || name.dynamic}`;
}

// Ordered list of theme CSS files (relative to themesDir) for the current
// Style + Page-width selection. Later files override earlier ones.
function composeThemeFiles() {
  const family = STYLE_FAMILIES.includes(store.get('styleFamily'))
    ? store.get('styleFamily')
    : 'fluent';
  const width = PAGE_WIDTHS.includes(store.get('pageWidth')) ? store.get('pageWidth') : 'dynamic';
  return [...familyLayers(family), widthLayer(family, width)];
}

function applyAppearance() {
  nativeTheme.themeSource = store.get('appearance') === 'dark' ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// Window + title
// ---------------------------------------------------------------------------
// Create a new application window with its own Session. `openTarget` optionally
// seeds what the window opens once its renderer is ready: { path } for a file,
// { folder } for a directory (explorer mode). With no target the window shows
// the Welcome document.
function createWindow(openTarget = null) {
  const bounds = store.get('window') || { width: 1100, height: 820 };
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#ffffff',
    icon: appIconPath(),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  const session = new Session(win);
  if (openTarget && openTarget.path) session.pendingOpenPath = openTarget.path;
  if (openTarget && openTarget.folder) session.pendingOpenFolder = openTarget.folder;
  sessions.set(session.id, session);
  lastFocusedSession = session;

  // Security: never let renderer content open new windows or navigate the top
  // frame away from the local app shell (they would inherit the preload bridge).
  // External http(s) links are routed through the vetted open-external channel.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('focus', () => {
    lastFocusedSession = session;
    rebuildMenu();
  });

  win.on('close', (e) => {
    if (session.forceClose || !session.isDirty) {
      persistWindowBounds(session);
      return;
    }
    e.preventDefault();
    promptUnsaved(session).then((proceed) => {
      if (proceed) {
        session.forceClose = true;
        win.close();
      }
    });
  });

  win.on('closed', () => {
    stopWatching(session);
    sessions.delete(session.id);
    if (lastFocusedSession === session) lastFocusedSession = null;
  });

  rebuildMenu();
  updateTitle(session);
  applyAppearance();
  return session;
}

function persistWindowBounds(session) {
  if (!session || session.win.isDestroyed()) return;
  const [width, height] = session.win.getSize();
  store.set('window', { width, height });
}

function updateTitle(session) {
  if (!session || session.win.isDestroyed()) return;
  const base = session.currentPath
    ? path.basename(session.currentPath)
    : session.currentName || 'Untitled';
  session.win.setTitle(`${session.isDirty ? '\u2022 ' : ''}${base} - Folio`);
}

function setDirty(session, value) {
  if (!session) return;
  session.isDirty = !!value;
  updateTitle(session);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function rebuildMenu() {
  const session = focusedSession();
  const template = buildMenu({
    isMac: process.platform === 'darwin',
    styleFamily: store.get('styleFamily'),
    appearance: store.get('appearance'),
    pageWidth: store.get('pageWidth'),
    recentFiles: store.get('recentFiles') || [],
    hasFolder: !!(session && session.currentFolder),
    hasFile: !!(session && session.currentPath),
    canGoBack: canGoBack(session),
    canGoForward: canGoForward(session),
    lineNumbers: !!store.get('lineNumbers'),
    actions,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Push the composed theme stack to every open window.
function pushThemeAll() {
  const payload = { files: composeThemeFiles() };
  for (const session of sessions.values()) send(session, 'set-theme', payload);
}

const actions = {
  newWindow: () => createWindow(),
  open: () => withSession((s) => doOpen(s)),
  openFolder: () => withSession((s) => doOpenFolder(s)),
  closeFolder: () => withSession((s) => doCloseFolder(s)),
  openRecent: (p) => withSession((s) => loadFile(s, p)),
  back: () => withSession((s) => navigateHistory(s, -1)),
  forward: () => withSession((s) => navigateHistory(s, 1)),
  clearRecent: () => {
    store.clearRecent();
    rebuildMenu();
  },
  save: () => withSession((s) => doSave(s)),
  saveAs: () => withSession((s) => doSaveAs(s)),
  copyPath: () => copyDocumentPath(),
  format: (kind) => sendFocused('command', { name: 'format', format: kind }),
  reload: () => withSession((s) => doReload(s)),
  exportPDF: () => withSession((s) => doExportPDF(s)),
  newFile: () => withSession((s) => doNew(s)),
  toggleSource: () => sendFocused('command', { name: 'toggle-source' }),
  toggleOutline: () => sendFocused('command', { name: 'toggle-outline' }),
  toggleFiles: () => sendFocused('command', { name: 'toggle-files' }),
  toggleLineNumbers: () => sendFocused('command', { name: 'toggle-line-numbers' }),
  zoomIn: () => sendFocused('command', { name: 'zoom-in' }),
  zoomOut: () => sendFocused('command', { name: 'zoom-out' }),
  zoomReset: () => sendFocused('command', { name: 'zoom-reset' }),
  find: () => sendFocused('command', { name: 'find' }),
  findInFiles: () => {
    const session = focusedSession();
    if (!session) return;
    if (!session.currentFolder) {
      dialog.showMessageBox(session.win, {
        type: 'info',
        title: 'Find in Files',
        message: 'Find in Files searches an open folder.',
        detail: 'Open a folder first (File ▸ Open Folder) to search across its Markdown files.',
      });
      return;
    }
    send(session, 'command', { name: 'find-in-files' });
  },
  setStyleFamily: (family) => {
    store.set('styleFamily', family);
    pushThemeAll();
    rebuildMenu();
  },
  setAppearance: (appearance) => {
    store.set('appearance', appearance);
    applyAppearance();
    rebuildMenu();
  },
  setPageWidth: (width) => {
    store.set('pageWidth', width);
    pushThemeAll();
    rebuildMenu();
  },
  about: () => showAbout(focusedSession()),
  installShellCommand: () => installShellCommand(),
  openWelcome: () => withSession((s) => openBuiltinDoc(s, 'welcome')),
  openFormattingTour: () => withSession((s) => openBuiltinDoc(s, 'formatting-tour')),
};

// Run an action against the focused window's Session, creating a new window when
// none is focused (e.g. New/Open triggered on macOS with all windows closed).
function withSession(fn) {
  let session = focusedSession();
  if (!session) session = createWindow();
  return fn(session);
}

// Copy the focused document's absolute path to the clipboard (for sharing,
// pasting into a terminal, etc.) and flash a short confirmation toast. No-op
// with a gentle hint when the document is untitled (never saved to disk).
function copyDocumentPath() {
  const session = focusedSession();
  if (!session) return;
  if (!session.currentPath) {
    send(session, 'command', { name: 'toast', text: 'Save the document first to copy its path' });
    return;
  }
  clipboard.writeText(session.currentPath);
  send(session, 'command', { name: 'toast', text: 'Path copied to clipboard' });
}

// macOS: install a small `folio` wrapper into /usr/local/bin so the app can be
// launched from the terminal (the .app bundle itself isn't on PATH). The wrapper
// shells out to `open -a "Folio"`, which routes any file arg through the app's
// existing `open-file` handling. Never crashes the app: everything is guarded.
function installShellCommand() {
  const session = focusedSession();
  const parentWin = session ? session.win : null;

  try {
    if (process.platform !== 'darwin') {
      dialog.showMessageBox(parentWin, {
        type: 'info',
        title: 'Install Command',
        message: "Installing the 'folio' command isn't supported on this platform yet.",
        detail:
          'On Windows a packaged install already places Folio on your PATH, and Linux support is planned.',
        buttons: ['OK'],
      });
      return;
    }

    const binDir = '/usr/local/bin';
    const target = `${binDir}/folio`;
    const script = '#!/bin/sh\nexec open -a "Folio" "$@"\n';
    const manualCommand =
      `sudo mkdir -p ${binDir} && ` +
      `printf '#!/bin/sh\\nexec open -a "Folio" "$@"\\n' | sudo tee ${target} >/dev/null && ` +
      `sudo chmod 0755 ${target}`;

    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(target, script, { mode: 0o755 });
      fs.chmodSync(target, 0o755); // ensure mode even if the file pre-existed
    } catch (err) {
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
        const response = dialog.showMessageBoxSync(parentWin, permissionDialogOptions(target, manualCommand));
        if (response === 0) clipboard.writeText(manualCommand);
        return;
      }
      throw err;
    }

    dialog.showMessageBox(parentWin, {
      type: 'info',
      title: 'Command Installed',
      message: "The 'folio' command was installed.",
      detail:
        `You can now run:\n\n    folio path/to/file.md\n\n` +
        `You may need to open a new terminal, and make sure ${binDir} is on your PATH.`,
      buttons: ['OK'],
    });
  } catch (err) {
    try {
      dialog.showMessageBox(parentWin, {
        type: 'error',
        title: 'Install Command',
        message: "Couldn't install the 'folio' command.",
        detail: String((err && err.message) || err),
        buttons: ['OK'],
      });
    } catch {
      // Swallow: never let this crash the app.
    }
  }
}

// Dialog shown when /usr/local/bin/folio can't be written without elevation.
// "Copy Command" (button 0) copies the sudo one-liner to the clipboard.
function permissionDialogOptions(target, manualCommand) {
  return {
    type: 'warning',
    title: 'Install Command',
    message: "Installing the 'folio' command needs elevated permissions.",
    detail:
      `Folio couldn't write ${target} directly. Run this in a terminal to install it manually:\n\n` +
      `${manualCommand}`,
    buttons: ['Copy Command', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  };
}

function send(session, channel, payload) {
  if (session && !session.win.isDestroyed()) {
    session.win.webContents.send(channel, payload);
  }
}

function sendFocused(channel, payload) {
  send(focusedSession(), channel, payload);
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

// Extract the first launch argument that resolves to an existing file OR
// directory, returning { path, isDir }, or null when none is present. Skips the
// executable, the app-path arg (present as "." or the project dir when running
// unpackaged), and any flags.
function pathArgFrom(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (!a || a.startsWith('-')) continue;
    try {
      const resolved = path.resolve(a);
      if (!fs.existsSync(resolved)) continue;
      const st = fs.statSync(resolved);
      if (st.isFile()) return { path: resolved, isDir: false };
      if (st.isDirectory()) return { path: resolved, isDir: true };
    } catch (_) {
      /* ignore and keep scanning */
    }
  }
  return null;
}

// Open a bundled document (welcome / formatting tour) as an untitled buffer, so
// it can be read and edited but Save won't overwrite the shipped copy.
async function openBuiltinDoc(session, key) {
  if (!(await confirmDiscardIfDirty(session))) return;
  loadBuiltinDoc(session, key);
}

// Load a bundled document without a dirty-check (caller's responsibility).
function loadBuiltinDoc(session, key) {
  const doc = BUILTIN_DOCS[key];
  if (!doc) return;
  let content;
  try {
    content = fs.readFileSync(builtinDocPath(doc.file), 'utf8');
  } catch (err) {
    dialog.showErrorBox('Folio', `Cannot open ${doc.name}.\n\n${err.message}`);
    return;
  }
  session.currentPath = null;
  session.currentName = doc.name;
  setDirty(session, false);
  stopWatching(session);
  resetHistory(session);
  send(session, 'load-document', { path: null, content, name: doc.name });
  updateTitle(session);
  rebuildMenu();
}

// Close the open folder: clear the explorer, forget it, and return to Welcome.
async function doCloseFolder(session) {
  if (!session.currentFolder) return;
  if (!(await confirmDiscardIfDirty(session))) return;
  session.currentFolder = null;
  store.set('folder', null);
  store.set('filesVisible', false);
  invalidateSearchCache();
  send(session, 'open-folder', null); // renderer hides + clears the explorer
  loadBuiltinDoc(session, 'welcome');
  rebuildMenu();
}

// ---------------------------------------------------------------------------
// External-change watching (live reload)
// ---------------------------------------------------------------------------

// Stop watching whatever file this session was watching, if any.
function stopWatching(session) {
  if (session.watchedPath) {
    fs.unwatchFile(session.watchedPath, session.watchListener);
    session.watchedPath = null;
    session.watchListener = null;
  }
}

// Watch the session's current file for out-of-app edits. Uses fs.watchFile
// (polling) rather than fs.watch because it is reliable across editors that save
// atomically (write to a temp file then rename), which invalidate an fs.watch
// handle. The 1s poll is negligible per document and gives near-instant live
// reload for a viewer.
function watchCurrentFile(session) {
  stopWatching(session);
  if (!session.currentPath) return;
  const target = session.currentPath;
  try {
    session.lastMtimeMs = fs.statSync(target).mtimeMs;
  } catch (_) {
    session.lastMtimeMs = 0;
  }
  const listener = (curr) => {
    // Only react to the file we still have open, and ignore deletions (mtime 0)
    // so a transient save-rename gap doesn't blank the view.
    if (target !== session.currentPath || curr.mtimeMs === 0) return;
    if (curr.mtimeMs === session.lastMtimeMs) return;
    session.lastMtimeMs = curr.mtimeMs;
    onExternalChange(session);
  };
  fs.watchFile(target, { interval: 1000 }, listener);
  session.watchedPath = target;
  session.watchListener = listener;
}

// The open file changed on disk. Reload silently when the buffer is clean; when the
// user has unsaved edits, ask before discarding them.
async function onExternalChange(session) {
  if (!session.currentPath) return;
  if (session.isDirty) {
    const { response } = await dialog.showMessageBox(session.win, {
      type: 'warning',
      buttons: ['Reload', 'Keep My Changes'],
      defaultId: 1,
      cancelId: 1,
      title: 'File changed on disk',
      message: `${path.basename(session.currentPath)} was modified outside Folio.`,
      detail: 'Reloading will discard the unsaved changes you have made here.',
    });
    if (response !== 0) return;
  }
  reloadCurrentFile(session);
}

// Re-read the session's current file and push it to the renderer, preserving the
// reading position. Does not touch the recent list. Refreshes the watched mtime so
// the re-read is not itself mistaken for another external change.
function reloadCurrentFile(session) {
  if (!session.currentPath) return;
  try {
    const content = fs.readFileSync(session.currentPath, 'utf8');
    try {
      session.lastMtimeMs = fs.statSync(session.currentPath).mtimeMs;
    } catch (_) {
      /* leave lastMtimeMs as-is */
    }
    setDirty(session, false);
    send(session, 'load-document', {
      path: session.currentPath,
      content,
      baseUrl: pathToFileURL(session.currentPath).href,
      preserveScroll: true,
    });
    updateTitle(session);
  } catch (err) {
    dialog.showErrorBox('Folio — cannot reload file', `${session.currentPath}\n\n${err.message}`);
  }
}

// Manual File ▸ Reload from Disk. No-op for untitled/built-in docs.
async function doReload(session) {
  if (!session.currentPath) return;
  if (session.isDirty && !(await confirmDiscardIfDirty(session))) return;
  reloadCurrentFile(session);
}

// ---------------------------------------------------------------------------
// Back/forward navigation history
//
// A per-session, browser-style stack of the file documents the user has viewed.
// Only real files are tracked (built-in Welcome/Untitled docs reset it so
// Back/Forward stay disabled outside a reading context). Clicking a link,
// picking a file in the explorer, and Open/Open Recent all push onto it; Back and
// Forward walk it without recording a new entry.
// ---------------------------------------------------------------------------

// Push a freshly navigated-to file onto the session's history, dropping any
// forward entries. A repeat of the current document only updates its anchor.
function recordHistory(session, filePath, anchor = null) {
  if (!session || !filePath) return;
  session.history = session.history.slice(0, session.historyIndex + 1);
  const top = session.history[session.historyIndex];
  if (top && top.path === filePath) {
    top.anchor = anchor || null;
    return;
  }
  session.history.push({ path: filePath, anchor: anchor || null });
  session.historyIndex = session.history.length - 1;
}

// Reset history to a single seed file (or empty for built-in/untitled docs).
function resetHistory(session, filePath = null, anchor = null) {
  if (!session) return;
  session.history = filePath ? [{ path: filePath, anchor: anchor || null }] : [];
  session.historyIndex = session.history.length - 1;
}

function canGoBack(session) {
  return !!session && session.historyIndex > 0;
}

function canGoForward(session) {
  return !!session && session.historyIndex >= 0 && session.historyIndex < session.history.length - 1;
}

// Walk history by delta (-1 = Back, +1 = Forward). Honors unsaved changes and
// skips entries whose file has since disappeared, loading without re-recording.
async function navigateHistory(session, delta) {
  if (!session) return;
  const targetIndex = session.historyIndex + delta;
  if (targetIndex < 0 || targetIndex >= session.history.length) return;
  const entry = session.history[targetIndex];
  if (!entry) return;
  if (!fs.existsSync(entry.path)) {
    dialog.showMessageBox(session.win, {
      type: 'warning',
      title: 'Folio',
      message: 'That document is no longer available.',
      detail: entry.path,
      buttons: ['OK'],
    });
    return;
  }
  if (!(await confirmDiscardIfDirty(session))) return;
  session.historyIndex = targetIndex;
  loadFile(session, entry.path, entry.anchor, { record: false });
}

async function loadFile(session, filePath, anchor = null, { record = true } = {}) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    session.currentPath = filePath;
    session.currentName = path.basename(filePath);
    store.addRecent(filePath);
    setDirty(session, false);
    watchCurrentFile(session);
    if (record) recordHistory(session, filePath, anchor);
    send(session, 'load-document', {
      path: filePath,
      content,
      baseUrl: pathToFileURL(filePath).href,
      anchor: anchor || null,
    });
    rebuildMenu();
    updateTitle(session);
  } catch (err) {
    dialog.showErrorBox('Folio — cannot open file', `${filePath}\n\n${err.message}`);
  }
}

async function doOpenFolder(session) {
  if (!(await confirmDiscardIfDirty(session))) return;
  const res = await dialog.showOpenDialog(session.win, {
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return;
  openFolder(session, res.filePaths[0], { openEntry: true });
}

// Scan a folder, push its tree to the renderer's file explorer, and optionally
// open its entry document. Dirty-check is the caller's responsibility.
function openFolder(session, dir, { openEntry } = {}) {
  const tree = scanFolder(dir);
  session.currentFolder = dir;
  store.set('folder', dir);
  store.set('filesVisible', true);
  invalidateSearchCache();
  resetHistory(session);
  send(session, 'open-folder', { root: dir, name: path.basename(dir) || dir, tree });
  if (openEntry) {
    const entry = entryDocFor(tree);
    if (entry) loadFile(session, entry);
  }
  rebuildMenu();
}

async function doOpen(session) {
  if (!(await confirmDiscardIfDirty(session))) return;
  const res = await dialog.showOpenDialog(session.win, {
    title: 'Open Markdown file',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return;
  loadFile(session, res.filePaths[0]);
}

async function doNew(session) {
  if (!(await confirmDiscardIfDirty(session))) return;
  session.currentPath = null;
  session.currentName = 'Untitled';
  setDirty(session, false);
  stopWatching(session);
  resetHistory(session);
  send(session, 'load-document', { path: null, content: '' });
  updateTitle(session);
  rebuildMenu();
}

// ---------------------------------------------------------------------------
// Main -> renderer request/response
//
// A few operations (save, export) need the renderer's current editor content or
// need it to switch out of source mode first. Rather than reach into the page
// with executeJavaScript() (which would run in the main world and bypass context
// isolation), we send a tokened request over `folio-request` and await the reply
// on `folio-response`. Each request is keyed to the owning window's webContents so
// replies can't cross wires between windows.
// ---------------------------------------------------------------------------
let nextRequestId = 1;
const pendingRequests = new Map(); // id -> { resolve, timer }

ipcMain.on('folio-response', (_e, { id, value } = {}) => {
  const entry = pendingRequests.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingRequests.delete(id);
  entry.resolve(value);
});

// Ask a session's renderer for something and await its reply. `kind` is
// 'content' (the current editor text) or 'prepare-export' (leave source mode,
// resolve true). Resolves to a fallback after a short timeout so a wedged
// renderer can't hang a save forever.
function ask(session, kind, { timeoutMs = 4000, fallback = null } = {}) {
  if (!session || session.win.isDestroyed()) return Promise.resolve(fallback);
  const id = nextRequestId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve(fallback);
    }, timeoutMs);
    pendingRequests.set(id, { resolve, timer });
    send(session, 'folio-request', { id, kind });
  });
}

async function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

// Save the session's document. Returns true only after a successful write, false
// on cancel or error, so callers (e.g. the unsaved-changes prompt) can tell
// whether it is safe to proceed.
async function doSave(session) {
  if (!session.currentPath) return doSaveAs(session);
  const content = await ask(session, 'content', { fallback: null });
  if (content == null) return false;
  try {
    await writeFile(session.currentPath, content);
    try {
      session.lastMtimeMs = fs.statSync(session.currentPath).mtimeMs;
    } catch (_) {
      /* ignore */
    }
    store.addRecent(session.currentPath);
    setDirty(session, false);
    send(session, 'saved');
    rebuildMenu();
    return true;
  } catch (err) {
    dialog.showErrorBox('Folio — cannot save file', `${session.currentPath}\n\n${err.message}`);
    return false;
  }
}

async function doSaveAs(session) {
  const res = await dialog.showSaveDialog(session.win, {
    title: 'Save Markdown file',
    defaultPath: session.currentPath || `${session.currentName || 'Untitled'}.md`,
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePath) return false;
  const content = await ask(session, 'content', { fallback: null });
  if (content == null) return false;
  try {
    await writeFile(res.filePath, content);
    session.currentPath = res.filePath;
    session.currentName = path.basename(res.filePath);
    store.addRecent(res.filePath);
    setDirty(session, false);
    watchCurrentFile(session);
    send(session, 'saved');
    send(session, 'document-path-changed', {
      path: res.filePath,
      baseUrl: pathToFileURL(res.filePath).href,
    });
    rebuildMenu();
    updateTitle(session);
    return true;
  } catch (err) {
    dialog.showErrorBox('Folio — cannot save file', `${res.filePath}\n\n${err.message}`);
    return false;
  }
}

function pageSizeForWidth() {
  return store.get('pageWidth') === 'letter' ? 'Letter' : 'A4';
}

async function doExportPDF(session) {
  if (!session || session.win.isDestroyed()) return;
  // Ensure the rendered preview is showing (not the source editor) before print.
  await ask(session, 'prepare-export', { fallback: true });

  const suggested = session.currentPath
    ? session.currentPath.replace(/\.[^.]+$/, '.pdf')
    : `${session.currentName || 'Untitled'}.pdf`;
  const res = await dialog.showSaveDialog(session.win, {
    title: 'Export to PDF',
    defaultPath: suggested,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return;

  try {
    const data = await session.win.webContents.printToPDF({
      pageSize: pageSizeForWidth(),
      printBackground: true,
      margins: { marginType: 'default' },
    });
    fs.writeFileSync(res.filePath, data);
  } catch (err) {
    dialog.showErrorBox('Folio — cannot export PDF', err.message);
  }
}

// ---------------------------------------------------------------------------
// Unsaved-changes prompts
// ---------------------------------------------------------------------------
async function promptUnsaved(session) {
  // Returns true if it is OK to proceed (close/replace the document).
  const { response } = await dialog.showMessageBox(session.win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Folio',
    message: 'Do you want to save the changes you made?',
    detail: "Your changes will be lost if you don't save them.",
  });
  if (response === 2) return false; // cancel
  if (response === 1) return true; // don't save
  // Save — only proceed if the write actually succeeded.
  return doSave(session);
}

async function confirmDiscardIfDirty(session) {
  if (!session.isDirty) return true;
  return promptUnsaved(session);
}

// ---------------------------------------------------------------------------
// About dialog
// ---------------------------------------------------------------------------
function showAbout(session) {
  dialog.showMessageBox(session ? session.win : undefined, {
    type: 'info',
    title: 'About Folio',
    message: `Folio ${app.getVersion()}`,
    detail:
      'A lightweight, themeable Markdown editor and viewer with a Typora-like look.\n\n' +
      'Folio is not affiliated with, endorsed by, or sponsored by the Typora team. ' +
      '"Typora" is a trademark of its respective owner and is referenced solely to ' +
      'describe theme compatibility.\n\n' +
      'Built with Electron, CodeMirror and markdown-it.',
    buttons: ['Close'],
    defaultId: 0,
    cancelId: 0,
  });
}

// ---------------------------------------------------------------------------
// IPC from renderer
// ---------------------------------------------------------------------------
ipcMain.handle('get-init', (event) => {
  const session = sessionFor(event.sender);
  let document = null;
  let folder = null;
  let filesVisible = false;

  const openAsDocument = (target) => {
    const content = fs.readFileSync(target, 'utf8');
    session.currentPath = target;
    session.currentName = path.basename(target);
    store.addRecent(target);
    setDirty(session, false);
    watchCurrentFile(session);
    rebuildMenu();
    updateTitle(session);
    return { path: target, content, name: session.currentName, baseUrl: pathToFileURL(target).href };
  };

  // If this window was launched pointing at a folder, start in file-explorer mode
  // and open that folder's entry document.
  if (session && session.pendingOpenFolder) {
    const dir = session.pendingOpenFolder;
    session.pendingOpenFolder = null;
    try {
      if (fs.statSync(dir).isDirectory()) {
        const tree = scanFolder(dir);
        folder = { root: dir, name: path.basename(dir) || dir, tree };
        session.currentFolder = dir;
        store.set('folder', dir);
        filesVisible = true;
        const entry = entryDocFor(tree);
        if (entry) {
          try {
            document = openAsDocument(entry);
          } catch (_) {
            /* fall through to welcome */
          }
        }
      }
    } catch (_) {
      /* folder was moved/deleted — ignore and fall back to welcome */
    }
  }

  // If this window was launched with a file path (CLI arg or macOS open-file),
  // open that file instead of the welcome document.
  if (!document && session && session.pendingOpenPath) {
    const target = session.pendingOpenPath;
    session.pendingOpenPath = null;
    try {
      document = openAsDocument(target);
    } catch (err) {
      dialog.showErrorBox('Folio — cannot open file', `${target}\n\n${err.message}`);
    }
  }

  if (!document) {
    let initialContent = '';
    let baseUrl = null;
    try {
      const welcomePath = builtinDocPath('welcome.md');
      initialContent = fs.readFileSync(welcomePath, 'utf8');
      baseUrl = pathToFileURL(welcomePath).href;
    } catch (_) {
      initialContent = '# Welcome to Folio\n\nCreate or open a Markdown file to get started.\n';
    }
    document = { path: null, content: initialContent, name: 'Welcome', baseUrl };
  }

  // Seed the back/forward history so a link click from the first document can be
  // walked back to it. Built-in/untitled docs (path null) start with empty history.
  if (session) resetHistory(session, document.path || null);

  return {
    themesBaseUrl: pathToFileURL(themesDir() + path.sep).href,
    themeFiles: composeThemeFiles(),
    settings: {
      sourceMode: store.get('sourceMode'),
      // Outline is never shown automatically on startup; the file explorer only
      // appears when Folio was launched pointing at a folder.
      outlineVisible: false,
      filesVisible,
      lineNumbers: store.get('lineNumbers'),
      zoom: store.get('zoom'),
    },
    folder,
    document,
  };
});

ipcMain.on('dirty-changed', (event, value) => {
  const session = sessionFor(event.sender);
  if (session) setDirty(session, value);
});

ipcMain.on('state-changed', (_e, state) => {
  if (typeof state.sourceMode === 'boolean') store.set('sourceMode', state.sourceMode);
  if (typeof state.outlineVisible === 'boolean') store.set('outlineVisible', state.outlineVisible);
  if (typeof state.filesVisible === 'boolean') store.set('filesVisible', state.filesVisible);
  if (typeof state.lineNumbers === 'boolean') {
    store.set('lineNumbers', state.lineNumbers);
    rebuildMenu(); // keep the View > Show Line Numbers checkbox in sync
  }
  if (typeof state.zoom === 'number') store.set('zoom', state.zoom);
});

ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// Content search across every markdown file in the sender window's open folder.
ipcMain.handle('search-files', (event, query) => {
  const session = sessionFor(event.sender);
  if (!session || !session.currentFolder) return { query, files: [], truncated: false };
  try {
    return searchInFolder(session.currentFolder, query);
  } catch (_) {
    return { query, files: [], truncated: false };
  }
});

// Extensions we refuse to hand to the OS shell from an in-document link: anything
// that would execute code or run a script interpreter if double-clicked.
const UNSAFE_OPEN_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif', '.cpl', '.ps1', '.psm1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.reg', '.lnk',
  '.sh', '.bash', '.zsh', '.py', '.rb', '.pl', '.app', '.command',
]);

// Open a non-markdown local target (e.g. a PDF or image linked from a doc) through
// the OS, but only after guarding against the obvious footguns: no UNC/remote
// paths, no executable/script types, and always an explicit confirmation showing
// the resolved absolute path so a malicious link can't silently launch anything.
async function openExternalTarget(session, target) {
  const win = session ? session.win : undefined;
  if (/^(\\\\|\/\/)/.test(target)) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Folio',
      message: 'Blocked opening a network location.',
      detail: `${target}\n\nFolio does not open UNC or remote paths from document links.`,
      buttons: ['OK'],
    });
    return;
  }
  if (UNSAFE_OPEN_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Folio',
      message: 'Blocked opening an executable or script.',
      detail: `${target}\n\nFor safety, Folio does not launch this type of file from a document link.`,
      buttons: ['OK'],
    });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Open external file?',
    message: 'Open this file with its default application?',
    detail: path.resolve(target),
    buttons: ['Open', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) shell.openPath(target);
}

// Navigation from the file explorer (a file click) or from an in-document link
// (relative path / folder). Honors unsaved changes before switching documents.
ipcMain.handle('navigate', async (event, payload) => {
  const session = sessionFor(event.sender);
  if (!session) return { ok: false };
  const target = resolveNavTarget(payload);
  if (!target) return { ok: false };
  switch (target.kind) {
    case 'markdown':
      if (!(await confirmDiscardIfDirty(session))) return { ok: false, canceled: true };
      loadFile(session, target.path, target.anchor);
      return { ok: true };
    case 'folder-empty':
      dialog.showMessageBox(session.win, {
        type: 'info',
        title: 'Folio',
        message: 'Nothing to display for this folder.',
        detail: `${target.path}\n\nAdd an _index.md (or README.md) to make the folder viewable.`,
        buttons: ['OK'],
      });
      return { ok: false };
    case 'external':
      await openExternalTarget(session, target.path);
      return { ok: false, external: true };
    case 'missing':
      dialog.showMessageBox(session.win, {
        type: 'warning',
        title: 'Folio',
        message: 'Cannot find the linked item.',
        detail: target.path,
        buttons: ['OK'],
      });
      return { ok: false };
    default:
      return { ok: false };
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A second launch (e.g. `folio some.md` while already running) opens the given
  // path in a NEW window rather than stealing the current one.
  app.on('second-instance', (_e, argv) => {
    const arg = pathArgFrom(argv);
    if (arg && arg.isDir) createWindow({ folder: arg.path });
    else if (arg) createWindow({ path: arg.path });
    else {
      const session = focusedSession();
      if (session) {
        if (session.win.isMinimized()) session.win.restore();
        session.win.focus();
      } else {
        createWindow();
      }
    }
  });

  // macOS: files opened via Finder / `open` arrive through this event, which
  // can fire before the app is ready.
  let pendingLaunchTarget = null;
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    if (app.isReady()) {
      createWindow({ path: filePath });
    } else {
      pendingLaunchTarget = { path: filePath };
    }
  });

  // Windows/Linux: a file or folder path passed on the command line at launch.
  const launchArg = pathArgFrom(process.argv);
  if (launchArg && launchArg.isDir) pendingLaunchTarget = { folder: launchArg.path };
  else if (launchArg) pendingLaunchTarget = { path: launchArg.path };

  app.whenReady().then(() => {
    createWindow(pendingLaunchTarget);
    pendingLaunchTarget = null;
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
