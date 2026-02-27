const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { registerIbkrIpcHandlers } = require('./ibkr-ipc');

const HOST = 'localhost';
const PORT = 5500;

let staticServer = null;
let mainWindow = null;

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
  };

  return types[ext] || 'application/octet-stream';
}

function resolveFilePath(requestUrl) {
  const normalizedPath = decodeURIComponent(requestUrl.split('?')[0]);
  const requested = normalizedPath === '/' ? '/index.html' : normalizedPath;
  const absolutePath = path.resolve(app.getAppPath(), `.${requested}`);
  const rootPath = path.resolve(app.getAppPath());

  if (!absolutePath.startsWith(rootPath)) {
    return null;
  }

  return absolutePath;
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const filePath = resolveFilePath(req.url || '/');
      if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (statErr, stats) => {
        if (statErr || !stats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }

        res.writeHead(200, { 'Content-Type': getContentType(filePath) });
        fs.createReadStream(filePath).pipe(res);
      });
    });

    server.on('error', err => {
      reject(err);
    });

    server.listen(PORT, HOST, () => {
      staticServer = server;
      resolve();
    });
  });
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 1024,
    minWidth: 900,
    minHeight: 760,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadURL(`http://${HOST}:${PORT}`);
  mainWindow = win;

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
}

async function bootstrap() {
  try {
    await startStaticServer();
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Unable to start QuickStrike',
      message: 'Failed to start local app server.',
      detail: `${err.message}\n\nPort ${PORT} is required for OAuth redirect compatibility.`,
    });
    app.quit();
    return;
  }

  registerIbkrIpcHandlers({
    ipcMain,
    getMainWindowProvider: () => mainWindow,
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (staticServer) {
    staticServer.close();
    staticServer = null;
  }
});
