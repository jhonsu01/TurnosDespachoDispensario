'use strict';
/**
 * Genera los iconos de la app de escritorio sin dependencias externas:
 *  - desktop/build/icon.ico  (16/24/32/48/64/128/256 px, entradas PNG)
 *  - desktop/build/icon-256.png (para referencia/README)
 * Diseño: cruz médica blanca + píldora sobre fondo teal redondeado.
 * Idempotente: siempre produce el mismo resultado.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- Codificador PNG mínimo ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(tipo, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([len, cuerpo, crc]);
}

function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // filtro 0 por scanline
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Dibujo por SDF con antialiasing ----------
function sdfRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function cobertura(d) {
  // d < 0 dentro de la figura; suavizado de ~1px
  return Math.min(1, Math.max(0, 0.5 - d));
}

function pintar(rgba, w, i, r, g, b, alpha) {
  const o = i * 4;
  const a0 = rgba[o + 3] / 255;
  const a = alpha + a0 * (1 - alpha);
  if (a <= 0) return;
  rgba[o] = Math.round((r * alpha + rgba[o] * a0 * (1 - alpha)) / a);
  rgba[o + 1] = Math.round((g * alpha + rgba[o + 1] * a0 * (1 - alpha)) / a);
  rgba[o + 2] = Math.round((b * alpha + rgba[o + 2] * a0 * (1 - alpha)) / a);
  rgba[o + 3] = Math.round(a * 255);
}

function dibujarIcono(s) {
  const rgba = Buffer.alloc(s * s * 4); // transparente
  const c = s / 2;
  const esc = s / 108; // unidades del lienzo base 108x108
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = y * s + x;
      const px = x + 0.5, py = y + 0.5;
      // Fondo: cuadrado redondeado teal con leve degradado vertical
      const dFondo = sdfRoundRect(px, py, c, c, 50 * esc, 50 * esc, 24 * esc);
      const aFondo = cobertura(dFondo / esc) ;
      if (aFondo > 0) {
        const t = y / s;
        pintar(rgba, s, i, Math.round(14 + 8 * t), Math.round(116 - 30 * t), Math.round(144 - 27 * t), aFondo);
      }
      // Cruz médica blanca (barra vertical + horizontal, extremos redondeados)
      const dV = sdfRoundRect(px, py, c, c - 4 * esc, 11 * esc, 27 * esc, 8 * esc);
      const dH = sdfRoundRect(px, py, c, c - 4 * esc, 27 * esc, 11 * esc, 8 * esc);
      const dCruz = Math.min(dV, dH);
      const aCruz = cobertura(dCruz / esc);
      if (aCruz > 0) pintar(rgba, s, i, 255, 255, 255, aCruz);
      // Píldora acento (cápsula inclinada abajo a la derecha, mitad ámbar)
      const ang = -Math.PI / 5;
      const ox = px - (c + 22 * esc), oy = py - (c + 26 * esc);
      const rx = ox * Math.cos(ang) - oy * Math.sin(ang);
      const ry = ox * Math.sin(ang) + oy * Math.cos(ang);
      const dPil = sdfRoundRect(rx + c, ry + c, c, c, 14 * esc, 6.5 * esc, 6.5 * esc);
      const aPil = cobertura(dPil / esc);
      if (aPil > 0) {
        if (rx < 0) pintar(rgba, s, i, 250, 204, 21, aPil);   // mitad ámbar
        else pintar(rgba, s, i, 241, 245, 249, aPil);          // mitad clara
        // línea divisoria
        if (Math.abs(rx) < 0.9 * esc) pintar(rgba, s, i, 12, 74, 110, aPil * 0.9);
      }
    }
  }
  return rgba;
}

// ---------- Empaquetado ICO (entradas PNG) ----------
function empacarIco(tamanos) {
  const pngs = tamanos.map(s => ({ s, png: encodePng(dibujarIcono(s), s, s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // tipo icono
  header.writeUInt16LE(pngs.length, 4);
  const entradas = [];
  let offset = 6 + pngs.length * 16;
  for (const { s, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entradas.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entradas, ...pngs.map(p => p.png)]);
}

const raiz = path.join(__dirname, '..');
const dirBuild = path.join(raiz, 'desktop', 'build');
fs.mkdirSync(dirBuild, { recursive: true });

const TAMANOS = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(path.join(dirBuild, 'icon.ico'), empacarIco(TAMANOS));
fs.writeFileSync(path.join(dirBuild, 'icon-256.png'), encodePng(dibujarIcono(256), 256, 256));
console.log(`✓ icon.ico generado (${TAMANOS.join(', ')} px) en desktop/build/`);

// ---------- Mipmaps Android (fallback PNG para API < 26) ----------
const DENSIDADES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const dirRes = path.join(raiz, 'android', 'app', 'src', 'main', 'res');
for (const [dpi, tam] of Object.entries(DENSIDADES)) {
  const dir = path.join(dirRes, `mipmap-${dpi}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), encodePng(dibujarIcono(tam), tam, tam));
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), encodePng(dibujarIcono(tam), tam, tam));
}
console.log(`✓ mipmaps Android generados (${Object.keys(DENSIDADES).join(', ')})`);
