# Changelog

## v0.5.0 — 2026-07-10

### Entregas parciales y saldos pendientes (falta de stock)
- Al despachar (panel admin y Asistente), cada medicamento tiene ahora columnas
  **"Entregar"** y **"Queda pendiente"**: si el stock no alcanza lo prescrito, se
  entrega lo disponible y el resto queda registrado como **saldo pendiente** a
  nombre del paciente (se sugiere automáticamente según el stock).
- Cuando el paciente regresa, al abrir su despacho aparece el aviso
  **"⏳ Este paciente tiene medicamentos pendientes"** con botón *➕ Entregar*
  que agrega el saldo a la entrega; al confirmarse, el pendiente se reduce o salda.
- **Consulta de pendientes por documento** en el Asistente (botón "⏳ Consultar
  pendientes") para saber cuánto se le debe a un paciente sin abrir un turno.
- El comprobante muestra "⏳ Quedan N pendientes" y todo queda auditado
  (PENDIENTE_CREADO / PENDIENTE_PARCIAL / PENDIENTE_SALDADO).

### Asistente
- **Buscador de turnos** (documento, nombre o número) y filtro por estado.
- Cambio de módulo con botones (window.prompt no existe en Electron).

## v0.4.1 — 2026-07-10

- **Asistente: la cámara ya funciona al adjuntar fórmulas.** Chromium bloquea
  `navigator.mediaDevices` en orígenes http remotos; el Asistente ahora marca el
  origen del servidor como seguro al arrancar (y se relanza una sola vez cuando
  se conecta a un servidor nuevo).
- **App del paciente: el historial de entregas muestra la fecha y hora** en que
  se entregó cada fórmula (antes solo aparecía la fecha del turno).

## v0.4.0 — 2026-07-09

### Correcciones
- **Asistente**: corregido el error `ERR_SOCKET_DGRAM_NOT_RUNNING` al arrancar
  (los reenvíos del autodescubrimiento UDP disparaban con el socket ya cerrado).
- **Aislamiento por módulo**: un despachador/asistente ya no puede despachar los
  turnos llamados por otro módulo (ni en la app Android ni en el Asistente);
  se muestran como "Lo atiende el módulo N".

### Mejoras
- **Adjuntar fórmula desde el escritorio** (panel admin y Asistente): si el paciente
  no la adjuntó, el modal de despacho permite 📷 tomar foto con la cámara
  (con selector de dispositivos disponibles), 🖼 subir imagen o 📄 subir PDF
  (renderizado local con pdf.js vendorizado, funciona offline).
- **Inventario (app Android)**: la fecha de vencimiento del lote ahora usa un
  selector de calendario (DatePicker) en lugar de digitarla.
- **Kiosko de autoservicio ajustado a pantalla**: tamaños en función de la altura
  (clamp/vh) para que el teclado, el botón de solicitar y la pantalla del ticket
  encajen sin desplazamientos en TVs y tablets.

## v0.3.0 — 2026-07-09

### Nueva app: Dispensario Asistente (MSI)
- Cliente de escritorio para los módulos de atención en Windows: **solo turnos y despacho**
  (asignar turno, llamar, OCR, buscador, entregar). Sin acceso a administración.
- Autodescubrimiento del servidor por UDP + conexión manual de respaldo.
- Ingreso con **PIN de despachador + selección de módulo**; el módulo queda en cada entrega.

### Ticket térmico en el kiosko de autoservicio
- Impresión ESC/POS por red (RAW 9100) para **Epson TM-T20IVL** y compatibles:
  80 mm, 576 puntos, número de turno gigante, QR nativo y **corte automático**.
- Botón "🖨 Imprimir mi ticket" para quien no tenga la app.
- **Búsqueda de impresoras en la red** desde el kiosko (⚙) y desde el panel; la selección
  queda enlazada en el servidor.
- **Personalización del ticket en el panel**: logo PNG (impreso en B/N), nombre, fecha,
  PIN, QR y mensaje de pie configurables + impresión de prueba.

### Panel y servidor
- PIN de sesión del rol **Inventario** ahora visible en Configuración (faltaba).
- Historial de entregas con columna **Módulo** (app de despachador, asistente o panel).
- Despachador en Android: al entrar **elige su módulo**; queda predeterminado al llamar
  y se registra en el comprobante de entrega.

## v0.2.0 — 2026-07-09

### Android
- **APK Paciente separado** (`TurnosDispensario-Paciente-vX.apk`): solo el rol paciente,
  sin selección de roles ni datos técnicos; muestra únicamente "Servidor 🟢 Conectado / 🔴 Sin conexión".
- **Fórmulas en PDF** (paciente y despachador): las páginas se renderizan localmente
  (PdfRenderer, máx. 8) y el OCR ignora las hojas de historia clínica, leyendo solo la fórmula.
- **Despachador**: puede adjuntar la fórmula física (foto, imagen o PDF) y agregar
  medicamentos con un **buscador** (sin OCR). Toda entrega exige fórmula adjunta.
- **Nuevo rol Inventario (almacenista)**: catálogo con stock, alta de medicamentos y
  entradas de lote, con **escáner de código de barras** (Google code-scanner, reciclado
  de SeguimientoPrecios).

### Escritorio
- Despacho con **buscador de medicamentos** (nombre, principio activo o código).
- Campo Código de medicamento con **escáner de código de barras por cámara**
  (ZXing sobre `<video>`, reciclado de SeguimientoPrecios).
- Visor de fórmulas multipágina en el modal de despacho.

### Servidor
- Rol `inventario` con PIN de sesión propio y permisos sobre catálogo e inventario.
- `POST /api/formulas` acepta `imagenes_base64[]` (multipágina); OCR multi-imagen.
- Regla de negocio: **no se despacha sin fórmula médica adjunta**.
- Release publica 2 APKs (staff + paciente) nombrados con el tag.

## v0.1.0 — 2026-07-09

Primera versión funcional del ecosistema completo.

### Escritorio (MSI)
- Servidor local Electron + Express + WebSocket + SQLite (sql.js, sin dependencias nativas).
- Panel de administración: dashboard (turnos, espera promedio, inventario, vencimientos),
  turnos con filtros, catálogo de medicamentos, inventario por lotes con ajuste y alertas
  de vencimiento, historial de entregas con comprobantes firmados y auditoría.
- Despacho asistido: ver fórmula, OCR con OpenAI Vision, validación contra inventario y
  entrega con descuento FEFO + comprobante HMAC-SHA256.
- Pantalla pública del turnero (`display.html`, modo oscuro) y kiosko táctil de
  autoservicio (`kiosko.html`) con QR offline.
- PINs de sesión por rol + tokens de dispositivo revocables.
- Autodescubrimiento UDP (puerto 18400).

### Android (APK)
- Rol Paciente: turno con QR/PIN, foto de fórmula (cámara o galería, comprimida a 1600 px),
  vibración al llamado, comprobante de entrega e historial. Cola offline con reintento.
- Rol Despachador: lista de turnos, llamado a módulo, imagen de la fórmula, OCR con IA,
  validación contra inventario y confirmación de entrega.
- Rol Kiosko: pantalla del turnero o punto de turnos, a pantalla completa con reconexión.
- Icono adaptativo (todas las densidades, monochrome incluido) + banner Android TV.

### Infraestructura
- CI: sintaxis + smoke test end-to-end de la API + compilación del APK debug.
- Release por tag `v*`: MSI + APK firmado nombrados con el tag; solo se conserva la
  última release (las anteriores se eliminan junto con sus tags).
- Generador determinístico de iconos (ICO multiresolución + mipmaps PNG) sin dependencias.
