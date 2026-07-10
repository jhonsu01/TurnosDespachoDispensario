'use strict';
/**
 * Capa de datos: SQLite via sql.js (WASM, sin dependencias nativas).
 * La base se persiste a disco tras cada mutación. Las imágenes de las
 * fórmulas se guardan en disco (carpeta formulas/ junto a la base).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pacientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_documento TEXT NOT NULL CHECK (tipo_documento IN ('CC','CE','NIT','PASAPORTE','TI')),
  numero_documento TEXT NOT NULL,
  nombre TEXT,
  telefono TEXT,
  UNIQUE (tipo_documento, numero_documento)
);
CREATE TABLE IF NOT EXISTS medicamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  principio_activo TEXT NOT NULL,
  concentracion TEXT NOT NULL,
  presentacion TEXT NOT NULL,
  laboratorio TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS inventario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medicamento_id INTEGER NOT NULL REFERENCES medicamentos(id),
  lote TEXT NOT NULL,
  cantidad INTEGER NOT NULL,
  fecha_vencimiento TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turnos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paciente_id INTEGER NOT NULL REFERENCES pacientes(id),
  numero INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'ESPERANDO'
    CHECK (estado IN ('CREADO','ESPERANDO','LLAMANDO','DESPACHO','ENTREGADO','FINALIZADO','NO_PRESENTADO')),
  modulo_asignado INTEGER,
  codigo_pin TEXT NOT NULL,
  qr_code TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  llamado_en TEXT
);
CREATE TABLE IF NOT EXISTS formulas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turno_id INTEGER NOT NULL REFERENCES turnos(id),
  imagen_ruta TEXT NOT NULL,
  ocr_estado TEXT NOT NULL DEFAULT 'PENDIENTE'
    CHECK (ocr_estado IN ('PENDIENTE','PROCESADA','ERROR')),
  ocr_json TEXT,
  ocr_error TEXT,
  fecha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entregas (
  turno_id INTEGER PRIMARY KEY REFERENCES turnos(id),
  codigo TEXT NOT NULL UNIQUE,
  json TEXT NOT NULL,
  firma TEXT NOT NULL,
  usuario TEXT,
  fecha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dispositivos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  rol TEXT NOT NULL CHECK (rol IN ('despachador','admin','kiosko','inventario')),
  nombre TEXT,
  creado TEXT NOT NULL,
  ultimo_acceso TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pendientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paciente_id INTEGER NOT NULL REFERENCES pacientes(id),
  medicamento_id INTEGER NOT NULL REFERENCES medicamentos(id),
  cantidad INTEGER NOT NULL,
  origen TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','SALDADO')),
  fecha TEXT NOT NULL,
  fecha_saldado TEXT,
  saldado_por TEXT
);
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  actor TEXT NOT NULL,
  accion TEXT NOT NULL,
  detalle TEXT
);
`;

// Catálogo inicial de medicamentos (editable desde el panel).
const MEDICAMENTOS_SEED = [
  ['MED-001', 'Losartán', 'Losartán potásico', '50mg', 'Tableta', 'Genfar'],
  ['MED-002', 'Metformina', 'Metformina clorhidrato', '850mg', 'Tableta', 'La Santé'],
  ['MED-003', 'Acetaminofén', 'Paracetamol', '500mg', 'Tableta', 'MK'],
  ['MED-004', 'Omeprazol', 'Omeprazol', '20mg', 'Cápsula', 'Genfar'],
  ['MED-005', 'Ibuprofeno', 'Ibuprofeno', '400mg', 'Tableta', 'MK'],
  ['MED-006', 'Amlodipino', 'Amlodipino besilato', '5mg', 'Tableta', 'La Santé'],
  ['MED-007', 'Atorvastatina', 'Atorvastatina cálcica', '20mg', 'Tableta', 'Genfar'],
  ['MED-008', 'Salbutamol', 'Salbutamol sulfato', '100mcg', 'Inhalador', 'GSK'],
  ['MED-009', 'Enalapril', 'Enalapril maleato', '20mg', 'Tableta', 'MK'],
  ['MED-010', 'Loratadina', 'Loratadina', '10mg', 'Tableta', 'Genfar'],
];

const CONFIG_DEFAULTS = {
  timeout_minutos: '5',
  num_modulos: '3',
  nombre_centro: 'Dispensario de Medicamentos',
  marquesina_velocidad: '45',
  marquesina_mensaje: '',
  dias_alerta_vencimiento: '60',
  openai_api_key: '',
  openai_modelo: 'gpt-4o-mini',
  // Impresora térmica de tickets (Epson TM-T20IVL o compatible ESC/POS, RAW 9100)
  impresora_ip: '',
  impresora_puerto: '9100',
  ticket_logo: '', // PNG en base64 (se imprime en monocromo)
  ticket_opciones: '{"mostrar_logo":true,"mostrar_nombre":true,"mostrar_fecha":true,"mostrar_pin":true,"mostrar_qr":true,"mensaje_pie":"Conserva este ticket. Observa la pantalla: te llamaremos por tu número."}',
  secreto_firma: '', // se genera al iniciar
};

/** Normaliza texto para comparar nombres de medicamentos (sin tildes, minúsculas). */
function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

