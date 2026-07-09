'use strict';
/**
 * OCR de fórmulas médicas con OpenAI Vision (chat/completions).
 * Devuelve { medicamentos: [{ nombre, concentracion, presentacion, cantidad }] }.
 * La API key y el modelo se configuran desde el panel (tabla config).
 */
const https = require('https');

const PROMPT = `Eres un sistema OCR de fórmulas médicas de un dispensario.
Analiza la(s) imagen(es) adjuntas. Pueden ser varias páginas de un mismo documento
(por ejemplo un PDF con historia clínica + fórmula): IGNORA las páginas de historia
clínica, evoluciones, laboratorios o notas, y extrae los medicamentos SOLO de la(s)
página(s) que correspondan a la fórmula médica / prescripción.
Interpreta abreviaturas médicas comunes (tab=tableta, cap=cápsula, jbe=jarabe, amp=ampolla, c/8h, etc.).
Responde ÚNICAMENTE un JSON válido con esta estructura exacta:
{"medicamentos":[{"nombre":"...","concentracion":"...","presentacion":"...","cantidad":30}],"observaciones":"..."}
- "nombre": nombre comercial o principio activo del medicamento.
- "concentracion": ej "50mg", "500mg/5ml". Vacío si no se lee.
- "presentacion": Tableta / Cápsula / Jarabe / Inhalador / Ampolla / Crema. Vacío si no se lee.
- "cantidad": número total de unidades a entregar (calcula dosis x días si aplica). Usa 1 si no es claro.
- "observaciones": dudas de lectura o texto ilegible.
Si la imagen no es una fórmula médica, devuelve {"medicamentos":[],"observaciones":"No parece una fórmula médica"}.`;

function llamarOpenAi(apiKey, modelo, imagenesBase64) {
  const payload = JSON.stringify({
    model: modelo || 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        ...imagenesBase64.map(b64 => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' },
        })),
      ],
    }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 90000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (res.statusCode !== 200) {
            return reject(new Error(body.error?.message || `OpenAI respondió ${res.statusCode}`));
          }
          resolve(body.choices[0].message.content);
        } catch (e) {
          reject(new Error('Respuesta de OpenAI ilegible: ' + e.message));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Timeout consultando OpenAI (90s)')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Procesa una fórmula: llama a OpenAI Vision y normaliza el resultado.
 * Lanza Error con mensaje claro si no hay API key o la respuesta es inválida.
 */
async function procesarFormula({ apiKey, modelo, imagenBase64, imagenesBase64 }) {
  if (!apiKey) {
    throw new Error('No hay API key de OpenAI configurada. Ve a Configuración → OCR con IA.');
  }
  const paginas = imagenesBase64 || [imagenBase64];
  const contenido = await llamarOpenAi(apiKey, modelo, paginas.slice(0, 8));
  let json;
  try {
    json = JSON.parse(contenido);
  } catch (e) {
    throw new Error('El OCR no devolvió JSON válido');
  }
  if (!Array.isArray(json.medicamentos)) json.medicamentos = [];
  json.medicamentos = json.medicamentos.map(m => ({
    nombre: String(m.nombre || '').trim(),
    concentracion: String(m.concentracion || '').trim(),
    presentacion: String(m.presentacion || '').trim(),
    cantidad: Number(m.cantidad) > 0 ? Math.round(Number(m.cantidad)) : 1,
  })).filter(m => m.nombre);
  json.observaciones = String(json.observaciones || '');
  return json;
}

module.exports = { procesarFormula };
