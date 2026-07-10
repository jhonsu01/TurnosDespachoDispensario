package com.dispensario.turnos

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
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
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
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
    private var etiquetasEntrega = mutableListOf<String>()
    private var catalogoMeds: JSONArray = JSONArray()

    /** A qué turno se sube la próxima fórmula (el del paciente o el que atiende el despachador). */
    private var turnoParaFormula: Long = -1

    private var tareaPeriodica: Runnable? = null
    private var reintento: Runnable? = null

    private val tomarFoto = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (ok && fotoArchivo != null) subirFormulaDesdeArchivo(fotoArchivo!!)
    }

    private val elegirImagen = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) subirFormulaDesdeUri(uri)
    }

    private val elegirPdf = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) subirFormulaDesdePdf(uri)
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
        findViewById<Button>(R.id.btnRolInventario).setOnClickListener { elegirRol("inventario") }
        findViewById<Button>(R.id.btnRolKiosko).setOnClickListener { elegirRol("kiosko") }

        // Conexión
        findViewById<Button>(R.id.btnConectar).setOnClickListener { conectar() }
        findViewById<Button>(R.id.btnBuscar).setOnClickListener { buscarServidor() }
        findViewById<Button>(R.id.btnVolverRol).setOnClickListener { mostrarVista(R.id.vistaRol) }

        // Paciente
        findViewById<Button>(R.id.btnSolicitar).setOnClickListener { solicitarTurno() }
        findViewById<Button>(R.id.btnHistorial).setOnClickListener { mostrarHistorial() }
        findViewById<Button>(R.id.btnNuevoTurno).setOnClickListener { terminarTurnoCliente() }
        findViewById<Button>(R.id.btnFormulaCamara).setOnClickListener { turnoParaFormula = turnoActivo; abrirCamara() }
        findViewById<Button>(R.id.btnFormulaGaleria).setOnClickListener { turnoParaFormula = turnoActivo; elegirImagen.launch("image/*") }
        findViewById<Button>(R.id.btnFormulaPdf).setOnClickListener { turnoParaFormula = turnoActivo; elegirPdf.launch("application/pdf") }

        // Despachador
        findViewById<Button>(R.id.btnOcr).setOnClickListener { ejecutarOcr() }
        findViewById<Button>(R.id.btnEntregar).setOnClickListener { confirmarEntrega() }
        findViewById<Button>(R.id.btnVolverLista).setOnClickListener { entrarDespacho() }
        findViewById<Button>(R.id.btnDespachoCamara).setOnClickListener { turnoParaFormula = turnoDespachoId; abrirCamara() }
        findViewById<Button>(R.id.btnDespachoGaleria).setOnClickListener { turnoParaFormula = turnoDespachoId; elegirImagen.launch("image/*") }
        findViewById<Button>(R.id.btnDespachoPdf).setOnClickListener { turnoParaFormula = turnoDespachoId; elegirPdf.launch("application/pdf") }
        findViewById<EditText>(R.id.inputBuscarMed).addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) { buscarMedicamentoDespacho() }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })

        // Inventario
        findViewById<Button>(R.id.btnAgregarMedicamento).setOnClickListener { dialogoNuevoMedicamento() }
        findViewById<EditText>(R.id.inputBuscarInv).addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) { pintarInventario() }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })

        // Cambiar rol / servidor
        val reset = View.OnClickListener { cambiarRol() }
        findViewById<Button>(R.id.btnCambiarServidor).setOnClickListener(reset)
        findViewById<Button>(R.id.btnCambiarRolDespacho).setOnClickListener(reset)
        findViewById<Button>(R.id.btnCambiarRolInventario).setOnClickListener(reset)

        // APK Paciente: sin selección de roles, siempre entra como paciente
        if (BuildConfig.SOLO_PACIENTE) {
            findViewById<Button>(R.id.btnCambiarServidor).text = "Cambiar servidor"
            findViewById<Button>(R.id.btnVolverRol).visibility = View.GONE
        }

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
            R.id.vistaDespacho, R.id.vistaDespachoDetalle, R.id.vistaInventario,
        )
        for (v in vistas) findViewById<View>(v).visibility = if (v == id) View.VISIBLE else View.GONE
    }

    private fun estadoConexion(texto: String) {
        findViewById<TextView>(R.id.txtEstadoConexion).text = texto
    }

    /**
     * Estado de conexión del paciente: sin IP ni datos técnicos,
     * solo "Servidor" y un indicador de conectado/desconectado.
     */
    private fun conexionPaciente(conectado: Boolean) {
        val txt = findViewById<TextView>(R.id.txtEstadoConexion)
        txt.text = if (conectado) "Servidor  🟢 Conectado" else "Servidor  🔴 Sin conexión"
        txt.setTextColor(getColor(if (conectado) R.color.verde else R.color.rojo))
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
        if (BuildConfig.SOLO_PACIENTE) elegirRol("paciente") else mostrarVista(R.id.vistaRol)
    }

    private fun restaurarSesion() {
        val rol = if (BuildConfig.SOLO_PACIENTE) "paciente" else prefs.getString("rol", null)
        val host = prefs.getString("host", null)
        if (rol == null || host == null) {
            if (BuildConfig.SOLO_PACIENTE) elegirRol("paciente") else mostrarVista(R.id.vistaRol)
            return
        }
        rolElegido = rol
        val cliente = ApiClient(host, prefs.getInt("puerto", 3000), prefs.getString("token", "") ?: "")
        api = cliente
        if (rol == "paciente") conexionPaciente(true)
        else estadoConexion("Servidor: $host:${prefs.getInt("puerto", 3000)} · rol: $rol")

        // Roles elevados: verificar que el acceso no haya sido revocado desde el panel
        if (rol in listOf("despachador", "kiosko", "inventario")) {
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
                            "inventario" -> entrarInventario()
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
            "inventario" -> "PIN de sesión — Inventario (ver panel del PC)"
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
                        conexionPaciente(true)
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
                        "inventario" -> entrarInventario()
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
                ui.post { conexionPaciente(false) }
            }
        }
    }

    private fun pintarTurno(t: JSONObject) {
        conexionPaciente(true)
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
        findViewById<Button>(R.id.btnFormulaPdf).visibility = if (botonesFormula) View.VISIBLE else View.GONE

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
                txtModulo.text = "Este turno se cerrará solo en unos segundos"
                if (estadoAnterior != "ENTREGADO") {
                    vibrar()
                    mostrarComprobante()
                    // El turno se cierra solo: el paciente no tiene que tocar "Terminar"
                    val turnoDeEsteCierre = turnoActivo
                    ui.postDelayed({
                        if (turnoActivo == turnoDeEsteCierre && estadoAnterior == "ENTREGADO") {
                            terminarTurnoCliente()
                        }
                    }, 12000)
                }
                btnNuevo.text = "Terminar ahora"
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

    /** Convierte una fecha ISO UTC del servidor a hora local legible. */
    private fun fechaLocal(iso: String): String = try {
        val parser = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
        parser.timeZone = java.util.TimeZone.getTimeZone("UTC")
        java.text.SimpleDateFormat("dd/MM/yyyy h:mm a", java.util.Locale("es"))
            .format(parser.parse(iso.substring(0, 19))!!)
    } catch (e: Exception) {
        iso
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
                        if (m.optInt("pendiente", 0) > 0) {
                            sb.append("   ⏳ quedan ${m.getInt("pendiente")} pendientes por stock\n")
                        }
                    }
                    sb.append("\nEntregado: ${fechaLocal(c.getString("fecha"))}")
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
                        sb.append("🧾 ${e.getString("codigo")} — turno %03d\n".format(e.getInt("numero_turno")))
                        sb.append("📅 Entregado: ${fechaLocal(e.optString("fecha", ""))}\n")
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
                enviarFormula(listOf(b64))
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
                enviarFormula(listOf(b64))
            } catch (e: Exception) {
                ui.post { toast("No se pudo leer la imagen: ${e.message}") }
            }
        }
    }

    /**
     * Fórmula en PDF: renderiza cada página a imagen (máx. 8) y las sube todas.
     * Muchos PDF traen la fórmula mezclada con historia clínica: el OCR del
     * servidor identifica la página de la fórmula e ignora el resto.
     */
    private fun subirFormulaDesdePdf(uri: Uri) {
        io.execute {
            try {
                val fd = contentResolver.openFileDescriptor(uri, "r")
                    ?: throw Exception("No se pudo abrir el PDF")
                val paginas = mutableListOf<String>()
                fd.use {
                    val pdf = PdfRenderer(it)
                    pdf.use {
                        val total = minOf(pdf.pageCount, 8)
                        for (i in 0 until total) {
                            pdf.openPage(i).use { page ->
                                // Render a ~150 dpi (los PDF vienen en puntos de 72 dpi)
                                val escala = 150f / 72f
                                val ancho = (page.width * escala).toInt().coerceAtMost(1600)
                                val alto = (page.height * ancho / page.width)
                                val bmp = Bitmap.createBitmap(ancho, alto, Bitmap.Config.ARGB_8888)
                                bmp.eraseColor(Color.WHITE)
                                page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                paginas.add(comprimirABase64(bmp))
                            }
                        }
                    }
                }
                if (paginas.isEmpty()) throw Exception("El PDF no tiene páginas")
                ui.post { toast("PDF de ${paginas.size} página(s) — subiendo…") }
                enviarFormula(paginas)
            } catch (e: Exception) {
                ui.post { toast("No se pudo leer el PDF: ${e.message}") }
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

    /** Sube las páginas al turno correspondiente (paciente o despacho). */
    private fun enviarFormula(paginas: List<String>) {
        val cliente = api ?: return
        val turno = turnoParaFormula
        if (turno <= 0) return
        ui.post { toast("Subiendo fórmula…") }
        try {
            cliente.subirFormula(turno, paginas)
            ui.post {
                toast("Fórmula enviada ✓")
                if (turno == turnoActivo) consultarTurno()
                if (turno == turnoDespachoId) recargarFormulaDespacho()
            }
        } catch (e: Exception) {
            ui.post { toast("No se pudo subir la fórmula: ${e.message}") }
        }
    }

    // ---------- ROL DESPACHADOR ----------
    private fun entrarDespacho() {
        mostrarVista(R.id.vistaDespacho)
        // Primera vez: el despachador elige su módulo de atención
        if (prefs.getInt("modulo", 0) <= 0) elegirModulo() else iniciarPeriodica(5000) { refrescarTurnosDespacho() }
    }

    /** Diálogo de selección del módulo en el que atiende este despachador. */
    private fun elegirModulo() {
        val input = EditText(this)
        input.inputType = InputType.TYPE_CLASS_NUMBER
        val actual = prefs.getInt("modulo", 1)
        input.setText(actual.toString())
        input.hint = "Número de módulo (ej: 1)"
        AlertDialog.Builder(this)
            .setTitle("💊 ¿En qué módulo vas a atender?")
            .setMessage("Los turnos que llames y las entregas quedarán registrados con este módulo. Puedes cambiarlo tocando el encabezado.")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Aceptar") { _, _ ->
                val m = input.text.toString().toIntOrNull() ?: 1
                prefs.edit().putInt("modulo", if (m > 0) m else 1).apply()
                iniciarPeriodica(5000) { refrescarTurnosDespacho() }
            }
            .show()
    }

    private fun miModulo(): Int = prefs.getInt("modulo", 1).coerceAtLeast(1)

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
        estadoConexion("Rol: despachador · Módulo ${miModulo()} (toca aquí para cambiarlo)")
        findViewById<TextView>(R.id.txtEstadoConexion).setOnClickListener {
            if (rolElegido == "despachador") elegirModulo()
        }
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

            // Aislamiento por módulo: los turnos llamados por OTRO módulo no se atienden aquí
            val moduloTurno = if (t.isNull("modulo_asignado")) 0 else t.getInt("modulo_asignado")
            val esMio = moduloTurno == 0 || moduloTurno == miModulo()
            if (estado == "ESPERANDO" || estado == "CREADO") {
                val boton = Button(this)
                boton.layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                boton.text = "📣 Llamar a mi módulo (${miModulo()})"
                boton.setOnClickListener { dialogoLlamar(t.getLong("id")) }
                tarjeta.addView(boton)
            } else if (esMio) {
                val boton = Button(this)
                boton.layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                boton.text = "💊 Despachar"
                boton.setBackgroundColor(getColor(R.color.amarillo))
                boton.setTextColor(getColor(R.color.fondo))
                boton.setOnClickListener { abrirDetalleDespacho(t) }
                tarjeta.addView(boton)
            } else {
                val aviso = TextView(this)
                aviso.text = "Lo atiende el módulo $moduloTurno"
                aviso.setTextColor(getColor(R.color.gris))
                aviso.textSize = 13f
                tarjeta.addView(aviso)
            }
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
        input.setText(miModulo().toString()) // predeterminado: el módulo elegido al ingresar
        input.hint = "Número de módulo (ej: 1)"
        AlertDialog.Builder(this)
            .setTitle("Llamar turno a tu módulo")
            .setView(input)
            .setPositiveButton("Llamar") { _, _ ->
                val modulo = input.text.toString().toIntOrNull() ?: miModulo()
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
        etiquetasEntrega.clear()
        detenerPeriodica()
        mostrarVista(R.id.vistaDespachoDetalle)
        val nombre = t.optString("paciente_nombre", "")
        findViewById<TextView>(R.id.txtDespachoTitulo).text =
            "Turno %03d · %s %s%s".format(t.getInt("numero"),
                t.getString("tipo_documento"), t.getString("numero_documento"),
                if (nombre.isNotEmpty() && nombre != "null") "\n$nombre" else "")
        findViewById<TextView>(R.id.txtValidacion).text =
            "Sin medicamentos aún. Usa el OCR o el buscador de abajo."
        findViewById<ImageView>(R.id.imgFormula).visibility = View.GONE
        findViewById<EditText>(R.id.inputBuscarMed).setText("")
        val cliente = api ?: return
        io.execute {
            // Marca el turno EN DESPACHO, precarga el catálogo y la fórmula
            try { if (t.getString("estado") == "LLAMANDO") cliente.setEstado(turnoDespachoId, "DESPACHO", null) } catch (e: Exception) {}
            try { catalogoMeds = cliente.medicamentos() } catch (e: Exception) {}
            recargarFormulaDespacho()
        }
    }

    /** Consulta la fórmula más reciente del turno en despacho y actualiza la vista. */
    private fun recargarFormulaDespacho() {
        val cliente = api ?: return
        if (turnoDespachoId <= 0) return
        io.execute {
            try {
                val formulas = cliente.formulas(turnoDespachoId)
                ui.post {
                    if (formulas.length() == 0) {
                        findViewById<TextView>(R.id.txtFormulaInfo).text =
                            "⚠ Sin fórmula adjunta. Toda entrega requiere fórmula: " +
                            "tómale foto o adjunta la imagen/PDF con los botones de abajo."
                        findViewById<Button>(R.id.btnOcr).isEnabled = false
                    } else {
                        val f = formulas.getJSONObject(0)
                        formulaActualId = f.getLong("id")
                        val paginas = f.optInt("num_paginas", 1)
                        findViewById<TextView>(R.id.txtFormulaInfo).text =
                            "📄 Fórmula adjunta (${f.getString("ocr_estado")}" +
                            (if (paginas > 1) ", $paginas páginas" else "") + ")"
                        findViewById<Button>(R.id.btnOcr).isEnabled = true
                        cargarImagenFormula(formulaActualId)
                    }
                }
            } catch (e: Exception) {
                ui.post { findViewById<TextView>(R.id.txtFormulaInfo).text = "No se pudo consultar la fórmula." }
            }
        }
    }

    // ---------- Buscador manual de medicamentos (despacho sin OCR) ----------
    private fun normalizar(s: String): String =
        java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD)
            .replace(Regex("\\p{Mn}+"), "").lowercase().trim()

    private fun buscarMedicamentoDespacho() {
        val q = normalizar(findViewById<EditText>(R.id.inputBuscarMed).text.toString())
        val cont = findViewById<LinearLayout>(R.id.resultadosBusqueda)
        cont.removeAllViews()
        if (q.length < 2) return
        var mostrados = 0
        for (i in 0 until catalogoMeds.length()) {
            if (mostrados >= 6) break
            val m = catalogoMeds.getJSONObject(i)
            val texto = normalizar("${m.getString("nombre")} ${m.getString("principio_activo")} ${m.getString("codigo")}")
            if (!texto.contains(q)) continue
            mostrados++
            val etiqueta = "${m.getString("nombre")} ${m.getString("concentracion")} (${m.getString("presentacion")})"
            val boton = Button(this)
            boton.text = "➕ $etiqueta · stock ${m.optInt("stock")}"
            boton.textSize = 13f
            boton.isAllCaps = false
            boton.setBackgroundColor(getColor(R.color.panel))
            boton.setTextColor(getColor(R.color.texto))
            boton.layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            boton.setOnClickListener { dialogoCantidadItem(m, etiqueta) }
            cont.addView(boton)
        }
    }

    private fun dialogoCantidadItem(m: JSONObject, etiqueta: String) {
        val input = EditText(this)
        input.inputType = InputType.TYPE_CLASS_NUMBER
        input.hint = "Cantidad a entregar"
        AlertDialog.Builder(this)
            .setTitle(etiqueta)
            .setView(input)
            .setPositiveButton("Agregar") { _, _ ->
                val cantidad = input.text.toString().toIntOrNull() ?: 1
                itemsEntrega.put(JSONObject()
                    .put("medicamento_id", m.getLong("id"))
                    .put("cantidad", cantidad))
                etiquetasEntrega.add("$etiqueta x$cantidad")
                findViewById<EditText>(R.id.inputBuscarMed).setText("")
                findViewById<LinearLayout>(R.id.resultadosBusqueda).removeAllViews()
                pintarItemsEntrega()
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun pintarItemsEntrega() {
        val sb = StringBuilder("MEDICAMENTOS A ENTREGAR\n\n")
        etiquetasEntrega.forEach { sb.append("• $it\n") }
        sb.append("\n⚠ Verifica contra la fórmula física antes de confirmar.")
        findViewById<TextView>(R.id.txtValidacion).text = sb.toString()
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
        etiquetasEntrega.clear()
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
                    etiquetasEntrega.add("${v.getString("medicamento")} x${sol.getInt("cantidad")}")
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
        if (formulaActualId <= 0) {
            toast("Toda entrega requiere fórmula médica. Adjúntala primero (foto, imagen o PDF).")
            return
        }
        if (itemsEntrega.length() == 0) {
            toast("No hay medicamentos en la entrega. Usa el OCR o el buscador para agregarlos.")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Confirmar entrega — módulo ${miModulo()}")
            .setMessage("¿Entregar ${itemsEntrega.length()} medicamento(s) y generar el comprobante?\n" +
                "Esta acción descuenta el inventario.")
            .setPositiveButton("Entregar") { _, _ ->
                io.execute {
                    try {
                        val c = cliente.registrarEntrega(turnoDespachoId, itemsEntrega, miModulo())
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

    // ---------- ROL INVENTARIO (ALMACENISTA) ----------
    private fun entrarInventario() {
        mostrarVista(R.id.vistaInventario)
        iniciarPeriodica(10000) { refrescarInventario() }
    }

    private fun refrescarInventario() {
        val cliente = api ?: return
        io.execute {
            try {
                catalogoMeds = cliente.medicamentos()
                ui.post {
                    estadoConexion("Servidor: ${prefs.getString("host", "")} · rol: inventario")
                    pintarInventario()
                }
            } catch (e: Exception) {
                ui.post { estadoConexion("Sin conexión — reintentando…") }
            }
        }
    }

    private fun pintarInventario() {
        val q = normalizar(findViewById<EditText>(R.id.inputBuscarInv).text.toString())
        val cont = findViewById<LinearLayout>(R.id.listaInventario)
        cont.removeAllViews()
        for (i in 0 until catalogoMeds.length()) {
            val m = catalogoMeds.getJSONObject(i)
            val etiqueta = "${m.getString("nombre")} ${m.getString("concentracion")} (${m.getString("presentacion")})"
            if (q.length >= 2 && !normalizar("$etiqueta ${m.getString("principio_activo")} ${m.getString("codigo")}").contains(q)) continue

            val tarjeta = LinearLayout(this)
            tarjeta.orientation = LinearLayout.VERTICAL
            tarjeta.setBackgroundColor(getColor(R.color.panel))
            tarjeta.setPadding(28, 20, 28, 20)
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = 12
            tarjeta.layoutParams = lp

            val titulo = TextView(this)
            titulo.text = etiqueta
            titulo.setTextColor(getColor(R.color.texto))
            titulo.textSize = 15f
            tarjeta.addView(titulo)

            val stock = m.optInt("stock")
            val detalle = TextView(this)
            detalle.text = "${m.getString("codigo")} · stock: $stock"
            detalle.setTextColor(getColor(if (stock > 0) R.color.verde else R.color.rojo))
            detalle.textSize = 13f
            tarjeta.addView(detalle)

            val boton = Button(this)
            boton.text = "📦 Registrar entrada (lote)"
            boton.textSize = 13f
            boton.isAllCaps = false
            boton.layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            boton.setOnClickListener { dialogoNuevoLote(m, etiqueta) }
            tarjeta.addView(boton)
            cont.addView(tarjeta)
        }
    }

    /** Escáner de código de barras con la cámara (reciclado de SeguimientoPrecios). */
    private fun escanearCodigo(destino: EditText) {
        GmsBarcodeScanning.getClient(this).startScan()
            .addOnSuccessListener { b -> b.rawValue?.let { destino.setText(it) } }
            .addOnFailureListener { toast("No se pudo iniciar el escáner: ${it.message}") }
            .addOnCanceledListener { }
    }

    private fun campoConEscaner(hint: String): Pair<LinearLayout, EditText> {
        val fila = LinearLayout(this)
        fila.orientation = LinearLayout.HORIZONTAL
        val input = EditText(this)
        input.hint = hint
        input.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        val botonScan = Button(this)
        botonScan.text = "📷"
        botonScan.setOnClickListener { escanearCodigo(input) }
        fila.addView(input)
        fila.addView(botonScan)
        return Pair(fila, input)
    }

    private fun dialogoNuevoMedicamento() {
        val cliente = api ?: return
        val contenedor = LinearLayout(this)
        contenedor.orientation = LinearLayout.VERTICAL
        contenedor.setPadding(48, 24, 48, 8)
        val (filaCodigo, inputCodigo) = campoConEscaner("Código o código de barras *")
        contenedor.addView(filaCodigo)
        val inputNombre = EditText(this); inputNombre.hint = "Nombre *"; contenedor.addView(inputNombre)
        val inputPrincipio = EditText(this); inputPrincipio.hint = "Principio activo"; contenedor.addView(inputPrincipio)
        val inputConc = EditText(this); inputConc.hint = "Concentración (ej: 50mg) *"; contenedor.addView(inputConc)
        val inputPres = EditText(this); inputPres.hint = "Presentación (ej: Tableta) *"; contenedor.addView(inputPres)
        val inputLab = EditText(this); inputLab.hint = "Laboratorio"; contenedor.addView(inputLab)

        AlertDialog.Builder(this)
            .setTitle("＋ Nuevo medicamento")
            .setView(contenedor)
            .setPositiveButton("Guardar") { _, _ ->
                val codigo = inputCodigo.text.toString().trim()
                val nombre = inputNombre.text.toString().trim()
                val conc = inputConc.text.toString().trim()
                val pres = inputPres.text.toString().trim()
                if (codigo.isEmpty() || nombre.isEmpty() || conc.isEmpty() || pres.isEmpty()) {
                    toast("Código, nombre, concentración y presentación son obligatorios")
                    return@setPositiveButton
                }
                io.execute {
                    try {
                        cliente.crearMedicamento(codigo, nombre,
                            inputPrincipio.text.toString().trim().ifEmpty { nombre },
                            conc, pres, inputLab.text.toString().trim())
                        ui.post { toast("Medicamento creado ✓"); refrescarInventario() }
                    } catch (e: Exception) {
                        ui.post { toast("Error: ${e.message}") }
                    }
                }
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun dialogoNuevoLote(m: JSONObject, etiqueta: String) {
        val cliente = api ?: return
        val contenedor = LinearLayout(this)
        contenedor.orientation = LinearLayout.VERTICAL
        contenedor.setPadding(48, 24, 48, 8)
        val (filaLote, inputLote) = campoConEscaner("Número de lote *")
        contenedor.addView(filaLote)
        val inputCantidad = EditText(this)
        inputCantidad.hint = "Cantidad que entra *"
        inputCantidad.inputType = InputType.TYPE_CLASS_NUMBER
        contenedor.addView(inputCantidad)
        // Vencimiento con selector de calendario (más práctico que digitar la fecha)
        val inputVence = EditText(this)
        inputVence.hint = "📅 Fecha de vencimiento *"
        inputVence.isFocusable = false
        inputVence.isClickable = true
        inputVence.setOnClickListener {
            val cal = java.util.Calendar.getInstance()
            cal.add(java.util.Calendar.YEAR, 1) // sugerencia inicial: un año adelante
            android.app.DatePickerDialog(this, { _, anio, mes, dia ->
                inputVence.setText("%04d-%02d-%02d".format(anio, mes + 1, dia))
            }, cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH),
                cal.get(java.util.Calendar.DAY_OF_MONTH)).show()
        }
        contenedor.addView(inputVence)

        AlertDialog.Builder(this)
            .setTitle("📦 Entrada — $etiqueta")
            .setView(contenedor)
            .setPositiveButton("Registrar") { _, _ ->
                val lote = inputLote.text.toString().trim()
                val cantidad = inputCantidad.text.toString().toIntOrNull() ?: 0
                val vence = inputVence.text.toString().trim()
                if (lote.isEmpty() || cantidad <= 0 || !Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(vence)) {
                    toast("Lote, cantidad (>0) y fecha de vencimiento son obligatorios")
                    return@setPositiveButton
                }
                io.execute {
                    try {
                        cliente.crearLote(m.getLong("id"), lote, cantidad, vence)
                        ui.post { toast("Entrada registrada ✓"); refrescarInventario() }
                    } catch (e: Exception) {
                        ui.post { toast("Error: ${e.message}") }
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
