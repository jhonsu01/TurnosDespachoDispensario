# 💊 Turnos Dispensario

Sistema inteligente de dispensario de medicamentos con turnero, **OCR de fórmulas médicas con IA** e inventario por lotes. **Offline-first** y de red local:

| Componente | Tecnología | Entregable |
| --- | --- | --- |
| 🖥️ Escritorio (servidor + panel admin) | Electron + Express + WebSocket + SQLite | Instalador **MSI** |
| 📱 App móvil multirol (paciente / despachador / kiosko) | Android (Kotlin) | **APK** |
| 📺 Pantallas informativas | Web en modo oscuro (`/display.html`) con marquesina configurable | Servida por el escritorio |
| 🎫 Kiosko de autoservicio | Web táctil (`/kiosko.html`) con QR del turno | Servida por el escritorio |

Los instaladores se publican automáticamente en la sección **[Releases](../../releases)** de este repositorio (solo se conserva la última versión; los binarios se nombran con el tag).

## Arquitectura

```
[APP ANDROID] ←— WiFi local (autodescubrimiento UDP :18400) —→ [SERVIDOR LOCAL (DESKTOP)]
                                                                  │  API REST + WebSocket + SQLite
                                                                  │  OCR → OpenAI Vision (opcional)
                                                                  ▼
                                                      [PANTALLAS TV / KIOSKO DE TURNOS]
```

- **Offline-first**: todo funciona en red local, sin internet. La app encola la solicitud de turno
  y reintenta automáticamente si pierde conexión. Solo el OCR requiere internet (OpenAI).
- **Autodescubrimiento**: la app encuentra el servidor sola por broadcast UDP (puerto 18400).
- **Comprobantes firmados** con HMAC-SHA256, descargables en JSON desde el panel.
- **Auditoría completa** de emparejamientos, OCR, inventario y entregas.

## Roles

| Rol | Dónde | Emparejamiento | Qué hace |
| --- | --- | --- | --- |
| 👤 **Paciente** | App Android | Sin PIN (se identifica con su documento) | Solicita turno (QR + PIN), **fotografía y adjunta su fórmula médica**, vibra al ser llamado, recibe su comprobante y consulta su historial |
| 💊 **Despachador** | App Android o panel | PIN de sesión → token | Llama turnos al módulo, ve la fórmula, **ejecuta el OCR con IA**, valida contra inventario y confirma la entrega |
| 🗃 **Almacenista / Administrador** | Panel de escritorio | Solo desde el equipo servidor | Catálogo de medicamentos, entradas de inventario por lote, vencimientos, dashboard, auditoría, configuración e IA |
| 📺 **Kiosko** | App Android (TV/tablet) o navegador | PIN de sesión → token (una sola vez) | Pantalla del turnero a pantalla completa o punto de autoservicio de turnos |

## Flujo del sistema

1. **Turno**: el paciente lo solicita desde la app o el kiosko (documento) → número, QR y PIN.
2. **Fórmula**: el paciente fotografía su fórmula médica desde la app (cámara o galería).
3. **OCR con IA**: el despachador ejecuta la lectura (OpenAI Vision) → JSON de medicamentos
   `{nombre, concentración, presentación, cantidad}` con interpretación de abreviaturas.
4. **Validación**: el sistema cruza el resultado contra el inventario (matching sin tildes,
   por nombre o principio activo) → disponible / no disponible con stock.
5. **Llamado**: pantalla TV + vibración del teléfono, con módulo asignado.
6. **Entrega**: validación humana obligatoria; al confirmar se descuenta el inventario por
   lotes **FEFO** (primero el que vence) y se genera el comprobante firmado `ENT-#####`.
7. **Ausencias**: timeout configurable → NO_PRESENTADO automático.

Estados del turno: `CREADO → ESPERANDO → LLAMANDO → DESPACHO → ENTREGADO → FINALIZADO` (+ `NO_PRESENTADO`).

## OCR con IA

- Configura tu API key de OpenAI en **Panel → Configuración → OCR con IA** (se guarda solo en
  la base local del equipo servidor).
- Modelo por defecto: `gpt-4o-mini` (configurable).
- El sistema exige **validación humana** antes de entregar: el OCR propone, el despachador confirma.
- Sin API key, todo lo demás funciona; el botón de OCR devuelve un error claro.

## Seguridad

- Roles elevados emparejados con **PINs de sesión aleatorios de 6 dígitos** generados en cada
  arranque (visibles en el panel). El PIN se ingresa **una sola vez por dispositivo**: el
  emparejamiento entrega un token persistente, revocable desde el panel.
- Las rutas administrativas solo aceptan conexiones desde el propio equipo servidor.
- El documento del paciente se enmascara en las vistas públicas del turnero.
- Registro de auditoría de todas las acciones sensibles.

## Desarrollo

```bash
# Servidor de escritorio
cd desktop
npm install
npm start            # abre el panel en Electron
npm run dist         # genera el MSI en desktop/dist/

# Smoke test de la API (el mismo que corre en CI)
node ../.ci/smoke-test.js

# APK Android
cd android
./gradlew assembleRelease   # requiere JDK 17

# Regenerar iconos (ICO Windows + mipmaps Android)
node execution/generar_iconos.js
```

## Releases automáticas

Al hacer push de un tag `v*`:

1. Se compila el **MSI** en Windows y el **APK** firmado en Linux.
2. Los binarios se renombran con el tag: `TurnosDispensario-v0.1.0.msi` / `.apk`.
3. Se **eliminan todas las releases y tags anteriores** (solo queda la última).
4. Se publica la release con notas generadas automáticamente.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

## Licencia

MIT — © Jhon Supelano
