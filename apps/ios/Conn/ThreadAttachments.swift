import AVKit
import ImageIO
import QuickLook
import SwiftUI
import UniformTypeIdentifiers
import WebKit

@MainActor
final class AttachmentThumbnails {
    private let images = NSCache<NSString, UIImage>()

    init() { images.totalCostLimit = 32 * 1024 * 1024 }

    func clear() { images.removeAllObjects() }

    func image(_ key: String) -> UIImage? { images.object(forKey: key as NSString) }

    func insert(_ image: CGImage, key: String) {
        images.setObject(UIImage(cgImage: image), forKey: key as NSString, cost: image.bytesPerRow * image.height)
    }

    nonisolated static func decode(_ bytes: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              CGImageSourceGetStatus(source) == .statusComplete else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 1024,
        ] as CFDictionary)
    }
}

struct ThreadAttachments: View {
    static let radius: CGFloat = 17
    static let tailRadius: CGFloat = 17
    let files: [FfiAttachment]
    let store: CoreStore
    let thread: String
    var body: some View {
        let images = files.filter { $0.isImage }
        let others = files.filter { !$0.isImage }
        VStack(alignment: .leading, spacing: 3) {
            if let only = images.first, images.count == 1 {
                // One image takes the whole width at its own aspect ratio (lab `[data-count="1"]`).
                AttachmentTile(file: only, store: store, thread: thread, single: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id([only.id, thread, store.attachmentEnvironment, String(store.identityEpoch)])
            } else if !images.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: min(2, images.count)), spacing: 3) {
                    ForEach(images, id: \.id) { file in
                        // Each tile needs its own identity: a shared `.id` made the grid draw only one.
                        AttachmentTile(file: file, store: store, thread: thread)
                            .id([file.id, thread, store.attachmentEnvironment, String(store.identityEpoch)])
                    }
                }
            }
            ForEach(others, id: \.id) { file in
                let top: CGFloat = images.isEmpty && file.id == others.first?.id ? Self.radius : 4
                let bottom: CGFloat = file.id == others.last?.id ? Self.radius : 4
                AttachmentTile(file: file, store: store, thread: thread)
                    .clipShape(UnevenRoundedRectangle(
                        topLeadingRadius: top, bottomLeadingRadius: bottom,
                        bottomTrailingRadius: file.id == others.last?.id ? Self.tailRadius : bottom,
                        topTrailingRadius: top, style: .continuous
                    ))
            }
        }
        // Concentric with the user bubble (20 on every corner) 3 inside it.
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: Self.radius, bottomLeadingRadius: Self.radius,
            bottomTrailingRadius: Self.tailRadius, topTrailingRadius: Self.radius, style: .continuous
        ))
    }
}

private struct AttachmentTile: View {
    let file: FfiAttachment
    let store: CoreStore
    let thread: String
    /// The message's only image: full width at its own aspect ratio, at most `singleImageMaxHeight` tall.
    var single = false
    @Environment(\.connTheme) private var theme
    @State private var loaded: UIImage?
    @State private var preview: URL?
    @State private var directory: URL?
    @State private var busy = false
    private enum Failure {
        case preview, download
    }
    @State private var failure: Failure?
    @State private var attempt = 0
    @State private var player: AVPlayer?
    private var video: Bool { file.mimeType.hasPrefix("video/") }
    private var thumbnailKey: String {
        [store.attachmentEnvironment, thread, file.id, file.name, file.mimeType, String(file.sizeBytes)]
            .map { "\($0.utf8.count):\($0)" }.joined()
    }

    private var thumbnail: UIImage? {
        if file.id.hasPrefix("pending:") { return loaded }
        return loaded ?? store.imageThumbnails.image(thumbnailKey)
    }

    private static let singleImageMaxHeight: CGFloat = 320

