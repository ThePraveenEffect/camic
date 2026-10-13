import AVFoundation
import Foundation
import VideoToolbox

/// Hardware H.264 encoder for iOS using VideoToolbox.
///
/// AVCaptureSession (camera) → AVCaptureVideoDataOutput → VTCompressionSession
/// → Annex-B access units. Keyframes are prefixed with SPS/PPS so a mid-stream
/// joiner can decode (protocol requirement).
final class VideoEncoder: NSObject {
    struct Frame {
        let data: Data
        let isKey: Bool
        let ptsUs: Int64
    }
    var onFrame: ((Frame) -> Void)?
    var onError: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var compression: VTCompressionSession?
    private let outputQueue = DispatchQueue(label: "camic.video.encoder")
    private var spsPps: Data?
    private var running = false
    private var width = 1280
    private var height = 720
    private var fps = 30
    private var bitrate = 4_000_000
    private var useBack = true

    func configure(width: Int, height: Int, fps: Int, bitrate: Int, useBack: Bool) {
        self.width = width; self.height = height; self.fps = fps
        self.bitrate = bitrate; self.useBack = useBack
    }

    func start() {
        guard !running else { return }
        requestPermission { [weak self] granted in
            guard let self else { return }
            guard granted else { self.onError?("camera permission denied"); return }
            DispatchQueue.main.async { self.setupAndRun() }
        }
    }

    private func requestPermission(_ done: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: done(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                AVCaptureDevice.requestAccess(for: .audio) { _ in done(granted) }
            }
        default: done(false)
        }
    }

    private func setupAndRun() {
        do {
            try configureSession()
            try startCompression()
            session.startRunning()
            running = true
        } catch {
            onError?("video setup: \(error.localizedDescription)")
        }
    }

    private func configureSession() throws {
        session.beginConfiguration()
        session.sessionPreset = .hd1280x720
        session.inputs.forEach { session.removeInput($0) }
        session.outputs.forEach { session.removeOutput($0) }

        let position: AVCaptureDevice.Position = useBack ? .back : .front
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
                ?? AVCaptureDevice.default(for: .video) else {
            throw NSError(domain: "camic", code: 1, userInfo: [NSLocalizedDescriptionKey: "no camera"])
        }
        let input = try AVCaptureDeviceInput(device: device)
        if session.canAddInput(input) { session.addInput(input) }

        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.setSampleBufferDelegate(self, queue: outputQueue)
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
    }

    private func startCompression() throws {
        var status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil, imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: compressionCallback, refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &compression)
        guard status == noErr, let compression else {
            throw NSError(domain: "camic", code: 2, userInfo: [NSLocalizedDescriptionKey: "VTCompressionSessionCreate \(status)"])
        }
        VTSessionSetProperty(compression, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(compression, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        VTSessionSetProperty(compression, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        VTSessionSetProperty(compression, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 2))
        VTSetSessionProperty(compression, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTCompressionSessionPrepareToEncodeFrames(compression)
    }

    func stop() {
        running = false
        session.stopRunning()
        if let compression { VTCompressionSessionCompleteFrames(compression, untilPresentationTimeStamp: .invalid) }
        compression = nil
        spsPps = nil
    }

    func switchCamera() {
        useBack = !useBack
        if running { stop(); start() }
    }

    fileprivate func handle(sampleBuffer: CMSampleBuffer) {
        guard running, let compression else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        var frameProperties: CFDictionary?
        let flags: VTEncodeInfoFlags = []
        VTCompressionSessionEncodeFrame(compression, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid, frameProperties: frameProperties, infoFlagsOut: nil) { [weak self] status, _, sampleBuffer in
            guard status == noErr, let sampleBuffer else { return }
            self?.emit(sampleBuffer: sampleBuffer)
        }
    }

    private func emit(sampleBuffer: CMSampleBuffer) {
        guard let data = annexBData(from: sampleBuffer) else { return }
        let isKey = isKeyframe(sampleBuffer)
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let ptsUs = Int64(CMTimeGetSeconds(pts) * 1_000_000)
        var out = data
        if isKey, let cfg = spsPps { out = cfg + data } // prefix SPS/PPS on keyframes
        onFrame?(Frame(data: out, isKey: isKey, ptsUs: ptsUs))
    }

    /// Extract SPS/PPS and convert the frame to Annex-B bytes.
    private func annexBData(from sampleBuffer: CMSampleBuffer) -> Data? {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer) else { return nil }
        // cache SPS/PPS
        var spsSize = 0, spsCount = 0
        var spsPtr: UnsafePointer<UInt8>?
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(description, parameterSetIndex: 0, parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize, parameterSetCountOut: &spsCount, nalUnitHeaderLengthOut: nil)
        var ppsSize = 0, ppsCount = 0
        var ppsPtr: UnsafePointer<UInt8>?
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(description, parameterSetIndex: 1, parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize, parameterSetCountOut: &ppsCount, nalUnitHeaderLengthOut: nil)
        if let spsPtr, spsSize > 0, let ppsPtr, ppsSize > 0 {
            var cfg = Data()
            cfg.append(contentsOf: [0, 0, 0, 1]); cfg.append(spsPtr, count: spsSize)
            cfg.append(contentsOf: [0, 0, 0, 1]); cfg.append(ppsPtr, count: ppsSize)
            spsPps = cfg
        }
        // frame data (already Annex-B with start codes from VT)
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLength, dataPointerOut: &dataPointer)
        guard let dataPointer, totalLength > 0 else { return nil }
        return Data(bytes: dataPointer, count: totalLength)
    }

    private func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [CFDictionary] else { return false }
        guard let first = attachments.first else { return false }
        let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
        return !notSync
    }
}

extension VideoEncoder: AVCaptureVideoDataOutputSampleBufferDelegate {}

private let compressionCallback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
    guard status == noErr, let refcon, let sampleBuffer else { return }
    let encoder = Unmanaged<VideoEncoder>.fromOpaque(refcon).takeUnretainedValue()
    // handled synchronously in encode completion; nothing to do here
}
