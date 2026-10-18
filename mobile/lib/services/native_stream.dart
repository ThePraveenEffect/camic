import 'dart:async';
import 'package:flutter/services.dart';

/// Bridge to the native Kotlin encoders (VideoEncoder + AudioEncoder).
///
/// Exposes:
///  - [start]/[stop]/[switchCamera] via MethodChannel `camic/stream`
///  - encoded frames via EventChannel `camic/frames`
///  - mDNS advertise via MethodChannel `camic/nsd`
///
/// Frame events are maps: {type, data: Uint8List, isKey, ts}. [onFrame] fires
/// for every video/audio/config frame; the caller (StreamService) packets them
/// onto UDP.
class NativeStream {
  static const _method = MethodChannel('camic/stream');
  static const _nsd = MethodChannel('camic/nsd');
  static const _perm = MethodChannel('camic/permission');
  static const _frames = EventChannel('camic/frames');

  Function(Map<String, dynamic>)? onFrame;
  Function(String)? onError;
  StreamSubscription? _sub;

  /// Ask Android for CAMERA + RECORD_AUDIO at runtime (required on 6.0+;
  /// Camera2/AudioRecord fail silently without them). Returns true if granted.
  Future<bool> requestPermissions() async {
    try {
      return await _perm.invokeMethod('request') == true;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  Future<void> start({
    required int w,
    required int h,
    required int fps,
    required int bitrate,
    bool audioEnabled = true,
    int sampleRate = 48000,
    int channels = 1,
    int audioBitrate = 64000,
    bool facingBack = true,
  }) async {
    // Subscribe to frames/errors BEFORE starting so encoder failures during
    // startup reach onError instead of being dropped (EventChannel has no queue).
    _listenFrames();
    await _method.invokeMethod('start', {
      'w': w, 'h': h, 'fps': fps, 'bitrate': bitrate,
      'audioEnabled': audioEnabled, 'sampleRate': sampleRate,
      'channels': channels, 'audioBitrate': audioBitrate, 'facingBack': facingBack,
    });
  }

  void _listenFrames() {
    _sub?.cancel();
    _sub = _frames.receiveBroadcastStream().listen((event) {
      final map = Map<String, dynamic>.from(event as Map);
      onFrame?.call(map);
    }, onError: (e) => onError?.call(e.toString()));
  }

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
    await _method.invokeMethod('stop');
  }

  Future<void> switchCamera() => _method.invokeMethod('switchCamera');

  /// One-shot AF re-scan onto whatever is in frame now, then re-freeze.
  Future<void> refocus() => _method.invokeMethod('refocus');

  /// Relay the desktop's measured packet loss (~1 Hz) to the encoder.
  Future<void> reportLoss(double lossPct) => _method.invokeMethod('netq', {'loss': lossPct});

  Future<void> advertise({required String name, required int port, required String id}) =>
      _nsd.invokeMethod('register', {'name': name, 'port': port, 'id': id});

  Future<void> unadvertise() => _nsd.invokeMethod('unregister');
}