class Db {
  constructor(sqlDb, filePath) {
    this._db = sqlDb;
    this._file = filePath;
    this.dirFormulas = path.join(path.dirname(filePath), 'formulas');
  }

  static async open(filePath) {
    const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    const SQL = await initSqlJs({ wasmBinary });
    const sqlDb = fs.existsSync(filePath)
      ? new SQL.Database(fs.readFileSync(filePath))
      : new SQL.Database();
    const db = new Db(sqlDb, filePath);
    db._db.run(SCHEMA);
    db._migrar();
    db._seed();
    db.save();
    fs.mkdirSync(db.dirFormulas, { recursive: true });
    return db;
  }

  /** Migraciones para bases creadas por versiones anteriores. */
  _migrar() {
    // v0.2.0: el CHECK de dispositivos.rol debe aceptar 'inventario'
    const def = this.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dispositivos'`)[0];
    if (def && !def.sql.includes('inventario')) {
      this.run('ALTER TABLE dispositivos RENAME TO dispositivos_old');
      this.run(`CREATE TABLE dispositivos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL UNIQUE,
        rol TEXT NOT NULL CHECK (rol IN ('despachador','admin','kiosko','inventario')),
        nombre TEXT,
        creado TEXT NOT NULL,
        ultimo_acceso TEXT,
        activo INTEGER NOT NULL DEFAULT 1
      )`);
      this.run(`INSERT INTO dispositivos SELECT * FROM dispositivos_old`);
      this.run('DROP TABLE dispositivos_old');
    }
    // v0.3.0: la entrega registra desde qué módulo se despachó
    const colsEnt = this.query('PRAGMA table_info(entregas)').map(c => c.name);
    if (!colsEnt.includes('modulo')) {
      this.run('ALTER TABLE entregas ADD COLUMN modulo INTEGER');
    }
  }

  _seed() {
    for (const [clave, valor] of Object.entries(CONFIG_DEFAULTS)) {
      const actual = clave === 'secreto_firma' && !this.getConfig(clave)
        ? crypto.randomBytes(16).toString('hex')
        : valor;
      this.run('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)', [clave, actual]);
    }
    const n = this.query('SELECT COUNT(*) AS c FROM medicamentos')[0].c;
    if (n === 0) {
      for (const m of MEDICAMENTOS_SEED) {
        this.run(
          `INSERT INTO medicamentos (codigo, nombre, principio_activo, concentracion, presentacion, laboratorio)
           VALUES (?, ?, ?, ?, ?, ?)`, m);
      }
      // Lote inicial de demostración por medicamento (vence en un año)
      const venc = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      for (const { id } of this.query('SELECT id FROM medicamentos')) {
        this.run(
          'INSERT INTO inventario (medicamento_id, lote, cantidad, fecha_vencimiento) VALUES (?, ?, ?, ?)',
          [id, `L-2026-${String(id).padStart(3, '0')}`, 100, venc]);
      }
    }
  }

