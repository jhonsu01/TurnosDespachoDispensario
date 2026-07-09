# Changelog

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
