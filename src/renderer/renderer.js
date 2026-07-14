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
};

let editor = null;
const editableCompartment = new Compartment();

// DOM
const $write = document.getElementById('write');
const $preview = document.getElementById('folio-preview');
const $source = document.getElementById('typora-source');
const $outline = document.getElementById('folio-outline');
const $outlineList = document.getElementById('folio-outline-list');
const $stats = document.getElementById('folio-stats');
const $btnOutline = document.getElementById('btn-outline');
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
  // Open external links in the OS browser rather than navigating the window.
  $write.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.folioAPI.openExternal(href);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------
function slugify(text, index) {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
  return base ? `${base}-${index}` : `heading-${index}`;
}

function buildOutline() {
  const headings = $write.querySelectorAll('h1, h2, h3, h4, h5, h6');
  $outlineList.innerHTML = '';
  headings.forEach((h, i) => {
    if (!h.id) h.id = slugify(h.textContent || '', i);
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
  window.folioAPI.setDirty(false);

  if (state.sourceMode) {
    if (!editor) createEditor(state.docText);
    else setEditorText(state.docText);
    requestAnimationFrame(() => editor && editor.requestMeasure());
    updateStats();
  } else {
    renderPreview();
  }
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

  // Load initial document (rendered preview first).
  loadDocument(init.document || { path: null, content: '' });

  // Honour a persisted source-mode preference.
  if (s.sourceMode) setSourceMode(true);

  // Wire status-bar buttons.
  $btnSource.addEventListener('click', () => setSourceMode(!state.sourceMode));
  $btnOutline.addEventListener('click', () => setOutlineVisible(!state.outlineVisible));

  // Wire main -> renderer events.
  window.folioAPI.onCommand((payload) => handleCommand(payload && payload.name));
  window.folioAPI.onLoadDocument((doc) => loadDocument(doc));
  window.folioAPI.onSetTheme((themeFile) => applyTheme(themeFile));
  window.folioAPI.onSaved(() => markSaved());
  window.folioAPI.onDocumentPathChanged((info) => {
    state.path = info && info.path;
    if (info && info.baseUrl) state.baseUrl = info.baseUrl;
    if (!state.sourceMode) renderPreview();
  });
}

boot().catch((err) => {
  document.getElementById('write').innerHTML =
    `<h1>Folio failed to start</h1><pre>${String(err && err.stack ? err.stack : err)}</pre>`;
  console.error(err);
});
