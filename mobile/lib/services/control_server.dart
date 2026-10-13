import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Camic control server (phone side). Listens on TCP 4747, accepts one
/// desktop connection, performs the PIN handshake, and dispatches commands.
///
/// Protocol: newline-delimited JSON. First message must be `hello` with a valid
/// PIN within 3s. Emits high-level callbacks to the app/stream layer.
class ControlServer {
  final String pin;
  final String deviceId;
  final String deviceName;

  /// Invoked when a desktop asks to start streaming.
  void Function(StreamConfig cfg)? onStart;
  void Function()? onStop;
  void Function()? onKeyframe;
  void Function()? onSwitchCamera;
  void Function(bool on)? onTorch;

  /// Invoked when the authenticated desktop link goes away (clean close,
  /// error, or timeout). The app uses this to immediately drop the
  /// "connected"/"streaming" state instead of showing a stale connection.
  void Function()? onDisconnect;

  ServerSocket? _server;
  Socket? _client;
  InternetAddress? peerAddress;
  Timer? _authTimer;
  Timer? _keepAlive;
  bool _linkUp = false; // an authenticated desktop is currently connected
  int _attempts = 0;
  DateTime _attemptWindow = DateTime.now();

  ControlServer({required this.pin, required this.deviceId, required this.deviceName});

  Future<void> start({int port = 4747}) async {
    _server = await ServerSocket.bind(InternetAddress.anyIPv4, port, shared: false);
    _server!.listen(_onConnection, onError: (_) {});
  }

  void _onConnection(Socket socket) {
    // single desktop at a time
    if (identical(_client, socket)) return;
    final hadLink = _linkUp;
    _client?.destroy();
    _client = socket;
    peerAddress = socket.remoteAddress;
    final peer = '${socket.remoteAddress.address}:${socket.remotePort}';
    var authed = false;
    final sb = StringBuffer();

    _authTimer?.cancel();
    _authTimer = Timer(const Duration(seconds: 3), () { if (!authed) socket.destroy(); });

    socket.listen((data) {
      sb.write(utf8.decode(data, allowMalformed: true));
      var text = sb.toString();
      var idx = text.indexOf('\n');
      while (idx != -1) {
        final line = text.substring(0, idx).trim();
        text = text.substring(idx + 1);
        if (line.isNotEmpty) {
          final wasAuthed = authed;
          authed = _handleLine(line, socket, authed, peer) || authed;
          if (authed && !wasAuthed) _markLinkUp(socket);
        }
        idx = text.indexOf('\n');
      }
      sb.clear();
      sb.write(text);
    }, onError: (_) { _teardown(socket, hadLink); }, onDone: () {
      _teardown(socket, hadLink);
    });
  }

  /// Link is authenticated: start a keepalive so a silently-vanished desktop
  /// (crash / wifi drop / no clean TCP close) is detected within ~5s.
  void _markLinkUp(Socket socket) {
    _linkUp = true;
    _keepAlive?.cancel();
    _keepAlive = Timer.periodic(const Duration(seconds: 2), (_) {
      if (!identical(_client, socket)) return;
      _send(socket, {'cmd': 'ping', 't': DateTime.now().millisecondsSinceEpoch});
    });
  }

  void _teardown(Socket socket, bool wasLinkUp) {
    _authTimer?.cancel();
    if (identical(_client, socket)) {
      _client = null;
      peerAddress = null;
      _keepAlive?.cancel();
      _keepAlive = null;
      if (_linkUp || wasLinkUp) {
        _linkUp = false;
        onDisconnect?.call();
      }
    }
  }

  bool _handleLine(String line, Socket socket, bool authed, String peer) {
    Map<String, dynamic> msg;
    try { msg = jsonDecode(line) as Map<String, dynamic>; } catch (_) { return authed; }
    final cmd = msg['cmd'];

    if (cmd == 'hello') {
      if (!_checkRateLimit()) { _send(socket, {'cmd': 'error', 'code': 'rate_limited'}); socket.destroy(); return authed; }
      if ((msg['pin'] ?? '').toString() != pin) {
        _attempts++;
        _send(socket, {'cmd': 'error', 'code': 'bad_pin', 'message': 'Incorrect PIN'});
        socket.destroy();
        return authed;
      }
      _attempts = 0;
      _authTimer?.cancel();
      _send(socket, {
        'cmd': 'helloAck', 'v': 1, 'id': deviceId, 'name': deviceName,
        'battery': 85, 'temp': 31.0,
        'cameras': [
          {'id': 0, 'name': 'Back', 'facing': 'back', 'res': [[1920, 1080], [1280, 720], [640, 480]]},
          {'id': 1, 'name': 'Front', 'facing': 'front', 'res': [[1280, 720], [640, 480]]},
        ],
      });
      return true;
    }

    if (!authed) return authed; // ignore non-hello before auth

    switch (cmd) {
      case 'start':
        final v = Map<String, dynamic>.from(msg['video'] as Map? ?? {});
        final a = Map<String, dynamic>.from(msg['audio'] as Map? ?? {});
        onStart?.call(StreamConfig.fromMaps(v, a));
        break;
      case 'stop': onStop?.call(); break;
      case 'keyframe': onKeyframe?.call(); break;
      case 'switchCamera': onSwitchCamera?.call(); break;
      case 'setTorch': onTorch?.call(msg['on'] == true); break;
      case 'ping': _send(socket, {'cmd': 'pong', 't': msg['t'], 'lt': DateTime.now().millisecondsSinceEpoch}); break;
      case 'pong': break; // reply to our own keepalive — nothing to do
      default: break;
    }
    return authed;
  }

  bool _checkRateLimit() {
    final now = DateTime.now();
    if (now.difference(_attemptWindow) > const Duration(minutes: 1)) { _attemptWindow = now; _attempts = 0; }
    return _attempts < 5;
  }

  void sendStatus(Map<String, dynamic> status) { if (_client != null) _send(_client!, status); }

  void _send(Socket s, Map<String, dynamic> obj) {
    try { s.write(jsonEncode(obj) + '\n'); } catch (_) {}
  }

  Future<void> stop() async {
    _authTimer?.cancel();
    _keepAlive?.cancel();
    _keepAlive = null;
    final wasUp = _linkUp;
    _linkUp = false;
    _client?.destroy();
    _client = null;
    peerAddress = null;
    await _server?.close();
    _server = null;
    if (wasUp) onDisconnect?.call();
  }
}

class StreamConfig {
  final int w, h, fps, bitrate;
  final bool audioEnabled;
  final int sampleRate, channels, audioBitrate;
  StreamConfig({required this.w, required this.h, required this.fps, required this.bitrate,
    required this.audioEnabled, required this.sampleRate, required this.channels, required this.audioBitrate});

  factory StreamConfig.fromMaps(Map v, Map a) => StreamConfig(
    w: (v['w'] as num?)?.toInt() ?? 1280,
    h: (v['h'] as num?)?.toInt() ?? 720,
    fps: (v['fps'] as num?)?.toInt() ?? 30,
    bitrate: (v['bitrate'] as num?)?.toInt() ?? 4000000,
    audioEnabled: a['enabled'] as bool? ?? true,
    sampleRate: (a['sampleRate'] as num?)?.toInt() ?? 48000,
    channels: (a['channels'] as num?)?.toInt() ?? 1,
    audioBitrate: (a['bitrate'] as num?)?.toInt() ?? 64000,
  );
}
