package com.camic.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.*
import android.media.ImageReader
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.util.Size
import android.view.Surface
import java.nio.ByteBuffer

/**
 * Hardware H.264 encoder with a zero-copy Camera2 input surface.
 *
 * Pipeline: Camera2 → encoder input Surface → MediaCodec (COLOR_FormatSurface)
 * → Annex-B access units on the drain thread → callback per frame.
 *
 * Each keyframe is prefixed with the SPS/PPS codec-config so a mid-stream
 * joiner can decode (protocol requirement).
 */
class VideoEncoder(private val context: Context) {

    interface Listener {
        fun onFormat(width: Int, height: Int)
        fun onFrame(data: ByteArray, isKey: Boolean, tsUs: Long)
        fun onError(message: String)
    }

    var listener: Listener? = null

    /** Last fatal error (e.g. SecurityException from missing CAMERA permission). */
    @Volatile var lastError: String? = null
        private set

    fun isRunning(): Boolean = running

    private var codec: MediaCodec? = null
    private var cameraDevice: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var inputSurface: Surface? = null
    private var drainThread: HandlerThread? = null
    private var drainHandler: Handler? = null
    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null
    private var spsPps: ByteArray? = null
    @Volatile private var running = false
    private var facingBack = true
    private var width = 1280
    private var height = 720
    private var fps = 30
    private var bitrate = 4_000_000

    fun configure(width: Int, height: Int, fps: Int, bitrate: Int, facingBack: Boolean) {
        this.width = width; this.height = height; this.fps = fps; this.bitrate = bitrate; this.facingBack = facingBack
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        running = true
        lastError = null
        try {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2) // IDR every ~2s
                setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 0)
            }
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
                configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                inputSurface = createInputSurface()
                start()
            }
            drainThread = HandlerThread("cb-video-drain").apply { start() }
            drainHandler = Handler(drainThread!!.looper)
            drainHandler!!.post { drainLoop() }
            openCamera()
            listener?.onFormat(width, height)
        } catch (t: Throwable) {
            running = false
            lastError = "video encoder start: ${t.javaClass.simpleName}: ${t.message}"
            listener?.onError(lastError!!)
        }
    }

    @SuppressLint("MissingPermission")
    private fun openCamera() {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val camId = pickCamera(manager)
            ?: run { listener?.onError("no camera"); return }
        cameraThread = HandlerThread("cb-camera").apply { start() }
        cameraHandler = Handler(cameraThread!!.looper)
        manager.openCamera(camId, object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                cameraDevice = camera
                createSession(camera)
            }
            override fun onDisconnected(camera: CameraDevice) { camera.close(); cameraDevice = null }
            override fun onError(camera: CameraDevice, error: Int) {
                lastError = "camera error $error"
                listener?.onError(lastError!!)
            }
        }, cameraHandler)
    }

    private fun createSession(camera: CameraDevice) {
        val target = inputSurface ?: return
        @Suppress("DEPRECATION")
        camera.createCaptureSession(listOf(target), object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                try {
                    val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply { addTarget(target) }
                    req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                    req.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, android.util.Range(fps, fps))
                    s.setRepeatingRequest(req.build(), null, cameraHandler)
                } catch (t: Throwable) { listener?.onError("repeating: ${t.message}") }
            }
            override fun onConfigureFailed(s: CameraCaptureSession) { listener?.onError("session failed") }
        }, cameraHandler)
    }

    private fun pickCamera(manager: CameraManager): String? {
        val wantFacing = if (facingBack) CameraCharacteristics.LENS_FACING_BACK else CameraCharacteristics.LENS_FACING_FRONT
        return manager.cameraIdList.firstOrNull { id ->
            manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == wantFacing
        } ?: manager.cameraIdList.firstOrNull()
    }

    private fun drainLoop() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            val c = codec ?: break
            val outIndex = try { c.dequeueOutputBuffer(info, 10_000) } catch (t: Throwable) { break }
            if (outIndex >= 0) {
                val buf: ByteBuffer = c.getOutputBuffer(outIndex) ?: continue
                try {
                    if (info.size > 0) {
                        val data = ByteArray(info.size)
                        buf.position(info.offset); buf.get(data)
                        val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                        val isKey = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                        if (isConfig) {
                            spsPps = data // cache SPS/PPS
                        } else {
                            val out = if (isKey && spsPps != null) prepend(spsPps!!, data) else data
                            listener?.onFrame(out, isKey, info.presentationTimeUs)
                        }
                    }
                } finally {
                    c.releaseOutputBuffer(outIndex, false)
                }
            } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                // format change; SPS/PPS will arrive as codec-config buffer
            }
        }
    }

    private fun prepend(head: ByteArray, body: ByteArray): ByteArray {
        val out = ByteArray(head.size + body.size)
        System.arraycopy(head, 0, out, 0, head.size)
        System.arraycopy(body, 0, out, head.size, body.size)
        return out
    }

    fun switchCamera() {
        facingBack = !facingBack
        if (running) { stopInternal(); start() }
    }

    fun stop() { running = false; stopInternal() }

    private fun stopInternal() {
        try { session?.close() } catch (_: Throwable) {}
        try { cameraDevice?.close() } catch (_: Throwable) {}
        try { codec?.stop(); codec?.release() } catch (_: Throwable) {}
        try { inputSurface?.release() } catch (_: Throwable) {}
        drainThread?.quitSafely(); cameraThread?.quitSafely()
        session = null; cameraDevice = null; codec = null; inputSurface = null
        spsPps = null
    }
}
