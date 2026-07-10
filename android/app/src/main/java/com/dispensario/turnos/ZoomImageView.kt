package com.dispensario.turnos

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Matrix
import android.graphics.RectF
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import androidx.appcompat.widget.AppCompatImageView

/**
 * ImageView con zoom por pellizco y desplazamiento con el dedo, para que el
 * despachador pueda leer la fórmula médica en detalle sin usar el OCR.
 * Doble propósito: pinch para escalar (1x–6x) y arrastre para moverse.
 */
class ZoomImageView(context: Context) : AppCompatImageView(context) {

    private val matriz = Matrix()
    private var escala = 1f
    private var ultimoX = 0f
    private var ultimoY = 0f
    private var arrastrando = false

    private val detectorEscala = ScaleGestureDetector(context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(d: ScaleGestureDetector): Boolean {
                val nueva = (escala * d.scaleFactor).coerceIn(1f, 6f)
                val factor = nueva / escala
                escala = nueva
                matriz.postScale(factor, factor, d.focusX, d.focusY)
                acotar()
                imageMatrix = matriz
                return true
            }
        })

    init {
        scaleType = ScaleType.MATRIX
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        if (changed) ajustarInicial()
    }

    /** Encaja la imagen completa centrada (equivalente a fitCenter) como estado 1x. */
    private fun ajustarInicial() {
        val d = drawable ?: return
        val vw = width.toFloat(); val vh = height.toFloat()
        val iw = d.intrinsicWidth.toFloat(); val ih = d.intrinsicHeight.toFloat()
        if (vw <= 0 || vh <= 0 || iw <= 0 || ih <= 0) return
        val s = minOf(vw / iw, vh / ih)
        matriz.reset()
        matriz.postScale(s, s)
        matriz.postTranslate((vw - iw * s) / 2f, (vh - ih * s) / 2f)
        escala = 1f
        imageMatrix = matriz
    }

    /** Evita que la imagen se salga de los bordes al hacer pan/zoom. */
    private fun acotar() {
        val d = drawable ?: return
        val rect = RectF(0f, 0f, d.intrinsicWidth.toFloat(), d.intrinsicHeight.toFloat())
        matriz.mapRect(rect)
        var dx = 0f; var dy = 0f
        if (rect.width() <= width) dx = (width - rect.width()) / 2f - rect.left
        else if (rect.left > 0) dx = -rect.left
        else if (rect.right < width) dx = width - rect.right
        if (rect.height() <= height) dy = (height - rect.height()) / 2f - rect.top
        else if (rect.top > 0) dy = -rect.top
        else if (rect.bottom < height) dy = height - rect.bottom
        matriz.postTranslate(dx, dy)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        detectorEscala.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                ultimoX = event.x; ultimoY = event.y; arrastrando = true
            }
            MotionEvent.ACTION_MOVE -> {
                if (arrastrando && !detectorEscala.isInProgress && escala > 1f) {
                    matriz.postTranslate(event.x - ultimoX, event.y - ultimoY)
                    acotar()
                    imageMatrix = matriz
                }
                ultimoX = event.x; ultimoY = event.y
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> arrastrando = false
        }
        return true
    }
}
