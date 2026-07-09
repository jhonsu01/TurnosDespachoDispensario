package com.dispensario.turnos

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Cliente HTTP mínimo (HttpURLConnection, sin dependencias externas).
 * Los roles elevados se autentican con un token de dispositivo (header X-TOKEN)
 * obtenido al emparejar con el PIN de sesión; el rol paciente no usa token.
 * Todas las llamadas deben ejecutarse fuera del hilo principal.
 */
class ApiClient(private val host: String, private val puerto: Int, private val token: String = "") {

    private fun abrir(ruta: String, metodo: String, timeoutLecturaMs: Int = 8000): HttpURLConnection {
        val conn = URL("http://$host:$puerto$ruta").openConnection() as HttpURLConnection
        conn.requestMethod = metodo
        conn.connectTimeout = 4000
        conn.readTimeout = timeoutLecturaMs
        if (token.isNotEmpty()) conn.setRequestProperty("X-TOKEN", token)
        conn.setRequestProperty("Content-Type", "application/json")
        return conn
    }

    private fun leer(conn: HttpURLConnection): String {
        val stream = if (conn.responseCode < 400) conn.inputStream else conn.errorStream
        return stream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
    }

    private fun extraerError(body: String): String = try {
        JSONObject(body).optString("error", "Error del servidor")
    } catch (e: Exception) {
        "Error del servidor"
    }

    private fun getJson(ruta: String): JSONObject {
        val conn = abrir(ruta, "GET")
        try {
            val body = leer(conn)
            if (conn.responseCode != 200) throw ApiException(conn.responseCode, extraerError(body))
            return JSONObject(body)
        } finally { conn.disconnect() }
    }

    private fun getArray(ruta: String): JSONArray {
        val conn = abrir(ruta, "GET")
        try {
            val body = leer(conn)
            if (conn.responseCode != 200) throw ApiException(conn.responseCode, extraerError(body))
            return JSONArray(body)
        } finally { conn.disconnect() }
    }

    private fun enviar(ruta: String, metodo: String, cuerpo: JSONObject?, timeoutMs: Int = 12000): String {
        val conn = abrir(ruta, metodo, timeoutMs)
        try {
            if (cuerpo != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(cuerpo.toString().toByteArray()) }
            }
            val resp = leer(conn)
            if (conn.responseCode !in 200..299) throw ApiException(conn.responseCode, extraerError(resp))
            return resp
        } finally { conn.disconnect() }
    }

    fun ping(): JSONObject = getJson("/api/ping")

    /** Empareja el dispositivo con un PIN de sesión y devuelve {token, rol}. */
    fun emparejar(rol: String, pin: String, nombreDispositivo: String): JSONObject =
        JSONObject(enviar("/api/emparejar", "POST",
            JSONObject().put("rol", rol).put("pin", pin).put("nombre", nombreDispositivo)))

    fun crearTurno(tipoDoc: String, numeroDoc: String, nombre: String?, telefono: String?): JSONObject {
        val body = JSONObject().put("tipo_documento", tipoDoc).put("numero_documento", numeroDoc)
        if (!nombre.isNullOrBlank()) body.put("nombre", nombre)
        if (!telefono.isNullOrBlank()) body.put("telefono", telefono)
        return JSONObject(enviar("/api/turnos", "POST", body))
    }

    fun turno(id: Long): JSONObject = getJson("/api/turnos/$id")

    fun turnos(): JSONArray = getArray("/api/turnos")

    fun setEstado(id: Long, estado: String, modulo: Int?): JSONObject {
        val body = JSONObject().put("estado", estado)
        if (modulo != null) body.put("modulo_asignado", modulo)
        return JSONObject(enviar("/api/turnos/$id/estado", "PUT", body))
    }

    fun finalizarTurno(id: Long): JSONObject =
        JSONObject(enviar("/api/turnos/$id/finalizar", "POST", null))

    /** Sube la foto de la fórmula en base64 (puede tardar en redes lentas). */
    fun subirFormula(turnoId: Long, imagenBase64: String): JSONObject =
        JSONObject(enviar("/api/formulas", "POST",
            JSONObject().put("turno_id", turnoId).put("imagen_base64", imagenBase64), 30000))

    fun formulas(turnoId: Long): JSONArray = getArray("/api/formulas/$turnoId")

    /** Ejecuta el OCR con IA en el servidor (hasta ~90 s). */
    fun ejecutarOcr(formulaId: Long): JSONObject {
        val conn = abrir("/api/formulas/$formulaId/ocr", "POST", 95000)
        try {
            val body = leer(conn)
            if (conn.responseCode != 200) throw ApiException(conn.responseCode, extraerError(body))
            return JSONObject(body)
        } finally { conn.disconnect() }
    }

    fun registrarEntrega(turnoId: Long, items: JSONArray): JSONObject =
        JSONObject(enviar("/api/entregas", "POST",
            JSONObject().put("turno_id", turnoId).put("items", items).put("usuario", "app-despachador")))

    fun entrega(turnoId: Long): JSONObject? {
        val conn = abrir("/api/entregas/$turnoId", "GET")
        try {
            val body = leer(conn)
            if (conn.responseCode == 404) return null
            if (conn.responseCode != 200) throw ApiException(conn.responseCode, extraerError(body))
            return JSONObject(body)
        } finally { conn.disconnect() }
    }

    fun historial(tipoDoc: String, numeroDoc: String): JSONArray =
        getArray("/api/historial?tipo_documento=$tipoDoc&numero_documento=$numeroDoc")
}

class ApiException(val codigo: Int, mensaje: String) : Exception(mensaje)
