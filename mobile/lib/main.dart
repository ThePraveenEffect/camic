import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'package:flutter/material.dart';
import 'services/control_server.dart';
import 'services/stream_service.dart';
import 'services/native_stream.dart';

void main() => runApp(const CamicApp());

class CamicApp extends StatelessWidget {
  const CamicApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Camic',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF4F8CFF), brightness: Brightness.dark),
        scaffoldBackgroundColor: const Color(0xFF0F1115),
        useMaterial3: true,
      ),
      home: const ServerScreen(),
    );
  }
}

class ServerScreen extends StatefulWidget {
  const ServerScreen({super.key});
  @override
  State<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends State<ServerScreen> with WidgetsBindingObserver {
  late final StreamService _stream;
  late final NativeStream _nsd;
  ControlServer? _control;
  String _pin = '';
  String _deviceId = '';
  String _status = 'Starting…';
  String _detail = '';
  bool _ready = false;
  bool _streaming = false;
  bool _permsDenied = false;
  final _log = <String>[];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _stream = StreamService()..onLog = _addLog;
    _nsd = _stream.native;
    _boot();
  }

  Future<void> _boot() async {
    final perms = await _requestPermissions();
    if (!perms) {
      _permsDenied = true;
      setState(() { _status = 'Permissions required'; _detail = 'Camera and Microphone access are needed to stream.'; });
      return;
    }
    _permsDenied = false;
    _pin = _genPin();
    _deviceId = _genId();
    _control = ControlServer(
      pin: _pin, deviceId: _deviceId,
      deviceName: await _deviceName(),
    );
    _control!.onStart = _onStart;
    _control!.onStop = _onStop;
    _control!.onSwitchCamera = () => _stream.switchCamera();
    _control!.onTorch = (_) {}; // torch wired in VideoEncoder if desired
    _control!.onDisconnect = _onDisconnect;
    try {
      await _control!.start(port: 4747);
      await _nsd.advertise(name: await _deviceName(), port: 4747, id: _deviceId);
      setState(() { _ready = true; _status = 'Ready to connect'; _detail = 'Waiting for a Camic desktop on this Wi-Fi…'; });
    } catch (e) {
      setState(() { _status = 'Failed to start'; _detail = e.toString(); });
    }
  }

  Future<bool> _requestPermissions() async {
    // Android 6.0+ requires runtime grants: Camera2/AudioRecord throw
    // SecurityException without them and never show a prompt themselves.
    if (!Platform.isAndroid) return true; // iOS: AVFoundation request added on Mac build
    return await _stream.native.requestPermissions();
  }

  Future<String> _deviceName() async {
    try {
      final info = await Process.run('getprop', ['ro.product.model']);
      final m = (info.stdout as String).trim();
      if (m.isNotEmpty) return m;
    } catch (_) {}
    return 'Camic Phone';
  }

  void _onStart(StreamConfig cfg) async {
    // resolve desktop IP from the connected socket (control server knows peer)
    final dest = _control?.peerAddress;
    if (dest == null) { _addLog('no peer to stream to'); return; }
    try {
      if (Platform.isAndroid) {
        final ok = await _stream.native.requestPermissions();
        if (!ok) {
          _addLog('camera/mic permission denied — grant them in Android Settings');
          _control?.sendStatus({'cmd': 'error', 'code': 'permission_denied', 'message': 'camera/microphone permission denied'});
          return;
        }
      }
      await _stream.start(cfg, dest);
      setState(() => _streaming = true);
      _control?.sendStatus({'cmd': 'started', 'video': {'w': cfg.w, 'h': cfg.h, 'fps': cfg.fps, 'codec': 'h264'},
        'audio': {'enabled': cfg.audioEnabled, 'sampleRate': cfg.sampleRate, 'channels': cfg.channels, 'codec': 'aac'}});
    } catch (e) {
      _addLog('start failed: $e');
      _control?.sendStatus({'cmd': 'error', 'code': 'start_failed', 'message': e.toString()});
    }
  }

  void _onStop() async {
    await _stream.stop();
    setState(() => _streaming = false);
    _control?.sendStatus({'cmd': 'stopped'});
  }

