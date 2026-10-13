package com.camic.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var streamPlugin: StreamPlugin? = null
    private var nsdPlugin: NsdPlugin? = null
    private var pendingPermissionResult: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        streamPlugin = StreamPlugin(applicationContext)
        streamPlugin!!.attach(flutterEngine.dartExecutor.binaryMessenger)
        nsdPlugin = NsdPlugin(applicationContext)
        nsdPlugin!!.attach(flutterEngine.dartExecutor.binaryMessenger)

        // Runtime permission requests (Camera2/AudioRecord never prompt by themselves).
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "camic/permission")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "request" -> requestMediaPermissions(result)
                    else -> result.notImplemented()
                }
            }
    }

    private fun requestMediaPermissions(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < 23) { result.success(true); return }
        val needed = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) { result.success(true); return }
        if (pendingPermissionResult != null) { result.success(false); return }
        pendingPermissionResult = result
        requestPermissions(needed.toTypedArray(), REQ_MEDIA)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MEDIA) {
            val granted = grantResults.isNotEmpty() &&
                grantResults.all { it == PackageManager.PERMISSION_GRANTED }
            pendingPermissionResult?.success(granted)
            pendingPermissionResult = null
        }
    }

    companion object {
        private const val REQ_MEDIA = 4747
    }
}
