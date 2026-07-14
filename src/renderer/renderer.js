// Folio renderer: markdown-it preview into #write + CodeMirror 6 source editor
// under #typora-source, with Typora-compatible theme swapping.

import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import { full as emojiPlugin } from 'markdown-it-emoji';
import hljs from 'highlight.js';

import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from '@codemirror/search';

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        return `<pre class="md-fences hljs"><code class="hljs language-${lang}">${out}</code></pre>`;
      } catch (_) {
        /* fall through */
      }
    }
    return `<pre class="md-fences hljs"><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`;
  },
})
  .use(taskLists, { enabled: true })
  .use(footnote)
  .use(emojiPlugin);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  docText: '',
  savedText: '',
  path: null,
  sourceMode: false,
  outlineVisible: false,
  zoom: 0, // integer steps of 10%
  dirty: false,
  themesBaseUrl: '',
  themeFiles: [],
  baseUrl: null, // file:// URL of the open document, used to resolve relative assets
  folder: null, // { root, name } of the open folder, or null
  tree: [], // file-explorer tree nodes
  expanded: new Set(), // paths of expanded dirs
  filesVisible: false,
  pendingAnchor: null, // heading to scroll to after the next preview render
};

let editor = null;
const editableCompartment = new Compartment();

// DOM
const $write = document.getElementById('write');
const $preview = document.getElementById('folio-preview');
const $source = document.getElementById('typora-source');
const $outline = document.getElementById('folio-outline');
const $outlineList = document.getElementById('folio-outline-list');
const $files = document.getElementById('folio-files');
const $filesTree = document.getElementById('folio-files-tree');
const $filesTitle = document.getElementById('folio-files-title');
const $stats = document.getElementById('folio-stats');
const $btnOutline = document.getElementById('btn-outline');
const $btnFiles = document.getElementById('btn-files');
const $btnSource = document.getElementById('btn-source');
const $btnSourceLabel = document.getElementById('btn-source-label');

// ---------------------------------------------------------------------------
// CodeMirror editor
// ---------------------------------------------------------------------------
function createEditor(initialText) {
  const updateListener = EditorView.updateListener.of((v) => {
    if (v.docChanged && state.sourceMode) {
      state.docText = v.state.doc.toString();
      recomputeDirty();
      updateStats();
    }
  });

  const startState = EditorState.create({
    doc: initialText,
    extensions: [
      history(),
      drawSelection(),
      highlightSpecialChars(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.lineWrapping,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, codeLanguages: [] }),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      // Legacy compat class so themes' `#typora-source .CodeMirror` rules apply.
      EditorView.editorAttributes.of({ class: 'CodeMirror' }),
      editableCompartment.of(EditorView.editable.of(true)),
      updateListener,
    ],
  });

  editor = new EditorView({ state: startState, parent: $source });
}

function setEditorText(text) {
  if (!editor) return;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
  });
}

// ---------------------------------------------------------------------------
// Rendering / preview
// ---------------------------------------------------------------------------
function currentText() {
  return state.sourceMode && editor ? editor.state.doc.toString() : state.docText;
}

// ---------------------------------------------------------------------------
// YAML front matter
// ---------------------------------------------------------------------------
// A leading `--- ... ---` block would otherwise be mis-parsed (the closing
// `---` turns the metadata into a giant setext H1). Strip it and render it as
// a subtle metadata box, the way Typora shows document front matter.
function splitFrontMatter(text) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontMatter: null, body: text };
  return { frontMatter: m[1], body: text.slice(m[0].length) };
}

function renderFrontMatter(fm) {
  return `<pre class="md-front-matter">${md.utils.escapeHtml(fm)}</pre>`;
}

function renderPreview() {
  const { frontMatter, body } = splitFrontMatter(currentText() || '');
  let html = md.render(body);
  if (frontMatter != null) html = renderFrontMatter(frontMatter) + html;
  $write.innerHTML = html;
  resolveLocalAssets();
  wireLinks();
  buildOutline();
  updateStats();
}

// Rewrite relative asset URLs (e.g. `docs/folio.png`) so they resolve against
// the *opened document's* folder rather than the app's renderer directory.
// Without this, relative <img> paths 404 because the window is loaded from
// src/renderer/index.html. Absolute, remote (http/https), data:, blob:, and
// already-file: URLs are left untouched.
function resolveLocalAssets() {
  if (!state.baseUrl) return;
  $write.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    // Skip anchors and anything that already carries a URL scheme or is
    // protocol-relative (`//host/...`).
    if (!src || src.startsWith('#') || src.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
      return;
    }
    try {
      img.setAttribute('src', new URL(src, state.baseUrl).href);
    } catch (_) {
      /* leave the original src in place */
    }
  });
}

