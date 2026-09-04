import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from 'electron';

import { createRelayApp } from './relay-server.mjs';

let relay;
let mainWindow;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const config = relay.configStore.get();
  const localOrigin = `http://${config.listenHost}:${config.listenPort}`;
  mainWindow = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 620,
    minHeight: 520,
    title: 'NZB Relay',
    // The sidebar runs the full height of the window and reserves space for the
    // traffic lights, so the title bar itself is hidden.
    titleBarStyle: 'hiddenInset',
    // Matches the stylesheet's two grounds so the window does not flash the
    // wrong colour before the first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(localOrigin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(localOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', event => {
    if (process.platform === 'darwin' && !quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  await mainWindow.loadURL(localOrigin);
}

app.on('second-instance', createWindow);
app.on('activate', createWindow);
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', async event => {
  if (relay?.server.listening) {
    event.preventDefault();
    await relay.stop();
    relay = null;
    app.quit();
  }
});

app.whenReady().then(async () => {
  try {
    const secretCodec = safeStorage.isEncryptionAvailable()
      ? {
          encrypt: value => safeStorage.encryptString(value).toString('base64'),
          decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
        }
      : null;
    relay = await createRelayApp({
      dataDirectory: app.getPath('userData'),
      secretCodec,
      openNzbDirectory: directory => shell.openPath(directory)
    });
    await relay.start();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox('NZB Relay could not start', error.message);
    app.quit();
  }
});
