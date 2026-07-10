'use strict';
/**
 * Adjuntar fórmula médica desde el escritorio (panel admin y app Asistente):
 *  - 📷 Cámara: getUserMedia con selector de dispositivos y captura a foto.
 *  - 🖼 Imagen: archivo local, redimensionada a máx. 1600 px.
 *  - 📄 PDF: renderizado local con pdf.js (máx. 8 páginas); el OCR del servidor
 *    ignora las páginas de historia clínica.
 * Uso: AdjuntarFormula.abrir(turnoId, { token, onSubida }) — crea su propio modal.
 */
const AdjuntarFormula = (() => {
  let turnoId = null;
  let token = '';
  let onSubida = null;
  let streamCamara = null;

  function h(html) {
    const div = document.createElement('div');
    div.innerHTML = html.trim();
    return div.firstChild;
  }

  function asegurarModal() {
    if (document.getElementById('adj-fondo')) return;
    const modal = h(`
      <div id="adj-fondo" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);align-items:center;justify-content:center;z-index:30;">
        <div style="background:white;border-radius:12px;padding:1.4rem;width:min(640px,94vw);max-height:90vh;overflow:auto;">
          <h3 style="margin-bottom:.6rem;">📎 Adjuntar fórmula médica</h3>
          <p style="font-size:.8rem;color:#64748B;margin-bottom:.8rem;">
            Para cuando el paciente trae la fórmula en físico o en PDF y no la adjuntó desde su app.</p>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
            <button class="accion" id="adj-btn-camara">📷 Tomar foto con cámara</button>
            <label class="accion" style="cursor:pointer;">🖼 Imagen
              <input id="adj-file-img" type="file" accept="image/*" style="display:none;"></label>
            <label class="accion" style="cursor:pointer;">📄 PDF
              <input id="adj-file-pdf" type="file" accept="application/pdf" style="display:none;"></label>
          </div>
          <div id="adj-zona-camara" style="display:none;margin-top:.8rem;">
            <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.4rem;">
              <label style="font-size:.8rem;color:#64748B;">Cámara:</label>
              <select id="adj-cam" style="flex:1;padding:.35rem;border:1px solid #DEE6EB;border-radius:6px;"></select>
            </div>
            <video id="adj-video" muted autoplay playsinline style="width:100%;border-radius:8px;background:#000;"></video>
            <div style="text-align:center;margin-top:.5rem;">
              <button class="accion primario" id="adj-capturar" style="font-size:1rem;padding:.6rem 1.4rem;">📸 Capturar fórmula</button>
            </div>
          </div>
          <p id="adj-msg" style="font-size:.85rem;color:#0E7490;margin-top:.8rem;min-height:1.2rem;"></p>
          <div style="display:flex;justify-content:flex-end;margin-top:.6rem;">
            <button class="accion" id="adj-cerrar">Cerrar</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(modal);
    document.getElementById('adj-cerrar').onclick = cerrar;
    document.getElementById('adj-btn-camara').onclick = abrirCamara;
    document.getElementById('adj-capturar').onclick = capturar;
    document.getElementById('adj-file-img').onchange = (e) => {
      if (e.target.files[0]) subirImagen(e.target.files[0]);
      e.target.value = '';
    };
    document.getElementById('adj-file-pdf').onchange = (e) => {
      if (e.target.files[0]) subirPdf(e.target.files[0]);
      e.target.value = '';
    };
  }

  function msg(t) { document.getElementById('adj-msg').textContent = t; }

  function abrir(id, opts = {}) {
    asegurarModal();
    turnoId = id;
    token = opts.token || '';
    onSubida = opts.onSubida || null;
    msg('');
    document.getElementById('adj-zona-camara').style.display = 'none';
    document.getElementById('adj-fondo').style.display = 'flex';
  }

  function cerrar() {
    detenerCamara();
    document.getElementById('adj-fondo').style.display = 'none';
  }

  // ---- Cámara (con selector de dispositivos disponibles) ----
  async function iniciarStream(deviceId) {
    detenerCamara();
    streamCamara = await navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    document.getElementById('adj-video').srcObject = streamCamara;
  }

  async function abrirCamara() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg('La cámara no está disponible en esta ventana. Actualiza la app Asistente a la última versión y ábrela de nuevo.');
      return;
    }
    document.getElementById('adj-zona-camara').style.display = 'block';
    try {
      await iniciarStream(null);
      msg('Encuadra la fórmula y presiona Capturar.');
      // Con el permiso concedido ya hay etiquetas: poblar el selector de cámaras
      const dispositivos = await navigator.mediaDevices.enumerateDevices();
      const cams = dispositivos.filter(d => d.kind === 'videoinput');
      const sel = document.getElementById('adj-cam');
      sel.innerHTML = cams.map((c, i) =>
        `<option value="${c.deviceId}">${c.label || ('Cámara ' + (i + 1))}</option>`).join('');
      sel.onchange = () => iniciarStream(sel.value).catch(e => msg('No se pudo cambiar de cámara: ' + e.message));
    } catch (e) {
      msg('No se pudo abrir la cámara: ' + (e.message || e));
    }
  }

  function detenerCamara() {
    if (streamCamara) {
      streamCamara.getTracks().forEach(t => t.stop());
      streamCamara = null;
    }
  }

  function capturar() {
    const video = document.getElementById('adj-video');
    if (!streamCamara || !video.videoWidth) { msg('La cámara aún no está lista.'); return; }
    const canvas = document.createElement('canvas');
    const escala = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * escala);
    canvas.height = Math.round(video.videoHeight * escala);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    detenerCamara();
    document.getElementById('adj-zona-camara').style.display = 'none';
    enviar([canvas.toDataURL('image/jpeg', 0.85)]);
  }

  // ---- Imagen de archivo ----
  function subirImagen(archivo) {
    msg('Procesando imagen…');
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const escala = Math.min(1, 1600 / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      enviar([canvas.toDataURL('image/jpeg', 0.85)]);
    };
    img.onerror = () => msg('No se pudo leer la imagen.');
    img.src = URL.createObjectURL(archivo);
  }

  // ---- PDF (pdf.js, renderizado local) ----
  async function subirPdf(archivo) {
    if (typeof pdfjsLib === 'undefined') { msg('La librería PDF no está disponible.'); return; }
    msg('Renderizando PDF…');
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: await archivo.arrayBuffer() }).promise;
      const total = Math.min(pdf.numPages, 8);
      const paginas = [];
      for (let i = 1; i <= total; i++) {
        msg(`Renderizando página ${i} de ${total}…`);
        const page = await pdf.getPage(i);
        let viewport = page.getViewport({ scale: 2 });
        const escala = Math.min(1, 1600 / Math.max(viewport.width, viewport.height)) * 2;
        viewport = page.getViewport({ scale: escala });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        paginas.push(canvas.toDataURL('image/jpeg', 0.85));
      }
      enviar(paginas);
    } catch (e) {
      msg('No se pudo leer el PDF: ' + (e.message || e));
    }
  }

  // ---- Subida al servidor ----
  async function enviar(dataUrls) {
    msg(`Subiendo fórmula (${dataUrls.length} página(s))…`);
    try {
      const r = await fetch('/api/formulas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-TOKEN': token } : {}) },
        body: JSON.stringify({
          turno_id: turnoId,
          imagenes_base64: dataUrls.map(u => u.replace(/^data:image\/\w+;base64,/, '')),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { msg('⚠ ' + (d.error || 'Error subiendo la fórmula')); return; }
      msg('✅ Fórmula adjuntada correctamente.');
      if (onSubida) onSubida();
      setTimeout(cerrar, 900);
    } catch (e) {
      msg('⚠ Sin conexión con el servidor.');
    }
  }

  return { abrir };
})();
