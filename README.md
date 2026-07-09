# Folio

**A lightweight, themeable Markdown editor & viewer with a Typora-like look — edit the
source, preview it rendered, swap CSS themes (Typora-theme compatible).**

Folio renders your Markdown into a paged, themed "sheet" (just like Typora), lets you flip
into a themed source-code editor, and switches the whole look — preview *and* editor — by
swapping a single CSS theme file.

![Folio screenshot placeholder](docs/screenshot.png)

> _Screenshot placeholder — add `docs/screenshot.png` (preview + source mode) here._

---

## Why Folio?

I own a valid Typora license, but it's limited to 3 machines and I use many more — work and
home desktops, several laptops, and cloud/remote boxes. Folio lets me **view and lightly
edit** my Markdown with the same familiar, paged, themeable look on all those extra
machines. It's meant to **complement Typora, not replace it**: same theming conventions, so
the CSS themes I already use "just work."

## Non-affiliation disclaimer

> Folio is **not affiliated with, endorsed by, or sponsored by the Typora team**. "Typora"
> is a trademark of its respective owner and is referenced here solely to describe theme
> compatibility.

---

## Features

- **Rendered preview** of GitHub-flavored Markdown injected into Typora's `#write`
  container, so Typora themes style it as a page/sheet.
- **Themed source-code editor** (CodeMirror 6) under `#typora-source`, so a selected theme
  styles the editor too — including the grey-bar-free source-mode background.
- **Typora-compatible theming**: pick any top-level `.css` file in the `themes/` folder from
  the **Themes** menu; the active theme is remembered.
