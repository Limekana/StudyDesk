// Preload for the glance widget window.
//
// The widget is frameless, so it has no system close button and the renderer
// has to ask for one. With contextIsolation and sandbox on — which both stay
// on — the renderer cannot reach Electron directly, so this exposes exactly
// one verb over contextBridge and nothing else.
//
// Deliberately not a general IPC surface: the widget is read-only, and the
// smallest possible bridge is the one least likely to become a way for page
// content to drive the main process later.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studydeskWidget', {
  close: () => ipcRenderer.send('widget:close'),
});
