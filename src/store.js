// Tiny JSON-file settings store in Electron's userData dir.
// Avoids an extra native/ESM dependency (electron-store is ESM-only in v9+).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Three-axis theming: a Style family, an Appearance, and a Page width are
  // composed at runtime into a stack of theme stylesheets.
  styleFamily: 'fluent', // 'fluent' | 'github' | 'word'
  appearance: 'light', // 'light' | 'dark'
  pageWidth: 'dynamic', // 'dynamic' | 'a4' | 'letter'
  recentFiles: [],
  window: { width: 1100, height: 820 },
  sourceMode: false,
  outlineVisible: false,
  zoom: 0,
};

const MAX_RECENT = 10;

// Map a legacy single-file `theme` setting (e.g. "microsoft-word-a4.css") onto
// the new three-axis model, so users upgrading keep a sensible selection.
function migrateLegacyTheme(parsed) {
  if (!parsed || parsed.styleFamily || typeof parsed.theme !== 'string') return null;
  const t = parsed.theme.toLowerCase();
  const styleFamily = t.includes('word') ? 'word' : t.includes('github') ? 'github' : 'fluent';
  const pageWidth = t.includes('letter') ? 'letter' : t.includes('a4') ? 'a4' : 'dynamic';
  return { styleFamily, appearance: 'light', pageWidth };
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'folio-settings.json');
    this.data = { ...DEFAULTS };
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        const migrated = migrateLegacyTheme(parsed);
        this.data = { ...DEFAULTS, ...parsed, ...(migrated || {}) };
        this.data.window = { ...DEFAULTS.window, ...(parsed.window || {}) };
        delete this.data.theme; // drop the obsolete key
        if (migrated) this._flush(); // persist the one-time migration
      }
    } catch (err) {
      console.error('[folio] failed to read settings, using defaults:', err);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._flush();
  }

  addRecent(filePath) {
    if (!filePath) return;
    const list = (this.data.recentFiles || []).filter((p) => p !== filePath);
    list.unshift(filePath);
    this.data.recentFiles = list.slice(0, MAX_RECENT);
    this._flush();
  }

  clearRecent() {
    this.data.recentFiles = [];
    this._flush();
  }

  _flush() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[folio] failed to persist settings:', err);
    }
  }
}

module.exports = { Store };
