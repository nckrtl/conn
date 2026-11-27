import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum ComposerDraftKey: Hashable {
    case thread(String)
    case new(project: String?, prompt: String)
}

@MainActor @Observable
final class ComposerDraft {
    var text: String { didSet { if text != oldValue { renewKey() } } }
    var files: [ComposerFile] = [] {
        didSet {
            renewKey()
            for file in files where !oldValue.contains(where: { $0 === file }) { uploads?.attach(file) }
        }
    }
    /// Starts each file's upload as it joins the draft (the store's `ComposerUploads`).
    @ObservationIgnored var uploads: ComposerUploads?
    var projectOverride: (id: String?, title: String)? { didSet { renewKey() } }
    private(set) var key = UUID().uuidString
    private var discarded = false
    var sending = false
    var importing = false
    var error: String?
    /// A queued message open for editing; Send saves it instead of sending a new message.
    var queuedEdit: QueuedEdit?
    /// Bumped to put the caret in the field (opening a queued message for editing).
    var focusRequest = 0
    var locked: Bool { sending || importing }
    var hasContent: Bool { !files.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    init(text: String = "") { self.text = text }

    private func renewKey() { key = UUID().uuidString }

    /// A reply that failed comes back after anything typed since (`composer_restore_draft`), so
    /// the caret stays in the newer text; its files follow any added since. With nothing new it
    /// keeps its idempotency key, so sending again can't double it.
    func restore(text sent: String, files sentFiles: [ComposerFile], key sentKey: String) {
        let untouched = text.isEmpty && files.isEmpty
        text = composerRestoreDraft(current: text, sent: sent)
        files += sentFiles.filter { file in !files.contains { $0 === file } }
        if untouched { key = sentKey }
    }

    func discard() {
        discarded = true
        queuedEdit = nil
        text = ""
        files = []
        projectOverride = nil
        error = nil
    }

    /// Photos are scaled before they upload, so their size and total are checked by the core.
    func append(_ file: ComposerFile) throws {
        guard !discarded else { throw CancellationError() }
        guard files.count < 100 else { throw ComposerFileError("Attach up to 100 files per message.") }
        files.append(file)
    }
}

private struct ComposerFileError: LocalizedError {
    var errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

final class ComposerFile: Identifiable, Sendable {
    let id = UUID()
    let url: URL
    let name: String
    let mime: String
    let size: Int
    /// Shown as a picture; HEIC uploads as JPEG.
    let isImage: Bool
    private let release = ReleaseHook()

    var uploadId: String { id.uuidString }
    var ffi: FfiComposerFile { FfiComposerFile(id: uploadId, path: url.path, name: name, mimeType: mime) }

    /// Runs once nothing holds the file any more.
    func onRelease(_ action: @escaping @Sendable () -> Void) { release.set(action) }

    init(copying source: URL, name: String, type: UTType, limits: FfiComposerLimits) throws {
        let info = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard info.isRegularFile == true, let size = info.fileSize else {
            throw ComposerFileError("Choose a file to attach.")
        }
        self.size = size
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.utf16.count <= 255 else {
            throw ComposerFileError("Choose a filename between 1 and 255 characters.")
        }
        self.name = name
        mime = type.preferredMIMEType ?? "application/octet-stream"
        isImage = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"].contains(mime)
        // The core scales these first, then checks the 10 MiB image limit.
        let scaled = ["image/png", "image/jpeg", "image/heic", "image/heif"].contains(mime)
        let maxSize: UInt64? = isImage && limits.images ? (scaled ? 200 * 1024 * 1024 : 10 * 1024 * 1024) : limits.maxFileBytes
        guard let maxSize else { throw ComposerFileError("This server cannot upload \(name).") }
        guard UInt64(size) <= maxSize else {
            throw ComposerFileError("\(name) exceeds the \(ByteCountFormatter.string(fromByteCount: Int64(maxSize), countStyle: .binary)) limit.")
        }
        url = FileManager.default.temporaryDirectory.appending(path: "conn-composer-\(id)")
        try FileManager.default.copyItem(at: source, to: url)
    }

    deinit {
        release.fire()
        try? FileManager.default.removeItem(at: url)
    }

    static func document(_ url: URL, limits: FfiComposerLimits) async throws -> ComposerFile {
        try await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            var coordinationError: NSError?
            var result: Result<ComposerFile, Error>?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { source in
                result = Result {
                    let type = try source.resourceValues(forKeys: [.contentTypeKey]).contentType
                    return try ComposerFile(copying: source, name: url.lastPathComponent,
                                            type: type ?? .data, limits: limits)
                }
            }
            if let coordinationError { throw coordinationError }
            guard let result else { throw CocoaError(.fileReadUnknown) }
            return try result.get()
        }.value
    }
}

struct ComposerPhotosPicker: UIViewControllerRepresentable {
    let draft: ComposerDraft
    let limits: FfiComposerLimits
    let dismiss: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.filter = limits.maxFileBytes == nil ? .images : .any(of: [.images, .videos])
        config.selectionLimit = max(1, 100 - draft.files.count)
        // The original (HEIC): Photos skips its full-size JPEG copy and the core scales it once.
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    @MainActor final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: ComposerPhotosPicker
        init(_ parent: ComposerPhotosPicker) { self.parent = parent }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            parent.dismiss()
            guard !results.isEmpty else { return }
            let draft = parent.draft
            draft.importing = true
            draft.error = nil
            Task {
                defer { draft.importing = false }
                do {
                    for result in results {
                        try draft.append(await photo(from: result.itemProvider))
                    }
                } catch { draft.error = error.localizedDescription }
            }
        }

        private func photo(from provider: NSItemProvider) async throws -> ComposerFile {
            guard let type = provider.registeredTypeIdentifiers.compactMap({ UTType($0) })
                .first(where: { $0.conforms(to: .image) || $0.conforms(to: .movie) }) else {
                throw ComposerFileError("Photos could not provide this item.")
            }
            let suggested = provider.suggestedName
            let limits = parent.limits
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                    continuation.resume(with: Result {
                        if let error { throw error }
                        guard let url else { throw CocoaError(.fileReadUnknown) }
                        let deliveredType = UTType(filenameExtension: url.pathExtension) ?? type
                        var name = suggested ?? url.lastPathComponent
                        if (name as NSString).pathExtension.isEmpty, let ext = deliveredType.preferredFilenameExtension {
                            name += "." + ext
                        }
                        return try ComposerFile(copying: url, name: name, type: deliveredType, limits: limits)
                    })
                }
            }
        }
    }
}
