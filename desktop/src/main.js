'use strict';
const path = require('path');
const { app, BrowserWindow, Menu, dialog } = require('electron');
const { crearServidor } = require('./server');

const PUERTO = Number(process.env.DISPENSARIO_PUERTO) || 3000;
let servidor = null;

async function iniciar() {
  const dbPath = path.join(app.getPath('userData'), 'dispensario.db');
  try {
    servidor = await crearServidor({ dbPath, puerto: PUERTO });
  } catch (e) {
    dialog.showErrorBox('Turnos Dispensario',
      `No se pudo iniciar el servidor en el puerto ${PUERTO}.\n\n${e.message}\n\n` +
      '¿Hay otra instancia abierta? Cierre la otra aplicación o defina la variable DISPENSARIO_PUERTO.');
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    title: 'Turnos Dispensario — Panel de Administración',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
  });
  win.loadURL(`http://127.0.0.1:${PUERTO}/admin.html`);
}

Menu.setApplicationMenu(null);
app.whenReady().then(iniciar);

app.on('window-all-closed', () => {
  if (servidor) servidor.close();
  app.quit();
});
