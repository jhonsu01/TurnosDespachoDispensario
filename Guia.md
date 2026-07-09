# 🧠 Guía para IA: Sistema Inteligente de Dispensario de Medicamentos con Turnero, OCR e Inventario

## 1. Objetivo General

Construir un ecosistema compuesto por:

- Aplicación Windows MSI servidor.
- Aplicación Android APK para pacientes/clientes.
- Kiosko digital de turnos.
- Pantallas informativas modo oscuro.
- Sistema offline-first con sincronización local.

El sistema permitirá:

- Gestión de turnos.
- Lectura de fórmulas médicas mediante OCR con IA.
- Extracción automática de medicamentos.
- Validación contra inventario.
- Despacho controlado.
- Registro de entregas.
- Auditoría completa.

---

# 2. Arquitectura

## Componentes

### Servidor Windows MSI

Responsable de:

- Administración general.
- Usuarios.
- Roles.
- Inventario.
- Configuración.
- Reportes.
- Sincronización.

### Aplicación Android

Funciones:

- Solicitar turno.
- Escanear QR.
- Registrar documento.
- Capturar fórmula.
- Recibir notificaciones.
- Consultar estado.
- Recibir comprobante.

### Kiosko

Funciones:

- Generación de turnos.
- Código QR.
- Pantalla pública.
- Información de atención.

---

# 3. Roles

## Administrador

Permisos:

- Crear usuarios.
- Configurar módulos.
- Gestionar inventario.
- Ver auditorías.
- Configurar IA.

## Almacenista

Funciones:

- Registrar medicamentos.
- Gestionar lotes.
- Controlar vencimientos.
- Entrada y salida de inventario.

## Despachador

Funciones:

- Atender turnos.
- Revisar fórmula.
- Validar medicamentos.
- Confirmar entrega.

## Kiosko

Funciones:

- Crear turnos.
- Mostrar estado.

---

# 4. Flujo del Sistema

## Paso 1: Creación del turno

Paciente:

- Escanea QR.
- Ingresa documento.
- Solicita turno.
- Adjunta fórmula.

---

## Paso 2: OCR Inteligente

Proceso:

Imagen fórmula médica

↓

OpenAI Vision API

↓

Texto estructurado

↓

JSON medicamentos


Ejemplo:

```json
{
 "medicamentos":[
 {
 "nombre":"Losartan",
 "concentracion":"50mg",
 "cantidad":30
 }
 ]
}
```

---

# 5. Validación Inventario

Comparación:

Formula médica:

- Nombre.
- Concentración.
- Presentación.
- Cantidad.

Inventario:

- Existencias.
- Lotes.
- Vencimiento.

Resultado:

Disponible / No disponible.

---

# 6. Sistema de Turnos

Estados:

```
CREADO
ESPERANDO
LLAMANDO
DESPACHO
ENTREGADO
FINALIZADO
```

Cuando el turno es llamado:

- Vibración móvil.
- Aviso en pantalla.
- Módulo asignado.

---

# 7. Entrega Medicamentos

El despachador confirma:

- Paciente.
- Documento.
- Medicamentos.
- Cantidades.

Genera comprobante JSON.

Ejemplo:

```json
{
 "id":"ENT-00001",
 "paciente":"123456",
 "medicamentos":[
 {
 "nombre":"Metformina",
 "cantidad":30
 }
 ],
 "fecha":"2026-07-09"
}
```

---

# 8. Base de Datos

## Pacientes

Campos:

- ID
- Documento
- Nombre
- Teléfono


## Medicamentos

Campos:

- Código.
- Nombre.
- Principio activo.
- Concentración.
- Presentación.
- Laboratorio.


## Inventario

Campos:

- Medicamento.
- Lote.
- Cantidad.
- Fecha vencimiento.


## Fórmulas

Campos:

- Imagen.
- OCR.
- Fecha.
- Paciente.


## Turnos

Campos:

- Número.
- Estado.
- Módulo.
- Fecha.


## Entregas

Campos:

- Turno.
- Medicamentos.
- Usuario.
- Fecha.

---

# 9. OCR con Inteligencia Artificial

Usar OpenAI Vision API para:

- Leer fórmulas.
- Identificar medicamentos.
- Interpretar abreviaturas.
- Convertir texto a JSON.


Debe incluir validación humana antes de entregar.

---

# 10. Funcionamiento Offline

Comunicación:

- WiFi LAN.
- Bluetooth LE.


Sin internet:

Guardar localmente:

- Turnos.
- Fórmulas.
- Inventario.
- Entregas.


Cuando vuelva conexión:

Sincronización automática.

---

# 11. Seguridad

Implementar:

- Roles RBAC.
- PIN de emparejamiento.
- Logs.
- Auditoría.
- Control de sesiones.

---

# 12. Dashboard Administrador

Mostrar:

- Inventario actual.
- Medicamentos próximos a vencer.
- Turnos pendientes.
- Tiempo promedio atención.
- Historial entregas.

---

# 13. Tecnologías recomendadas

## Backend

- FastAPI Python
o
- NestJS


## Base datos

- PostgreSQL producción.
- SQLite local.


## Windows

- Electron.
- React.
- TypeScript.


## Android

- Kotlin Jetpack Compose.
o
- Flutter.

---

# 14. Futuras mejoras IA

- Reconocimiento de cajas de medicamentos.
- Predicción de consumo.
- Alertas inteligentes.
- Optimización automática de inventario.

---

# Prompt para IA desarrolladora

Construye este sistema completo como aplicación empresarial.

Debe incluir:

- Aplicación Windows MSI servidor.
- Aplicación Android APK.
- Kiosko digital.
- OCR mediante OpenAI Vision API.
- Inventario farmacéutico.
- Sistema de turnos.
- Sincronización offline.
- Seguridad por roles.
- Auditoría.
- Arquitectura escalable.
