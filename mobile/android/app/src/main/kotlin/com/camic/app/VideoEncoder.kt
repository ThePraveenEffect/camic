package com.camic.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.*
import android.media.ImageReader
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Range
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
        /** Diagnostic line, surfaced to logcat and the phone's on-screen log. */
        fun onLog(message: String)
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
    private var requestedBitrate = 4_000_000
    // AE/AF settle tracking (camera handler thread only).
    private var afPhase = PHASE_SETTLE
    private var triggerAtMs = 0L
    private var sawAfState = false
    private var canTriggerAf = false
    private var macroAfAvailable = false
    // Sharpness-critical ISP request values (0 = unsupported, leave template
    // default). Chosen in createSession from the device's available-modes
    // queries; applied to EVERY request via applyQuality.
    private var edgeMode = 0
    private var nrMode = 0
    private var abMode = 0
    private var captureCb: CameraCaptureSession.CaptureCallback? = null
    private var firstFrameAtMs = 0L
    private var lastFocusD = Float.NaN
    private var focusStableFrames = 0
    private var lastExposureNs = 0L
    private var lastIso = 0
    private var exposureStableFrames = 0
    private var focusReady = false
    private var exposureReady = false
    private var waitLogged = false
    // Adaptive re-lock (camera handler thread only).
    private var probeAtMs = 0L
    private var probeStartMs = 0L
    private var adaptStartMs = 0L
    private var adaptAf = false
    private var adaptMacroRetried = false
    private var frozenExpNs = 0L
    private var frozenIso = 0
    private var frozenFocusD = Float.NaN
    private var probeCount = 0
    private var faceMode = 0
    private var baseFaceCount = -1
    private var baseFaceCx = 0f
    private var baseFaceCy = 0f
    private var baseFaceSize = 0f
    // Scene-adaptive bitrate (drain thread only).
    private var currentBpsCap = 0
    private var bitrateAdaptEnabled = true
    private var windowBytes = 0
    private var windowStartMs = 0L
    private var highStreak = 0
    private var lowStreak = 0
    // Network-congestion loop (drain thread only): the desktop measures packet
    // loss and reports it — the only true signal of Wi-Fi saturation.
    private var cleanStreak = 0
    private var netHoldUntilMs = 0L

    private companion object {
        const val PHASE_SETTLE = 0   // waiting for focus/exposure to settle
        const val PHASE_TRIGGER = 1 // one-shot AF running, waiting for FOCUSED_LOCKED
        const val PHASE_FROZEN = 2  // baseline held; periodic probe armed
        const val PHASE_PROBE = 3   // AE briefly unlocked to detect scene change
        const val PHASE_ADAPT = 4   // scene changed: fast refocus + AE re-converge

        const val PROBE_INTERVAL_MS = 3000L  // how often the scene is re-checked
        const val PROBE_SETTLE_MS = 250L      // AE observation window per probe
        const val ADAPT_TIMEOUT_MS = 1500L    // max wait for a refocus/step to finish
        const val MAX_BPS_CAP = 12_000_000    // scene-adaptive bitrate ceiling
        const val STABILIZE_EIS = false       // digital EIS softens; flip for handheld
    }

    fun configure(width: Int, height: Int, fps: Int, bitrate: Int, facingBack: Boolean) {
        this.width = width; this.height = height; this.fps = fps; this.facingBack = facingBack
        this.requestedBitrate = bitrate
        // Motion needs bitrate headroom: 1080p below 8 Mbps turns fine detail
        // into mush long before the encoder runs out of "allowed" bits.
        this.bitrate = if (width * height >= 1920 * 1080 && bitrate < 8_000_000) 8_000_000 else bitrate
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        running = true
        lastError = null
        try {
            currentBpsCap = bitrate
            bitrateAdaptEnabled = true
            windowBytes = 0; windowStartMs = 0L; highStreak = 0; lowStreak = 0
            cleanStreak = 0; netHoldUntilMs = 0L
            // CBR: a steady bit stream over Wi-Fi — VBR bursts on movement and
            // the burst is what gets dropped, which smears until the next IDR.
            // High profile (CABAC) buys ~10-15% efficiency over Baseline at the
            // same bitrate → visibly sharper; fall back if the encoder refuses.
            // Encoder-utilization ramping is meaningless under CBR (CBR fills
            // every window by definition) — bitrate is steered by the desktop's
            // loss feedback (adjustNetwork) instead.
            var usedCbr = true
            var highProfile = true
            codec = try {
                createCodec(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR, true)
            } catch (_: Throwable) {
                highProfile = false
                try {
                    createCodec(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR, false)
                } catch (_: Throwable) {
                    usedCbr = false
                    createCodec(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR, false)
                }
            }
            bitrateAdaptEnabled = !usedCbr
            drainThread = HandlerThread("cb-video-drain").apply { start() }
            drainHandler = Handler(drainThread!!.looper)
            drainHandler!!.post { drainLoop() }
            openCamera()
            listener?.onFormat(width, height)
            if (bitrate != requestedBitrate) {
                listener?.onLog("bitrate floor: ${requestedBitrate / 1_000_000} → ${bitrate / 1_000_000} Mbps for ${width}x${height}")
            }
            listener?.onLog(
                "encoder: ${width}x${height}@$fps, ${bitrate / 1_000_000} Mbps ${if (usedCbr) "CBR" else "VBR"}, " +
                    "profile=${if (highProfile) "high" else "baseline"}, IDR every 1s"
            )
        } catch (t: Throwable) {
            running = false
            lastError = "video encoder start: ${t.javaClass.simpleName}: ${t.message}"
            listener?.onError(lastError!!)
        }
    }

    private fun createCodec(bitrateMode: Int, highProfile: Boolean): MediaCodec {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1) // IDR every ~1s → corruption clears in ≤1s
            setInteger(MediaFormat.KEY_BITRATE_MODE, bitrateMode)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 0)
            // Declare BT.709 limited-range so ffmpeg/the decoder colors the
            // picture correctly — an undeclared stream gets guessed as BT.601,
            // which reads as washed-out and "soft" even when it's sharp.
            setInteger(MediaFormat.KEY_COLOR_STANDARD, MediaFormat.COLOR_STANDARD_BT709)
            setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED)
            setInteger(MediaFormat.KEY_COLOR_TRANSFER, MediaFormat.COLOR_TRANSFER_SDR_VIDEO)
            if (highProfile) {
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileHigh)
                setInteger(
                    MediaFormat.KEY_LEVEL,
                    if (width * height > 1280 * 720) MediaCodecInfo.CodecProfileLevel.AVCLevel4
                    else MediaCodecInfo.CodecProfileLevel.AVCLevel31
                )
            }
        }
        val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            inputSurface = c.createInputSurface()
            c.start()
        } catch (t: Throwable) {
            try { c.release() } catch (_: Throwable) {}
            throw t
        }
        return c
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
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val chars = try { manager.getCameraCharacteristics(camera.id) } catch (_: Throwable) { null }
        resetMonitor()
        // Can we run a verifiable one-shot AF? NOTE: do NOT gate on
        // LENS_INFO_MINIMUM_FOCUS_DISTANCE > 0 — many HALs (Samsung budget
        // especially) report 0 ("unknown") on cameras that focus fine. The
        // AF-available-modes list is the reliable signal.
        val minFocus = chars?.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
        val afModes = chars?.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
        canTriggerAf = afModes != null &&
            (CaptureRequest.CONTROL_AF_MODE_AUTO in afModes ||
                CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO in afModes ||
                CaptureRequest.CONTROL_AF_MODE_MACRO in afModes)
        macroAfAvailable = afModes != null && CaptureRequest.CONTROL_AF_MODE_MACRO in afModes
        // ISP sharpness stack: hardware edge enhancement + minimal noise
        // reduction (HQ temporal NR smears fine detail — the indoor sharpness
        // killer) + anti-banding. Only modes the HAL advertises are ever set —
        // Camera2 rejects requests with out-of-range values outright.
        val hwLevel = chars?.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)
        val edgeModes = chars?.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES)
        edgeMode = if (edgeModes != null && CameraMetadata.EDGE_MODE_FAST in edgeModes)
            CameraMetadata.EDGE_MODE_FAST else 0
        val nrModes = chars?.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES)
        nrMode = when {
            nrModes == null -> 0
            CameraMetadata.NOISE_REDUCTION_MODE_MINIMAL in nrModes -> CameraMetadata.NOISE_REDUCTION_MODE_MINIMAL
            else -> 0 // template default (FAST) is the sane fallback
        }
        val abModes = chars?.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_ANTIBANDING_MODES)
        abMode = if (abModes != null && CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO in abModes)
            CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO else 0
        val maxSize = chars?.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?.getOutputSizes(android.graphics.ImageFormat.PRIVATE)
            ?.maxByOrNull { it.width * it.height }
        // Face detection (when available) is the instant "scene changed" signal.
        val fdModes = chars?.get(CameraCharacteristics.STATISTICS_INFO_AVAILABLE_FACE_DETECT_MODES)
        faceMode = when {
            fdModes == null -> 0
            CameraMetadata.STATISTICS_FACE_DETECT_MODE_SIMPLE in fdModes -> CameraMetadata.STATISTICS_FACE_DETECT_MODE_SIMPLE
            CameraMetadata.STATISTICS_FACE_DETECT_MODE_FULL in fdModes -> CameraMetadata.STATISTICS_FACE_DETECT_MODE_FULL
            else -> 0
        }
        @Suppress("DEPRECATION")
        camera.createCaptureSession(listOf(target), object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                try {
                    val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply { addTarget(target) }
                    // Continuous-video AF is the smoothest available mode, but it still
                    // hunts on movement → brief blur. The callback below locks focus
                    // and exposure once they settle (see monitorAeAf).
                    req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                    // Sharpness-critical ISP settings (EIS OFF, edge enhance,
                    // minimal NR, antibanding) — see applyQuality.
                    applyQuality(req)
                    // Ask for an FPS range the camera actually supports — prefer
                    // the hard [30,30] cadence (pickAeFpsRange prefers it); a
                    // range the sensor rejects forces a stuttersome fallback.
                    pickAeFpsRange(chars, fps)?.let { req.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
                    if (faceMode != 0) req.set(CaptureRequest.STATISTICS_FACE_DETECT_MODE, faceMode)
                    val callback = object : CameraCaptureSession.CaptureCallback() {
                        override fun onCaptureCompleted(
                            session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult
                        ) { monitorAeAf(session, target, result) }
                    }
                    captureCb = callback
                    s.setRepeatingRequest(req.build(), callback, cameraHandler)
                    // Report what the device actually supports — this line is the
                    // primary diagnostic for the next round of tuning.
                    listener?.onLog(
                        "camera: hwLevel=${hwLevelName(hwLevel)}, " +
                            "faces=${if (faceMode != 0) "on" else "off"}, " +
                            "aeFpsRange=${pickAeFpsRange(chars, fps) ?: "default"}, " +
                            "afModes=${afModes?.joinToString() ?: "n/a"}, " +
                            "afTrigger=${if (canTriggerAf) "on" else "OFF (fixed-focus?)"}, " +
                            "macro=${if (macroAfAvailable) "on" else "off"}, " +
                            "minFocus=${minFocus}D (≈${if (minFocus > 0f) (100f / minFocus).toInt() else -1}cm), " +
                            "maxOut=${maxSize?.width ?: 0}x${maxSize?.height ?: 0}"
                    )
                    listener?.onLog(
                        "isp: eis=${if (STABILIZE_EIS) "on" else "off"}, edge=${edgeName(edgeMode)}, " +
                            "nr=${nrName(nrMode)}, ab=${abName(abMode)}"
                    )
                } catch (t: Throwable) { listener?.onError("repeating: ${t.message}") }
            }
            override fun onConfigureFailed(s: CameraCaptureSession) { listener?.onError("session failed") }
        }, cameraHandler)
    }

    private fun resetMonitor() {
        afPhase = PHASE_SETTLE
        triggerAtMs = 0L
        sawAfState = false
        captureCb = null
        firstFrameAtMs = 0L
        lastFocusD = Float.NaN
        focusStableFrames = 0
        lastExposureNs = 0L
        lastIso = 0
        exposureStableFrames = 0
        focusReady = false
        exposureReady = false
        waitLogged = false
        probeAtMs = 0L; probeStartMs = 0L; adaptStartMs = 0L; adaptAf = false; adaptMacroRetried = false
        frozenExpNs = 0L; frozenIso = 0; frozenFocusD = Float.NaN; probeCount = 0
        baseFaceCount = -1; baseFaceCx = 0f; baseFaceCy = 0f; baseFaceSize = 0f
    }

    /**
     * Adaptive five-phase focus/exposure controller (observable signals only —
     * vendor AF/AE state reporting is unreliable across HALs):
     *
     * 1. SETTLE   — wait for focus/exposure to settle (≥1 s; fallback 4 s).
     * 2. TRIGGER  — one-shot AF, wait for a definitive FOCUSED_LOCKED so the
     *               frozen position is verified-sharp, not approximately-sharp.
     * 3. FROZEN   — lens OFF + AE_LOCK: zero hunting, zero blur. Every 3 s (or
     *               instantly when face geometry changes) an invisible probe
     *               re-checks the scene; every 3rd probe (~10 s) also re-runs
     *               AF so small close objects (cards, components) get caught
     *               even though they don't move metering or faces.
     * 4. PROBE    — AE unlocked for 250 ms; exposure/ISO/face compared against
     *               the frozen reference. Unchanged → re-lock silently, no
     *               visual effect at all. Changed → adapt.
     * 5. ADAPT    — one fast one-shot refocus + AE re-converge (≤1.5 s), then
     *               back to FROZEN with a fresh reference. Showing an object
     *               snaps to it quickly; a static scene never blurs.
     */
    private fun monitorAeAf(session: CameraCaptureSession, target: Surface, result: TotalCaptureResult) {
        if (!running) return
        val now = SystemClock.elapsedRealtime()
        if (firstFrameAtMs == 0L) firstFrameAtMs = now
        val upMs = now - firstFrameAtMs

        val focusD = result.get(CaptureResult.LENS_FOCUS_DISTANCE)
        val afState = result.get(CaptureResult.CONTROL_AF_STATE)
        if (afState != null) sawAfState = true
        if (focusD != null) {
            if (!lastFocusD.isNaN() && kotlin.math.abs(focusD - lastFocusD) <= 0.01f) focusStableFrames++ else focusStableFrames = 0
            lastFocusD = focusD
        }
        val exposureNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: 0L
        val iso = result.get(CaptureResult.SENSOR_SENSITIVITY) ?: 0
        if (exposureNs == lastExposureNs && iso == lastIso) exposureStableFrames++ else exposureStableFrames = 0
        lastExposureNs = exposureNs; lastIso = iso

        when (afPhase) {
            PHASE_TRIGGER -> {
                val stateDone = afState == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED ||
                    afState == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED
                val waited = upMs - triggerAtMs
                val timeout = if (sawAfState) waited >= 2500 else waited >= 1200
                if (!stateDone && !timeout) return
                if (timeout) listener?.onLog("AF one-shot timed out (state=${afName(afState)})")
                freezeLens(session, target, result, upMs, logFrozen = true, refreshRef = true)
            }

            PHASE_FROZEN -> {
                if (faceSigChanged(result) || upMs - probeAtMs >= PROBE_INTERVAL_MS) {
                    startProbe(session, target, upMs)
                }
            }

            PHASE_PROBE -> {
                if (upMs - probeStartMs < PROBE_SETTLE_MS) return
                val expPct = if (frozenExpNs > 0L) kotlin.math.abs(lastExposureNs - frozenExpNs) * 100 / frozenExpNs else 0L
                val isoPct = if (frozenIso > 0) kotlin.math.abs(lastIso - frozenIso) * 100 / frozenIso else 0
                // Every 3rd probe (~10 s) also re-runs AF: AE/face cannot see a
                // small close object (a microSD card barely moves metering), so
                // a periodic focus sweep is the only automatic way to catch one.
                val verifyTurn = probeCount % 3 == 0 && canTriggerAf
                val changed = expPct > 20L || isoPct > 25 || faceSigChanged(result) || verifyTurn
                if (!changed) {
                    freezeLens(session, target, result, upMs, logFrozen = false, refreshRef = false)
                    return
                }
                // Scene changed → adapt fast: AE is already unlocked by the probe
                // request, now run one bounded AF sweep.
                exposureStableFrames = 0
                adaptAf = false
                if (canTriggerAf) {
                    try {
                        val trig = cameraDevice!!.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                            addTarget(target)
                            applyQuality(this)
                            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
                            set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
                            set(CaptureRequest.CONTROL_AE_LOCK, false)
                        }
                        session.capture(trig.build(), null, cameraHandler)
                        adaptAf = true
                    } catch (t: Throwable) { listener?.onLog("adapt AF failed: ${t.message}") }
                }
                adaptStartMs = upMs
                adaptMacroRetried = false
                afPhase = PHASE_ADAPT
            }

            PHASE_ADAPT -> {
                val waited = upMs - adaptStartMs
                val aeState = result.get(CaptureResult.CONTROL_AE_STATE)
                val aeDone = aeState == null || aeState == CaptureResult.CONTROL_AE_STATE_CONVERGED ||
                    aeState == CaptureResult.CONTROL_AE_STATE_LOCKED || exposureStableFrames >= 5
                val afDone = when {
                    !adaptAf -> true
                    !sawAfState -> waited >= 1200
                    else -> afState == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED ||
                        afState == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED ||
                        waited >= ADAPT_TIMEOUT_MS
                }
                if (!aeDone || !afDone) return
                // AUTO couldn't find focus (very common for a small close card —
                // PDAF/contrast AUTO biases to face/desk distance). Retry once
                // in MACRO mode, which forces the close-focus lens range.
                val afLocked = afState == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED
                if (adaptAf && !afLocked && !adaptMacroRetried && macroAfAvailable) {
                    adaptMacroRetried = true
                    try {
                        // Switch the repeating stream to MACRO too — a lone
                        // MACRO trigger gets overridden by the AUTO-mode
                        // repeating request on many HALs.
                        val rep = cameraDevice!!.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                            addTarget(target)
                            applyQuality(this)
                            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_MACRO)
                            set(CaptureRequest.CONTROL_AE_LOCK, false)
                            if (faceMode != 0) set(CaptureRequest.STATISTICS_FACE_DETECT_MODE, faceMode)
                        }
                        session.setRepeatingRequest(rep.build(), captureCb, cameraHandler)
                        val trig = cameraDevice!!.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                            addTarget(target)
                            applyQuality(this)
                            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_MACRO)
                            set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
                            set(CaptureRequest.CONTROL_AE_LOCK, false)
                        }
                        session.capture(trig.build(), null, cameraHandler)
                        adaptStartMs = upMs
                        listener?.onLog("AF retry in macro mode (close subject)")
                        return
                    } catch (t: Throwable) { listener?.onLog("macro AF retry failed: ${t.message}") }
                }
                // A verify-turn adapt that lands back at the same focus/light
                // values was a no-op scan — refreeze silently (no log spam).
                val wasFocusD = frozenFocusD
                val focusMoved = !wasFocusD.isNaN() && !lastFocusD.isNaN() &&
                    kotlin.math.abs(lastFocusD - wasFocusD) > 0.1f
                val expPct = if (frozenExpNs > 0L) kotlin.math.abs(lastExposureNs - frozenExpNs) * 100 / frozenExpNs else 0L
                val isoPct = if (frozenIso > 0) kotlin.math.abs(lastIso - frozenIso) * 100 / frozenIso else 0
                val lightMoved = expPct > 20L || isoPct > 25
                val faceMoved = faceSigChanged(result)
                freezeLens(session, target, result, upMs, logFrozen = false, refreshRef = true)
                if (focusMoved || lightMoved || faceMoved) {
                    listener?.onLog(
                        "adapted at ${upMs}ms: af=${afName(afState)} focus=$wasFocusD→${lastFocusD}D " +
                            "exp=${lastExposureNs / 1_000_000}ms iso=$lastIso"
                    )
                }
            }

            else -> { // PHASE_SETTLE
                val afFocused = afState == null || afState == CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED ||
                    afState == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED
                if (!focusReady && upMs >= 1000 && (afFocused || focusStableFrames >= 8)) focusReady = true
                val aeState = result.get(CaptureResult.CONTROL_AE_STATE)
                val aeConverged = aeState == null || aeState == CaptureResult.CONTROL_AE_STATE_CONVERGED ||
                    aeState == CaptureResult.CONTROL_AE_STATE_LOCKED
                if (!exposureReady && upMs >= 1000 && (aeConverged || exposureStableFrames >= 10)) exposureReady = true

                if (!waitLogged && upMs >= 2000 && !(focusReady && exposureReady)) {
                    waitLogged = true
                    listener?.onLog("AE/AF still settling at ${upMs}ms: af=${afName(afState)} ae=${aeName(aeState)} focus=${focusD}D")
                }

                val forced = upMs >= 4000
                if (!forced && !(focusReady && exposureReady)) return

                // Settle complete (or forced): freeze exposure now, then one-shot AF.
                try {
                    val base = cameraDevice?.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)?.apply {
                        addTarget(target)
                        applyQuality(this)
                        set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
                        set(CaptureRequest.CONTROL_AE_LOCK, true)
                        if (faceMode != 0) set(CaptureRequest.STATISTICS_FACE_DETECT_MODE, faceMode)
                    } ?: run { freezeLens(session, target, result, upMs, logFrozen = true, refreshRef = true); return }
                    session.setRepeatingRequest(base.build(), captureCb, cameraHandler)
                } catch (t: Throwable) {
                    listener?.onLog("settle request failed: ${t.message}")
                    freezeLens(session, target, result, upMs, logFrozen = true, refreshRef = true)
                    return
                }

                if (!canTriggerAf) {
                    freezeLens(session, target, result, upMs, logFrozen = true, refreshRef = true)
                    return
                }
                try {
                    val trig = cameraDevice!!.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                        addTarget(target)
                        applyQuality(this)
                        set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
                        set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
                        set(CaptureRequest.CONTROL_AE_LOCK, true)
                    }
                    session.capture(trig.build(), null, cameraHandler)
                    triggerAtMs = upMs
                    afPhase = PHASE_TRIGGER
                } catch (t: Throwable) {
                    listener?.onLog("AF one-shot failed: ${t.message}")
                    freezeLens(session, target, result, upMs, logFrozen = true, refreshRef = true)
                }
            }
        }
    }

    /**
     * Invisible scene check: AF stays held where the freeze left it, AE is
     * unlocked for PROBE_SETTLE_MS so [monitorAeAf] can compare live exposure
     * against the frozen reference. Failures back off (probeAtMs is set first)
     * so a rejecting HAL can't be hammered.
     */
    private fun startProbe(session: CameraCaptureSession, target: Surface, upMs: Long) {
        probeAtMs = upMs
        probeCount++
        try {
            val req = cameraDevice?.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)?.apply {
                addTarget(target)
                applyQuality(this)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
                set(CaptureRequest.CONTROL_AE_LOCK, false)
                if (faceMode != 0) set(CaptureRequest.STATISTICS_FACE_DETECT_MODE, faceMode)
            } ?: return
            session.setRepeatingRequest(req.build(), captureCb, cameraHandler)
            probeStartMs = upMs
            exposureStableFrames = 0
            afPhase = PHASE_PROBE
        } catch (t: Throwable) {
            listener?.onLog("AE probe failed: ${t.message}")
        }
    }

    /**
     * Manual refocus — the phone-app "Focus" button (tap-to-focus equivalent).
     * AE unlocks, one-shot AF re-scans onto whatever is in frame now (e.g. a
     * microSD card held up), then the normal ADAPT completion re-freezes with
     * a fresh baseline. No-op while startup's settle/trigger sequence owns AF.
     */
    fun refocus() {
        cameraHandler?.post { requestRefocus() }
    }

    private fun requestRefocus() {
        if (!running) return
        val s = session ?: return
        val t = inputSurface ?: return
        if (!canTriggerAf) {
            listener?.onLog("refocus: no AF on this camera (fixed-focus / front?)")
            return
        }
        if (afPhase == PHASE_SETTLE || afPhase == PHASE_TRIGGER) {
            listener?.onLog("refocus ignored (camera still starting)")
            return
        }
        try {
            val base = cameraDevice?.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)?.apply {
                addTarget(t)
                applyQuality(this)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
                set(CaptureRequest.CONTROL_AE_LOCK, false)
                if (faceMode != 0) set(CaptureRequest.STATISTICS_FACE_DETECT_MODE, faceMode)
            } ?: return
            s.setRepeatingRequest(base.build(), captureCb, cameraHandler)
            adaptAf = false
            if (canTriggerAf) {
                val trig = cameraDevice!!.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                    addTarget(t)
                    applyQuality(this)
                    set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
                    set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
                    set(CaptureRequest.CONTROL_AE_LOCK, false)
                }
                s.capture(trig.build(), null, cameraHandler)
                adaptAf = true
            }
            exposureStableFrames = 0
            adaptStartMs = SystemClock.elapsedRealtime() - firstFrameAtMs
            adaptMacroRetried = false
            afPhase = PHASE_ADAPT
            listener?.onLog("manual refocus requested")
        } catch (t: Throwable) {
            listener?.onLog("refocus failed: ${t.message}")
        }
    }

    /** True when face count/position/size differs from the frozen baseline. */
    private fun faceSigChanged(result: TotalCaptureResult): Boolean {
        if (faceMode == 0 || baseFaceCount < 0) return false
        val faces = result.get(CaptureResult.STATISTICS_FACES)
        val count = faces?.size ?: 0
        if (count != baseFaceCount) return true
        val f = faces?.firstOrNull() ?: return false
        if (baseFaceSize <= 0f) return false
        val b = f.bounds
        val moved = kotlin.math.abs(b.centerX() - baseFaceCx) > width / 8f ||
            kotlin.math.abs(b.centerY() - baseFaceCy) > height / 8f
        val size = (b.width() + b.height()).toFloat()
        val resized = size < baseFaceSize * 0.75f || size > baseFaceSize * 1.35f
        return moved || resized
    }

    private fun recordFaceBaseline(result: TotalCaptureResult) {
        if (faceMode == 0) { baseFaceCount = -1; return }
        val faces = result.get(CaptureResult.STATISTICS_FACES)
        val f = faces?.firstOrNull()
        if (f == null) { baseFaceCount = 0; baseFaceSize = 0f; return }
        baseFaceCount = faces!!.size
        val b = f.bounds
        baseFaceCx = b.centerX().toFloat(); baseFaceCy = b.centerY().toFloat()
        baseFaceSize = (b.width() + b.height()).toFloat()
    }

    /**
     * Final state: lens OFF at the verified focus position + exposure locked.
     * [refreshRef] updates the probe's comparison baseline (first freeze after
     * settle, or after an adaptation — NOT on no-change re-freezes, so slow
     * cumulative changes still accumulate and eventually trigger an adapt).
     * Silent unless [logFrozen] (probe re-freezes happen every few seconds).
     */
    private fun freezeLens(
        session: CameraCaptureSession, target: Surface, result: TotalCaptureResult,
        upMs: Long, logFrozen: Boolean, refreshRef: Boolean
    ) {
        afPhase = PHASE_FROZEN
        if (refreshRef) {
            frozenExpNs = lastExposureNs
            frozenIso = lastIso
            frozenFocusD = lastFocusD
            recordFaceBaseline(result)
        }
        probeAtMs = upMs
        try {
            val req = cameraDevice?.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)?.apply {
                addTarget(target)
                applyQuality(this)
                // Freeze the lens at its verified position — continuous AF can no
                // longer re-hunt (and blur) when the subject or phone moves.
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
                set(CaptureRequest.CONTROL_AE_LOCK, true)
                if (faceMode != 0) set(CaptureRequest.STATISTICS_FACE_DETECT_MODE, faceMode)
            } ?: return
            session.setRepeatingRequest(req.build(), null, cameraHandler)
            if (logFrozen) {
                listener?.onLog(
                    "focus+exposure frozen at ${upMs}ms: af=${afName(result.get(CaptureResult.CONTROL_AF_STATE))} " +
                        "focus=${lastFocusD}D exp=${lastExposureNs / 1_000_000}ms iso=$lastIso"
                )
            }
        } catch (t: Throwable) {
            listener?.onLog("focus/exposure freeze FAILED: ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    private fun afName(v: Int?): String = when (v) {
        null -> "n/a"; 0 -> "INACTIVE"; 1 -> "PASSIVE_SCAN"; 2 -> "PASSIVE_FOCUSED"
        3 -> "PASSIVE_UNFOCUSED"; 4 -> "ACTIVE_SCAN"; 5 -> "FOCUSED_LOCKED"; 6 -> "NOT_FOCUSED_LOCKED"
        else -> "S$v"
    }

    private fun aeName(v: Int?): String = when (v) {
        null -> "n/a"; 0 -> "INACTIVE"; 1 -> "SEARCHING"; 2 -> "CONVERGED"
        3 -> "LOCKED"; 4 -> "PRECAPTURE"; 5 -> "FLASH_REQUIRED"
        else -> "S$v"
    }

    /**
     * Sharpness-critical settings carried by EVERY capture request we build.
     * Camera2 settings are per-request: a later setRepeatingRequest with a bare
     * TEMPLATE_RECORD would silently revert to the soft template defaults.
     * EIS is forced OFF — the A20 has no OIS, and digital crop+warp is a
     * measurable sharpness loss for a (mostly) static webcam. Flip the
     * STABILIZE_EIS constant if handheld shake ever matters more than detail.
     */
    private fun applyQuality(req: CaptureRequest.Builder) {
        req.set(
            CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
            if (STABILIZE_EIS) CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON
            else CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF
        )
        if (edgeMode != 0) req.set(CaptureRequest.EDGE_MODE, edgeMode)
        if (nrMode != 0) req.set(CaptureRequest.NOISE_REDUCTION_MODE, nrMode)
        if (abMode != 0) req.set(CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, abMode)
    }

    private fun hwLevelName(level: Int?): String = when (level) {
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "LEGACY"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "FULL"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "LEVEL3"
        else -> "n/a"
    }

    private fun edgeName(v: Int) = when (v) {
        CameraMetadata.EDGE_MODE_FAST -> "fast"
        CameraMetadata.EDGE_MODE_HIGH_QUALITY -> "hq"
        CameraMetadata.EDGE_MODE_OFF -> "off"
        else -> "default"
    }

    private fun nrName(v: Int) = when (v) {
        CameraMetadata.NOISE_REDUCTION_MODE_MINIMAL -> "minimal"
        CameraMetadata.NOISE_REDUCTION_MODE_FAST -> "fast"
        CameraMetadata.NOISE_REDUCTION_MODE_HIGH_QUALITY -> "hq"
        CameraMetadata.NOISE_REDUCTION_MODE_OFF -> "off"
        else -> "default"
    }

    private fun abName(v: Int) = when (v) {
        CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO -> "auto"
        CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_50HZ -> "50"
        CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_60HZ -> "60"
        else -> "default"
    }

    /**
     * Pick the tightest advertised AE FPS range containing [fps]; fall back to
     * the closest supported range, then to null (camera keeps template default).
     */
    private fun pickAeFpsRange(chars: CameraCharacteristics?, fps: Int): Range<Int>? {
        val ranges = chars?.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: return null
        val containing = ranges.filter { it.lower <= fps && it.upper >= fps }
        if (containing.isNotEmpty()) return containing.minByOrNull { it.upper - it.lower }
        return ranges.minByOrNull { kotlin.math.abs(it.upper - fps) }
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
                        trackBitrate(info.size)
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

    /**
     * Per-frame encoded-byte accounting (drain thread). Under CBR this cannot
     * reveal scene demand — CBR fills every window by definition — so the real
     * quality signal is the desktop's loss report (adjustNetwork). The
     * utilization ramp only runs for the VBR fallback path.
     */
    private fun trackBitrate(size: Int) {
        if (size <= 0) return
        val now = SystemClock.elapsedRealtime()
        if (windowStartMs == 0L) { windowStartMs = now; windowBytes = 0 }
        windowBytes += size
        if (!bitrateAdaptEnabled) return
        val dt = now - windowStartMs
        if (dt < 2000) return
        val bps = (windowBytes.toLong() * 8000 / dt).toInt()
        windowBytes = 0; windowStartMs = now
        if (currentBpsCap <= 0) return
        val util = bps.toDouble() / currentBpsCap
        if (util >= 0.9) { highStreak++; lowStreak = 0 }
        else if (util <= 0.55) { lowStreak++; highStreak = 0 }
        else { highStreak = 0; lowStreak = 0 }
        when {
            highStreak >= 2 && currentBpsCap < MAX_BPS_CAP -> {
                highStreak = 0
                setEncoderBitrate(minOf((currentBpsCap * 3L / 2).toInt(), MAX_BPS_CAP), "scene detail")
            }
            lowStreak >= 6 && currentBpsCap > bitrate -> {
                lowStreak = 0
                setEncoderBitrate(maxOf(currentBpsCap * 3 / 4, bitrate), "scene easy")
            }
        }
    }

    /**
     * Network-driven bitrate steering — the fix for "quality locked bad".
     * The desktop measures actual UDP packet loss every second and reports it;
     * that is the only honest signal of Wi-Fi saturation (the A20 uses crowded
     * 2.4 GHz, where 8-12 Mbps CBR can exceed airtime and the overflow is
     * dropped — mush between keyframes). Fast down, slow up:
     *   loss ≥ 2%   → cut to 75% immediately (floor 30% of configured), hold 4s
     *   loss ≥ 0.3% → cap at 6 Mbps, hold 4s
     *   clean 5s    → recover towards the configured rate in +15% steps
     */
    fun adjustNetwork(lossPct: Double) {
        drainHandler?.post {
            if (!running || currentBpsCap <= 0) return@post
            val now = SystemClock.elapsedRealtime()
            when {
                lossPct >= 2.0 -> {
                    cleanStreak = 0
                    if (now >= netHoldUntilMs) {
                        val target = maxOf(bitrate * 30 / 100, currentBpsCap * 3 / 4)
                        if (target != currentBpsCap) setEncoderBitrate(target, "loss ${lossPct.toInt()}%")
                        netHoldUntilMs = now + 4000
                    }
                }
                lossPct >= 0.3 -> {
                    cleanStreak = 0
                    if (now >= netHoldUntilMs && currentBpsCap > 6_000_000) {
                        setEncoderBitrate(6_000_000, "loss $lossPct%")
                        netHoldUntilMs = now + 4000
                    }
                }
                else -> {
                    if (now >= netHoldUntilMs) {
                        cleanStreak++
                        if (cleanStreak >= 5) {
                            cleanStreak = 0
                            val target = minOf(currentBpsCap * 115 / 100, bitrate)
                            if (target != currentBpsCap) setEncoderBitrate(target, "link clean")
                        }
                    }
                }
            }
        }
    }

    private fun setEncoderBitrate(bps: Int, why: String) {
        try {
            codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps) })
            currentBpsCap = bps
            listener?.onLog("quality: bitrate → ${bps / 1_000_000} Mbps ($why)")
        } catch (t: Throwable) {
            listener?.onLog("bitrate steering off: ${t.javaClass.simpleName}: ${t.message}")
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
