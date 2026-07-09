const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
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

const REPO_URL = 'https://github.com/dpokluda/Folio';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function themesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'themes')
    : path.join(__dirname, '..', 'themes');
}

function samplePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'samples', 'welcome.md')
    : path.join(__dirname, '..', 'samples', 'welcome.md');
}

// Window/taskbar icon. On Windows the packaged app uses the icon embedded in
// the .exe by electron-builder; setting it here mainly gives `npm start` (dev)
// and Linux a proper icon. Returns undefined if the asset is missing.
function appIconPath() {
  const base = path.join(__dirname, '..', 'build', 'icons');
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const p = path.join(base, file);
  return fs.existsSync(p) ? p : undefined;
}

function listThemes() {
  try {
    return fs
      .readdirSync(themesDir(), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.css'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.error('[folio] cannot read themes dir:', err);
    return [];
  }
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
}

function persistWindowBounds() {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getSize();
  store.set('window', { width, height });
}

function updateTitle() {
  if (!mainWindow) return;
  const base = currentPath ? path.basename(currentPath) : currentName || 'Untitled';
  mainWindow.setTitle(`${isDirty ? '\u2022 ' : ''}${base} — Folio`);
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
    themes: listThemes(),
    activeTheme: store.get('theme'),
    recentFiles: store.get('recentFiles') || [],
    actions,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const actions = {
  open: () => doOpen(),
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
  zoomIn: () => send('command', { name: 'zoom-in' }),
  zoomOut: () => send('command', { name: 'zoom-out' }),
  zoomReset: () => send('command', { name: 'zoom-reset' }),
  find: () => send('command', { name: 'find' }),
  setTheme: (themeFile) => {
    store.set('theme', themeFile);
    send('set-theme', themeFile);
    rebuildMenu();
  },
  about: () => showAbout(),
  openRepo: () => shell.openExternal(REPO_URL),
};

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------
async function loadFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    currentPath = filePath;
    currentName = path.basename(filePath);
    store.addRecent(filePath);
    setDirty(false);
    send('load-document', { path: filePath, content });
    rebuildMenu();
    updateTitle();
  } catch (err) {
    dialog.showErrorBox('Folio — cannot open file', `${filePath}\n\n${err.message}`);
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
    send('document-path-changed', { path: res.filePath });
    rebuildMenu();
    updateTitle();
    return true;
  } catch (err) {
    dialog.showErrorBox('Folio — cannot save file', `${res.filePath}\n\n${err.message}`);
    return false;
  }
}

function pageSizeForTheme() {
  const theme = (store.get('theme') || '').toLowerCase();
  if (theme.includes('letter')) return 'Letter';
  return 'A4'; // a4, dynamic, and base all print nicely on A4
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
      pageSize: pageSizeForTheme(),
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
  let initialContent = '';
  try {
    initialContent = fs.readFileSync(samplePath(), 'utf8');
  } catch (_) {
    initialContent = '# Welcome to Folio\n\nCreate or open a Markdown file to get started.\n';
  }
  return {
    themesBaseUrl: pathToFileURL(themesDir() + path.sep).href,
    themes: listThemes(),
    theme: store.get('theme'),
    settings: {
      sourceMode: store.get('sourceMode'),
      outlineVisible: store.get('outlineVisible'),
      zoom: store.get('zoom'),
    },
    document: { path: null, content: initialContent, name: 'Welcome' },
  };
});

ipcMain.on('dirty-changed', (_e, value) => setDirty(value));

ipcMain.on('state-changed', (_e, state) => {
  if (typeof state.sourceMode === 'boolean') store.set('sourceMode', state.sourceMode);
  if (typeof state.outlineVisible === 'boolean') store.set('outlineVisible', state.outlineVisible);
  if (typeof state.zoom === 'number') store.set('zoom', state.zoom);
});

ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
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
      const fileArg = argv.find((a) => /\.(md|markdown|mdown|mkd|txt)$/i.test(a));
      if (fileArg && fs.existsSync(fileArg)) loadFile(fileArg);
    }
  });

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
