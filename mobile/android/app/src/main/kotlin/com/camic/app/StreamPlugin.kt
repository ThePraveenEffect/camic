package com.camic.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.ArrayDeque

/**
 * Bridges the native encoders to Dart.
 *
 * MethodChannel "camic/stream" commands:
 *   start {w,h,fps,bitrate,audioEnabled,sampleRate,channels,audioBitrate,facingBack}
 *   stop
 *   switchCamera
 *   refocus
 *   netq {loss}  (desktop-measured packet loss → encoder bitrate steering)
 * Events via EventChannel "camic/frames":
 *   map {type:'video'|'audio'|'videoConfig'|'audioConfig'|'log', data: Uint8List, isKey: bool, ts: long}
 *
 * Frames are queued and flushed to Dart on the platform thread; Dart forwards
 * them to the UDP sender. Backpressure: if the queue grows beyond a cap we drop
 * non-key video frames (keeps latency bounded, protocol tolerates loss).
 */
class StreamPlugin(private val context: Context) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {
    private var methodChannel: MethodChannel? = null
    private var eventChannel: EventChannel? = null
    private var events: EventChannel.EventSink? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val videoEncoder = VideoEncoder(context)
    private val audioEncoder = AudioEncoder()
    private val queue = ArrayDeque<Map<String, Any?>>()
    private val lock = Object()
    private val MAX_QUEUE = 120
    private var audioEnabled = true

    fun attach(messenger: io.flutter.plugin.common.BinaryMessenger) {
        methodChannel = MethodChannel(messenger, "camic/stream")
        methodChannel!!.setMethodCallHandler(this)
        eventChannel = EventChannel(messenger, "camic/frames")
        eventChannel!!.setStreamHandler(this)
        videoEncoder.listener = object : VideoEncoder.Listener {
            override fun onFormat(width: Int, height: Int) {}
            override fun onFrame(data: ByteArray, isKey: Boolean, tsUs: Long) {
                enqueue(mapOf("type" to "video", "data" to data, "isKey" to isKey, "ts" to tsUs, "drop" to (!isKey)))
            }
            override fun onError(message: String) { sendError(message) }
            override fun onLog(message: String) { sendLog(message) }
        }
        audioEncoder.listener = object : AudioEncoder.Listener {
            override fun onFrame(data: ByteArray, tsUs: Long) { enqueue(mapOf("type" to "audio", "data" to data, "ts" to tsUs)) }
            override fun onConfig(data: ByteArray) { enqueue(mapOf("type" to "audioConfig", "data" to data)) }
            override fun onError(message: String) { sendError(message) }
        }
    }

    /** Diagnostic text → logcat + on-screen phone log (type 'log', no data). */
    private fun sendLog(message: String) {
        Log.i("Camic", message)
        enqueue(mapOf("type" to "log", "msg" to message))
    }

    override fun onMethodCall(call: io.flutter.plugin.common.MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> {
                val w = call.argument<Int>("w") ?: 1280
                val h = call.argument<Int>("h") ?: 720
                val fps = call.argument<Int>("fps") ?: 30
                val bitrate = call.argument<Int>("bitrate") ?: 4_000_000
                audioEnabled = call.argument<Boolean>("audioEnabled") ?: true
                val sampleRate = call.argument<Int>("sampleRate") ?: 48000
                val channels = call.argument<Int>("channels") ?: 1
                val audioBitrate = call.argument<Int>("audioBitrate") ?: 64000
                val facingBack = call.argument<Boolean>("facingBack") ?: true
                // Bring up the foreground service FIRST so the process is
                // camera-eligible before Camera2 opens (Android revokes camera
                // from backgrounded apps otherwise).
                StreamService.start(context)
                videoEncoder.configure(w, h, fps, bitrate, facingBack)
                videoEncoder.start()
                if (audioEnabled) { audioEncoder.configure(sampleRate, channels, audioBitrate); audioEncoder.start() }
                // Surface startup failures (e.g. missing CAMERA/RECORD_AUDIO permission)
                // to Dart instead of pretending the stream started.
                val vErr = videoEncoder.lastError
                if (vErr != null) { result.error("video_start_failed", vErr, null); return }
                val aErr = audioEncoder.lastError
                if (audioEnabled && aErr != null) { result.error("audio_start_failed", aErr, null); return }
                result.success(true)
            }
            "stop" -> { videoEncoder.stop(); audioEncoder.stop(); StreamService.stop(context); result.success(true) }
            "switchCamera" -> { videoEncoder.switchCamera(); result.success(true) }
            "refocus" -> { videoEncoder.refocus(); result.success(true) }
            "netq" -> { videoEncoder.adjustNetwork(call.argument<Double>("loss") ?: 0.0); result.success(true) }
            else -> result.notImplemented()
        }
    }

    override fun onListen(args: Any?, events: EventChannel.EventSink?) {
        this.events = events
        flush()
    }
    override fun onCancel(args: Any?) { this.events = null }

    private fun enqueue(frame: Map<String, Any?>) {
        synchronized(lock) {
            if (queue.size >= MAX_QUEUE) {
                // drop oldest non-key video to bound latency
                val it = queue.iterator()
                while (it.hasNext()) {
                    val f = it.next()
                    if (f["type"] == "video" && f["drop"] == true) { it.remove(); break }
                }
                if (queue.size >= MAX_QUEUE) queue.pollFirst()
            }
            queue.addLast(frame)
        }
        mainHandler.post { flush() }
    }

    private fun flush() {
        val sink = events ?: return
        while (true) {
            val frame = synchronized(lock) { if (queue.isEmpty()) null else queue.pollFirst() } ?: break
            try {
                val map = HashMap(frame)
                // 'log' frames carry only a msg string — casting a missing "data"
                // to ByteArray throws and would crash the app on the main thread.
                val data = frame["data"]
                if (data is ByteArray) map["data"] = data
                sink.success(map)
            } catch (t: Throwable) {
                Log.w("Camic", "frame flush failed: $t")
                break
            }
        }
    }

    private fun sendError(message: String) {
        mainHandler.post {
            try { events?.error("encode", message, null) } catch (t: Throwable) { Log.w("Camic", "error sink failed: $t") }
        }
    }
}
