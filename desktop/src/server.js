'use strict';
/**
 * Servidor local: API REST + WebSocket + páginas admin/display/kiosko.
 * - Rutas de administración: solo conexiones desde localhost.
 * - Roles elevados de la app (despachador/admin/kiosko): token de dispositivo (header X-TOKEN).
 * - Rol paciente: sin token, se identifica con su documento.
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Db } = require('./db');
const { procesarFormula } = require('./ocr');
const { construirTicket, enviarAImpresora, buscarImpresoras } = require('./ticket');

const PUERTO_DISCOVERY = 18400;

const ESTADOS = ['CREADO', 'ESPERANDO', 'LLAMANDO', 'DESPACHO', 'ENTREGADO', 'FINALIZADO', 'NO_PRESENTADO'];
const TIPOS_DOC = ['CC', 'CE', 'NIT', 'PASAPORTE', 'TI'];

function ipLocal() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

function esLocalhost(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function enmascarar(doc) {
  if (!doc) return '';
  return doc.length <= 3 ? '***' : '*'.repeat(doc.length - 3) + doc.slice(-3);
}

async function crearServidor({ dbPath, puerto = 3000 }) {
  const db = await Db.open(dbPath);
  const app = express();
  app.use(express.json({ limit: '12mb' })); // las fórmulas llegan en base64

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcast(tipo, data = {}) {
    const msg = JSON.stringify({ type: tipo, ...data, ts: Date.now() });
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(msg);
    }
  }

  // ---- Seguridad: PINs de sesión + tokens de dispositivo ----
  const generarPin = () => String(Math.floor(100000 + Math.random() * 900000));
  const pinsSesion = { despachador: generarPin(), admin: generarPin(), kiosko: generarPin(), inventario: generarPin() };
  const regenerarPins = () => {
    for (const rol of Object.keys(pinsSesion)) pinsSesion[rol] = generarPin();
  };

  const dispositivoDe = (req) => db.dispositivoPorToken(req.get('X-TOKEN'));
  const soloAdmin = (req, res, next) => {
    if (!esLocalhost(req)) return res.status(403).json({ error: 'Solo disponible desde el equipo servidor' });
    next();
  };
  const conToken = (...roles) => (req, res, next) => {
    if (esLocalhost(req)) return next();
    const disp = dispositivoDe(req);
    if (disp && (disp.rol === 'admin' || roles.includes(disp.rol))) return next();
    return res.status(401).json({ error: 'Dispositivo no autorizado o acceso revocado' });
  };
  const esOperador = (req) => {
    if (esLocalhost(req)) return true;
    const disp = dispositivoDe(req);
    return !!disp && (disp.rol === 'admin' || disp.rol === 'despachador');
  };
  const actorDe = (req) => {
    if (esLocalhost(req)) return 'panel';
    const disp = dispositivoDe(req);
    return disp ? `${disp.rol}:${disp.nombre || disp.id}` : 'desconocido';
  };

  // ---- Páginas ----
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (_req, res) => res.redirect('/admin.html'));
  app.get('/admin', (_req, res) => res.redirect('/admin.html'));
  app.get('/display', (_req, res) => res.redirect('/display.html'));
  app.get('/kiosko', (_req, res) => res.redirect('/kiosko.html'));

  // ---- API ----
  app.get('/api/ping', (req, res) => {
    const disp = dispositivoDe(req);
    const rol = esLocalhost(req) ? 'admin' : (disp ? disp.rol : 'paciente');
    res.json({
      ok: true,
      nombre: db.getConfig('nombre_centro'),
      version: require('../package.json').version,
      rol,
    });
  });

  // Emparejamiento de roles elevados: PIN de sesión -> token persistente
  app.post('/api/emparejar', (req, res) => {
    const { rol, pin, nombre } = req.body || {};
    if (!['despachador', 'admin', 'kiosko', 'inventario'].includes(rol)) {
      return res.status(400).json({ error: 'rol debe ser despachador, admin, kiosko o inventario' });
    }
    if (String(pin) !== pinsSesion[rol]) {
      return res.status(401).json({ error: 'PIN de emparejamiento incorrecto para ese rol' });
    }
    const disp = db.crearDispositivo(rol, String(nombre || 'dispositivo').slice(0, 60));
    db.auditar('sistema', 'EMPAREJAR', `rol ${rol}: ${disp.nombre}`);
    broadcast('dispositivos_updated');
    res.status(201).json({
      token: disp.token,
      rol: disp.rol,
      nombre_centro: db.getConfig('nombre_centro'),
    });
  });

  // Configuración pública de las pantallas (marquesina, módulos, ticket)
  app.get('/api/display', (_req, res) => {
    res.json({
      nombre_centro: db.getConfig('nombre_centro'),
      marquesina_velocidad: Number(db.getConfig('marquesina_velocidad')) || 45,
      marquesina_mensaje: db.getConfig('marquesina_mensaje') || '',
      num_modulos: Number(db.getConfig('num_modulos')) || 3,
      ticket_disponible: !!db.getConfig('impresora_ip'),
    });
  });

  // ---- Ticket térmico (Epson TM-T20IVL / ESC-POS por red, RAW 9100) ----
  // Imprime el ticket del turno. Lo usa el kiosko de autoservicio (sin token:
  // solo funciona dentro de la red local y queda auditado).
  app.post('/api/tickets/:turno_id', async (req, res) => {
    const t = db.turnoCompleto(Number(req.params.turno_id));
    if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
    const ip = db.getConfig('impresora_ip');
    if (!ip) return res.status(400).json({ error: 'No hay impresora configurada. Búscala desde el kiosko (⚙) o en el panel.' });
    let opciones = {};
    try { opciones = JSON.parse(db.getConfig('ticket_opciones') || '{}'); } catch (e) {}
    try {
      const datos = construirTicket({
        turno: t,
        nombreCentro: db.getConfig('nombre_centro'),
        opciones,
        logoBase64: db.getConfig('ticket_logo') || '',
      });
      await enviarAImpresora({ ip, puerto: Number(db.getConfig('impresora_puerto')) || 9100, datos });
      db.auditar('kiosko', 'TICKET_IMPRESO', `turno ${t.numero} en ${ip}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Busca impresoras RAW 9100 en la subred local (tarda unos segundos)
  app.post('/api/impresoras/buscar', async (_req, res) => {
    try {
      res.json({ impresoras: await buscarImpresoras() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Consulta y selección de la impresora enlazada (kiosko o panel)
  app.get('/api/impresora', (_req, res) => {
    res.json({
      ip: db.getConfig('impresora_ip') || '',
      puerto: Number(db.getConfig('impresora_puerto')) || 9100,
    });
  });

  app.put('/api/impresora', (req, res) => {
    const { ip, puerto } = req.body || {};
    if (ip !== undefined) db.setConfig('impresora_ip', String(ip).trim());
    if (Number(puerto) > 0) db.setConfig('impresora_puerto', Number(puerto));
    db.auditar(actorDe(req), 'IMPRESORA_CONFIG', `${ip}:${puerto || 9100}`);
    broadcast('config_updated');
    res.json({ ip: db.getConfig('impresora_ip'), puerto: Number(db.getConfig('impresora_puerto')) || 9100 });
  });

  // ---- Medicamentos ----
  app.get('/api/medicamentos', (_req, res) => res.json(db.getMedicamentos()));

  app.post('/api/medicamentos', conToken('inventario'), (req, res) => {
    const { codigo, nombre, principio_activo, concentracion, presentacion, laboratorio } = req.body || {};
    if (!codigo || !nombre || !concentracion || !presentacion) {
      return res.status(400).json({ error: 'codigo, nombre, concentracion y presentacion son obligatorios' });
    }
    try {
      const m = db.crearMedicamento({
        codigo: String(codigo).trim(),
        nombre: String(nombre).trim(),
        principio_activo: String(principio_activo || nombre).trim(),
        concentracion: String(concentracion).trim(),
        presentacion: String(presentacion).trim(),
        laboratorio: String(laboratorio || '').trim(),
      });
      db.auditar(actorDe(req), 'MEDICAMENTO_CREAR', `${m.codigo} ${m.nombre}`);
      broadcast('inventario_updated');
      res.status(201).json(m);
    } catch (e) {
      res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'Ya existe un medicamento con ese código' : e.message });
    }
  });

  app.put('/api/medicamentos/:id', conToken('inventario'), (req, res) => {
    const m = db.updateMedicamento(Number(req.params.id), req.body || {});
    if (!m) return res.status(400).json({ error: 'Nada que actualizar o medicamento inexistente' });
    broadcast('inventario_updated');
    res.json(m);
  });

  app.delete('/api/medicamentos/:id', conToken(), (req, res) => {
    const r = db.eliminarMedicamento(Number(req.params.id));
    db.auditar(actorDe(req), 'MEDICAMENTO_ELIMINAR', `id ${req.params.id}`);
    broadcast('inventario_updated');
    res.json(r);
  });

  // ---- Inventario (lotes) ----
  app.get('/api/inventario', conToken('despachador', 'inventario'), (_req, res) => res.json(db.getInventario()));

  app.post('/api/inventario', conToken('inventario'), (req, res) => {
    const { medicamento_id, lote, cantidad, fecha_vencimiento } = req.body || {};
    if (!medicamento_id || !lote || !(Number(cantidad) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha_vencimiento))) {
      return res.status(400).json({ error: 'medicamento_id, lote, cantidad (>0) y fecha_vencimiento (YYYY-MM-DD) son obligatorios' });
    }
    const l = db.crearLote({
      medicamento_id: Number(medicamento_id),
      lote: String(lote).trim(),
      cantidad: Number(cantidad),
      fecha_vencimiento: String(fecha_vencimiento),
    });
    db.auditar(actorDe(req), 'INVENTARIO_ENTRADA', `lote ${l.lote} x${l.cantidad} (med ${medicamento_id})`);
    broadcast('inventario_updated');
    res.status(201).json(l);
  });

  app.put('/api/inventario/:id', conToken('inventario'), (req, res) => {
    const cantidad = Number((req.body || {}).cantidad);
    if (!(cantidad >= 0)) return res.status(400).json({ error: 'cantidad debe ser un número >= 0' });
    const l = db.ajustarLote(Number(req.params.id), cantidad);
    if (!l) return res.status(404).json({ error: 'Lote no encontrado' });
    db.auditar(actorDe(req), 'INVENTARIO_AJUSTE', `lote id ${req.params.id} -> ${cantidad}`);
    broadcast('inventario_updated');
    res.json(l);
  });

  app.get('/api/inventario/vencimientos', conToken('despachador', 'inventario'), (req, res) => {
    const dias = Number(req.query.dias) || Number(db.getConfig('dias_alerta_vencimiento')) || 60;
    res.json(db.proximosAVencer(dias));
  });

  // ---- Turnos ----
  // El paciente no requiere PIN: se identifica con su documento
  app.post('/api/turnos', (req, res) => {
    const { tipo_documento, numero_documento, nombre, telefono } = req.body || {};
    if (!TIPOS_DOC.includes(tipo_documento)) {
      return res.status(400).json({ error: `tipo_documento debe ser uno de: ${TIPOS_DOC.join(', ')}` });
    }
    if (!numero_documento || !/^[A-Za-z0-9-]{3,20}$/.test(String(numero_documento))) {
      return res.status(400).json({ error: 'numero_documento inválido' });
    }
    const turno = db.crearTurno({
      tipo_documento,
      numero_documento: String(numero_documento),
      nombre: nombre ? String(nombre).slice(0, 80) : null,
      telefono: telefono ? String(telefono).slice(0, 20) : null,
    });
    broadcast('turnos_updated');
    res.status(201).json(turno);
  });

  app.get('/api/turnos', (req, res) => {
    const turnos = db.getTurnos({ estado: req.query.estado || null, fecha: req.query.fecha || null });
    // Operadores ven el documento completo; el público (display) lo ve enmascarado
    if (esOperador(req)) return res.json(turnos);
    res.json(turnos.map(t => ({
      ...t,
      numero_documento: enmascarar(t.numero_documento),
      paciente_nombre: null,
    })));
  });

  app.get('/api/turnos/:id', (req, res) => {
    const t = db.turnoCompleto(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
    res.json(t);
  });

  app.put('/api/turnos/:id/estado', conToken('despachador'), (req, res) => {
    const { estado, modulo_asignado } = req.body || {};
    if (!ESTADOS.includes(estado)) {
      return res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS.join(', ')}` });
    }
    const t = db.setEstadoTurno(Number(req.params.id), estado, modulo_asignado ?? null);
    if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
    broadcast('turnos_updated', { llamado: estado === 'LLAMANDO' ? t.numero : undefined });
    res.json(t);
  });

  // El propio paciente cierra su turno ENTREGADO -> FINALIZADO (sin token)
  app.post('/api/turnos/:id/finalizar', (req, res) => {
    const t = db.turnoCompleto(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
    if (t.estado !== 'ENTREGADO') return res.status(400).json({ error: 'Solo se finalizan turnos ENTREGADOS' });
    broadcast('turnos_updated');
    res.json(db.setEstadoTurno(t.id, 'FINALIZADO'));
  });

  // ---- Fórmulas médicas + OCR ----
  // El paciente (sin token) o el despachador adjuntan la fórmula: una imagen
  // (imagen_base64) o varias páginas (imagenes_base64, p. ej. un PDF renderizado).
  app.post('/api/formulas', (req, res) => {
    const { turno_id, imagen_base64, imagenes_base64 } = req.body || {};
    const t = db.turnoCompleto(Number(turno_id));
    if (!t) return res.status(404).json({ error: 'Turno no encontrado' });
    let paginas = Array.isArray(imagenes_base64) ? imagenes_base64 : (imagen_base64 ? [imagen_base64] : []);
    paginas = paginas
      .map(p => String(p).replace(/^data:image\/\w+;base64,/, ''))
      .filter(p => p.length >= 100)
      .slice(0, 8); // máximo 8 páginas por fórmula
    if (!paginas.length) {
      return res.status(400).json({ error: 'Se requiere imagen_base64 o imagenes_base64 (páginas del PDF)' });
    }
    const f = db.crearFormula(t.id, paginas);
    db.auditar(esLocalhost(req) || dispositivoDe(req) ? actorDe(req) : 'paciente:' + t.numero_documento,
      'FORMULA_SUBIDA', `turno ${t.numero}, fórmula ${f.id} (${paginas.length} página(s))`);
    broadcast('turnos_updated');
    res.status(201).json(f);
  });

  app.get('/api/formulas/:turno_id', conToken('despachador'), (req, res) => {
    res.json(db.getFormulas(Number(req.params.turno_id)));
  });

  // Imagen de una página de la fórmula (?pagina=1..n, por defecto la primera)
  app.get('/api/formulas/:id/imagen', conToken('despachador'), (req, res) => {
    const f = db.getFormula(Number(req.params.id));
    const rutas = db.rutasFormula(f);
    const idx = Math.max(1, Number(req.query.pagina) || 1) - 1;
    if (!rutas[idx] || !fs.existsSync(rutas[idx])) return res.status(404).json({ error: 'Imagen no encontrada' });
    res.type('jpeg').send(fs.readFileSync(rutas[idx]));
  });

  // Ejecuta el OCR con OpenAI Vision (todas las páginas) y valida contra inventario
  app.post('/api/formulas/:id/ocr', conToken('despachador'), async (req, res) => {
    const f = db.getFormula(Number(req.params.id));
    if (!f) return res.status(404).json({ error: 'Fórmula no encontrada' });
    const rutas = db.rutasFormula(f).filter(r => fs.existsSync(r));
    if (!rutas.length) return res.status(410).json({ error: 'Las imágenes ya no existen en disco' });
    try {
      const resultado = await procesarFormula({
        apiKey: db.getConfig('openai_api_key'),
        modelo: db.getConfig('openai_modelo'),
        imagenesBase64: rutas.map(r => fs.readFileSync(r).toString('base64')),
      });
      db.setResultadoOcr(f.id, { json: resultado });
      db.auditar(actorDe(req), 'OCR_PROCESADO', `fórmula ${f.id}: ${resultado.medicamentos.length} medicamentos`);
      broadcast('turnos_updated');
      res.json({
        ...resultado,
        validacion: db.validarContraInventario(resultado.medicamentos),
      });
    } catch (e) {
      db.setResultadoOcr(f.id, { error: e.message });
      db.auditar(actorDe(req), 'OCR_ERROR', `fórmula ${f.id}: ${e.message}`);
      res.status(502).json({ error: e.message });
    }
  });

  // Valida una lista de medicamentos (del OCR o manual) contra el inventario
  app.post('/api/validar', conToken('despachador'), (req, res) => {
    const items = (req.body || {}).medicamentos;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'medicamentos debe ser un arreglo' });
    res.json(db.validarContraInventario(items));
  });

  // ---- Entregas ----
  app.post('/api/entregas', conToken('despachador'), (req, res) => {
    const { turno_id, items, usuario, modulo } = req.body || {};
    const normal = (Array.isArray(items) ? items : []).map(i => ({
      medicamento_id: Number(i.medicamento_id),
      cantidad: Number(i.cantidad) > 0 ? Math.round(Number(i.cantidad)) : 0,
      pendiente: Number(i.pendiente) > 0 ? Math.round(Number(i.pendiente)) : 0,   // saldo que queda por falta de stock
      pendiente_id: Number(i.pendiente_id) > 0 ? Number(i.pendiente_id) : null,   // entrega contra un pendiente previo
    })).filter(i => i.medicamento_id && i.cantidad > 0);
    try {
      const comprobante = db.registrarEntrega(Number(turno_id), normal, usuario || actorDe(req), modulo);
      broadcast('turnos_updated');
      broadcast('inventario_updated');
      res.status(201).json(comprobante);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/entregas', conToken(), (req, res) => res.json(db.getEntregas()));

  // Saldos pendientes de un paciente (entregas parciales por falta de stock)
  app.get('/api/pendientes', conToken('despachador'), (req, res) => {
    const { tipo_documento, numero_documento } = req.query;
    if (!TIPOS_DOC.includes(tipo_documento) || !numero_documento) {
      return res.status(400).json({ error: 'tipo_documento y numero_documento son obligatorios' });
    }
    res.json(db.getPendientesDePaciente(tipo_documento, String(numero_documento)));
  });

  // El paciente consulta su comprobante (sin token: es su propio turno)
  app.get('/api/entregas/:turno_id', (req, res) => {
    const e = db.getEntrega(Number(req.params.turno_id));
    if (!e) return res.status(404).json({ error: 'Entrega no disponible' });
    res.json(e);
  });

  // Historial de entregas del propio paciente (se consulta por documento)
  app.get('/api/historial', (req, res) => {
    const { tipo_documento, numero_documento } = req.query;
    if (!TIPOS_DOC.includes(tipo_documento) || !numero_documento) {
      return res.status(400).json({ error: 'tipo_documento y numero_documento son obligatorios' });
    }
    res.json(db.getEntregasDePaciente(tipo_documento, String(numero_documento)));
  });

  // ---- Dashboard y auditoría ----
  app.get('/api/dashboard', conToken(), (_req, res) => res.json(db.dashboard()));
  app.get('/api/auditoria', soloAdmin, (req, res) => res.json(db.getAuditoria(Number(req.query.limite) || 200)));

  // ---- Gestión de dispositivos emparejados (solo panel local) ----
  app.get('/api/dispositivos', soloAdmin, (_req, res) => res.json(db.getDispositivos()));

  app.post('/api/dispositivos/:id/revocar', soloAdmin, (req, res) => {
    res.json(db.revocarDispositivo(Number(req.params.id)));
    db.auditar('panel', 'DISPOSITIVO_REVOCADO', `id ${req.params.id}`);
    broadcast('dispositivos_updated');
  });

  app.post('/api/config/regenerar-pines', soloAdmin, (_req, res) => {
    regenerarPins();
    res.json({ pines_sesion: pinsSesion });
  });

  app.get('/api/config', soloAdmin, (_req, res) => {
    const { secreto_firma, ...pub } = db.allConfig();
    pub.openai_api_key = pub.openai_api_key ? '••••' + pub.openai_api_key.slice(-4) : '';
    res.json({ ...pub, ip: ipLocal(), puerto, pines_sesion: pinsSesion });
  });

  app.put('/api/config', soloAdmin, (req, res) => {
    const permitidas = ['timeout_minutos', 'num_modulos', 'nombre_centro', 'marquesina_velocidad',
      'marquesina_mensaje', 'dias_alerta_vencimiento', 'openai_modelo',
      'impresora_ip', 'impresora_puerto', 'ticket_opciones', 'ticket_logo'];
    for (const k of permitidas) {
      if (req.body[k] !== undefined) db.setConfig(k, req.body[k]);
    }
    // La API key solo se actualiza si llega un valor nuevo (no el enmascarado)
    if (req.body.openai_api_key !== undefined && !/^•/.test(String(req.body.openai_api_key))) {
      db.setConfig('openai_api_key', String(req.body.openai_api_key).trim());
    }
    broadcast('config_updated');
    const { secreto_firma, ...pub } = db.allConfig();
    pub.openai_api_key = pub.openai_api_key ? '••••' + pub.openai_api_key.slice(-4) : '';
    res.json({ ...pub, ip: ipLocal(), puerto, pines_sesion: pinsSesion });
  });

  // Timeout de ausencias: LLAMANDO -> NO_PRESENTADO
  const chequeo = setInterval(() => {
    const timeout = Number(db.getConfig('timeout_minutos')) || 5;
    const vencidos = db.expirarLlamados(timeout);
    if (vencidos.length) broadcast('turnos_updated', { no_presentados: vencidos });
  }, 30 * 1000);

  // Autodescubrimiento: la app Android envía "DISPENSARIO_DISCOVER" por broadcast UDP
  // al puerto 18400 y el servidor responde con su IP, puerto y nombre.
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    if (!msg.toString().startsWith('DISPENSARIO_DISCOVER')) return;
    const respuesta = JSON.stringify({
      tipo: 'DISPENSARIO_SERVER',
      nombre: db.getConfig('nombre_centro'),
      ip: ipLocal(),
      puerto,
      version: require('../package.json').version,
    });
    udp.send(respuesta, rinfo.port, rinfo.address);
  });
  udp.on('error', (e) => console.warn('Discovery UDP no disponible:', e.message));
  try { udp.bind(PUERTO_DISCOVERY); } catch (e) { console.warn('Discovery UDP:', e.message); }

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(puerto, '0.0.0.0', resolve);
  });

  return {
    db,
    puerto,
    ip: ipLocal(),
    close: () => {
      clearInterval(chequeo);
      wss.close();
      server.close();
      try { udp.close(); } catch (e) { /* ya cerrado */ }
    },
  };
}

module.exports = { crearServidor, ipLocal };
