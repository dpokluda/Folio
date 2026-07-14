// Builds the native application menu template.
const path = require('path');

// "fluent" -> "Fluent", "word" -> "Microsoft Word" — the Style family radio
// group uses explicit labels below.
function buildMenu({ isMac, styleFamily, appearance, pageWidth, recentFiles, actions }) {
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
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => actions.open() },
      { label: 'Open Recent', submenu: recentSubmenu },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => actions.save() },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => actions.saveAs() },
      { type: 'separator' },
      { label: 'Export to PDF…', click: () => actions.exportPDF() },
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
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Toggle Source Code Mode',
        accelerator: 'CmdOrCtrl+/',
        click: () => actions.toggleSource(),
      },
      {
        label: 'Toggle Outline',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: () => actions.toggleOutline(),
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
      { label: 'Folio on GitHub', click: () => actions.openRepo() },
    ],
  });

  return template;
}

module.exports = { buildMenu };
