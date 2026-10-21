// Windows desktop app: serves the bundled app/ folder over a private app:// scheme (fully offline),
// makes page audio with the Kokoro voice, and saves pages into one Thendral folder (Google Drive if present).
const { app, BrowserWindow, protocol, net, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const root = path.join(__dirname, '..', 'app');
const modelDir = app.isPackaged
  ? path.join(process.resourcesPath, 'kokoro')
  : path.join(__dirname, '..', 'models', 'kokoro-int8-en-v0_19');

// ---------- the Thendral folder ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
const writeConfig = (c) => fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));

function defaultFolder() {
  const home = os.homedir();
  const candidates = [
    'G:\\My Drive', 'H:\\My Drive', 'I:\\My Drive',
    path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'My Drive'), path.join(home, 'Google Drive'),
  ];
  const drive = candidates.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  return path.join(drive || app.getPath('documents'), 'Thendral');
}
const folder = () => readConfig().folder || defaultFolder();
const safeName = (s) => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';

// ---------- voice worker ----------
let worker = null;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'tts-worker.mjs'), {
    workerData: { modelDir, threads: Math.max(1, Math.min(4, os.cpus().length - 1)) },
  });
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') p.sender.send('thendral:progress', m);
    else if (m.type === 'done') { pending.delete(m.id); p.resolve({ mp3: new Uint8Array(m.mp3), timings: m.timings, duration: m.duration }); }
    else if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.message)); }
  });
  worker.on('error', (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); worker = null; });
  return worker;
}

ipcMain.handle('thendral:info', () => ({ folder: folder(), voiceReady: fs.existsSync(path.join(modelDir, 'model.int8.onnx')) }));

ipcMain.handle('thendral:make', (event, job) => new Promise((resolve, reject) => {
  pending.set(job.id, { resolve, reject, sender: event.sender });
  getWorker().postMessage(job);
}));

ipcMain.handle('thendral:save', (_e, b) => {
  // b: {book, base, mp3, photo, json}
  const dir = path.join(folder(), safeName(b.book || 'My pages'));
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(b.base);
  if (b.mp3) fs.writeFileSync(path.join(dir, base + '.mp3'), Buffer.from(b.mp3));
  if (b.photo) fs.writeFileSync(path.join(dir, base + '.jpg'), Buffer.from(b.photo));
  fs.writeFileSync(path.join(dir, base + '.thendral.json'), b.json);
  return { dir, base };
});

ipcMain.handle('thendral:chooseFolder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { title: 'Choose where to keep your Thendral folder', properties: ['openDirectory', 'createDirectory'], defaultPath: path.dirname(folder()) });
  if (r.canceled || !r.filePaths[0]) return { folder: folder() };
  const chosen = path.basename(r.filePaths[0]).toLowerCase() === 'thendral' ? r.filePaths[0] : path.join(r.filePaths[0], 'Thendral');
  writeConfig({ ...readConfig(), folder: chosen });
  return { folder: chosen };
});

ipcMain.handle('thendral:openFolder', (_e, sub) => {
  const dir = sub ? path.join(folder(), safeName(sub)) : folder();
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// ---------- window ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 880,
    minWidth: 420,
    title: 'Thendral Text-to-Speech',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadURL('app://local/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
