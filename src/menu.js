// Builds the native application menu template.
const path = require('path');

// "fluent" -> "Fluent", "word" -> "Microsoft Word" — the Style family radio
// group uses explicit labels below.
function buildMenu({ isMac, styleFamily, appearance, pageWidth, recentFiles, hasFolder, hasFile, canGoBack, canGoForward, lineNumbers, actions }) {
  // macOS-only: install a `folio` shell wrapper into a PATH directory. The .app
  // bundle isn't on PATH, so this mirrors VS Code's "Install 'code' command".
  const shellCommandItems = isMac
    ? [
        { type: 'separator' },
        { label: "Install 'folio' Command in PATH…", click: () => actions.installShellCommand() },
      ]
    : [];
  const recentSubmenu =
    recentFiles && recentFiles.length
      ? [
          ...recentFiles.map((p) => ({
            label: path.basename(p),
            sublabel: p,
            click: () => actions.openRecent(p),
          })),
          { type: 'separator' },
          { label: 'Clear Recent', click: () => actions.clearRecent() },
        ]
      : [{ label: '(No recent files)', enabled: false }];

  // Themes: three orthogonal one-of choices — Style, Appearance, Page width.
  // Disabled header rows also break Electron's implicit radio grouping so each
  // block toggles independently.
  const themeSubmenu = [
    { label: 'Style', enabled: false },
    { label: 'Fluent', type: 'radio', checked: styleFamily === 'fluent', click: () => actions.setStyleFamily('fluent') },
    { label: 'GitHub', type: 'radio', checked: styleFamily === 'github', click: () => actions.setStyleFamily('github') },
    { label: 'Microsoft Word', type: 'radio', checked: styleFamily === 'word', click: () => actions.setStyleFamily('word') },
    { type: 'separator' },
    { label: 'Appearance', enabled: false },
    { label: 'Light', type: 'radio', checked: appearance !== 'dark', click: () => actions.setAppearance('light') },
    { label: 'Dark', type: 'radio', checked: appearance === 'dark', click: () => actions.setAppearance('dark') },
    { type: 'separator' },
    { label: 'Page Width', enabled: false },
    { label: 'Dynamic', type: 'radio', checked: pageWidth === 'dynamic', click: () => actions.setPageWidth('dynamic') },
    { label: 'A4', type: 'radio', checked: pageWidth === 'a4', click: () => actions.setPageWidth('a4') },
    { label: 'US Letter', type: 'radio', checked: pageWidth === 'letter', click: () => actions.setPageWidth('letter') },
  ];

  const template = [];

  if (isMac) {
    template.push({
      label: 'Folio',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => actions.newFile() },
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => actions.newWindow() },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => actions.open() },
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => actions.openFolder() },
      { label: 'Close Folder', accelerator: 'CmdOrCtrl+Shift+W', enabled: !!hasFolder, click: () => actions.closeFolder() },
      { label: 'Open Recent', submenu: recentSubmenu },
      { type: 'separator' },
      { label: 'Reload from Disk', accelerator: 'CmdOrCtrl+R', enabled: !!hasFile, click: () => actions.reload() },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => actions.save() },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => actions.saveAs() },
      { type: 'separator' },
      { label: 'Copy File Path', accelerator: 'CmdOrCtrl+Shift+C', enabled: !!hasFile, click: () => actions.copyPath() },
      { type: 'separator' },
      { label: 'Export to PDF…', click: () => actions.exportPDF() },
      ...shellCommandItems,
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: 'Quit' },
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => actions.find() },
      { label: 'Find in Files…', accelerator: 'CmdOrCtrl+Shift+F', click: () => actions.findInFiles() },
    ],
  });

  template.push({
    label: 'Go',
    submenu: [
      {
        label: 'Back',
        accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
        enabled: !!canGoBack,
        click: () => actions.back(),
      },
      {
        label: 'Forward',
        accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
        enabled: !!canGoForward,
        click: () => actions.forward(),
      },
    ],
  });

  // The accelerators here are display-only (registerAccelerator: false): the
  // actual keyboard handling lives in the CodeMirror editor so the shortcuts
  // work uniformly and aren't swallowed by the browser's native Ctrl+B/I/U.
  // Clicking a menu item still routes through actions.format for mouse users.
  const fmt = (label, accel, kind) => ({
    label,
    accelerator: accel,
    registerAccelerator: false,
    click: () => actions.format(kind),
  });
  template.push({
    label: 'Format',
    submenu: [
      fmt('Bold', 'CmdOrCtrl+B', 'bold'),
      fmt('Italic', 'CmdOrCtrl+I', 'italic'),
      fmt('Underline', 'CmdOrCtrl+U', 'underline'),
      fmt('Strikethrough', 'CmdOrCtrl+Shift+X', 'strikethrough'),
      fmt('Inline Code', 'CmdOrCtrl+E', 'code'),
      fmt('Code Block', 'CmdOrCtrl+Shift+E', 'codeblock'),
      fmt('Link', 'CmdOrCtrl+K', 'link'),
      { type: 'separator' },
      fmt('Inline Math', 'CmdOrCtrl+M', 'math'),
      fmt('Math Block', 'CmdOrCtrl+Shift+M', 'mathblock'),
      { type: 'separator' },
      fmt('Heading 1', 'CmdOrCtrl+1', 'h1'),
      fmt('Heading 2', 'CmdOrCtrl+2', 'h2'),
      fmt('Heading 3', 'CmdOrCtrl+3', 'h3'),
      fmt('Heading 4', 'CmdOrCtrl+4', 'h4'),
      fmt('Heading 5', 'CmdOrCtrl+5', 'h5'),
      fmt('Heading 6', 'CmdOrCtrl+6', 'h6'),
    ],
  });

  // Chromium's Windows menu renderer prints Ctrl+Alt accelerators in a
  // non-standard "Alt+Ctrl+…" order. For Ctrl+Alt items we therefore bake the
  // correctly ordered text into the label (a `\t` right-aligns it like an
  // accelerator) and let the renderer handle the keystroke, so Windows/Linux
  // show the conventional "Ctrl+Alt+…". macOS renders glyphs correctly, so it
  // keeps the native accelerator.
  const ctrlAltItem = (label, letter, onClick) =>
    isMac
      ? { label, accelerator: `Cmd+Alt+${letter}`, click: onClick }
      : { label: `${label}\tCtrl+Alt+${letter}`, click: onClick };

  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Toggle Source Code Mode',
        accelerator: 'CmdOrCtrl+/',
        click: () => actions.toggleSource(),
      },
      ctrlAltItem('Toggle File Explorer', 'E', () => actions.toggleFiles()),
      ctrlAltItem('Toggle Outline', 'O', () => actions.toggleOutline()),
      {
        label: 'Show Line Numbers',
        type: 'checkbox',
        checked: !!lineNumbers,
        click: () => actions.toggleLineNumbers(),
      },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => actions.zoomIn() },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => actions.zoomOut() },
      { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => actions.zoomReset() },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ],
  });

  template.push({ label: 'Themes', submenu: themeSubmenu });

  template.push({
    role: 'help',
    label: 'Help',
    submenu: [
      { label: 'Welcome', click: () => actions.openWelcome() },
      { label: 'Markdown Formatting Tour', click: () => actions.openFormattingTour() },
      { type: 'separator' },
      { label: 'About Folio', click: () => actions.about() },
    ],
  });

  return template;
}

module.exports = { buildMenu };
