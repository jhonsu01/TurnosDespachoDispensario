package com.dispensario.turnos

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.InputType
import android.util.Base64
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val tiposDoc = listOf("CC", "CE", "NIT", "PASAPORTE", "TI")

    private lateinit var prefs: android.content.SharedPreferences
    private var api: ApiClient? = null
    private var rolElegido: String? = null

    // Paciente
    private var turnoActivo: Long = -1
    private var estadoAnterior: String? = null
    private var fotoUri: Uri? = null
    private var fotoArchivo: File? = null

    // Despachador
    private var turnoDespachoId: Long = -1
    private var formulaActualId: Long = -1
    private var itemsEntrega: JSONArray = JSONArray()

    private var tareaPeriodica: Runnable? = null
    private var reintento: Runnable? = null

    private val tomarFoto = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (ok && fotoArchivo != null) subirFormulaDesdeArchivo(fotoArchivo!!)
    }

    private val elegirImagen = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) subirFormulaDesdeUri(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = getSharedPreferences("dispensario", Context.MODE_PRIVATE)

        findViewById<Spinner>(R.id.spinnerTipoDoc).adapter =
            ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, tiposDoc)

        // Selección de rol
        findViewById<Button>(R.id.btnRolPaciente).setOnClickListener { elegirRol("paciente") }
        findViewById<Button>(R.id.btnRolDespachador).setOnClickListener { elegirRol("despachador") }
        findViewById<Button>(R.id.btnRolKiosko).setOnClickListener { elegirRol("kiosko") }

        // Conexión
        findViewById<Button>(R.id.btnConectar).setOnClickListener { conectar() }
        findViewById<Button>(R.id.btnBuscar).setOnClickListener { buscarServidor() }
        findViewById<Button>(R.id.btnVolverRol).setOnClickListener { mostrarVista(R.id.vistaRol) }

        // Paciente
        findViewById<Button>(R.id.btnSolicitar).setOnClickListener { solicitarTurno() }
        findViewById<Button>(R.id.btnHistorial).setOnClickListener { mostrarHistorial() }
        findViewById<Button>(R.id.btnNuevoTurno).setOnClickListener { terminarTurnoCliente() }
        findViewById<Button>(R.id.btnFormulaCamara).setOnClickListener { abrirCamara() }
        findViewById<Button>(R.id.btnFormulaGaleria).setOnClickListener { elegirImagen.launch("image/*") }

        // Despachador
        findViewById<Button>(R.id.btnOcr).setOnClickListener { ejecutarOcr() }
        findViewById<Button>(R.id.btnEntregar).setOnClickListener { confirmarEntrega() }
        findViewById<Button>(R.id.btnVolverLista).setOnClickListener { entrarDespacho() }

        // Cambiar rol / servidor
        val reset = View.OnClickListener { cambiarRol() }
        findViewById<Button>(R.id.btnCambiarServidor).setOnClickListener(reset)
        findViewById<Button>(R.id.btnCambiarRolDespacho).setOnClickListener(reset)

        restaurarSesion()
    }

    override fun onDestroy() {
        super.onDestroy()
        detenerPeriodica()
        reintento?.let { ui.removeCallbacks(it) }
        io.shutdownNow()
    }

    override fun onResume() {
        super.onResume()
        // Al volver del kiosko con el rol borrado, regresar a la selección
        if (rolElegido == "kiosko" && prefs.getString("rol", null) == null) {
            mostrarVista(R.id.vistaRol)
            rolElegido = null
        }
    }

    // ---------- Navegación ----------
    private fun mostrarVista(id: Int) {
        detenerPeriodica()
        val vistas = listOf(
            R.id.vistaRol, R.id.vistaConfig, R.id.vistaRegistro, R.id.vistaTurno,
            R.id.vistaDespacho, R.id.vistaDespachoDetalle,
        )
        for (v in vistas) findViewById<View>(v).visibility = if (v == id) View.VISIBLE else View.GONE
    }

    private fun estadoConexion(texto: String) {
        findViewById<TextView>(R.id.txtEstadoConexion).text = texto
    }

    private fun detenerPeriodica() {
        tareaPeriodica?.let { ui.removeCallbacks(it) }
        tareaPeriodica = null
    }

    private fun iniciarPeriodica(intervaloMs: Long, accion: () -> Unit) {
        detenerPeriodica()
        val t = object : Runnable {
            override fun run() {
                accion()
                ui.postDelayed(this, intervaloMs)
            }
        }
        tareaPeriodica = t
        ui.post(t)
    }

    private fun cambiarRol() {
        prefs.edit().remove("rol").remove("turno_id").apply()
        rolElegido = null
        mostrarVista(R.id.vistaRol)
    }

    private fun restaurarSesion() {
        val rol = prefs.getString("rol", null)
        val host = prefs.getString("host", null)
        if (rol == null || host == null) {
            mostrarVista(R.id.vistaRol)
            return
        }
        rolElegido = rol
        val cliente = ApiClient(host, prefs.getInt("puerto", 3000), prefs.getString("token", "") ?: "")
        api = cliente
        estadoConexion("Servidor: $host:${prefs.getInt("puerto", 3000)} · rol: $rol")

        // Roles elevados: verificar que el acceso no haya sido revocado desde el panel
        if (rol in listOf("despachador", "kiosko")) {
            io.execute {
                val vigente = try {
                    val info = cliente.ping()
                    info.optString("rol") == rol || info.optString("rol") == "admin"
                } catch (e: Exception) {
                    true // sin red por ahora: entrar igual, las llamadas reintentarán
                }
                ui.post {
                    if (!vigente) {
                        toast("El acceso de este dispositivo fue revocado")
                        cambiarRol()
                    } else {
                        when (rol) {
                            "kiosko" -> startActivity(Intent(this, KioskActivity::class.java))
                            "despachador" -> entrarDespacho()
                        }
                    }
                }
            }
            return
        }

        // Paciente
        val turnoGuardado = prefs.getLong("turno_id", -1)
        if (turnoGuardado > 0) {
            turnoActivo = turnoGuardado
            mostrarVista(R.id.vistaTurno)
            iniciarPeriodica(3000) { consultarTurno() }
        } else {
            mostrarVista(R.id.vistaRegistro)
        }
    }

    // ---------- Vista 0: Rol ----------
    private fun elegirRol(rol: String) {
        rolElegido = rol
        mostrarVista(R.id.vistaConfig)
        // El paciente no necesita PIN; los roles elevados usan el PIN de sesión del panel
        findViewById<EditText>(R.id.inputPin).visibility =
            if (rol == "paciente") View.GONE else View.VISIBLE
        findViewById<EditText>(R.id.inputPin).setText("")
        findViewById<EditText>(R.id.inputPin).hint = when (rol) {
            "despachador" -> "PIN de sesión — Despachador (ver panel del PC)"
            "kiosko" -> "PIN de sesión — Kiosko (ver panel del PC)"
            else -> ""
        }
        buscarServidor()
    }

    // ---------- Vista 1: Conexión ----------
    private fun buscarServidor() {
        val txt = findViewById<TextView>(R.id.txtBusqueda)
        txt.text = "🔍 Buscando servidor en la red…"
        io.execute {
            val servidor = DiscoveryClient.buscarServidor(this)
            ui.post {
                if (servidor != null) {
                    findViewById<EditText>(R.id.inputServidor).setText(servidor.optString("ip"))
                    findViewById<EditText>(R.id.inputPuerto).setText(servidor.optInt("puerto", 3000).toString())
                    txt.text = "✅ Encontrado: ${servidor.optString("nombre")} (${servidor.optString("ip")})"
                    // El paciente no necesita PIN: conectar de una vez
                    if (rolElegido == "paciente") conectar()
                } else {
                    txt.text = "⚠ No se encontró el servidor automáticamente. " +
                        "Verifica que el equipo con Turnos Dispensario esté encendido en la misma red WiFi, " +
                        "o ingresa la IP manualmente."
                }
            }
        }
    }

    private fun conectar() {
        val host = findViewById<EditText>(R.id.inputServidor).text.toString().trim()
        val puerto = findViewById<EditText>(R.id.inputPuerto).text.toString().toIntOrNull() ?: 3000
        val pin = findViewById<EditText>(R.id.inputPin).text.toString().trim()
        val rol = rolElegido ?: return
        if (host.isEmpty()) { toast("No hay servidor. Usa la búsqueda o ingresa la IP."); return }
        if (rol != "paciente" && pin.isEmpty()) { toast("Ingresa el PIN de sesión que muestra el panel del PC"); return }

        estadoConexion("Conectando…")
        io.execute {
            try {
                if (rol == "paciente") {
                    // El paciente conecta sin PIN: se identifica con su documento
                    val cliente = ApiClient(host, puerto)
                    val info = cliente.ping()
                    ui.post {
                        api = cliente
                        prefs.edit().putString("host", host).putInt("puerto", puerto)
                            .remove("token").putString("rol", rol).apply()
                        estadoConexion("Conectado a ${info.optString("nombre", "servidor")} · rol: paciente")
                        mostrarVista(R.id.vistaRegistro)
                    }
                    return@execute
                }
                // Roles elevados: PIN de sesión -> token persistente del dispositivo
                val resultado = ApiClient(host, puerto)
                    .emparejar(rol, pin, "${Build.MANUFACTURER} ${Build.MODEL}")
                val token = resultado.getString("token")
                ui.post {
                    api = ApiClient(host, puerto, token)
                    prefs.edit().putString("host", host).putInt("puerto", puerto)
                        .putString("token", token).putString("rol", rol).apply()
                    estadoConexion("Conectado a ${resultado.optString("nombre_centro", "servidor")} · rol: $rol")
                    toast("Dispositivo emparejado ✓")
                    when (rol) {
                        "kiosko" -> elegirPantallaKiosko()
                        "despachador" -> entrarDespacho()
                    }
                }
            } catch (e: ApiException) {
                ui.post {
                    estadoConexion("Emparejamiento rechazado")
                    toast(e.message ?: "PIN de sesión incorrecto")
                }
            } catch (e: Exception) {
                ui.post {
                    estadoConexion("Sin conexión con $host:$puerto")
                    toast("No se pudo conectar. Verifica la red WiFi.")
                }
            }
        }
    }

    /** El kiosko puede ser la pantalla del turnero (TV) o el punto de autoservicio de turnos. */
    private fun elegirPantallaKiosko() {
        AlertDialog.Builder(this)
            .setTitle("📺 Modo Kiosko")
            .setMessage("¿Qué debe mostrar este dispositivo?")
            .setPositiveButton("Pantalla del turnero (TV)") { _, _ ->
                prefs.edit().putString("kiosko_pagina", "display.html").apply()
                startActivity(Intent(this, KioskActivity::class.java))
            }
            .setNegativeButton("Punto de turnos (autoservicio)") { _, _ ->
                prefs.edit().putString("kiosko_pagina", "kiosko.html").apply()
                startActivity(Intent(this, KioskActivity::class.java))
            }
            .setCancelable(false)
            .show()
    }

    // ---------- ROL PACIENTE ----------
    private fun solicitarTurno() {
        val cliente = api ?: return
        val tipoDoc = findViewById<Spinner>(R.id.spinnerTipoDoc).selectedItem.toString()
        val numeroDoc = findViewById<EditText>(R.id.inputDocumento).text.toString().trim()
        val nombre = findViewById<EditText>(R.id.inputNombre).text.toString().trim()
        val telefono = findViewById<EditText>(R.id.inputTelefono).text.toString().trim()
        if (numeroDoc.length < 3) { toast("Ingresa un número de documento válido"); return }

        prefs.edit().putString("pendiente", JSONObject()
            .put("tipo", tipoDoc).put("doc", numeroDoc)
            .put("nombre", nombre).put("tel", telefono).toString()).apply()
        estadoConexion("Solicitando turno…")
        intentarEnvioPendiente(cliente)
    }

    private fun intentarEnvioPendiente(cliente: ApiClient) {
        val pendiente = prefs.getString("pendiente", null) ?: return
        io.execute {
            try {
                val p = JSONObject(pendiente)
                val turno = cliente.crearTurno(
                    p.getString("tipo"), p.getString("doc"),
                    p.optString("nombre"), p.optString("tel"))
                ui.post {
                    prefs.edit().remove("pendiente").putLong("turno_id", turno.getLong("id")).apply()
                    turnoActivo = turno.getLong("id")
                    estadoAnterior = null
                    findViewById<TextView>(R.id.txtComprobante).visibility = View.GONE
                    findViewById<Button>(R.id.btnNuevoTurno).visibility = View.GONE
                    mostrarVista(R.id.vistaTurno)
                    pintarTurno(turno)
                    iniciarPeriodica(3000) { consultarTurno() }
                }
            } catch (e: ApiException) {
                ui.post {
                    prefs.edit().remove("pendiente").apply()
                    estadoConexion("Error: ${e.message}")
                    toast(e.message ?: "Solicitud rechazada")
                }
            } catch (e: Exception) {
                ui.post {
                    estadoConexion("Sin conexión — reintentando en 5 s…")
                    reintento = Runnable { intentarEnvioPendiente(cliente) }
                    ui.postDelayed(reintento!!, 5000)
                }
            }
        }
    }

    private fun consultarTurno() {
        val cliente = api ?: return
        if (turnoActivo <= 0) return
        io.execute {
            try {
                val t = cliente.turno(turnoActivo)
                ui.post { pintarTurno(t) }
            } catch (e: Exception) {
                ui.post { estadoConexion("Sin conexión — reintentando…") }
            }
        }
    }

    private fun pintarTurno(t: JSONObject) {
        estadoConexion("Servidor: ${prefs.getString("host", "")}:${prefs.getInt("puerto", 3000)} · rol: paciente")
        val numero = t.getInt("numero")
        val estado = t.getString("estado")
        val modulo = if (t.isNull("modulo_asignado")) null else t.getInt("modulo_asignado")

        findViewById<TextView>(R.id.txtNumeroTurno).text = String.format("%03d", numero)
        val txtEstado = findViewById<TextView>(R.id.txtEstadoTurno)
        val txtModulo = findViewById<TextView>(R.id.txtModulo)
        val btnNuevo = findViewById<Button>(R.id.btnNuevoTurno)
        val txtComprobante = findViewById<TextView>(R.id.txtComprobante)

        // Estado de la fórmula adjunta
        val numFormulas = t.optInt("num_formulas", 0)
        findViewById<TextView>(R.id.txtFormulaEstado).text = when {
            numFormulas == 0 -> "📎 Aún no has adjuntado tu fórmula médica"
            t.optString("ocr_estado") == "PROCESADA" -> "📄 Fórmula recibida y leída por el sistema ✓"
            else -> "📄 Fórmula recibida ✓ (pendiente de revisión)"
        }
        val botonesFormula = estado in listOf("ESPERANDO", "CREADO", "LLAMANDO", "DESPACHO")
        findViewById<Button>(R.id.btnFormulaCamara).visibility = if (botonesFormula) View.VISIBLE else View.GONE
        findViewById<Button>(R.id.btnFormulaGaleria).visibility = if (botonesFormula) View.VISIBLE else View.GONE

        when (estado) {
            "CREADO", "ESPERANDO" -> {
                txtEstado.text = "EN ESPERA"
                txtEstado.setTextColor(getColor(R.color.cian))
                txtModulo.text = "Espera a ser llamado"
            }
            "LLAMANDO" -> {
                txtEstado.text = "¡ES TU TURNO!"
                txtEstado.setTextColor(getColor(R.color.amarillo))
                txtModulo.text = "Acércate al módulo ${modulo ?: "-"}"
                if (estadoAnterior != "LLAMANDO") vibrar()
            }
            "DESPACHO" -> {
                txtEstado.text = "EN DESPACHO"
                txtEstado.setTextColor(getColor(R.color.amarillo))
                txtModulo.text = "Módulo ${modulo ?: "-"} — validando tu fórmula"
            }
            "ENTREGADO" -> {
                txtEstado.text = "MEDICAMENTOS ENTREGADOS ✓"
                txtEstado.setTextColor(getColor(R.color.verde))
                txtModulo.text = ""
                if (estadoAnterior != "ENTREGADO") {
                    vibrar()
                    mostrarComprobante()
                }
                btnNuevo.text = "Terminar"
                btnNuevo.visibility = View.VISIBLE
            }
            "FINALIZADO" -> {
                terminarTurnoCliente()
                return
            }
            "NO_PRESENTADO" -> {
                txtEstado.text = "NO PRESENTADO"
                txtEstado.setTextColor(getColor(R.color.rojo))
                txtModulo.text = "Solicita un nuevo turno"
                btnNuevo.text = getString(R.string.btn_nuevo_turno)
                btnNuevo.visibility = View.VISIBLE
                txtComprobante.visibility = View.GONE
                detenerPeriodica()
            }
        }
        estadoAnterior = estado
        if (estado in listOf("CREADO", "ESPERANDO", "LLAMANDO", "DESPACHO")) {
            btnNuevo.visibility = View.GONE
            txtComprobante.visibility = View.GONE
        }

        findViewById<TextView>(R.id.txtPinTurno).text = "PIN del turno: ${t.getString("codigo_pin")}"
        findViewById<ImageView>(R.id.imgQr).setImageBitmap(generarQr(t.getString("qr_code")))
    }

    /** Al ENTREGADO: consulta el comprobante y lo muestra. */
    private fun mostrarComprobante() {
        val cliente = api ?: return
        if (turnoActivo <= 0) return
        io.execute {
            try {
                val c = cliente.entrega(turnoActivo) ?: return@execute
                ui.post {
                    val sb = StringBuilder("COMPROBANTE ${c.getString("id")}\n")
                    val meds = c.getJSONArray("medicamentos")
                    for (i in 0 until meds.length()) {
                        val m = meds.getJSONObject(i)
                        sb.append("• ${m.getString("nombre")}: ${m.getInt("cantidad")} und\n")
                    }
                    sb.append("\nEntregado: ${c.getString("fecha").substring(0, 16).replace('T', ' ')}")
                    val txt = findViewById<TextView>(R.id.txtComprobante)
                    txt.text = sb.toString()
                    txt.visibility = View.VISIBLE
                }
            } catch (e: Exception) { /* siguiente intento */ }
        }
    }

    /** ENTREGADO -> FINALIZADO y limpia la vista para un nuevo turno. */
    private fun terminarTurnoCliente() {
        val cliente = api
        val turno = turnoActivo
        if (cliente != null && turno > 0 && estadoAnterior == "ENTREGADO") {
            io.execute { try { cliente.finalizarTurno(turno) } catch (e: Exception) { /* opcional */ } }
        }
        turnoActivo = -1
        estadoAnterior = null
        prefs.edit().remove("turno_id").apply()
        findViewById<TextView>(R.id.txtComprobante).visibility = View.GONE
        findViewById<Button>(R.id.btnNuevoTurno).visibility = View.GONE
        findViewById<EditText>(R.id.inputDocumento).setText("")
        mostrarVista(R.id.vistaRegistro)
    }

    private fun mostrarHistorial() {
        val cliente = api ?: return
        val tipoDoc = findViewById<Spinner>(R.id.spinnerTipoDoc).selectedItem.toString()
        val numeroDoc = findViewById<EditText>(R.id.inputDocumento).text.toString().trim()
        if (numeroDoc.length < 3) {
            toast("Escribe tu número de documento para consultar tus entregas")
            return
        }
        io.execute {
            try {
                val entregas = cliente.historial(tipoDoc, numeroDoc)
                ui.post {
                    val sb = StringBuilder()
                    for (i in 0 until entregas.length()) {
                        val e = entregas.getJSONObject(i)
                        sb.append("🧾 ${e.getString("codigo")} — turno %03d (%s)\n".format(
                            e.getInt("numero_turno"), e.optString("fecha_turno", "")))
                        val meds = e.getJSONArray("medicamentos")
                        for (j in 0 until meds.length()) {
                            val m = meds.getJSONObject(j)
                            sb.append("   • ${m.getString("nombre")}: ${m.getInt("cantidad")} und\n")
                        }
                        sb.append("\n")
                    }
                    val mensaje = if (entregas.length() == 0)
                        "Aún no tienes entregas registradas con el documento $tipoDoc $numeroDoc."
                    else sb.toString().trim()
                    AlertDialog.Builder(this)
                        .setTitle("💊 Mis entregas ($tipoDoc $numeroDoc)")
                        .setMessage(mensaje)
                        .setPositiveButton("Cerrar", null)
                        .show()
                }
            } catch (e: Exception) {
                ui.post { toast("No se pudo consultar el historial") }
            }
        }
    }

    // ---------- Fórmula: cámara / galería ----------
    private fun abrirCamara() {
        try {
            val dir = File(cacheDir, "formulas").apply { mkdirs() }
            fotoArchivo = File(dir, "formula-${System.currentTimeMillis()}.jpg")
            fotoUri = FileProvider.getUriForFile(this, "com.dispensario.turnos.fileprovider", fotoArchivo!!)
            tomarFoto.launch(fotoUri)
        } catch (e: Exception) {
            toast("No se pudo abrir la cámara: ${e.message}")
        }
    }

    private fun subirFormulaDesdeArchivo(archivo: File) {
        io.execute {
            try {
                val b64 = comprimirABase64(BitmapFactory.decodeFile(archivo.absolutePath))
                enviarFormula(b64)
            } catch (e: Exception) {
                ui.post { toast("No se pudo procesar la foto: ${e.message}") }
            }
        }
    }

    private fun subirFormulaDesdeUri(uri: Uri) {
        io.execute {
            try {
                val bmp = contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it) }
                val b64 = comprimirABase64(bmp)
                enviarFormula(b64)
            } catch (e: Exception) {
                ui.post { toast("No se pudo leer la imagen: ${e.message}") }
            }
        }
    }

    /** Reduce a máx 1600 px y comprime a JPEG 85 para que el OCR funcione bien sin saturar la red. */
    private fun comprimirABase64(original: Bitmap?): String {
        val bmp = original ?: throw Exception("Imagen vacía")
        val maxLado = 1600
        val escala = minOf(1f, maxLado.toFloat() / maxOf(bmp.width, bmp.height))
        val redimensionado = if (escala < 1f)
            Bitmap.createScaledBitmap(bmp, (bmp.width * escala).toInt(), (bmp.height * escala).toInt(), true)
        else bmp
        val out = ByteArrayOutputStream()
        redimensionado.compress(Bitmap.CompressFormat.JPEG, 85, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun enviarFormula(b64: String) {
        val cliente = api ?: return
        if (turnoActivo <= 0) return
        ui.post { toast("Subiendo fórmula…") }
        try {
            cliente.subirFormula(turnoActivo, b64)
            ui.post {
                toast("Fórmula enviada ✓")
                consultarTurno()
            }
        } catch (e: Exception) {
            ui.post { toast("No se pudo subir la fórmula: ${e.message}") }
        }
    }

    // ---------- ROL DESPACHADOR ----------
    private fun entrarDespacho() {
        mostrarVista(R.id.vistaDespacho)
        iniciarPeriodica(5000) { refrescarTurnosDespacho() }
    }

    private fun refrescarTurnosDespacho() {
        val cliente = api ?: return
        io.execute {
            try {
                val turnos = cliente.turnos()
                ui.post { pintarListaTurnos(turnos) }
            } catch (e: Exception) {
                ui.post { estadoConexion("Sin conexión — reintentando…") }
            }
        }
    }

    private fun pintarListaTurnos(turnos: JSONArray) {
        estadoConexion("Servidor: ${prefs.getString("host", "")} · rol: despachador")
        val contenedor = findViewById<LinearLayout>(R.id.listaTurnosDespacho)
        contenedor.removeAllViews()
        var visibles = 0
        for (i in 0 until turnos.length()) {
            val t = turnos.getJSONObject(i)
            val estado = t.getString("estado")
            if (estado in listOf("ENTREGADO", "FINALIZADO", "NO_PRESENTADO")) continue
            visibles++
            val tarjeta = LinearLayout(this)
            tarjeta.orientation = LinearLayout.VERTICAL
            tarjeta.setBackgroundColor(getColor(R.color.panel))
            tarjeta.setPadding(28, 24, 28, 24)
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = 14
            tarjeta.layoutParams = lp

            val info = TextView(this)
            val nombre = t.optString("paciente_nombre", "")
            info.text = "Turno %03d · %s %s%s".format(
                t.getInt("numero"), t.getString("tipo_documento"), t.getString("numero_documento"),
                if (nombre.isNotEmpty() && nombre != "null") "\n$nombre" else "")
            info.setTextColor(getColor(R.color.texto))
            info.textSize = 16f
            tarjeta.addView(info)

            val estadoTxt = TextView(this)
            val formula = if (t.optInt("num_formulas", 0) > 0) " · 📄 con fórmula" else " · sin fórmula"
            estadoTxt.text = estado.replace('_', ' ') + formula
            estadoTxt.setTextColor(getColor(if (estado == "ESPERANDO") R.color.cian else R.color.amarillo))
            estadoTxt.textSize = 13f
            tarjeta.addView(estadoTxt)

            val boton = Button(this)
            boton.layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            if (estado == "ESPERANDO" || estado == "CREADO") {
                boton.text = "📣 Llamar"
                boton.setOnClickListener { dialogoLlamar(t.getLong("id")) }
            } else {
                boton.text = "💊 Despachar"
                boton.setBackgroundColor(getColor(R.color.amarillo))
                boton.setTextColor(getColor(R.color.fondo))
                boton.setOnClickListener { abrirDetalleDespacho(t) }
            }
            tarjeta.addView(boton)
            contenedor.addView(tarjeta)
        }
        if (visibles == 0) {
            val vacio = TextView(this)
            vacio.text = "No hay turnos activos en este momento."
            vacio.setTextColor(getColor(R.color.gris))
            contenedor.addView(vacio)
        }
    }

    private fun dialogoLlamar(turnoId: Long) {
        val input = EditText(this)
        input.inputType = InputType.TYPE_CLASS_NUMBER
        input.hint = "Número de módulo (ej: 1)"
        AlertDialog.Builder(this)
            .setTitle("Llamar turno")
            .setView(input)
            .setPositiveButton("Llamar") { _, _ ->
                val modulo = input.text.toString().toIntOrNull() ?: 1
                io.execute {
                    try {
                        api?.setEstado(turnoId, "LLAMANDO", modulo)
                        ui.post { refrescarTurnosDespacho() }
                    } catch (e: Exception) {
                        ui.post { toast("No se pudo llamar el turno") }
                    }
                }
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun abrirDetalleDespacho(t: JSONObject) {
        turnoDespachoId = t.getLong("id")
        formulaActualId = -1
        itemsEntrega = JSONArray()
        detenerPeriodica()
        mostrarVista(R.id.vistaDespachoDetalle)
        val nombre = t.optString("paciente_nombre", "")
        findViewById<TextView>(R.id.txtDespachoTitulo).text =
            "Turno %03d · %s %s%s".format(t.getInt("numero"),
                t.getString("tipo_documento"), t.getString("numero_documento"),
                if (nombre.isNotEmpty() && nombre != "null") "\n$nombre" else "")
        findViewById<TextView>(R.id.txtValidacion).text = "Sin validación aún. Usa el OCR para leer la fórmula."
        findViewById<ImageView>(R.id.imgFormula).visibility = View.GONE
        val cliente = api ?: return
        io.execute {
            // Marca el turno EN DESPACHO y carga su fórmula más reciente
            try { if (t.getString("estado") == "LLAMANDO") cliente.setEstado(turnoDespachoId, "DESPACHO", null) } catch (e: Exception) {}
            try {
                val formulas = cliente.formulas(turnoDespachoId)
                ui.post {
                    if (formulas.length() == 0) {
                        findViewById<TextView>(R.id.txtFormulaInfo).text =
                            "El paciente no adjuntó fórmula. La entrega se registra desde el panel del PC."
                        findViewById<Button>(R.id.btnOcr).isEnabled = false
                    } else {
                        val f = formulas.getJSONObject(0)
                        formulaActualId = f.getLong("id")
                        findViewById<TextView>(R.id.txtFormulaInfo).text =
                            "📄 Fórmula adjunta (${f.getString("ocr_estado")})"
                        findViewById<Button>(R.id.btnOcr).isEnabled = true
                        cargarImagenFormula(formulaActualId)
                    }
                }
            } catch (e: Exception) {
                ui.post { findViewById<TextView>(R.id.txtFormulaInfo).text = "No se pudo consultar la fórmula." }
            }
        }
    }

    private fun cargarImagenFormula(formulaId: Long) {
        val host = prefs.getString("host", "") ?: return
        val puerto = prefs.getInt("puerto", 3000)
        val token = prefs.getString("token", "") ?: ""
        io.execute {
            try {
                val conn = java.net.URL("http://$host:$puerto/api/formulas/$formulaId/imagen")
                    .openConnection() as java.net.HttpURLConnection
                conn.setRequestProperty("X-TOKEN", token)
                val bmp = BitmapFactory.decodeStream(conn.inputStream)
                conn.disconnect()
                ui.post {
                    val img = findViewById<ImageView>(R.id.imgFormula)
                    img.setImageBitmap(bmp)
                    img.visibility = View.VISIBLE
                }
            } catch (e: Exception) { /* la imagen es opcional */ }
        }
    }

    private fun ejecutarOcr() {
        val cliente = api ?: return
        if (formulaActualId <= 0) { toast("Este turno no tiene fórmula adjunta"); return }
        findViewById<TextView>(R.id.txtValidacion).text = "🤖 Leyendo fórmula con IA… (puede tardar unos segundos)"
        io.execute {
            try {
                val r = cliente.ejecutarOcr(formulaActualId)
                ui.post { pintarValidacion(r.getJSONArray("validacion"), r.optString("observaciones")) }
            } catch (e: Exception) {
                ui.post {
                    findViewById<TextView>(R.id.txtValidacion).text = "❌ OCR falló: ${e.message}"
                }
            }
        }
    }

    private fun pintarValidacion(validacion: JSONArray, observaciones: String) {
        itemsEntrega = JSONArray()
        val sb = StringBuilder("VALIDACIÓN CONTRA INVENTARIO\n\n")
        for (i in 0 until validacion.length()) {
            val v = validacion.getJSONObject(i)
            val sol = v.getJSONObject("solicitado")
            val pedido = "${sol.getString("nombre")} ${sol.optString("concentracion")}".trim()
            if (v.isNull("medicamento_id")) {
                sb.append("❌ $pedido: no está en el catálogo\n")
            } else {
                val disponible = v.getBoolean("disponible")
                sb.append(if (disponible) "✅ " else "⚠ ")
                sb.append("${v.getString("medicamento")} x${sol.getInt("cantidad")} ")
                sb.append("(stock ${v.getInt("stock")})\n")
                if (disponible) {
                    itemsEntrega.put(JSONObject()
                        .put("medicamento_id", v.getLong("medicamento_id"))
                        .put("cantidad", sol.getInt("cantidad")))
                }
            }
        }
        if (observaciones.isNotEmpty() && observaciones != "null") sb.append("\n📝 $observaciones\n")
        sb.append("\nSe entregarán ${itemsEntrega.length()} medicamentos disponibles.")
        sb.append("\n⚠ Verifica contra la fórmula física antes de confirmar.")
        findViewById<TextView>(R.id.txtValidacion).text = sb.toString()
    }

    private fun confirmarEntrega() {
        val cliente = api ?: return
        if (itemsEntrega.length() == 0) {
            toast("No hay medicamentos disponibles validados. Usa el OCR primero o registra la entrega desde el panel del PC.")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Confirmar entrega")
            .setMessage("¿Entregar ${itemsEntrega.length()} medicamento(s) y generar el comprobante?\n" +
                "Esta acción descuenta el inventario.")
            .setPositiveButton("Entregar") { _, _ ->
                io.execute {
                    try {
                        val c = cliente.registrarEntrega(turnoDespachoId, itemsEntrega)
                        ui.post {
                            toast("Entrega ${c.getString("id")} registrada ✓")
                            entrarDespacho()
                        }
                    } catch (e: Exception) {
                        ui.post { toast("Error al entregar: ${e.message}") }
                    }
                }
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    // ---------- Utilidades ----------
    private fun generarQr(contenido: String): Bitmap {
        val matriz = QRCodeWriter().encode(contenido, BarcodeFormat.QR_CODE, 440, 440)
        val bmp = Bitmap.createBitmap(440, 440, Bitmap.Config.RGB_565)
        for (x in 0 until 440) {
            for (y in 0 until 440) {
                bmp.setPixel(x, y, if (matriz[x, y]) Color.BLACK else Color.WHITE)
            }
        }
        return bmp
    }

    private fun vibrar() {
        val v = getSystemService(VIBRATOR_SERVICE) as Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 400, 200, 400, 200, 600), -1))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(1200)
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
