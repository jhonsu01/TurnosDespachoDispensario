'use strict';
/**
 * Smoke test de la API del dispensario: levanta el servidor en un puerto de
 * prueba con una base temporal y recorre el flujo completo
 * turno -> fórmula -> validación -> llamado -> entrega -> comprobante.
 * Sale con código 1 si algo falla. No requiere API key de OpenAI
 * (el endpoint de OCR debe fallar con un error claro, no colgarse).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { crearServidor } = require(path.join(__dirname, '..', 'desktop', 'src', 'server.js'));

const PUERTO = 3999;
const BASE = `http://127.0.0.1:${PUERTO}`;

async function api(ruta, opts = {}) {
  const r = await fetch(BASE + ruta, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispensario-test-'));
  const servidor = await crearServidor({ dbPath: path.join(dir, 'test.db'), puerto: PUERTO });
  let fallo = null;

  try {
    // 1. Ping
    const ping = await api('/api/ping');
    assert.strictEqual(ping.status, 200, 'ping debe responder 200');
    assert.strictEqual(ping.data.ok, true);
    console.log('✓ ping');

    // 2. Catálogo sembrado con stock
    const meds = await api('/api/medicamentos');
    assert.ok(meds.data.length >= 10, 'catálogo seed presente');
    const losartan = meds.data.find(m => m.nombre.includes('Losart'));
    assert.ok(losartan && losartan.stock === 100, 'Losartán con stock 100');
    console.log('✓ catálogo y stock inicial');

    // 3. Crear turno de paciente
    const turno = await api('/api/turnos', {
      method: 'POST',
      body: JSON.stringify({
        tipo_documento: 'CC', numero_documento: '1121888926',
        nombre: 'Paciente de Prueba', telefono: '3001234567',
      }),
    });
    assert.strictEqual(turno.status, 201);
    assert.strictEqual(turno.data.numero, 1);
    assert.strictEqual(turno.data.estado, 'ESPERANDO');
    assert.ok(turno.data.qr_code.startsWith('DISPENSARIO|'));
    console.log('✓ crear turno');

    // 3b. El mismo documento retoma el turno abierto (no duplica)
    const repetido = await api('/api/turnos', {
      method: 'POST',
      body: JSON.stringify({ tipo_documento: 'CC', numero_documento: '1121888926' }),
    });
    assert.strictEqual(repetido.data.id, turno.data.id, 'no debe duplicar turno abierto');
    console.log('✓ anti-duplicado de turno');

    // 4. Subir fórmula (imagen dummy)
    const imagenFake = Buffer.from('x'.repeat(400)).toString('base64');
    const formula = await api('/api/formulas', {
      method: 'POST',
      body: JSON.stringify({ turno_id: turno.data.id, imagen_base64: imagenFake }),
    });
    assert.strictEqual(formula.status, 201);
    assert.strictEqual(formula.data.ocr_estado, 'PENDIENTE');
    console.log('✓ subir fórmula');

    // 5. OCR sin API key: error claro (502), nunca cuelga
    const ocr = await api(`/api/formulas/${formula.data.id}/ocr`, { method: 'POST' });
    assert.strictEqual(ocr.status, 502);
    assert.ok(/API key/i.test(ocr.data.error), 'error debe mencionar la API key');
    console.log('✓ OCR sin API key falla con mensaje claro');

    // 6. Validación contra inventario (simula salida del OCR)
    const validacion = await api('/api/validar', {
      method: 'POST',
      body: JSON.stringify({
        medicamentos: [
          { nombre: 'losartan', concentracion: '50mg', cantidad: 30 },
          { nombre: 'Medicina Inexistente', cantidad: 10 },
        ],
      }),
    });
    assert.strictEqual(validacion.status, 200);
    assert.strictEqual(validacion.data[0].disponible, true, 'Losartán disponible');
    assert.strictEqual(validacion.data[0].medicamento_id, losartan.id);
    assert.strictEqual(validacion.data[1].medicamento_id, null, 'inexistente sin match');
    console.log('✓ validación contra inventario (con matching sin tildes)');

    // 7. Llamar y pasar a despacho
    const llamado = await api(`/api/turnos/${turno.data.id}/estado`, {
      method: 'PUT',
      body: JSON.stringify({ estado: 'LLAMANDO', modulo_asignado: 2 }),
    });
    assert.strictEqual(llamado.data.estado, 'LLAMANDO');
    assert.strictEqual(llamado.data.modulo_asignado, 2);
    console.log('✓ llamado a módulo');

    // 8. Entrega: descuenta inventario FEFO y firma comprobante
    const entrega = await api('/api/entregas', {
      method: 'POST',
      body: JSON.stringify({
        turno_id: turno.data.id,
        items: [{ medicamento_id: losartan.id, cantidad: 30 }],
        usuario: 'smoke-test',
      }),
    });
    assert.strictEqual(entrega.status, 201);
    assert.strictEqual(entrega.data.id, 'ENT-00001');
    assert.ok(/^[0-9a-f]{64}$/.test(entrega.data.firma), 'firma HMAC presente');
    assert.strictEqual(entrega.data.medicamentos[0].cantidad, 30);
    console.log('✓ entrega con comprobante firmado');

    // 9. Stock descontado
    const meds2 = await api('/api/medicamentos');
    const losartan2 = meds2.data.find(m => m.id === losartan.id);
    assert.strictEqual(losartan2.stock, 70, 'stock descontado a 70');
    console.log('✓ inventario descontado (FEFO)');

    // 10. No se puede entregar dos veces
    const doble = await api('/api/entregas', {
      method: 'POST',
      body: JSON.stringify({ turno_id: turno.data.id, items: [{ medicamento_id: losartan.id, cantidad: 1 }] }),
    });
    assert.strictEqual(doble.status, 400);
    console.log('✓ anti doble entrega');

    // 11. Paciente finaliza y consulta historial
    const fin = await api(`/api/turnos/${turno.data.id}/finalizar`, { method: 'POST' });
    assert.strictEqual(fin.data.estado, 'FINALIZADO');
    const historial = await api('/api/historial?tipo_documento=CC&numero_documento=1121888926');
    assert.strictEqual(historial.data.length, 1);
    assert.strictEqual(historial.data[0].codigo, 'ENT-00001');
    console.log('✓ finalizar + historial del paciente');

    // 12. Dashboard y auditoría
    const dash = await api('/api/dashboard');
    assert.strictEqual(dash.data.turnos_hoy, 1);
    assert.strictEqual(dash.data.atendidos, 1);
    const audit = await api('/api/auditoria');
    assert.ok(audit.data.some(a => a.accion === 'ENTREGA'), 'entrega auditada');
    console.log('✓ dashboard + auditoría');

    // 13. Emparejamiento con PIN incorrecto es rechazado
    const mal = await api('/api/emparejar', {
      method: 'POST',
      body: JSON.stringify({ rol: 'despachador', pin: '000000', nombre: 'intruso' }),
    });
    assert.strictEqual(mal.status, 401);
    console.log('✓ PIN incorrecto rechazado');

    console.log('\n✅ Smoke test COMPLETO: todos los chequeos pasaron.');
  } catch (e) {
    fallo = e;
  } finally {
    servidor.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  if (fallo) {
    console.error('\n❌ Smoke test FALLÓ:', fallo.message);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
