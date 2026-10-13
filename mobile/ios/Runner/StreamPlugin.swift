import Flutter
import UIKit

/// Bridges the iOS encoders to Dart over the same channels as Android:
///   MethodChannel "camic/stream"  (start/stop/switchCamera)
///   EventChannel  "camic/frames"  (video/audio/config frames)
/// so the shared Dart NativeStream service works on both platforms.
public class StreamPlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
    private let video = VideoEncoder()
    private let audio = AudioEncoder()
    private var events: FlutterEventSink?
    private let queue = DispatchQueue(label: "camic.frames")

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = StreamPlugin()
        let method = FlutterMethodChannel(name: "camic/stream", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: method)
        let events = FlutterEventChannel(name: "camic/frames", binaryMessenger: registrar.messenger())
        events.setStreamHandler(instance)
        instance.attach()
    }

    private func attach() {
        video.onFrame = { [weak self] frame in
            self?.enqueue(type: "video", data: frame.data, isKey: frame.isKey, ts: frame.ptsUs)
        }
        audio.onFrame = { [weak self] frame in
            self?.enqueue(type: "audio", data: frame.data, isKey: false, ts: frame.ptsUs)
        }
        audio.onConfig = { [weak self] data in
            self?.enqueue(type: "audioConfig", data: data, isKey: false, ts: 0)
        }
        let errFn: (String) -> Void = { [weak self] msg in
            DispatchQueue.main.async { self?.events?(FlutterError(code: "encode", message: msg, details: nil)) }
        }
        video.onError = errFn
        audio.onError = errFn
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        switch call.method {
        case "start":
            video.configure(
                width: args["w"] as? Int ?? 1280,
                height: args["h"] as? Int ?? 720,
                fps: args["fps"] as? Int ?? 30,
                bitrate: args["bitrate"] as? Int ?? 4_000_000,
                useBack: args["facingBack"] as? Bool ?? true)
            video.start()
            if args["audioEnabled"] as? Bool ?? true {
                audio.configure(
                    sampleRate: args["sampleRate"] as? Int ?? 48000,
                    channels: args["channels"] as? Int ?? 1,
                    bitrate: args["audioBitrate"] as? Int ?? 64000)
                audio.start()
            }
            result(true)
        case "stop":
            video.stop(); audio.stop(); result(true)
        case "switchCamera":
            video.switchCamera(); result(true)
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    private func enqueue(type: String, data: Data, isKey: Bool, ts: Int64) {
        guard let sink = events else { return }
        let map: [String: Any] = [
            "type": type,
            "data": FlutterStandardTypedData(bytes: data),
            "isKey": isKey,
            "ts": ts,
        ]
        DispatchQueue.main.async { sink(map) }
    }

    // MARK: - FlutterStreamHandler
    public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        self.events = events
        return nil
    }
    public func onCancel(withArguments arguments: Any?) -> FlutterError? {
        self.events = nil
        return nil
    }
}