  /// The desktop link dropped (clean close, error, or keepalive timeout).
  /// Stop streaming and return to the ready state immediately — don't leave
  /// the UI showing a stale "connected".
  void _onDisconnect() {
    _stream.stop();
    if (!mounted) return;
    setState(() {
      _streaming = false;
      _status = 'Ready to connect';
      _detail = 'Desktop disconnected. Waiting for a Camic desktop on this Wi-Fi…';
    });
    _addLog('desktop disconnected');
  }

  void _addLog(String msg) {
    _log.add(msg);
    if (_log.length > 100) _log.removeAt(0);
    if (mounted) setState(() {});
  }

  String _genPin() => (Random().nextInt(900000) + 100000).toString();
  String _genId() {
    final r = Random.secure();
    return List.generate(16, (_) => '0123456789abcdef'[r.nextInt(16)]).join();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _control?.stop();
    _stream.stop();
    _nsd.unadvertise();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                Container(width: 44, height: 44, decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  gradient: const LinearGradient(colors: [Color(0xFF4F8CFF), Color(0xFF7C5CFF)]))),
                const SizedBox(width: 12),
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: const [
                  Text('Camic', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                  Text('wireless camera + mic', style: TextStyle(fontSize: 13, color: Colors.white54)),
                ]),
              ]),
              const SizedBox(height: 28),
              // PIN card
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(color: const Color(0xFF171A21), borderRadius: BorderRadius.circular(16), border: Border.all(color: const Color(0xFF2A2F3A))),
                child: Column(children: [
                  const Text('PAIRING PIN', style: TextStyle(fontSize: 12, letterSpacing: 2, color: Colors.white54)),
                  const SizedBox(height: 8),
                  Text(_pin, style: const TextStyle(fontSize: 44, fontWeight: FontWeight.bold, letterSpacing: 8, fontFeatures: [FontFeature.tabularFigures()])),
                  const SizedBox(height: 6),
                  Text('Enter this on your desktop', style: TextStyle(color: Colors.white.withValues(alpha: .5), fontSize: 13)),
                ]),
              ),
              const SizedBox(height: 20),
              // status
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: const Color(0xFF171A21), borderRadius: BorderRadius.circular(16), border: Border.all(color: const Color(0xFF2A2F3A))),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Container(width: 10, height: 10, decoration: BoxDecoration(shape: BoxShape.circle, color: _streaming ? Colors.red : (_ready ? Colors.green : Colors.orange))),
                    const SizedBox(width: 10),
                    Text(_status, style: const TextStyle(fontWeight: FontWeight.w600)),
                  ]),
                  const SizedBox(height: 6),
                  Text(_detail, style: const TextStyle(color: Colors.white54, fontSize: 13)),
                  if (_permsDenied) ...[
                    const SizedBox(height: 12),
                    FilledButton.icon(
                      onPressed: () async {
                        final ok = await _requestPermissions();
                        if (ok && mounted) {
                          _boot();
                        } else if (mounted) {
                          setState(() {});
                        }
                      },
                      icon: const Icon(Icons.shield_outlined, size: 18),
                      label: const Text('Grant camera & mic access'),
                    ),
                  ],
                ]),
              ),
              const SizedBox(height: 20),
              // controls
              Row(children: [
                Expanded(child: _btn('Flip camera', Icons.flip_camera_ios, () => _stream.switchCamera())),
                const SizedBox(width: 12),
                Expanded(child: _btn(_streaming ? 'Stop' : 'Idle', _streaming ? Icons.stop : Icons.videocam_off, () {
                  if (_streaming) _onStop();
                }, danger: _streaming)),
              ]),
              const SizedBox(height: 20),
              const Text('LOG', style: TextStyle(fontSize: 12, letterSpacing: 2, color: Colors.white38)),
              const SizedBox(height: 8),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: const Color(0xFF12151B), borderRadius: BorderRadius.circular(12)),
                  child: ListView.builder(
                    itemCount: _log.length, itemBuilder: (_, i) => Text(_log[_log.length - 1 - i], style: const TextStyle(fontSize: 12, color: Colors.white54, fontFamily: 'monospace')),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _btn(String label, IconData icon, VoidCallback onTap, {bool danger = false}) {
    return Material(
      color: danger ? Colors.red.shade700 : const Color(0xFF1E222B),
      borderRadius: BorderRadius.circular(12),
      child: InkWell(borderRadius: BorderRadius.circular(12), onTap: onTap,
        child: Padding(padding: const EdgeInsets.symmetric(vertical: 14), child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(icon, size: 18), const SizedBox(width: 8), Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
        ]))),
    );
  }
}
