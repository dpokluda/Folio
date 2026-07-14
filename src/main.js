const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { buildMenu } = require('./menu');

const store = new Store();

let mainWindow = null;
let currentPath = null; // absolute path of the open file, or null for an untitled doc
let currentName = 'Welcome'; // display name when untitled
let isDirty = false;
let forceClose = false;
let pendingOpenPath = null; // file to open once the renderer is ready (startup / macOS open-file)
let currentFolder = null; // root of the open folder (file-explorer mode), or null
let pendingOpenFolder = null; // folder to open in explorer mode once the renderer is ready (startup)

const REPO_URL = 'https://github.com/dpokluda/Folio';

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
const { isMarkdownFile, scanFolder, entryDocFor, resolveNavTarget } = require('./folder');

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
// stylesheets (base foundation → family overlay → width overlay). Appearance
// (light/dark) is handled separately by flipping Chromium's prefers-color-
// scheme through Electron's nativeTheme, which activates the dark palettes the
// theme stylesheets already carry behind @media (prefers-color-scheme: dark).
// ---------------------------------------------------------------------------
const STYLE_FAMILIES = ['fluent', 'github', 'word'];
const APPEARANCES = ['light', 'dark'];
const PAGE_WIDTHS = ['dynamic', 'a4', 'letter'];

function familyLayers(family) {
  switch (family) {
    case 'github':
      return ['fluent.css', 'github.css'];
    case 'word':
      return ['fluent.css', 'microsoft-word/word-type.css'];
    case 'fluent':
    default:
      return ['fluent.css'];
  }
}

