// Dots — self-updating home-screen widget for iPhone (Scriptable).
//
// Paste this file into Scriptable ONCE, named "Dots". You never need to
// paste it again: on every widget refresh it downloads the latest widget
// code (widget/dots-widget.js) and your countdowns (widget/countdowns.json)
// from GitHub Pages. Edit countdowns.json on GitHub and the widget follows.
//
// Widget Parameter: the countdown's name (e.g. Exam prep), its number in
// countdowns.json (1 = first), or leave it empty for the first one.
//
// Offline, it uses the last downloaded copy.

const BASE = 'https://menujai99-ai.github.io/sss/';
const CACHE_DIR = 'dots-cache';

// Keep the cache next to this script so importModule can find it.
const fm = module.filename.includes('/Mobile Documents/') ? FileManager.iCloud() : FileManager.local();
const scriptDir = module.filename.slice(0, module.filename.lastIndexOf('/'));
const cacheDir = fm.joinPath(scriptDir, CACHE_DIR);
if (!fm.fileExists(cacheDir)) fm.createDirectory(cacheDir, true);
const codePath = fm.joinPath(cacheDir, 'dots-widget.js');
const dataPath = fm.joinPath(cacheDir, 'countdowns.json');

/** Download a file from GitHub Pages, skipping its 10-minute HTTP cache. */
async function download(path) {
  const req = new Request(`${BASE}${path}?t=${Date.now()}`);
  req.timeoutInterval = 15;
  const text = await req.loadString();
  const status = req.response && req.response.statusCode;
  if (status !== 200) throw new Error(`HTTP ${status} for ${path}`);
  return text;
}

async function readCached(path) {
  if (!fm.fileExists(path)) return null;
  if (fm.isFileStoredIniCloud(path)) await fm.downloadFileFromiCloud(path);
  return fm.readString(path);
}

// 1. Refresh the cache (failures just keep the previous copy).
try {
  const code = await download('widget/dots-widget.js');
  if (code.includes('module.exports')) fm.writeString(codePath, code);
} catch (e) {
  console.log(`Using cached widget code: ${e}`);
}
try {
  const data = await download('widget/countdowns.json');
  JSON.parse(data); // only cache valid JSON
  fm.writeString(dataPath, data);
} catch (e) {
  console.log(`Using cached countdowns: ${e}`);
}

// 2. Run the widget code with the countdowns.
if (!(await readCached(codePath))) {
  const w = new ListWidget();
  w.addText('Dots').font = Font.boldSystemFont(14);
  w.addSpacer(4);
  const t = w.addText('Connect to the internet once so the widget can load from GitHub.');
  t.font = Font.systemFont(11);
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentSmall();
  Script.complete();
} else {
  let countdowns = [];
  try {
    countdowns = JSON.parse((await readCached(dataPath)) || '[]');
  } catch (e) {
    console.log(`countdowns.json is not valid JSON: ${e}`);
  }
  globalThis.__DOTS_VIA_LOADER = true;
  const widget = importModule(`${CACHE_DIR}/dots-widget`);
  await widget.main({ countdowns, param: args.widgetParameter });
}
