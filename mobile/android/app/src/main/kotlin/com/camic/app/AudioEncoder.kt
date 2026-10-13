package com.camic.app

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Process
import java.nio.ByteBuffer

/**
 * AAC-LC audio encoder: AudioRecord (mic) → MediaCodec AAC → ADTS-free raw
 * frames (protocol sends raw AAC AUs; desktop wraps ADTS). 20 ms frames.
 */
class AudioEncoder {
    interface Listener {
        fun onFrame(data: ByteArray, tsUs: Long)
        fun onConfig(data: ByteArray)
        fun onError(message: String)
    }
    var listener: Listener? = null

    /** Last fatal error (e.g. IllegalStateException from missing RECORD_AUDIO). */
    @Volatile var lastError: String? = null
        private set

    fun isRunning(): Boolean = running

    private var codec: MediaCodec? = null
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    private var sampleRate = 48000
    private var channels = 1
    private var bitrate = 64000

    fun configure(sampleRate: Int, channels: Int, bitrate: Int) {
        this.sampleRate = sampleRate; this.channels = channels; this.bitrate = bitrate
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        running = true
        lastError = null
        try {
            val channelMask = if (channels == 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO
            val minBuf = AudioRecord.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
            record = AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT, minBuf * 2)
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
            }
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
                configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                start()
            }
            record?.startRecording()
            thread = Thread({ encodeLoop() }, "cb-audio").apply { start() }
        } catch (t: Throwable) {
            running = false
            lastError = "audio start: ${t.javaClass.simpleName}: ${t.message}"
            listener?.onError(lastError!!)
        }
    }

    private fun encodeLoop() {
        val buf = ByteArray(2048) // ~20ms at 48k mono s16 = 1920 bytes
        val info = MediaCodec.BufferInfo()
        while (running) {
            val r = record?.read(buf, 0, buf.size) ?: -1
            if (r > 0) {
                val c = codec ?: break
                val inIndex = c.dequeueInputBuffer(10_000)
                if (inIndex >= 0) {
                    val inBuf = c.getInputBuffer(inIndex) ?: continue
                    inBuf.clear(); inBuf.put(buf, 0, r)
                    c.queueInputBuffer(inIndex, 0, r, System.nanoTime() / 1000, 0)
                }
                // drain
                while (true) {
                    val outIndex = c.dequeueOutputBuffer(info, 0)
                    if (outIndex >= 0) {
                        val outBuf = c.getOutputBuffer(outIndex) ?: break
                        if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                            val data = ByteArray(info.size)
                            outBuf.position(info.offset); outBuf.get(data)
                            listener?.onFrame(data, info.presentationTimeUs)
                        } else if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            val data = ByteArray(info.size)
                            outBuf.position(info.offset); outBuf.get(data)
                            listener?.onConfig(data)
                        }
                        c.releaseOutputBuffer(outIndex, false)
                    } else break
                }
            }
        }
    }

    fun stop() {
        running = false
        thread?.join(500)
        try { record?.stop() } catch (_: Throwable) {}
        try { codec?.stop(); codec?.release() } catch (_: Throwable) {}
        record = null; codec = null
    }
}
