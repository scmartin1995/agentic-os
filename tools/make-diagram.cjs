// Draws docs/img/architecture.png from docs/img/architecture.svg (a picture for viewers that do not draw SVG or diagram code).
// Run: node_modules\.bin\electron tools\make-diagram.cjs --disable-gpu
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.disableHardwareAcceleration();
const svgFile = path.join(__dirname, '..', 'docs', 'img', 'architecture.svg');
app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgFile, 'utf8');
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}svg{display:block;width:1280px;height:800px}</style>${svg}`;
  const w = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 1200));
  const img = await w.webContents.capturePage();
  const out = path.join(__dirname, '..', 'docs', 'img', 'architecture.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out, img.getSize().width + 'x' + img.getSize().height);
  app.quit();
});
