# Changelog

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
