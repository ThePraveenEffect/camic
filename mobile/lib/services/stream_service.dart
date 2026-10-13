import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'native_stream.dart';
import 'udp_sender.dart';
import 'control_server.dart';

/// Orchestrates a streaming session: native encoders → protocol UDP sender.
/// Also emits a 1s status line to the connected desktop.
class StreamService {
  final NativeStream native = NativeStream();
  UdpSender? _sender;
  Timer? _statusTimer;
  bool _streaming = false;

  bool get isStreaming => _streaming;
  void Function(String log)? onLog;

  StreamService() {
    native.onFrame = _handleFrame;
    native.onError = (e) => onLog?.call('encode error: $e');
  }

  Future<void> start(StreamConfig cfg, InternetAddress dest) async {
    await stop();
    _sender = UdpSender();
    await _sender!.open();
    _sender!.setDestination(dest);
    await native.start(
      w: cfg.w, h: cfg.h, fps: cfg.fps, bitrate: cfg.bitrate,
      audioEnabled: cfg.audioEnabled, sampleRate: cfg.sampleRate,
      channels: cfg.channels, audioBitrate: cfg.audioBitrate, facingBack: true,
    );
    _streaming = true;
    onLog?.call('streaming ${cfg.w}x${cfg.h}@${cfg.fps} → ${dest.address}');
    _statusTimer = Timer.periodic(const Duration(seconds: 1), (_) {});
  }

  void _handleFrame(Map<String, dynamic> frame) {
    if (!_streaming || _sender == null) return;
    final type = frame['type'] as String?;
    final data = frame['data'] as Uint8List?;
    if (data == null) return;
    switch (type) {
      case 'video':
        _sender!.sendVideoAu(data, frame['isKey'] == true);
        break;
      case 'videoConfig':
        _sender!.sendConfig(data);
        break;
      case 'audio':
        _sender!.sendAudio(data);
        break;
      case 'audioConfig':
        // AAC ASC — desktop derives sample rate from `started.audio`; ADTS wrap uses it
        break;
    }
  }

  void sendStatus(ControlServer control, {int? battery}) {
    control.sendStatus({'cmd': 'status', 'battery': battery, 'fps': 0, 'lossPct': 0});
  }

  Future<void> switchCamera() => native.switchCamera();

  Future<void> stop() async {
    _statusTimer?.cancel();
    _statusTimer = null;
    if (_streaming) { await native.stop(); }
    _sender?.close();
    _sender = null;
    _streaming = false;
  }
}