    /// 4:3 in a grid. A single image keeps its own ratio; the tile caps its height.
    private var imageRatio: CGFloat {
        guard single, let image = thumbnail, image.size.height > 0 else { return 4 / 3 }
        return image.size.width / image.size.height
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let player {
                VideoPlayer(player: player).aspectRatio(16 / 9, contentMode: .fit)
                    .onDisappear { player.pause() }
            } else if file.isImage {
                Button { Task { await openFile() } } label: {
                    // The ratio sets the height from the width, the frame stops a tall image at
                    // the cap, and the image fills (and is cropped to) that tile.
                    Color.clear
                        .aspectRatio(imageRatio, contentMode: .fit)
                        .frame(maxWidth: .infinity, maxHeight: single ? Self.singleImageMaxHeight : nil)
                        .overlay {
                        if let image = thumbnail {
                            Image(uiImage: image).resizable().scaledToFill().allowsHitTesting(false)
                        } else { fileLabel }
                    }
                    .clipped()
                    // `clipped` only clips drawing: the filled image's overflow still took taps
                    // meant for the message text. Only the tile itself opens the image.
                    .contentShape(Rectangle())
                }
            } else {
                Button {
                    if video { attempt += 1 } else { Task { await openFile() } }
                } label: { fileLabel }
            }
            if let failure {
                Button {
                    self.failure = nil
                    switch failure {
                    case .preview: attempt += 1
                    case .download: Task { await openFile() }
                    }
                } label: {
                    Label(failure == .download ? "Attachment unavailable. Retry" : "Preview unavailable. Retry",
                          systemImage: "arrow.clockwise").font(.caption)
                }
            }
        }
        .background(theme.card)
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(file.name)
        .task(id: "\(file.id)|\(attempt)|\(store.status == .connected)|\(String(describing: store.offlineReader.map(ObjectIdentifier.init)))") {
            do {
                if file.isImage, let local = store.pendingUploads[file.id] {
                    // A reply still uploading: its picked copy stands in.
                    let bytes = try Data(contentsOf: local.url)
                    if let thumbnail = await Task.detached(operation: { AttachmentThumbnails.decode(bytes) }).value {
                        loaded = UIImage(cgImage: thumbnail)
                    }
                    return
                }
                if file.isImage {
                    guard let reader = store.offlineReader, thumbnail == nil else { return }
                    for pass in 0..<2 {
                        let bytes = try await reader.imageBytes(thread: thread, file: file, online: store.status == .connected)
                        try Task.checkCancellation()
                        let thumbnail = await Task.detached { AttachmentThumbnails.decode(bytes) }.value
                        try Task.checkCancellation()
                        guard store.offlineReader === reader else { return }
                        if let thumbnail {
                            store.imageThumbnails.insert(thumbnail, key: thumbnailKey)
                            loaded = UIImage(cgImage: thumbnail)
                            failure = nil
                            return
                        }
                        try await reader.discardImage(thread: thread, file: file)
                        if pass == 1 || store.status != .connected { throw URLError(.cannotDecodeContentData) }
                    }
                    return
                }
                guard video, store.status == .connected else { return }
                let url = try await store.assetURL(id: file.id, name: file.name, mime: file.mimeType)
                try Task.checkCancellation()
                player = AVPlayer(url: url)
            } catch {
                if !Task.isCancelled { failure = .preview }
            }
        }
        .quickLookPreview($preview)
        .onChange(of: preview) { old, new in
            if old != nil && new == nil { removeDownload() }
        }
        .onDisappear { if preview == nil { removeDownload() } }
    }

    private var fileIcon: Image {
        switch (file.name as NSString).pathExtension.lowercased() {
        case "doc", "docx", "odt": Image("thread-file-word")
        case "xls", "xlsx", "ods": Image("thread-file-spreadsheet")
        case "pdf": Image("thread-file-pdf")
        case "md", "markdown": Image("thread-file-markdown")
        case "zip": Image("thread-file-zip")
        default: connImage(video ? "play.rectangle" : file.isImage ? "photo" : "doc.text")
        }
    }

    private var fileLabel: some View {
        HStack(spacing: 8) {
            fileIcon.resizable().scaledToFit().frame(width: 14, height: 14)
                .foregroundStyle(theme.mutedForeground)
            Text(file.name).fontWeight(.medium).lineLimit(2).truncationMode(.middle)
            Spacer(minLength: 4)
            if busy { ProgressView().controlSize(.small) }
            else { Text(ByteCountFormatter.string(fromByteCount: file.sizeBytes, countStyle: .file)).foregroundStyle(theme.mutedForeground) }
        }
        .font(.system(size: 13))
        .padding(10).contentShape(Rectangle())
    }

    private func openFile() async {
        guard !busy else { return }
        if let local = store.pendingUploads[file.id] {
            preview = local.url
            return
        }
        busy = true
        defer { busy = false }
        do {
            let epoch = store.identityEpoch
            removeDownload()
            let folder = URL.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            directory = folder
            let name = (file.name as NSString).lastPathComponent
            let local = folder.appending(path: ["", ".", "..", "/"].contains(name) ? "Attachment" : name)
            if file.isImage {
                guard let reader = store.offlineReader else { throw URLError(.notConnectedToInternet) }
                let bytes = try await reader.imageBytes(thread: thread, file: file, online: store.status == .connected)
                guard store.identityEpoch == epoch, store.offlineReader === reader else { throw URLError(.cancelled) }
                try bytes.write(to: local, options: .atomic)
            } else {
                let url = try await store.assetURL(id: file.id, name: file.name, mime: file.mimeType)
                let (temp, response) = try await URLSession.shared.download(from: url)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
                guard store.identityEpoch == epoch else { throw URLError(.cancelled) }
                try FileManager.default.moveItem(at: temp, to: local)
            }
            preview = local
            failure = nil
        } catch {
            failure = .download
            removeDownload()
        }
    }

    private func removeDownload() {
        if let directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
    }
}

