import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

/// Protocol v1 UDP packetizer (phone → desktop). Mirrors protocol/PROTOCOL.md.
///
/// Header (12 B, big-endian): version, type, flags, reserved, seq, timestamp.
/// Video AUs are fragmented into ≤MTU packets; last fragment flagged END_OF_FRAME.
/// Keyframes carry KEYFRAME; standalone CONFIG packets carry SPS/PPS.
class UdpSender {
  static const int _protoVer = 1;
  static const int _mtu = 1400;
  static const int _hdrSize = 12;
  static const int typeVideo = 0;
  static const int typeAudio = 1;
  static const int flagKeyframe = 1 << 0;
  static const int flagEof = 1 << 1;
  static const int flagConfig = 1 << 2;

  late RawDatagramSocket _socket;
  InternetAddress? _dest;
  final int _destPort;
  final Map<int, int> _seq = {typeVideo: 0, typeAudio: 0};
  final Stopwatch _clock = Stopwatch()..start();
  bool _ready = false;

  UdpSender({int destPort = 4748}) : _destPort = destPort;

  Future<void> open() async {
    _socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
    _ready = true;
  }

  void setDestination(InternetAddress addr) => _dest = addr;

  Uint8List _header(int type, int flags, int seq, int ts) {
    final h = Uint8List(_hdrSize);
    final bd = ByteData.view(h.buffer);
    bd.setUint8(0, _protoVer);
    bd.setUint8(1, type);
    bd.setUint8(2, flags);
    bd.setUint8(3, 0);
    bd.setUint32(4, seq);
    bd.setUint32(8, ts);
    return h;
  }

  int _tsMs() => _clock.elapsedMilliseconds;

  void _send(int type, int flags, Uint8List payload) {
    if (!_ready || _dest == null) return;
    final seq = _seq[type]!;
    _seq[type] = seq + 1;
    final pkt = Uint8List(_hdrSize + payload.length);
    pkt.setAll(0, _header(type, flags, seq, _tsMs()));
    pkt.setAll(_hdrSize, payload);
    try { _socket.send(pkt, _dest!, _destPort); } catch (_) {}
  }

  /// Fragment an access unit into MTU packets; last flagged EOF.
  void sendVideoAu(Uint8List au, bool isKey) {
    final firstFlags = isKey ? flagKeyframe : 0;
    if (au.length <= _mtu) { _send(typeVideo, firstFlags | flagEof, au); return; }
    var off = 0;
    while (off < au.length) {
      final end = (off + _mtu < au.length) ? off + _mtu : au.length;
      var flags = (off == 0 ? firstFlags : 0) | (end == au.length ? flagEof : 0);
      _send(typeVideo, flags, Uint8List.sublistView(au, off, end));
      off = end;
    }
  }

  void sendConfig(Uint8List spsPps) => _send(typeVideo, flagKeyframe | flagConfig, spsPps);
  void sendAudio(Uint8List aacFrame) => _send(typeAudio, flagEof, aacFrame);

  void close() {
    _ready = false;
    try { _socket.close(); } catch (_) {}
  }
}
