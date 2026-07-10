'use strict';
/**
 * Impresión de tickets de turno en impresoras térmicas ESC/POS por red
 * (RAW TCP puerto 9100). Probado contra Epson TM-T20IVL: papel 80 mm,
 * ancho imprimible 72 mm @ 203 dpi = 576 puntos, corte automático.
 * Sin dependencias: incluye un decodificador PNG mínimo para el logo.
 */
const net = require('net');
const os = require('os');
const zlib = require('zlib');

const ANCHO_DOTS = 576; // TM-T20IVL: 72 mm imprimibles a 203 dpi

// ---------- Decodificador PNG mínimo (para el logo) ----------
// Soporta PNG 8 bits, tipos de color 0 (gris), 2 (RGB), 4 (gris+alfa), 6 (RGBA),
// sin entrelazado. Devuelve { ancho, alto, gris: Uint8Array } (0=negro, 255=blanco).
function decodificarPng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504E47) {
    throw new Error('El logo no es un PNG válido');
  }
  let pos = 8;
  let ancho = 0, alto = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const tipo = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.slice(pos + 8, pos + 8 + len);
    if (tipo === 'IHDR') {
      ancho = data.readUInt32BE(0);
      alto = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (tipo === 'IDAT') {
      idat.push(data);
    } else if (tipo === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('El logo debe ser PNG de 8 bits por canal');
  if (interlace !== 0) throw new Error('El logo no debe usar entrelazado (interlace)');
  const canales = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!canales) throw new Error('Tipo de color PNG no soportado (usa RGB o RGBA)');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ancho * canales;
  const gris = new Uint8Array(ancho * alto);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < alto; y++) {
    const filtro = raw[y * (stride + 1)];
    const fila = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    // Desfiltrado PNG (None/Sub/Up/Average/Paeth)
    for (let x = 0; x < stride; x++) {
      const a = x >= canales ? fila[x - canales] : 0;
      const b = prev[x];
      const c = x >= canales ? prev[x - canales] : 0;
      let v = fila[x];
      if (filtro === 1) v = (v + a) & 0xFF;
      else if (filtro === 2) v = (v + b) & 0xFF;
      else if (filtro === 3) v = (v + ((a + b) >> 1)) & 0xFF;
      else if (filtro === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xFF;
      }
      fila[x] = v;
    }
    prev.set(fila);
    for (let x = 0; x < ancho; x++) {
      const o = x * canales;
      let g, alfa = 255;
      if (colorType === 0) g = fila[o];
      else if (colorType === 4) { g = fila[o]; alfa = fila[o + 1]; }
      else {
        g = Math.round(0.299 * fila[o] + 0.587 * fila[o + 1] + 0.114 * fila[o + 2]);
        if (colorType === 6) alfa = fila[o + 3];
      }
      // Fondo blanco para píxeles transparentes
      gris[y * ancho + x] = alfa < 128 ? 255 : g;
    }
  }
  return { ancho, alto, gris };
}

/** Convierte el logo PNG a un raster ESC/POS (GS v 0) centrado, máx. 384 puntos de ancho. */
function rasterLogo(pngBase64) {
  const { ancho, alto, gris } = decodificarPng(Buffer.from(pngBase64, 'base64'));
  const maxAncho = 384;
  const escala = Math.min(1, maxAncho / ancho);
  const w = Math.max(1, Math.round(ancho * escala));
  const h = Math.max(1, Math.round(alto * escala));
  const bytesFila = Math.ceil(w / 8);
  const data = Buffer.alloc(bytesFila * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(ancho - 1, Math.floor(x / escala));
      const sy = Math.min(alto - 1, Math.floor(y / escala));
      if (gris[sy * ancho + sx] < 140) { // umbral: oscuro = imprimir
        data[y * bytesFila + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x1D, 0x76, 0x30, 0x00, bytesFila & 0xFF, bytesFila >> 8, h & 0xFF, h >> 8]),
    data,
  ]);
}

// ---------- Constructor del ticket ----------
const ESC = 0x1B, GS = 0x1D;
const cmd = (...b) => Buffer.from(b);
// Los tickets térmicos usan CP437/CP850: se transliteran las tildes para
// imprimir igual en cualquier impresora sin pelear con code pages.
function texto(s) {
  const limpio = String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[ñ]/g, 'n').replace(/[Ñ]/g, 'N');
  return Buffer.from(limpio + '\n', 'ascii');
}

