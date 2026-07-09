// Builds the native application menu template.
const path = require('path');

// "fluent-a4.css" -> "Fluent A4" ; "microsoft-word-us-letter.css" -> "Microsoft Word US Letter"
function titleCaseTheme(filename) {
  const base = filename.replace(/\.css$/i, '');
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (['A4', 'US', 'PDF'].includes(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function buildMenu({ isMac, themes, activeTheme, recentFiles, actions }) {
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

  const themeSubmenu = themes.length
    ? themes.map((file) => ({
        label: titleCaseTheme(file),
        type: 'radio',
        checked: file === activeTheme,
        click: () => actions.setTheme(file),
      }))
    : [{ label: '(No themes found)', enabled: false }];

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

module.exports = { buildMenu, titleCaseTheme };
