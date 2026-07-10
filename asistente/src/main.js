'use strict';
/**
 * Dispensario Asistente: cliente de escritorio para los módulos de atención.
 * No tiene servidor propio: descubre el servidor del dispensario por UDP
 * (mismo protocolo que la app Android) y carga /asistente.html, que solo
 * permite asignar turnos y despachar (PIN de despachador, sin administración).
 */
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const http = require('http');
const { app, BrowserWindow, Menu, ipcMain } = require('electron');

const PUERTO_DISCOVERY = 18400;
let win = null;

const archivoConfig = () => path.join(app.getPath('userData'), 'servidor.json');

function leerServidorGuardado() {
  try {
    return JSON.parse(fs.readFileSync(archivoConfig(), 'utf8'));
  } catch (e) {
    return null;
  }
}

function guardarServidor(ip, puerto) {
  try {
    fs.writeFileSync(archivoConfig(), JSON.stringify({ ip, puerto }));
  } catch (e) { /* no crítico */ }
}

// Chromium desactiva la cámara (navigator.mediaDevices) en orígenes http que no
// sean localhost. El panel admin corre en 127.0.0.1 y no lo sufre, pero el
// asistente carga http://IP-del-servidor: se marca ese origen como seguro ANTES
// de que arranque Chromium. Si el servidor cambia, se guarda y se relanza una vez.
const servidorInicial = leerServidorGuardado();
let origenSeguro = servidorInicial ? `http://${servidorInicial.ip}:${servidorInicial.puerto}` : null;
if (origenSeguro) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', origenSeguro);
}

/** Carga la app del servidor; si su origen aún no está marcado como seguro, relanza. */
function cargarServidor(ip, puerto) {
  guardarServidor(ip, puerto);
  const origen = `http://${ip}:${puerto}`;
  if (origen !== origenSeguro) {
    app.relaunch();
    app.exit(0);
    return;
  }
  win.loadURL(`${origen}/asistente.html`);
}

/** Busca el servidor por broadcast UDP ("DISPENSARIO_DISCOVER" → puerto 18400). */
function descubrirServidor(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let cerrado = false;
    const reenvios = [];
    const terminar = (resultado) => {
      if (cerrado) return;
      cerrado = true;
      reenvios.forEach(clearTimeout);
      try { socket.close(); } catch (e) { /* ya cerrado */ }
      resolve(resultado);
    };
    const timer = setTimeout(() => terminar(null), timeoutMs);
    socket.on('message', (msg) => {
      try {
        const d = JSON.parse(msg.toString());
        if (d.tipo === 'DISPENSARIO_SERVER' && d.ip) {
          clearTimeout(timer);
          terminar({ ip: d.ip, puerto: d.puerto || 3000 });
        }
      } catch (e) { /* paquete ajeno */ }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      const datos = Buffer.from('DISPENSARIO_DISCOVER');
      // Los reenvíos verifican que el socket siga vivo (evita ERR_SOCKET_DGRAM_NOT_RUNNING)
      const enviar = () => {
        if (cerrado) return;
        try { socket.send(datos, PUERTO_DISCOVERY, '255.255.255.255', () => {}); } catch (e) { /* socket cerrado */ }
      };
      enviar();
      reenvios.push(setTimeout(enviar, 1200), setTimeout(enviar, 2400));
    });
    socket.on('error', () => { clearTimeout(timer); terminar(null); });
  });
}

/** Verifica que el servidor responda /api/ping. */
function probarServidor(ip, puerto) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port: puerto, path: '/api/ping', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function conectarYCargar() {
  // 1) Autodescubrimiento  2) último servidor usado  3) pantalla de conexión manual
  const candidatos = [];
  const descubierto = await descubrirServidor();
  if (descubierto) candidatos.push(descubierto);
  const guardado = leerServidorGuardado();
  if (guardado) candidatos.push(guardado);
  for (const c of candidatos) {
    if (await probarServidor(c.ip, c.puerto)) {
      cargarServidor(c.ip, c.puerto);
      return;
    }
  }
  win.loadFile(path.join(__dirname, 'conectar.html'));
}

// La pantalla de conexión manual valida la IP a través del proceso principal
ipcMain.handle('conectar', async (_ev, ip, puerto) => {
  const ok = await probarServidor(ip, puerto);
  if (ok) cargarServidor(ip, puerto);
  return ok;
});

ipcMain.handle('reintentar-descubrir', async () => {
  const d = await descubrirServidor();
  if (d && await probarServidor(d.ip, d.puerto)) {
    cargarServidor(d.ip, d.puerto);
    return true;
  }
  return false;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Dispensario Asistente',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Si el servidor se cae, volver a la pantalla de conexión en vez de quedarse en blanco
  win.webContents.on('did-fail-load', (_e, _code, _desc, url) => {
    if (url && url.includes('asistente.html')) {
      setTimeout(() => conectarYCargar(), 3000);
    }
  });
  conectarYCargar();
});

app.on('window-all-closed', () => app.quit());