struct ThreadEmbed: View {
    let store: CoreStore
    let thread: String
    let item: String
    @State private var session: ThreadMcpApp?
    let attachment: String
    let title: String
    let height: CGFloat
    let mcp: Bool
    @State private var url: URL?
    @State private var failed = false
    @State private var attempt = 0
    @State private var expanded = false

    var body: some View {
        ThreadCard {
            Label {
                Text(mcp ? "MCP app" : "HTML preview")
            } icon: {
                (mcp ? Image("thread-mcp") : connImage("laptopcomputer"))
                    .resizable().scaledToFit().frame(width: 14, height: 14)
            }
            Spacer()
            Button { expanded = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right").padding(6) }
                .disabled(url == nil || failed).accessibilityLabel("Expand " + title)
        } content: {
            if failed {
                Button("Preview unavailable. Retry") { attempt += 1 }.padding()
            } else if let url {
                Group {
                    if expanded { Color.clear }
                    else { SandboxedPage(url: url, title: title, session: session, fullscreen: false) { failed = true } }
                }.frame(height: min(480, max(80, height)))
            } else { ProgressView().padding() }
        }
        .task(id: "\(attachment)|\(attempt)|\(store.status == .connected)") {
            failed = false
            url = nil
            session = nil
            do {
                let asset = try await store.assetURL(id: attachment, name: "preview.html", mime: "text/html", mcp: mcp)
                let app = mcp ? try await store.mcpApp(thread: thread, item: item, attachment: attachment) : nil
                if !Task.isCancelled { session = app; url = asset }
            } catch { if !Task.isCancelled { failed = true } }
        }
        .sheet(isPresented: $expanded) {
            NavigationStack {
                if let url { SandboxedPage(url: url, title: title, session: session, fullscreen: true) {
                    expanded = false
                    failed = true
                }.navigationTitle(title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { Button("Done") { expanded = false } } }
            }
        }
    }
}