function comandoQr(contenido) {
  const datos = Buffer.from(contenido, 'ascii');
  const len = datos.length + 3;
  return Buffer.concat([
    cmd(GS, 0x28, 0x6B, 4, 0, 49, 65, 50, 0),                 // modelo 2
    cmd(GS, 0x28, 0x6B, 3, 0, 49, 67, 6),                      // tamaño de módulo 6
    cmd(GS, 0x28, 0x6B, 3, 0, 49, 69, 49),                     // corrección M
    cmd(GS, 0x28, 0x6B, len & 0xFF, len >> 8, 49, 80, 48), datos, // almacenar
    cmd(GS, 0x28, 0x6B, 3, 0, 49, 81, 48),                     // imprimir
  ]);
}

/**
 * Construye el ticket ESC/POS del turno según las opciones de personalización.
 * opciones: { mostrar_logo, mostrar_nombre, mostrar_fecha, mostrar_pin, mostrar_qr, mensaje_pie }
 */
function construirTicket({ turno, nombreCentro, opciones, logoBase64 }) {
  const partes = [];
  partes.push(cmd(ESC, 0x40));       // init
  partes.push(cmd(ESC, 0x61, 1));    // centrado

  if (opciones.mostrar_logo && logoBase64) {
    try {
      partes.push(rasterLogo(logoBase64));
      partes.push(texto(''));
    } catch (e) { /* logo inválido: se imprime sin él */ }
  }
  if (opciones.mostrar_nombre !== false) {
    partes.push(cmd(ESC, 0x45, 1)); // negrita
    partes.push(texto(nombreCentro || 'Dispensario'));
    partes.push(cmd(ESC, 0x45, 0));
    partes.push(texto('------------------------------'));
  }
  partes.push(texto('SU TURNO ES'));
  partes.push(cmd(GS, 0x21, 0x33)); // número gigante: 4x de ancho y alto
  partes.push(texto(String(turno.numero).padStart(3, '0')));
  partes.push(cmd(GS, 0x21, 0x00)); // tamaño normal

  if (opciones.mostrar_fecha !== false) {
    const f = new Date(turno.timestamp || Date.now());
    partes.push(texto(f.toLocaleDateString('es-CO') + ' ' +
      f.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })));
  }
  if (opciones.mostrar_pin !== false && turno.codigo_pin) {
    partes.push(texto('PIN: ' + turno.codigo_pin));
  }
  if (opciones.mostrar_qr !== false && turno.qr_code) {
    partes.push(texto(''));
    partes.push(comandoQr(turno.qr_code));
  }
  if (opciones.mensaje_pie) {
    partes.push(texto(''));
    partes.push(texto(opciones.mensaje_pie));
  }
  partes.push(texto('\n'));
  partes.push(cmd(GS, 0x56, 66, 3)); // avance + corte parcial automático
  return Buffer.concat(partes);
}

/** Envía bytes crudos a la impresora de red (RAW 9100). */
function enviarAImpresora({ ip, puerto = 9100, datos, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port: puerto });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`La impresora ${ip}:${puerto} no respondió en ${timeoutMs / 1000}s`));
    }, timeoutMs);
    socket.on('connect', () => {
      socket.end(datos, () => {
        clearTimeout(timer);
        resolve({ ok: true });
      });
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`No se pudo conectar con la impresora ${ip}:${puerto} (${e.code || e.message})`));
    });
  });
}

/** Busca impresoras RAW 9100 en la subred local /24 (conexión TCP rápida). */
async function buscarImpresoras({ timeoutMs = 500 } = {}) {
  let base = null;
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) { base = i.address; break; }
    }
    if (base) break;
  }
  if (!base) return [];
  const prefijo = base.split('.').slice(0, 3).join('.');
  const probar = (ip) => new Promise((resolve) => {
    const s = net.connect({ host: ip, port: 9100 });
    const timer = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    s.on('connect', () => { clearTimeout(timer); s.destroy(); resolve(ip); });
    s.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  const encontradas = [];
  // Lotes de 32 para no saturar la red
  for (let inicio = 1; inicio <= 254; inicio += 32) {
    const lote = [];
    for (let i = inicio; i < inicio + 32 && i <= 254; i++) {
      const ip = `${prefijo}.${i}`;
      if (ip !== base) lote.push(probar(ip));
    }
    for (const r of await Promise.all(lote)) if (r) encontradas.push(r);
  }
  return encontradas;
}

module.exports = { construirTicket, enviarAImpresora, buscarImpresoras };
