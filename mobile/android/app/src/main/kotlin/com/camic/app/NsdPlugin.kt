package com.camic.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.MethodChannel

/**
 * mDNS/DNS-SD advertising via Android NsdManager so desktops on the LAN can
 * auto-discover the phone (_camic._tcp). TXT records carry id/ver/enc.
 */
class NsdPlugin(private val context: Context) : MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var nsdManager: NsdManager? = null
    private var registered = false
    private var registrationListener: NsdManager.RegistrationListener? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    fun attach(messenger: io.flutter.plugin.common.BinaryMessenger) {
        channel = MethodChannel(messenger, "camic/nsd")
        channel!!.setMethodCallHandler(this)
        nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    }

    override fun onMethodCall(call: io.flutter.plugin.common.MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "register" -> {
                val name = call.argument<String>("name") ?: "Camic"
                val port = call.argument<Int>("port") ?: 4747
                val id = call.argument<String>("id") ?: ""
                register(name, port, id, result)
            }
            "unregister" -> { unregister(); result.success(true) }
            else -> result.notImplemented()
        }
    }

    private fun register(name: String, port: Int, id: String, result: MethodChannel.Result) {
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = "_camic._tcp"
            this.port = port
            setAttribute("id", id)
            setAttribute("ver", "1")
            setAttribute("enc", "h264")
            setAttribute("aenc", "aac")
            setAttribute("pin", "1")
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(nsdServiceInfo: NsdServiceInfo) { mainHandler.post { result.success(true) } }
            override fun onRegistrationFailed(arg0: NsdServiceInfo, arg1: Int) { mainHandler.post { result.error("nsd", "register failed $arg1", null) } }
            override fun onServiceUnregistered(arg0: NsdServiceInfo) {}
            override fun onUnregistrationFailed(arg0: NsdServiceInfo, arg1: Int) {}
        }
        registrationListener = listener
        nsdManager?.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        registered = true
    }

    private fun unregister() {
        if (registered) {
            try { nsdManager?.unregisterService(registrationListener) } catch (e: Throwable) {}
            registrationListener = null
            registered = false
        }
    }
}