- **Live features** via [markdown-it](https://github.com/markdown-it/markdown-it): tables,
  strikethrough, task lists, footnotes, autolinking, typographic replacements, and emoji.
- **Syntax highlighting** of fenced code blocks with
  [highlight.js](https://highlightjs.org/).
- **Document outline** sidebar generated from headings.
- **Status bar** (Typora-style) with mode-toggle buttons (Outline, Source/Exit Source) and
  live document stats: word, character and line counts plus an estimated reading time.
- **File handling**: Open, Open Recent, Save, Save As, and **Export to PDF** (via Electron's
  `printToPDF`, honoring the A4 / US Letter page themes).
- **Unsaved-changes tracking** with a title-bar indicator and a save prompt on open/close.
- **Zoom** in/out/reset, and **cross-platform** (macOS, Linux, Windows).

## How it works — the theming contract

Folio deliberately mirrors Typora's DOM so existing themes render faithfully:

- Rendered Markdown is injected inside an element with **`id="write"`** (themes style
  `#write` as the page).
- The source editor lives under **`#typora-source`** using CodeMirror 6, with a legacy
  `.CodeMirror` compatibility class so `#typora-source .CodeMirror*` theme rules apply.
- The body gets the class **`typora-sourceview-on`** in source mode (themes key the white
  source-mode background off this).
- Themes are switched by swapping a single stylesheet `<link href>`; `@import` chains,
  `@font-face`, and window-width `@media` breakpoints all work because the renderer is
  Chromium.

---

## How to build & run

**Prerequisites:** [Node.js LTS](https://nodejs.org/) (Node 18+; developed on Node 20/24).

```sh
# 1. Install dependencies
npm install

# 2. Run the app (builds the renderer bundle, then launches Electron)
npm start
```

`npm start` bundles the renderer with [esbuild](https://esbuild.github.io/) and launches
Electron. On first launch it opens a bundled `samples/welcome.md` demo document.

### Packaging

Folio packages with [electron-builder](https://www.electron.build/):

```sh
npm run dist          # package for the current platform
npm run dist:win      # Windows (NSIS installer)
npm run dist:mac      # macOS (DMG)
npm run dist:linux    # Linux (AppImage + deb)
```

Build artifacts are written to `release/`.

#### App icon

The app icon lives in `build/icons/` as an editable `icon.svg` (a light rounded
tile with a stylized **F** and a teal editor caret). The packaged `.ico`
(Windows), `.icns` (macOS), and `.png` (Linux) files are generated from it with:

```sh
npm run icons
```

(Requires the dev-only `sharp` and `png2icons` packages, installed by
`npm install`.) The generated files are committed, so this only needs re-running
when the SVG changes.

#### Windows packaging note

electron-builder downloads a `winCodeSign` bundle that contains macOS symlinks.
Extracting those symlinks on Windows normally requires Administrator rights or
**Developer Mode**, and without them the build fails with *"Cannot create
symbolic link : A required privilege is not held by the client."* This is an
electron-builder/Windows limitation, not a Folio bug.

Folio works around it automatically: `npm run dist` / `npm run dist:win` first
run `scripts/prepare-wincodesign.js`, which pre-extracts that bundle with
symlink creation disabled into electron-builder's cache — so no Administrator
rights or Developer Mode are needed. (The macOS symlinks are irrelevant to a
Windows build.)

---

## How to use

- **Open a file** — `File ▸ Open…` (`Ctrl/Cmd+O`). Recently opened files appear under
  `File ▸ Open Recent`.
- **Toggle source mode** — `View ▸ Toggle Source Code Mode` (`Ctrl/Cmd+/`), or the
  **`</>` Source** button in the status bar. The themed CodeMirror editor appears; toggle
  back (the button reads **Exit Source**) to re-render the preview.
- **Switch themes** — pick any theme from the **Themes** menu. Both the preview and the
  source editor restyle instantly; your choice is remembered.
- **Outline** — `View ▸ Toggle Outline` (`Ctrl/Cmd+Shift+O`), or the **Outline** button in
  the status bar, shows a headings sidebar.
- **Save** — `Ctrl/Cmd+S` (Save As: `Ctrl/Cmd+Shift+S`). An unsaved document shows a `•` in
  the title bar and prompts before you close or open another file.
- **Export to PDF** — `File ▸ Export to PDF…`. The page size follows the active theme (A4 vs
  US Letter).
- **Zoom** — `Ctrl/Cmd +` / `Ctrl/Cmd -` / `Ctrl/Cmd 0`.
- **Find** — `Ctrl/Cmd+F` (in source mode).

---

## Themes

Folio ships a `themes/` folder. The **Themes** menu lists **only the top-level `.css` files**
in that folder (non-recursive) — exactly like Typora. Subfolders such as `microsoft-word/`
(and its `fonts/`) are treated as **assets**, not selectable themes. Filenames are
title-cased for display (e.g. `fluent-a4.css` → "Fluent A4").

**Bundled themes** (a personal Typora setup):

| Theme file                     | Menu label                | Notes                              |
| ------------------------------ | ------------------------- | ---------------------------------- |
| `fluent.css`                   | Fluent                    | Base Fluent theme                  |
| `fluent-a4.css`                | Fluent A4                 | Fixed A4 "printed page"            |
| `fluent-us-letter.css`         | Fluent US Letter          | Fixed US Letter page               |
| `fluent-dynamic.css`           | Fluent Dynamic            | Width follows the window           |
| `microsoft-word-a4.css`        | Microsoft Word A4         | Word/Aptos look, A4 page           |
| `microsoft-word-us-letter.css` | Microsoft Word US Letter  | Word/Aptos look, US Letter         |
| `microsoft-word-dynamic.css`   | Microsoft Word Dynamic    | Word/Aptos look, dynamic width     |

The `microsoft-word/` subfolder holds the shared partials (`word-type.css`,
`word-page-*.css`) that those themes `@import`.

### Add your own Typora themes

Drop any Typora-style theme's `.css` file into `themes/` (put its assets in a subfolder if it
has any) and restart Folio — it will appear in the **Themes** menu. Because Folio honors the
Typora DOM contract (`#write`, `#typora-source .CodeMirror`, `typora-sourceview-on`), most
Typora themes work unchanged.

### ⚠️ A note about the Aptos fonts (Microsoft Word themes)

The Microsoft Word themes reference **Aptos** fonts. The `.ttf` files are **Microsoft Office
"cloud fonts"** and are **not redistributed** in this repository — they're excluded via
`.gitignore` (`themes/microsoft-word/fonts/*.ttf`).

To get the full Word look, supply your own Aptos fonts by copying these files into
`themes/microsoft-word/fonts/`:

```
Aptos-Regular.ttf        Aptos-Bold.ttf
Aptos-Italic.ttf         Aptos-BoldItalic.ttf
AptosDisplay-Regular.ttf AptosDisplay-Bold.ttf
```

On Windows with Office installed they typically live under
`C:\Users\<you>\AppData\Local\Microsoft\FontCache\4\CloudFonts\Aptos\`. Without them, the
Word themes fall back to **Segoe UI / Inter**.

> The **Fluent** themes look best with the free [Inter](https://github.com/rsms/inter) and
> [JetBrains Mono](https://www.jetbrains.com/lp/mono/) fonts installed, but degrade
> gracefully to system fonts.

---

## Project layout

```
src/
  main.js        Electron main process (window, menus, IPC, file I/O, PDF export)
  preload.js     contextBridge IPC surface
  menu.js        native application menu template
  store.js       settings persistence (JSON in userData)
  renderer/
    index.html   #write (preview) + #typora-source (editor) shells
    renderer.js  markdown-it render + CodeMirror 6 + theme swapping (bundled by esbuild)
    app.css      app chrome + CodeMirror→Typora compat + highlight.js token colors
themes/          Typora-compatible themes (top-level .css files are selectable)
samples/         welcome.md demo document
build.js         esbuild bundler for the renderer
```

## License

[MIT](LICENSE) © David Pokluda.

## Acknowledgements

- **Typora** — for the theming conventions (`#write`, `#typora-source`,
  `typora-sourceview-on`) this app deliberately mirrors for compatibility.
- **[Electron](https://www.electronjs.org/)** — cross-platform Chromium shell.
- **[CodeMirror 6](https://codemirror.net/)** — the source-code editor.
- **[markdown-it](https://github.com/markdown-it/markdown-it)** and its plugins — Markdown
  rendering.
- **[highlight.js](https://highlightjs.org/)** — fenced-code syntax highlighting.
- The **[Fluent](https://github.com/li3zhen1/Fluent-Typora)** theme, on which the bundled
  Fluent variants are based.
