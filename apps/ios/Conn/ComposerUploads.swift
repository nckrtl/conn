import Foundation
import ImageIO
import Observation
import UniformTypeIdentifiers

/// Draft files start uploading as soon as they are attached; the core runs the queue and decides
/// how images are scaled (`conn_client::uploads`). This keeps each file's status for its chip.
/// An upload lives as long as its `ComposerFile`: the draft, a reply on its way or a queued edit
/// holding the file keeps it, and the last one letting go drops it.
@MainActor @Observable
final class ComposerUploads {
    private(set) var statuses: [String: FfiUploadStatus] = [:]
    @ObservationIgnored private var core: ConnCore?
    @ObservationIgnored private var live: [String: WeakFile] = [:]
    @ObservationIgnored private lazy var bridge = UploadBridge(owner: self)
    @ObservationIgnored private let codec = ImageIOCodec()

    private struct WeakFile { weak var file: ComposerFile? }

    @ObservationIgnored private var connection: UInt64?

    /// Points uploads at the store's current core. A new connection starts every live file again.
    /// Each `session.core()` call wraps the same core in a new object, so the id decides.
    func use(_ core: ConnCore?, connection: UInt64?) {
        guard connection != self.connection else { return }
        self.connection = connection
        self.core = core
        statuses = [:]
        guard let core else { return }
        core.setUploadHandlers(listener: bridge, codec: codec)
        for entry in live.values { if let file = entry.file { core.attachUpload(file: file.ffi) } }
    }

    func attach(_ file: ComposerFile) {
        let id = file.uploadId
        if live[id]?.file == nil {
            live[id] = WeakFile(file: file)
            file.onRelease { [weak self] in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.release(id) } }
            }
        }
        core?.attachUpload(file: file.ffi)
    }

    func retry(_ file: ComposerFile) {
        core?.retryUpload(id: file.uploadId)
    }

    private func release(_ id: String) {
        live[id] = nil
        statuses[id] = nil
        core?.dropUpload(id: id)
    }

    fileprivate func update(_ id: String, _ status: FfiUploadStatus?) {
        guard live[id] != nil, statuses[id] != status else { return }
        statuses[id] = status
    }
}

/// Hops core callbacks to the main queue in the order they came.
private final class UploadBridge: FfiUploadListener, @unchecked Sendable {
    private weak var owner: ComposerUploads?

    init(owner: ComposerUploads) { self.owner = owner }

    func onUpload(id: String, status: FfiUploadStatus?) {
        DispatchQueue.main.async { [weak owner] in
            MainActor.assumeIsolated { owner?.update(id, status) }
        }
    }
}

/// ImageIO decodes (HEIC included) and scales in one subsampled pass, applying the orientation;
/// the core picks the size and keeps the smaller encoding. Metadata such as location is dropped.
final class ImageIOCodec: FfiImageCodec, @unchecked Sendable {
    func inspect(bytes: Data) -> FfiImageInfo? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
        let turned = (5...8).contains(orientation)
        return FfiImageInfo(
            width: UInt32(turned ? height : width),
            height: UInt32(turned ? width : height),
            alpha: properties[kCGImagePropertyHasAlpha] as? Bool ?? false
        )
    }

    func encode(bytes: Data, width: UInt32, height: UInt32, jpegQuality: Float?, png: Bool) -> FfiEncodedImage? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        func write(_ type: UTType, _ properties: [CFString: Any]) -> Data? {
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, properties as CFDictionary)
            return CGImageDestinationFinalize(destination) ? data as Data : nil
        }
        return FfiEncodedImage(
            jpeg: jpegQuality.flatMap { write(.jpeg, [kCGImageDestinationLossyCompressionQuality: $0]) },
            png: png ? write(.png, [:]) : nil
        )
    }
}

/// Runs once, from whichever thread lets go of the file last.
final class ReleaseHook: @unchecked Sendable {
    private let lock = NSLock()
    private var action: (@Sendable () -> Void)?

    func set(_ action: @escaping @Sendable () -> Void) { lock.withLock { self.action = action } }

    func fire() {
        let action = lock.withLock { () -> (@Sendable () -> Void)? in
            defer { self.action = nil }
            return self.action
        }
        action?()
    }
}
