'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Puente mínimo para la pantalla de conexión manual (conectar.html)
contextBridge.exposeInMainWorld('asistente', {
  conectar: (ip, puerto) => ipcRenderer.invoke('conectar', ip, puerto),
  reintentarDescubrir: () => ipcRenderer.invoke('reintentar-descubrir'),
});
