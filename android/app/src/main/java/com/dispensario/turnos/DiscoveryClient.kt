package com.dispensario.turnos

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/**
 * Autodescubrimiento del servidor: envía "DISPENSARIO_DISCOVER" por broadcast UDP
 * al puerto 18400 y espera la respuesta {tipo:"DISPENSARIO_SERVER", ip, puerto, nombre}.
 * Debe ejecutarse fuera del hilo principal.
 */
object DiscoveryClient {

    private const val PUERTO = 18400
    private const val MENSAJE = "DISPENSARIO_DISCOVER"

    fun buscarServidor(context: Context, timeoutMs: Long = 6000): JSONObject? {
        val socket = DatagramSocket()
        try {
            socket.broadcast = true
            socket.soTimeout = 1500
            val datos = MENSAJE.toByteArray()
            val destinos = mutableSetOf(InetAddress.getByName("255.255.255.255"))
            broadcastWifi(context)?.let { destinos.add(it) }

            val limite = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < limite) {
                for (destino in destinos) {
                    try {
                        socket.send(DatagramPacket(datos, datos.size, destino, PUERTO))
                    } catch (e: Exception) { /* red sin broadcast; se intenta el siguiente */ }
                }
                try {
                    val buffer = ByteArray(1024)
                    val paquete = DatagramPacket(buffer, buffer.size)
                    socket.receive(paquete)
                    val json = JSONObject(String(paquete.data, 0, paquete.length))
                    if (json.optString("tipo") == "DISPENSARIO_SERVER" && json.has("ip")) {
                        return json
                    }
                } catch (e: SocketTimeoutException) { /* reintentar hasta agotar el límite */ }
            }
            return null
        } finally {
            socket.close()
        }
    }

    /** Dirección de broadcast de la red WiFi actual (ej: 192.168.0.255). */
    private fun broadcastWifi(context: Context): InetAddress? {
        return try {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val dhcp = wifi.dhcpInfo ?: return null
            if (dhcp.ipAddress == 0) return null
            val broadcast = (dhcp.ipAddress and dhcp.netmask) or dhcp.netmask.inv()
            val bytes = ByteArray(4) { i -> (broadcast shr (i * 8) and 0xFF).toByte() }
            InetAddress.getByAddress(bytes)
        } catch (e: Exception) {
            null
        }
    }
}
