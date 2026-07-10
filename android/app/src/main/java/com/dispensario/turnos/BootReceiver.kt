package com.dispensario.turnos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Autoarranque del kiosko: al encender el TV o la tablet, los APKs de kiosko
 * (kioskotv / autoservicio) se abren solos si ya están emparejados.
 * Nota: algunos equipos exigen habilitar "autoarranque" o "mostrar sobre otras
 * apps" para la app la primera vez.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != "android.intent.action.QUICKBOOT_POWERON") return
        // Solo los APKs de kiosko arrancan solos, y solo si ya hay servidor emparejado
        if (!BuildConfig.MODO_FIJO.startsWith("kiosko") && BuildConfig.MODO_FIJO != "autoservicio") return
        val prefs = context.getSharedPreferences("dispensario", Context.MODE_PRIVATE)
        if (prefs.getString("host", null) == null) return
        val lanzar = Intent(context, MainActivity::class.java)
        lanzar.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(lanzar)
        } catch (e: Exception) { /* el sistema puede restringir el arranque en frío */ }
    }
}