function wireLinks() {
  $write.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!href) return;
    if (/^(https?:|mailto:)/i.test(href)) {
      // External links open in the OS browser / mail client.
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.folioAPI.openExternal(href);
      });
      return;
    }
    if (href.startsWith('#')) {
      // In-page anchor: scroll within the current document.
      a.addEventListener('click', (e) => {
        e.preventDefault();
        scrollToAnchor(href.slice(1));
      });
      return;
    }
    // Relative / internal link (another doc or a folder). Let main resolve it
    // against the current document and navigate (with an unsaved-changes check).
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo({ href, fromPath: state.path });
    });
  });
}

// Ask main to open a target: either { path } (explorer click) or
// { href, fromPath } (in-document link). Main handles the dirty prompt and,
// on success, sends back a load-document that updates the view + explorer.
function navigateTo(payload) {
  Promise.resolve(window.folioAPI.navigate(payload)).catch((err) => console.error(err));
}

// GitHub-style heading slug so both the outline and `#anchor` links resolve to
// the same ids.
function githubSlug(text) {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function scrollToAnchor(rawId) {
  if (!rawId) return;
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch (_) {
    /* use raw */
  }
  const slug = githubSlug(id);
  let el = document.getElementById(id) || (slug && document.getElementById(slug));
  if (!el) {
    el = [...$write.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(
      (h) => githubSlug(h.textContent || '') === slug
    );
  }
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------
// Assign GitHub-style ids to headings (deduping collisions) so both the
// outline and in-document `#anchor` links resolve to the same targets.
function assignHeadingIds(headings) {
  const seen = Object.create(null);
  headings.forEach((h) => {
    if (h.id) return;
    let base = githubSlug(h.textContent || '') || 'section';
    let id = base;
    if (seen[base] != null) {
      seen[base] += 1;
      id = `${base}-${seen[base]}`;
    } else {
      seen[base] = 0;
    }
    h.id = id;
  });
}

function buildOutline() {
  const headings = $write.querySelectorAll('h1, h2, h3, h4, h5, h6');
  assignHeadingIds(headings);
  $outlineList.innerHTML = '';
  headings.forEach((h) => {
    const item = document.createElement('a');
    item.className = `outline-item outline-${h.tagName.toLowerCase()}`;
    item.textContent = h.textContent || '';
    item.href = `#${h.id}`;
    item.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $outlineList.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// File explorer (folder mode)
// ---------------------------------------------------------------------------
function normPath(p) {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePath(a, b) {
  return !!a && !!b && normPath(a) === normPath(b);
}

// Set (or clear) the open folder and render its tree. `show` controls whether
// the pane becomes visible (true for an explicit Open Folder, driven by the
// stored preference at boot).
function setFolder(payload, show) {
  if (!payload) {
    state.folder = null;
    state.tree = [];
    state.expanded = new Set();
  } else {
    state.folder = { root: payload.root, name: payload.name };
    state.tree = payload.tree || [];
    state.expanded = new Set();
    // Start collapsed; only expand the path down to the active file so it stays visible.
    expandAncestorsOf(state.path);
  }
  $filesTitle.textContent = state.folder ? state.folder.name : 'Files';
  renderFileTree();
  if (show != null) setFilesVisible(show);
}

function expandAncestorsOf(filePath) {
  if (!filePath) return;
  const target = normPath(filePath);
  const walk = (nodes) => {
    nodes.forEach((n) => {
      if (n.type === 'dir') {
        if (target.startsWith(normPath(n.path) + '/')) state.expanded.add(n.path);
        walk(n.children);
      }
    });
  };
  walk(state.tree);
}

function renderFileTree() {
  $filesTree.innerHTML = '';
  if (!state.tree.length) {
    const empty = document.createElement('div');
    empty.className = 'folio-files-empty';
    empty.textContent = state.folder ? 'No markdown files' : 'No folder open';
    $filesTree.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  state.tree.forEach((node) => frag.appendChild(renderTreeNode(node, 0)));
  $filesTree.appendChild(frag);
  const active = $filesTree.querySelector('.files-file.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function renderTreeNode(node, depth) {
  const indent = 8 + depth * 14;
  if (node.type === 'dir') {
    const wrap = document.createElement('div');
    const open = state.expanded.has(node.path);
    const row = document.createElement('div');
    row.className = 'files-row files-dir';
    row.style.paddingLeft = `${indent}px`;
    const twisty = document.createElement('span');
    twisty.className = 'files-twisty';
    twisty.textContent = open ? '\u25be' : '\u25b8'; // ▾ / ▸
    const ico = document.createElement('span');
    ico.className = 'files-ico';
    ico.textContent = open ? '\u{1f4c2}' : '\u{1f4c1}'; // open/closed folder
    const name = document.createElement('span');
    name.className = 'files-name';
    name.textContent = node.name;
    row.append(twisty, ico, name);
    row.addEventListener('click', () => {
      if (state.expanded.has(node.path)) state.expanded.delete(node.path);
      else state.expanded.add(node.path);
      renderFileTree();
    });
    wrap.appendChild(row);
    if (open) {
      node.children.forEach((c) => wrap.appendChild(renderTreeNode(c, depth + 1)));
    }
    return wrap;
  }
  // File
  const row = document.createElement('div');
  row.className = 'files-row files-file';
  if (samePath(node.path, state.path)) row.classList.add('active');
  row.style.paddingLeft = `${indent + 14}px`; // align past the folder twisty
  row.title = node.path;
  const ico = document.createElement('span');
  ico.className = 'files-ico';
  ico.textContent = '\u{1f4c4}'; // 📄
  const name = document.createElement('span');
  name.className = 'files-name';
  name.textContent = node.name;
  row.append(ico, name);
  row.addEventListener('click', () => navigateTo({ path: node.path }));
  return row;
}

// Keep the explorer highlight/expansion in sync with the active document.
function syncFileTree() {
  if (!state.tree.length) return;
  expandAncestorsOf(state.path);
  renderFileTree();
}

function setFilesVisible(on) {
  state.filesVisible = on;
  $files.hidden = !on;
  updateStatusButtons();
  persistState();
}

// ---------------------------------------------------------------------------
// Status bar: live document stats + mode-toggle buttons
// ---------------------------------------------------------------------------
function computeStats(text) {
  const t = text || '';
  const words = (t.match(/[^\s]+/g) || []).length;
  const chars = [...t].length;
  const lines = t.length ? t.split(/\r\n|\r|\n/).length : 0;
  const readMin = Math.max(1, Math.round(words / 200));
  return { words, chars, lines, readMin };
}

function updateStats() {
  const s = computeStats(currentText());
  const parts = [
    `${s.words.toLocaleString()} ${s.words === 1 ? 'word' : 'words'}`,
    `${s.chars.toLocaleString()} ${s.chars === 1 ? 'char' : 'chars'}`,
    `${s.lines.toLocaleString()} ${s.lines === 1 ? 'line' : 'lines'}`,
    `~${s.readMin} min read`,
  ];
  $stats.innerHTML = parts
    .map((p) => `<span class="folio-stat">${p}</span>`)
    .join('<span class="folio-stat-sep">·</span>');
}

function updateStatusButtons() {
  $btnSource.classList.toggle('active', state.sourceMode);
  $btnSourceLabel.textContent = state.sourceMode ? 'Exit Source' : 'Source';
  $btnSource.title = state.sourceMode
    ? 'Exit Source Code Mode (Ctrl/Cmd+/)'
    : 'Toggle Source Code Mode (Ctrl/Cmd+/)';
  $btnOutline.classList.toggle('active', state.outlineVisible);
  $btnFiles.classList.toggle('active', state.filesVisible);
}
function setSourceMode(on) {
  state.sourceMode = on;
  document.body.classList.toggle('typora-sourceview-on', on);

  if (on) {
    if (!editor) createEditor(state.docText);
    else setEditorText(state.docText);
    $preview.hidden = true;
    $source.hidden = false;
    // CM needs a measure once it becomes visible.
    requestAnimationFrame(() => {
      editor.requestMeasure();
      editor.focus();
    });
  } else {
    if (editor) state.docText = editor.state.doc.toString();
    $source.hidden = true;
    $preview.hidden = false;
    renderPreview();
  }
  updateStatusButtons();
  persistState();
}

function setOutlineVisible(on) {
  state.outlineVisible = on;
  $outline.hidden = !on;
  updateStatusButtons();
  persistState();
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
function applyZoom() {
  const factor = Math.max(0.5, Math.min(2.5, 1 + state.zoom * 0.1));
  document.getElementById('folio-root').style.zoom = String(factor);
}

function zoom(delta) {
  if (delta === 0) state.zoom = 0;
  else state.zoom = Math.max(-5, Math.min(15, state.zoom + delta));
  applyZoom();
  persistState();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
// The active theme is composed of an ordered stack of stylesheets (base
// foundation → family overlay → width overlay). They are mounted as <link>
// elements appended after app.css so the theme wins on shared selectors and
// later layers override earlier ones. Appearance (light/dark) is handled by
// the main process via nativeTheme, which the stylesheets react to through
// their @media (prefers-color-scheme: dark) blocks — no work needed here.
function applyTheme(payload) {
  const files = Array.isArray(payload) ? payload : payload && payload.files;
  if (!files || !files.length) return;
  state.themeFiles = files;

  document.querySelectorAll('link.folio-theme').forEach((l) => l.remove());
  for (const file of files) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.className = 'folio-theme';
    link.href = state.themesBaseUrl + file;
    document.head.appendChild(link);
  }
}

// ---------------------------------------------------------------------------
// Dirty tracking
// ---------------------------------------------------------------------------
function recomputeDirty() {
  const dirty = currentText() !== state.savedText;
  if (dirty !== state.dirty) {
    state.dirty = dirty;
    window.folioAPI.setDirty(dirty);
  }
}

function markSaved() {
  state.savedText = currentText();
  state.dirty = false;
  window.folioAPI.setDirty(false);
}

// ---------------------------------------------------------------------------
// Document loading
// ---------------------------------------------------------------------------
function loadDocument(doc) {
  state.path = doc.path || null;
  state.baseUrl = doc.baseUrl || null;
  state.docText = doc.content || '';
  state.savedText = state.docText;
  state.dirty = false;
  state.pendingAnchor = doc.anchor || null;
  window.folioAPI.setDirty(false);

  if (state.sourceMode) {
    if (!editor) createEditor(state.docText);
    else setEditorText(state.docText);
    requestAnimationFrame(() => editor && editor.requestMeasure());
    updateStats();
  } else {
    renderPreview();
    if (state.pendingAnchor) {
      const anchor = state.pendingAnchor;
      requestAnimationFrame(() => scrollToAnchor(anchor));
    }
  }
  state.pendingAnchor = null;
  syncFileTree();
  updateStatusButtons();
  $preview.scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function persistState() {
  window.folioAPI.setState({
    sourceMode: state.sourceMode,
    outlineVisible: state.outlineVisible,
    filesVisible: state.filesVisible,
    zoom: state.zoom,
  });
}

// ---------------------------------------------------------------------------
// Commands from the native menu
// ---------------------------------------------------------------------------
function handleCommand(name) {
  switch (name) {
    case 'toggle-source':
      setSourceMode(!state.sourceMode);
      break;
    case 'toggle-outline':
      setOutlineVisible(!state.outlineVisible);
      break;
    case 'toggle-files':
      setFilesVisible(!state.filesVisible);
      break;
    case 'zoom-in':
      zoom(1);
      break;
    case 'zoom-out':
      zoom(-1);
      break;
    case 'zoom-reset':
      zoom(0);
      break;
    case 'find':
      if (!state.sourceMode) setSourceMode(true);
      requestAnimationFrame(() => editor && openSearchPanel(editor));
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Bridge for the main process (executeJavaScript targets the main world)
// ---------------------------------------------------------------------------
window.folio = {
  getContent: () => currentText(),
  prepareForExport: () => {
    if (state.sourceMode) setSourceMode(false);
    return true;
  },
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const init = await window.folioAPI.getInit();
  state.themesBaseUrl = init.themesBaseUrl;

  applyTheme(init.themeFiles);

  const s = init.settings || {};
  state.zoom = typeof s.zoom === 'number' ? s.zoom : 0;
  applyZoom();
  setOutlineVisible(!!s.outlineVisible);

  // Restore a previously opened folder (explorer tree) before loading the doc,
  // so the initial document highlights correctly. Visibility follows the stored
  // preference.
  if (init.folder) {
    setFolder(init.folder, null);
  }
  setFilesVisible(!!s.filesVisible && !!state.folder);

  // Load initial document (rendered preview first).
  loadDocument(init.document || { path: null, content: '' });

  // Honour a persisted source-mode preference.
  if (s.sourceMode) setSourceMode(true);

  // Wire status-bar buttons.
  $btnSource.addEventListener('click', () => setSourceMode(!state.sourceMode));
  $btnOutline.addEventListener('click', () => setOutlineVisible(!state.outlineVisible));
  $btnFiles.addEventListener('click', () => setFilesVisible(!state.filesVisible));

  // Wire main -> renderer events.
  window.folioAPI.onCommand((payload) => handleCommand(payload && payload.name));
  window.folioAPI.onLoadDocument((doc) => loadDocument(doc));
  window.folioAPI.onOpenFolder((payload) => setFolder(payload, true));
  window.folioAPI.onSetTheme((themeFile) => applyTheme(themeFile));
  window.folioAPI.onSaved(() => markSaved());
  window.folioAPI.onDocumentPathChanged((info) => {
    state.path = info && info.path;
    if (info && info.baseUrl) state.baseUrl = info.baseUrl;
    if (!state.sourceMode) renderPreview();
    syncFileTree();
  });
}

boot().catch((err) => {
  document.getElementById('write').innerHTML =
    `<h1>Folio failed to start</h1><pre>${String(err && err.stack ? err.stack : err)}</pre>`;
  console.error(err);
});