function widthLayer(family, width) {
  if (family === 'word') {
    const map = {
      a4: 'microsoft-word/word-page-a4.css',
      letter: 'microsoft-word/word-page-letter.css',
      dynamic: 'microsoft-word/word-page-dynamic.css',
    };
    return map[width] || map.dynamic;
  }
  const map = {
    a4: 'fluent-a4.css',
    letter: 'fluent-us-letter.css',
    dynamic: 'fluent-dynamic.css',
  };
  return map[width] || map.dynamic;
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
function createWindow() {
  const win = store.get('window') || { width: 1100, height: 820 };
  mainWindow = new BrowserWindow({
    width: win.width,
    height: win.height,
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

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (forceClose || !isDirty) {
      persistWindowBounds();
      return;
    }
    e.preventDefault();
    promptUnsaved().then((proceed) => {
      if (proceed) {
        forceClose = true;
        mainWindow.close();
      }
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  rebuildMenu();
  updateTitle();
  applyAppearance();
}

function persistWindowBounds() {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getSize();
  store.set('window', { width, height });
}

function updateTitle() {
  if (!mainWindow) return;
  const base = currentPath ? path.basename(currentPath) : currentName || 'Untitled';
  mainWindow.setTitle(`${isDirty ? '\u2022 ' : ''}${base} - Folio`);
}

function setDirty(value) {
  isDirty = !!value;
  updateTitle();
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function rebuildMenu() {
  const template = buildMenu({
    isMac: process.platform === 'darwin',
    styleFamily: store.get('styleFamily'),
    appearance: store.get('appearance'),
    pageWidth: store.get('pageWidth'),
    recentFiles: store.get('recentFiles') || [],
    actions,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Push the composed theme stack to the renderer.
function pushTheme() {
  send('set-theme', { files: composeThemeFiles() });
}

const actions = {
  open: () => doOpen(),
  openFolder: () => doOpenFolder(),
  openRecent: (p) => loadFile(p),
  clearRecent: () => {
    store.clearRecent();
    rebuildMenu();
  },
  save: () => doSave(),
  saveAs: () => doSaveAs(),
  exportPDF: () => doExportPDF(),
  newFile: () => doNew(),
  toggleSource: () => send('command', { name: 'toggle-source' }),
  toggleOutline: () => send('command', { name: 'toggle-outline' }),
  toggleFiles: () => send('command', { name: 'toggle-files' }),
  zoomIn: () => send('command', { name: 'zoom-in' }),
  zoomOut: () => send('command', { name: 'zoom-out' }),
  zoomReset: () => send('command', { name: 'zoom-reset' }),
  find: () => send('command', { name: 'find' }),
  setStyleFamily: (family) => {
    store.set('styleFamily', family);
    pushTheme();
    rebuildMenu();
  },
  setAppearance: (appearance) => {
    store.set('appearance', appearance);
    applyAppearance();
    rebuildMenu();
  },
  setPageWidth: (width) => {
    store.set('pageWidth', width);
    pushTheme();
    rebuildMenu();
  },
  about: () => showAbout(),
  openRepo: () => shell.openExternal(REPO_URL),
  openWelcome: () => openBuiltinDoc('welcome'),
  openFormattingTour: () => openBuiltinDoc('formatting-tour'),
};

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
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

// Open a folder requested from outside the app (CLI arg on a running instance),
// honoring unsaved changes first.
async function openExternalFolder(dir) {
  if (!(await confirmDiscardIfDirty())) return;
  openFolder(dir, { openEntry: true });
}
// or macOS Finder "open-file"), honoring unsaved changes first.
async function openExternalPath(filePath) {
  if (!(await confirmDiscardIfDirty())) return;
  loadFile(filePath);
}

// Open a bundled document (welcome / formatting tour) as an untitled buffer, so
// it can be read and edited but Save won't overwrite the shipped copy.
async function openBuiltinDoc(key) {
  const doc = BUILTIN_DOCS[key];
  if (!doc) return;
  if (!(await confirmDiscardIfDirty())) return;
  let content;
  try {
    content = fs.readFileSync(builtinDocPath(doc.file), 'utf8');
  } catch (err) {
    dialog.showErrorBox('Folio', `Cannot open ${doc.name}.\n\n${err.message}`);
    return;
  }
  currentPath = null;
  currentName = doc.name;
  setDirty(false);
  send('load-document', { path: null, content, name: doc.name });
  updateTitle();
}

async function loadFile(filePath, anchor = null) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    currentPath = filePath;
    currentName = path.basename(filePath);
    store.addRecent(filePath);
    setDirty(false);
    send('load-document', {
      path: filePath,
      content,
      baseUrl: pathToFileURL(filePath).href,
      anchor: anchor || null,
    });
    rebuildMenu();
    updateTitle();
  } catch (err) {
    dialog.showErrorBox('Folio — cannot open file', `${filePath}\n\n${err.message}`);
  }
}

async function doOpenFolder() {
  if (!(await confirmDiscardIfDirty())) return;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return;
  openFolder(res.filePaths[0], { openEntry: true });
}

// Scan a folder, push its tree to the renderer's file explorer, and optionally
// open its entry document. Dirty-check is the caller's responsibility.
function openFolder(dir, { openEntry } = {}) {
  const tree = scanFolder(dir);
  currentFolder = dir;
  store.set('folder', dir);
  store.set('filesVisible', true);
  send('open-folder', { root: dir, name: path.basename(dir) || dir, tree });
  if (openEntry) {
    const entry = entryDocFor(tree);
    if (entry) loadFile(entry);
  }
}

async function doOpen() {
  if (!(await confirmDiscardIfDirty())) return;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Markdown file',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return;
  loadFile(res.filePaths[0]);
}

async function doNew() {
  if (!(await confirmDiscardIfDirty())) return;
  currentPath = null;
  currentName = 'Untitled';
  setDirty(false);
  send('load-document', { path: null, content: '' });
  updateTitle();
}

async function getEditorContent() {
  if (!mainWindow) return '';
  return mainWindow.webContents.executeJavaScript('window.folio.getContent()');
}

async function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

async function doSave() {
  if (!currentPath) return doSaveAs();
  const content = await getEditorContent();
  try {
    await writeFile(currentPath, content);
    store.addRecent(currentPath);
    setDirty(false);
    send('saved');
    rebuildMenu();
  } catch (err) {
    dialog.showErrorBox('Folio — cannot save file', `${currentPath}\n\n${err.message}`);
  }
}

async function doSaveAs() {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Markdown file',
    defaultPath: currentPath || `${currentName || 'Untitled'}.md`,
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePath) return false;
  const content = await getEditorContent();
  try {
    await writeFile(res.filePath, content);
    currentPath = res.filePath;
    currentName = path.basename(res.filePath);
    store.addRecent(res.filePath);
    setDirty(false);
    send('saved');
    send('document-path-changed', { path: res.filePath, baseUrl: pathToFileURL(res.filePath).href });
    rebuildMenu();
    updateTitle();
    return true;
  } catch (err) {
    dialog.showErrorBox('Folio — cannot save file', `${res.filePath}\n\n${err.message}`);
    return false;
  }
}

function pageSizeForWidth() {
  return store.get('pageWidth') === 'letter' ? 'Letter' : 'A4';
}

async function doExportPDF() {
  if (!mainWindow) return;
  // Ensure the rendered preview is showing (not the source editor) before print.
  await mainWindow.webContents.executeJavaScript('window.folio.prepareForExport()');

  const suggested = currentPath
    ? currentPath.replace(/\.[^.]+$/, '.pdf')
    : `${currentName || 'Untitled'}.pdf`;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export to PDF',
    defaultPath: suggested,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return;

  try {
    const data = await mainWindow.webContents.printToPDF({
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
async function promptUnsaved() {
  // Returns true if it is OK to proceed (close/replace the document).
  const { response } = await dialog.showMessageBox(mainWindow, {
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
  // Save
  if (!currentPath) {
    return doSaveAs();
  }
  await doSave();
  return true;
}

async function confirmDiscardIfDirty() {
  if (!isDirty) return true;
  return promptUnsaved();
}

// ---------------------------------------------------------------------------
// About dialog
// ---------------------------------------------------------------------------
function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About Folio',
    message: `Folio ${app.getVersion()}`,
    detail:
      'A lightweight, themeable Markdown editor & viewer with a Typora-like look.\n\n' +
      'Folio is not affiliated with, endorsed by, or sponsored by the Typora team. ' +
      '"Typora" is a trademark of its respective owner and is referenced solely to ' +
      'describe theme compatibility.\n\n' +
      'Built with Electron, CodeMirror and markdown-it.\n' +
      REPO_URL,
    buttons: ['Open GitHub', 'Close'],
    defaultId: 1,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) shell.openExternal(REPO_URL);
  });
}

// ---------------------------------------------------------------------------
// IPC from renderer
// ---------------------------------------------------------------------------
ipcMain.handle('get-init', () => {
  let document = null;
  let folder = null;
  let filesVisible = false;

  const openAsDocument = (target) => {
    const content = fs.readFileSync(target, 'utf8');
    currentPath = target;
    currentName = path.basename(target);
    store.addRecent(target);
    setDirty(false);
    rebuildMenu();
    updateTitle();
    return { path: target, content, name: currentName, baseUrl: pathToFileURL(target).href };
  };

  // If Folio was launched pointing at a folder, start in file-explorer mode and
  // open that folder's entry document.
  if (pendingOpenFolder) {
    const dir = pendingOpenFolder;
    pendingOpenFolder = null;
    try {
      if (fs.statSync(dir).isDirectory()) {
        const tree = scanFolder(dir);
        folder = { root: dir, name: path.basename(dir) || dir, tree };
        currentFolder = dir;
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

  // If Folio was launched with a file path (CLI arg or macOS open-file), open
  // that file instead of the welcome document.
  if (!document && pendingOpenPath) {
    const target = pendingOpenPath;
    pendingOpenPath = null;
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

  return {
    themesBaseUrl: pathToFileURL(themesDir() + path.sep).href,
    themeFiles: composeThemeFiles(),
    settings: {
      sourceMode: store.get('sourceMode'),
      // Outline is never shown automatically on startup; the file explorer only
      // appears when Folio was launched pointing at a folder.
      outlineVisible: false,
      filesVisible,
      zoom: store.get('zoom'),
    },
    folder,
    document,
  };
});

ipcMain.on('dirty-changed', (_e, value) => setDirty(value));

ipcMain.on('state-changed', (_e, state) => {
  if (typeof state.sourceMode === 'boolean') store.set('sourceMode', state.sourceMode);
  if (typeof state.outlineVisible === 'boolean') store.set('outlineVisible', state.outlineVisible);
  if (typeof state.filesVisible === 'boolean') store.set('filesVisible', state.filesVisible);
  if (typeof state.zoom === 'number') store.set('zoom', state.zoom);
});

ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// Navigation from the file explorer (a file click) or from an in-document link
// (relative path / folder). Honors unsaved changes before switching documents.
ipcMain.handle('navigate', async (_e, payload) => {
  const target = resolveNavTarget(payload);
  if (!target) return { ok: false };
  switch (target.kind) {
    case 'markdown':
      if (!(await confirmDiscardIfDirty())) return { ok: false, canceled: true };
      loadFile(target.path, target.anchor);
      return { ok: true };
    case 'folder-empty':
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Folio',
        message: 'Nothing to display for this folder.',
        detail: `${target.path}\n\nAdd an _index.md (or README.md) to make the folder viewable.`,
        buttons: ['OK'],
      });
      return { ok: false };
    case 'external':
      shell.openPath(target.path);
      return { ok: false, external: true };
    case 'missing':
      dialog.showMessageBox(mainWindow, {
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
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const arg = pathArgFrom(argv);
      if (arg && arg.isDir) openExternalFolder(arg.path);
      else if (arg) openExternalPath(arg.path);
    }
  });

  // macOS: files opened via Finder / `open` arrive through this event, which
  // can fire before the app is ready.
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    if (mainWindow) {
      openExternalPath(filePath);
    } else {
      pendingOpenPath = filePath;
    }
  });

  // Windows/Linux: a file or folder path passed on the command line at launch.
  const launchArg = pathArgFrom(process.argv);
  if (launchArg && launchArg.isDir) pendingOpenFolder = launchArg.path;
  else if (launchArg) pendingOpenPath = launchArg.path;

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