  query(sql, params = []) {
    const stmt = this._db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  run(sql, params = []) {
    this._db.run(sql, params);
  }

  save() {
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    fs.writeFileSync(this._file, Buffer.from(this._db.export()));
  }

  // ---- Auditoría ----
  auditar(actor, accion, detalle = '') {
    this.run('INSERT INTO auditoria (fecha, actor, accion, detalle) VALUES (?, ?, ?, ?)',
      [new Date().toISOString(), String(actor), String(accion), String(detalle)]);
    this.save();
  }

  getAuditoria(limite = 200) {
    return this.query('SELECT * FROM auditoria ORDER BY id DESC LIMIT ?', [limite]);
  }

  // ---- Config ----
  getConfig(clave) {
    const r = this.query('SELECT valor FROM config WHERE clave = ?', [clave]);
    return r.length ? r[0].valor : null;
  }

  setConfig(clave, valor) {
    this.run('INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor',
      [clave, String(valor)]);
    this.save();
  }

  allConfig() {
    const out = {};
    for (const { clave, valor } of this.query('SELECT clave, valor FROM config')) out[clave] = valor;
    return out;
  }

  // ---- Medicamentos ----
  getMedicamentos() {
    return this.query(`
      SELECT m.*,
             COALESCE((SELECT SUM(i.cantidad) FROM inventario i
                       WHERE i.medicamento_id = m.id AND i.cantidad > 0
                         AND i.fecha_vencimiento >= date('now')), 0) AS stock
      FROM medicamentos m WHERE m.activo = 1
      ORDER BY m.nombre, m.concentracion`);
  }

  crearMedicamento({ codigo, nombre, principio_activo, concentracion, presentacion, laboratorio }) {
    this.run(
      `INSERT INTO medicamentos (codigo, nombre, principio_activo, concentracion, presentacion, laboratorio, activo)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [codigo, nombre, principio_activo, concentracion, presentacion, laboratorio || '']);
    this.save();
    return this.query('SELECT * FROM medicamentos ORDER BY id DESC LIMIT 1')[0];
  }

  updateMedicamento(id, campos) {
    const permitidos = ['codigo', 'nombre', 'principio_activo', 'concentracion', 'presentacion', 'laboratorio'];
    const sets = [];
    const params = [];
    for (const k of permitidos) {
      if (campos[k] !== undefined) { sets.push(`${k} = ?`); params.push(campos[k]); }
    }
    if (!sets.length) return null;
    params.push(id);
    this.run(`UPDATE medicamentos SET ${sets.join(', ')} WHERE id = ?`, params);
    this.save();
    return this.query('SELECT * FROM medicamentos WHERE id = ?', [id])[0] || null;
  }

  eliminarMedicamento(id) {
    const usado = this.query(
      'SELECT COUNT(*) AS c FROM inventario WHERE medicamento_id = ?', [id])[0].c;
    if (usado > 0) {
      // Conserva el histórico: solo se oculta de las listas
      this.run('UPDATE medicamentos SET activo = 0 WHERE id = ?', [id]);
    } else {
      this.run('DELETE FROM medicamentos WHERE id = ?', [id]);
    }
    this.save();
    return { ok: true, oculto: usado > 0 };
  }

  // ---- Inventario (lotes) ----
  getInventario() {
    return this.query(`
      SELECT i.*, m.codigo, m.nombre, m.concentracion, m.presentacion
      FROM inventario i JOIN medicamentos m ON m.id = i.medicamento_id
      WHERE i.cantidad > 0
      ORDER BY m.nombre, i.fecha_vencimiento`);
  }

  crearLote({ medicamento_id, lote, cantidad, fecha_vencimiento }) {
    this.run(
      'INSERT INTO inventario (medicamento_id, lote, cantidad, fecha_vencimiento) VALUES (?, ?, ?, ?)',
      [medicamento_id, lote, cantidad, fecha_vencimiento]);
    this.save();
    return this.query('SELECT * FROM inventario ORDER BY id DESC LIMIT 1')[0];
  }

  ajustarLote(id, cantidad) {
    this.run('UPDATE inventario SET cantidad = ? WHERE id = ?', [Math.max(0, cantidad), id]);
    this.save();
    return this.query('SELECT * FROM inventario WHERE id = ?', [id])[0] || null;
  }

  proximosAVencer(dias) {
    const limite = new Date(Date.now() + dias * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return this.query(`
      SELECT i.*, m.nombre, m.concentracion, m.presentacion
      FROM inventario i JOIN medicamentos m ON m.id = i.medicamento_id
      WHERE i.cantidad > 0 AND i.fecha_vencimiento <= ?
      ORDER BY i.fecha_vencimiento`, [limite]);
  }

  /**
   * Valida una lista de medicamentos extraídos por el OCR contra el inventario.
   * Matching por nombre/principio activo (sin tildes) + concentración si viene.
   */
  validarContraInventario(items) {
    const meds = this.getMedicamentos();
    return (items || []).map(item => {
      const nombre = normalizar(item.nombre);
      const conc = normalizar(item.concentracion);
      const candidatos = meds.filter(m => {
        const n = normalizar(m.nombre);
        const p = normalizar(m.principio_activo);
        return nombre && (n.includes(nombre) || nombre.includes(n) ||
                          p.includes(nombre) || nombre.includes(p));
      });
      const match = (conc && candidatos.find(m => normalizar(m.concentracion) === conc))
        || candidatos[0] || null;
      const cantidad = Number(item.cantidad) > 0 ? Number(item.cantidad) : 1;
      return {
        solicitado: {
          nombre: item.nombre || '',
          concentracion: item.concentracion || '',
          presentacion: item.presentacion || '',
          cantidad,
        },
        medicamento_id: match ? match.id : null,
        medicamento: match ? `${match.nombre} ${match.concentracion} (${match.presentacion})` : null,
        stock: match ? match.stock : 0,
        disponible: !!match && match.stock >= cantidad,
      };
    });
  }

  /** Descuenta unidades de un medicamento por lotes FEFO (primero el que vence antes). */
  descontarInventario(medicamento_id, cantidad) {
    const lotes = this.query(
      `SELECT * FROM inventario
       WHERE medicamento_id = ? AND cantidad > 0 AND fecha_vencimiento >= date('now')
       ORDER BY fecha_vencimiento`, [medicamento_id]);
    const total = lotes.reduce((s, l) => s + l.cantidad, 0);
    if (total < cantidad) throw new Error('Stock insuficiente para el medicamento ' + medicamento_id);
    let restante = cantidad;
    const usados = [];
    for (const l of lotes) {
      if (restante <= 0) break;
      const toma = Math.min(l.cantidad, restante);
      this.run('UPDATE inventario SET cantidad = cantidad - ? WHERE id = ?', [toma, l.id]);
      usados.push({ lote: l.lote, cantidad: toma, fecha_vencimiento: l.fecha_vencimiento });
      restante -= toma;
    }
    this.save();
    return usados;
  }

  // ---- Turnos ----
  crearTurno({ tipo_documento, numero_documento, nombre = null, telefono = null }) {
    let paciente = this.query(
      'SELECT * FROM pacientes WHERE tipo_documento = ? AND numero_documento = ?',
      [tipo_documento, numero_documento])[0];
    if (!paciente) {
      this.run('INSERT INTO pacientes (tipo_documento, numero_documento, nombre, telefono) VALUES (?, ?, ?, ?)',
        [tipo_documento, numero_documento, nombre, telefono]);
      paciente = this.query('SELECT * FROM pacientes ORDER BY id DESC LIMIT 1')[0];
    } else if (nombre || telefono) {
      this.run('UPDATE pacientes SET nombre = COALESCE(?, nombre), telefono = COALESCE(?, telefono) WHERE id = ?',
        [nombre, telefono, paciente.id]);
    }
    const hoy = new Date().toISOString().slice(0, 10);
    // Un solo turno abierto por paciente y día: si ya tiene uno activo, lo retoma.
    const abierto = this.query(
      `SELECT id FROM turnos
       WHERE paciente_id = ? AND fecha = ?
         AND estado IN ('CREADO','ESPERANDO','LLAMANDO','DESPACHO','ENTREGADO')
       ORDER BY id DESC`, [paciente.id, hoy])[0];
    if (abierto) return this.turnoCompleto(abierto.id);

    const nro = (this.query('SELECT COALESCE(MAX(numero),0) AS m FROM turnos WHERE fecha = ?', [hoy])[0].m) + 1;
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const ts = new Date().toISOString();
    const qr = `DISPENSARIO|${hoy}|${nro}|${pin}`;
    this.run(
      `INSERT INTO turnos (paciente_id, numero, fecha, estado, codigo_pin, qr_code, timestamp)
       VALUES (?, ?, ?, 'ESPERANDO', ?, ?, ?)`,
      [paciente.id, nro, hoy, pin, qr, ts]);
    const id = this.query('SELECT id FROM turnos ORDER BY id DESC LIMIT 1')[0].id;
    this.save();
    return this.turnoCompleto(id);
  }

  turnoCompleto(id) {
    const t = this.query(
      `SELECT t.*, p.tipo_documento, p.numero_documento, p.nombre AS paciente_nombre, p.telefono,
              (SELECT COUNT(*) FROM formulas f WHERE f.turno_id = t.id) AS num_formulas,
              (SELECT f.ocr_estado FROM formulas f WHERE f.turno_id = t.id ORDER BY f.id DESC LIMIT 1) AS ocr_estado
       FROM turnos t
       JOIN pacientes p ON p.id = t.paciente_id
       WHERE t.id = ?`, [id])[0];
    return t || null;
  }

  getTurnos({ fecha = null, estado = null } = {}) {
    const f = fecha || new Date().toISOString().slice(0, 10);
    let sql = `SELECT t.*, p.tipo_documento, p.numero_documento, p.nombre AS paciente_nombre,
                      (SELECT COUNT(*) FROM formulas fo WHERE fo.turno_id = t.id) AS num_formulas,
                      (SELECT fo.ocr_estado FROM formulas fo WHERE fo.turno_id = t.id ORDER BY fo.id DESC LIMIT 1) AS ocr_estado,
                      (SELECT e.codigo FROM entregas e WHERE e.turno_id = t.id) AS entrega_codigo
               FROM turnos t
               JOIN pacientes p ON p.id = t.paciente_id
               WHERE t.fecha = ?`;
    const params = [f];
    if (estado) { sql += ' AND t.estado = ?'; params.push(estado); }
    sql += ' ORDER BY t.numero ASC';
    return this.query(sql, params);
  }

  setEstadoTurno(id, estado, modulo = null) {
    const turno = this.turnoCompleto(id);
    if (!turno) return null;
    const llamadoEn = estado === 'LLAMANDO' ? new Date().toISOString() : turno.llamado_en;
    this.run('UPDATE turnos SET estado = ?, modulo_asignado = COALESCE(?, modulo_asignado), llamado_en = ? WHERE id = ?',
      [estado, modulo, llamadoEn, id]);
    this.save();
    return this.turnoCompleto(id);
  }

  /** Turnos LLAMANDO cuyo tiempo de espera venció -> NO_PRESENTADO. Devuelve ids afectados. */
  expirarLlamados(timeoutMin) {
    const limite = new Date(Date.now() - timeoutMin * 60 * 1000).toISOString();
    const vencidos = this.query(
      `SELECT id FROM turnos WHERE estado = 'LLAMANDO' AND llamado_en IS NOT NULL AND llamado_en < ?`, [limite]);
    for (const { id } of vencidos) {
      this.run(`UPDATE turnos SET estado = 'NO_PRESENTADO' WHERE id = ?`, [id]);
    }
    if (vencidos.length) this.save();
    return vencidos.map(v => v.id);
  }

  // ---- Fórmulas médicas ----
  /**
   * Guarda una fórmula de una o varias páginas (los PDF llegan como una imagen
   * por página). imagen_ruta almacena un JSON array de rutas.
   */
  crearFormula(turno_id, imagenesBase64) {
    const paginas = Array.isArray(imagenesBase64) ? imagenesBase64 : [imagenesBase64];
    const base = Date.now();
    const rutas = paginas.map((b64, i) => {
      const ruta = path.join(this.dirFormulas, `formula-${turno_id}-${base}-p${i + 1}.jpg`);
      fs.writeFileSync(ruta, Buffer.from(b64, 'base64'));
      return ruta;
    });
    this.run('INSERT INTO formulas (turno_id, imagen_ruta, fecha) VALUES (?, ?, ?)',
      [turno_id, JSON.stringify(rutas), new Date().toISOString()]);
    this.save();
    return this.query('SELECT id, turno_id, ocr_estado, fecha FROM formulas ORDER BY id DESC LIMIT 1')[0];
  }

  /** Rutas de las páginas de una fórmula (compatible con fórmulas v0.1 de una ruta). */
  rutasFormula(f) {
    if (!f) return [];
    try {
      const arr = JSON.parse(f.imagen_ruta);
      return Array.isArray(arr) ? arr : [f.imagen_ruta];
    } catch (e) {
      return [f.imagen_ruta];
    }
  }

  getFormulas(turno_id) {
    return this.query(
      'SELECT * FROM formulas WHERE turno_id = ? ORDER BY id DESC', [turno_id]
    ).map(f => ({
      id: f.id,
      turno_id: f.turno_id,
      ocr_estado: f.ocr_estado,
      ocr_json: f.ocr_json,
      ocr_error: f.ocr_error,
      fecha: f.fecha,
      num_paginas: this.rutasFormula(f).length,
    }));
  }

  getFormula(id) {
    return this.query('SELECT * FROM formulas WHERE id = ?', [id])[0] || null;
  }

  setResultadoOcr(id, { json = null, error = null }) {
    if (json !== null) {
      this.run(`UPDATE formulas SET ocr_estado = 'PROCESADA', ocr_json = ?, ocr_error = NULL WHERE id = ?`,
        [JSON.stringify(json), id]);
    } else {
      this.run(`UPDATE formulas SET ocr_estado = 'ERROR', ocr_error = ? WHERE id = ?`, [String(error), id]);
    }
    this.save();
    return this.getFormula(id);
  }

  // ---- Entregas ----
  /**
   * Registra la entrega de un turno: descuenta inventario por lotes FEFO
   * y genera un comprobante JSON firmado con HMAC-SHA256.
   * items: [{ medicamento_id, cantidad }]
   */
  registrarEntrega(turno_id, items, usuario = 'panel', modulo = null) {
    const turno = this.turnoCompleto(turno_id);
    if (!turno) throw new Error('Turno no encontrado');
    if (this.query('SELECT 1 FROM entregas WHERE turno_id = ?', [turno_id]).length) {
      throw new Error('Este turno ya tiene una entrega registrada');
    }
    if (!Array.isArray(items) || !items.length) throw new Error('La entrega no tiene medicamentos');
    // Política del dispensario: toda entrega requiere fórmula médica adjunta
    const numFormulas = this.query(
      'SELECT COUNT(*) AS c FROM formulas WHERE turno_id = ?', [turno_id])[0].c;
    if (numFormulas === 0) {
      throw new Error('No se puede despachar sin fórmula médica. Adjunta la fórmula (foto o PDF) antes de confirmar.');
    }

    // Validación previa: si algún ítem no tiene stock se aborta sin descontar nada
    for (const it of items) {
      const med = this.query('SELECT * FROM medicamentos WHERE id = ?', [it.medicamento_id])[0];
      if (!med) throw new Error(`Medicamento ${it.medicamento_id} no existe`);
      const stock = this.query(
        `SELECT COALESCE(SUM(cantidad),0) AS s FROM inventario
         WHERE medicamento_id = ? AND fecha_vencimiento >= date('now')`, [it.medicamento_id])[0].s;
      if (stock < it.cantidad) {
        throw new Error(`Stock insuficiente de ${med.nombre} ${med.concentracion} (hay ${stock}, se piden ${it.cantidad})`);
      }
    }

    const detalle = items.map(it => {
      const med = this.query('SELECT * FROM medicamentos WHERE id = ?', [it.medicamento_id])[0];
      const lotes = this.descontarInventario(it.medicamento_id, it.cantidad);
      return {
        medicamento_id: it.medicamento_id,
        codigo: med.codigo,
        nombre: `${med.nombre} ${med.concentracion} (${med.presentacion})`,
        cantidad: it.cantidad,
        pendiente: Number(it.pendiente) > 0 ? Math.round(Number(it.pendiente)) : 0,
        pendiente_id: Number(it.pendiente_id) > 0 ? Number(it.pendiente_id) : null,
        lotes,
      };
    });

    const seq = this.query('SELECT COUNT(*) AS c FROM entregas')[0].c + 1;
    const codigo = `ENT-${String(seq).padStart(5, '0')}`;
    // Módulo desde el que se entrega: el indicado, o el módulo al que se llamó el turno
    const moduloEntrega = Number(modulo) > 0 ? Number(modulo) : (turno.modulo_asignado || null);
    const comprobante = {
      id: codigo,
      turno_id,
      numero_turno: turno.numero,
      fecha_turno: turno.fecha,
      modulo: moduloEntrega,
      paciente: {
        tipo_documento: turno.tipo_documento,
        numero_documento: turno.numero_documento,
        nombre: turno.paciente_nombre || '',
      },
      medicamentos: detalle,
      entregado_por: usuario,
      fecha: new Date().toISOString(),
    };
    const json = JSON.stringify(comprobante);
    const firma = crypto.createHmac('sha256', this.getConfig('secreto_firma') || 'dispensario')
      .update(json).digest('hex');
    this.run('INSERT INTO entregas (turno_id, codigo, json, firma, usuario, fecha, modulo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [turno_id, codigo, json, firma, usuario, comprobante.fecha, moduloEntrega]);

    // Saldos pendientes: lo que faltó por stock queda registrado a nombre del
    // paciente, y las entregas contra un pendiente existente lo reducen/saldan.
    for (const d of detalle) {
      if (d.pendiente_id) this.descontarPendiente(d.pendiente_id, d.cantidad, usuario);
      if (d.pendiente > 0) {
        this.run(
          `INSERT INTO pendientes (paciente_id, medicamento_id, cantidad, origen, fecha)
           VALUES (?, ?, ?, ?, ?)`,
          [turno.paciente_id, d.medicamento_id, d.pendiente, codigo, comprobante.fecha]);
        this.auditar(usuario, 'PENDIENTE_CREADO', `${codigo}: ${d.nombre} x${d.pendiente} (falta de stock)`);
      }
    }
    this.setEstadoTurno(turno_id, 'ENTREGADO');
    this.auditar(usuario, 'ENTREGA',
      `${codigo} turno ${turno.numero} (${detalle.length} medicamentos${moduloEntrega ? `, módulo ${moduloEntrega}` : ''})`);
    return { ...comprobante, firma };
  }

  getEntrega(turno_id) {
    const r = this.query('SELECT * FROM entregas WHERE turno_id = ?', [turno_id])[0];
    if (!r) return null;
    return { ...JSON.parse(r.json), firma: r.firma };
  }

  getEntregas(limite = 100) {
    return this.query(
      `SELECT e.turno_id, e.codigo, e.usuario, e.fecha, e.json, e.modulo, t.numero,
              p.tipo_documento, p.numero_documento, p.nombre AS paciente_nombre
       FROM entregas e
       JOIN turnos t ON t.id = e.turno_id
       JOIN pacientes p ON p.id = t.paciente_id
       ORDER BY e.fecha DESC LIMIT ?`, [limite]
    ).map(r => ({
      turno_id: r.turno_id,
      codigo: r.codigo,
      numero_turno: r.numero,
      paciente: { tipo_documento: r.tipo_documento, numero_documento: r.numero_documento, nombre: r.paciente_nombre },
      num_items: JSON.parse(r.json).medicamentos.length,
      usuario: r.usuario,
      modulo: r.modulo,
      fecha: r.fecha,
    }));
  }

  /** Historial de entregas de un paciente (consulta por documento). */
  getEntregasDePaciente(tipo_documento, numero_documento) {
    return this.query(
      `SELECT e.turno_id, e.codigo, e.json, e.fecha, t.numero, t.fecha AS fecha_turno
       FROM entregas e
       JOIN turnos t ON t.id = e.turno_id
       JOIN pacientes p ON p.id = t.paciente_id
       WHERE p.tipo_documento = ? AND p.numero_documento = ?
       ORDER BY e.fecha DESC LIMIT 50`,
      [tipo_documento, numero_documento]
    ).map(r => {
      const c = JSON.parse(r.json);
      return {
        turno_id: r.turno_id,
        codigo: r.codigo,
        numero_turno: r.numero,
        fecha_turno: r.fecha_turno,
        fecha: r.fecha,
        medicamentos: c.medicamentos.map(m => ({ nombre: m.nombre, cantidad: m.cantidad })),
      };
    });
  }

  // ---- Saldos pendientes (entregas parciales por falta de stock) ----
  getPendientesDePaciente(tipo_documento, numero_documento) {
    return this.query(
      `SELECT pe.id, pe.cantidad, pe.origen, pe.fecha, pe.medicamento_id,
              m.nombre, m.concentracion, m.presentacion,
              COALESCE((SELECT SUM(i.cantidad) FROM inventario i
                        WHERE i.medicamento_id = m.id AND i.cantidad > 0
                          AND i.fecha_vencimiento >= date('now')), 0) AS stock
       FROM pendientes pe
       JOIN pacientes p ON p.id = pe.paciente_id
       JOIN medicamentos m ON m.id = pe.medicamento_id
       WHERE pe.estado = 'PENDIENTE' AND p.tipo_documento = ? AND p.numero_documento = ?
       ORDER BY pe.fecha`, [tipo_documento, numero_documento]);
  }

  /** Reduce un pendiente por una entrega; si llega a cero (o menos) queda SALDADO. */
  descontarPendiente(id, cantidadEntregada, actor = 'panel') {
    const p = this.query(`SELECT * FROM pendientes WHERE id = ? AND estado = 'PENDIENTE'`, [id])[0];
    if (!p) return;
    const restante = p.cantidad - cantidadEntregada;
    if (restante > 0) {
      this.run('UPDATE pendientes SET cantidad = ? WHERE id = ?', [restante, id]);
      this.auditar(actor, 'PENDIENTE_PARCIAL', `pendiente ${id}: quedan ${restante}`);
    } else {
      this.run(`UPDATE pendientes SET estado = 'SALDADO', fecha_saldado = ?, saldado_por = ? WHERE id = ?`,
        [new Date().toISOString(), String(actor), id]);
      this.auditar(actor, 'PENDIENTE_SALDADO', `pendiente ${id} entregado completo`);
    }
    this.save();
  }

  // ---- Dashboard ----
  dashboard() {
    const hoy = new Date().toISOString().slice(0, 10);
    const turnosHoy = this.getTurnos({ fecha: hoy });
    const atendidos = turnosHoy.filter(t => ['ENTREGADO', 'FINALIZADO'].includes(t.estado));
    const tiempos = turnosHoy
      .filter(t => t.llamado_en && t.timestamp)
      .map(t => (new Date(t.llamado_en) - new Date(t.timestamp)) / 60000);
    const dias = Number(this.getConfig('dias_alerta_vencimiento')) || 60;
    return {
      fecha: hoy,
      turnos_hoy: turnosHoy.length,
      pendientes: turnosHoy.filter(t => ['CREADO', 'ESPERANDO', 'LLAMANDO', 'DESPACHO'].includes(t.estado)).length,
      atendidos: atendidos.length,
      no_presentados: turnosHoy.filter(t => t.estado === 'NO_PRESENTADO').length,
      espera_promedio_min: tiempos.length ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : 0,
      items_inventario: this.query('SELECT COALESCE(SUM(cantidad),0) AS s FROM inventario')[0].s,
      proximos_a_vencer: this.proximosAVencer(dias),
      entregas_recientes: this.getEntregas(10),
    };
  }

  // ---- Dispositivos emparejados (roles elevados) ----
  crearDispositivo(rol, nombre) {
    const token = crypto.randomBytes(24).toString('hex');
    this.run(
      'INSERT INTO dispositivos (token, rol, nombre, creado, ultimo_acceso, activo) VALUES (?, ?, ?, ?, ?, 1)',
      [token, rol, nombre || 'dispositivo', new Date().toISOString(), new Date().toISOString()]);
    this.save();
    return this.query('SELECT * FROM dispositivos ORDER BY id DESC LIMIT 1')[0];
  }

  dispositivoPorToken(token) {
    if (!token) return null;
    const d = this.query('SELECT * FROM dispositivos WHERE token = ? AND activo = 1', [token])[0];
    if (!d) return null;
    // Bump de último acceso (máx. una escritura por minuto para no castigar el disco)
    const hace1min = new Date(Date.now() - 60 * 1000).toISOString();
    if (!d.ultimo_acceso || d.ultimo_acceso < hace1min) {
      this.run('UPDATE dispositivos SET ultimo_acceso = ? WHERE id = ?', [new Date().toISOString(), d.id]);
      this.save();
    }
    return d;
  }

  getDispositivos() {
    return this.query('SELECT id, rol, nombre, creado, ultimo_acceso, activo FROM dispositivos ORDER BY activo DESC, ultimo_acceso DESC');
  }

  revocarDispositivo(id) {
    this.run('UPDATE dispositivos SET activo = 0 WHERE id = ?', [id]);
    this.save();
    return { ok: true };
  }
}

module.exports = { Db, normalizar };
