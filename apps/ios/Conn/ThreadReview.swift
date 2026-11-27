import SwiftUI

struct TurnCheckpointCard: View {
    let fileCount: Int
    let additions: Int64
    let deletions: Int64
    let files: [FfiTurnCheckpointFile]
    let ordinal: Int64?
    let threadId: String
    let store: CoreStore
    @State private var overrides: [String: Bool] = [:]
    @State private var expanded = false
    @State private var selected: ReviewPath?
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size
    @Environment(\.connTheme) private var theme

    private struct ReviewPath: Identifiable { let id: String }

    var body: some View {
        let rows = changedFileRows(files: files, overrides: overrides, expanded: expanded)
        let folders = rows.filter(\.directory)
        let allOpen = folders.allSatisfy(\.expanded)
        ThreadCard {
            Text("\(fileCount) changed \(fileCount == 1 ? "file" : "files")")
                .fontWeight(.medium).foregroundStyle(theme.foreground)
            DiffCounts(additions: additions, deletions: deletions)
            Spacer(minLength: 0)
            if !folders.isEmpty {
                Button { expanded = !allOpen; overrides = [:] } label: {
                    ThreadGlyph(name: allOpen ? "chevrons-down-up" : "chevrons-up-down", size: size * 14 / 13).padding(5)
                }.accessibilityLabel(allOpen ? "Collapse all folders" : "Expand all folders")
            }
            if ordinal != nil {
                Button { selected = ReviewPath(id: files.first?.path ?? "") } label: {
                    ThreadGlyph(name: "file-diff", size: size * 14 / 13).padding(5)
                }.accessibilityLabel("Open diff")
            }
        } content: {
            VStack(spacing: 0) {
                ForEach(rows, id: \.path) { row in
                    Button {
                        if row.directory { overrides[row.path] = !row.expanded }
                        else { selected = ReviewPath(id: row.path) }
                    } label: {
                        HStack(spacing: 6) {
                            if row.directory {
                                ThreadGlyph(name: row.expanded ? "chevron-down" : "chevron-right", size: size * 12 / 13)
                            }
                            ThreadGlyph(name: row.directory ? "folder" : "file-text", size: size * 14 / 13)
                            Text(row.name).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            DiffCounts(additions: row.additions, deletions: row.deletions, columns: true)
                        }
                        .font(.system(size: size))
                        .foregroundStyle(theme.mutedForeground)
                        .padding(.leading, 9 + CGFloat(row.depth) * 12)
                        .padding(.trailing, 9).frame(minHeight: 32).contentShape(Rectangle())
                    }
                    .disabled(!row.directory && ordinal == nil)
                }
            }
        }
        .buttonStyle(.plain)
        .sheet(item: $selected) { path in
            if let ordinal {
                CheckpointReview(files: files, selected: path.id) { try await store.patches(thread: threadId, turn: ordinal) }
            }
        }
    }
}

private struct DiffCounts: View {
    let additions: Int64
    let deletions: Int64
    /// File rows right-align both counts in fixed columns (lab: 5ch and 4ch).
    var columns = false
    /// The review header's subtitle sets it at 12 instead of the thread text.
    var fontSize: CGFloat?
    @ScaledMetric(relativeTo: .body) private var scaledSize: CGFloat = ThreadText.size
    @Environment(\.connTheme) private var theme
    private var size: CGFloat { fontSize ?? scaledSize }
    var body: some View {
        HStack(spacing: columns ? 0 : 6) {
            Text("+\(additions.formatted(.number.notation(.compactName)).lowercased())").foregroundStyle(theme.diffAdded)
                .frame(minWidth: columns ? size * 0.6 * 5 : nil, alignment: .trailing)
            Text("−\(deletions.formatted(.number.notation(.compactName)).lowercased())").foregroundStyle(theme.diffRemoved)
                .frame(minWidth: columns ? size * 0.6 * 4 : nil, alignment: .trailing)
        }
        .font(.system(size: size).monospacedDigit())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(additions) additions, \(deletions) deletions")
    }
}

private struct CheckpointReview: View {
    let files: [FfiTurnCheckpointFile]
    let selected: String
    let load: () async throws -> [FfiFilePatch]
    @State private var patches: [FfiFilePatch]?
    @State private var error: String?
    @State private var attempt = 0
    @State private var collapsed: Set<String> = []
    @State private var viewed: Set<String> = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance

    var body: some View {
        NavigationStack {
            Group {
                if let patches {
                    if patches.isEmpty { ContentUnavailableView("No line changes", systemImage: "doc.text") }
                    else {
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                                    ForEach(patches, id: \.path) { patch in
                                        Section {
                                            if !collapsed.contains(patch.path) { PatchBody(patch: patch, review: true) }
                                        } header: {
                                            patchHeader(patch).id(patch.path)
                                        }
                                    }
                                }.padding(.bottom, 8)
                            }.onAppear { proxy.scrollTo(selected, anchor: .top) }
                        }
                    }
                } else if let error {
                    VStack { Text(error); Button("Retry") { attempt += 1 } }
                } else { ProgressView("Loading diff…") }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.codeBackground)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(theme.codeBackground, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SheetGlassButton(glyph: "chevron-left", label: "Back to chat") { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
                // Lab `GlassHeader`: "Latest turn" over the totals at 12/16.
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text("Latest turn").font(.system(size: 17, weight: .semibold)).lineHeight(.exact(points: 22))
                            .foregroundStyle(theme.foreground)
                        DiffCounts(additions: files.reduce(Int64(0)) { $0 + $1.additions },
                                   deletions: files.reduce(Int64(0)) { $0 + $1.deletions }, fontSize: 12)
                            .lineHeight(.exact(points: 16))
                    }
                }
            }
            .task(id: attempt) {
                error = nil
                do { let result = try await load(); try Task.checkCancellation(); patches = result }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
        }
    }

    /// Lab `.m-review-file-header`: 56 high, `11 10` padding, 500 13/18, a 1 pt line under it;
    /// the toggle (chevron 16, file 14, path), then "−n +n", then the viewed box.
    private func patchHeader(_ patch: FfiFilePatch) -> some View {
        HStack(spacing: 10) {
            Button {
                if !collapsed.insert(patch.path).inserted { collapsed.remove(patch.path) }
            } label: {
                HStack(spacing: 8) {
                    ThreadGlyph(name: collapsed.contains(patch.path) ? "chevron-right" : "chevron-down", size: 16)
                    ThreadGlyph(name: "file-text", size: 14)
                    Text(patch.path).lineLimit(1).truncationMode(.head)
                        .foregroundStyle(theme.foreground)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(theme.mutedForeground)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            if let file = files.first(where: { $0.path == patch.path }) {
                HStack(spacing: 4) {
                    Text("−\(file.deletions)").foregroundStyle(reviewColors.deleteText)
                    Text("+\(file.additions)").foregroundStyle(reviewColors.addText)
                }
            }
            Button {
                if !viewed.insert(patch.path).inserted { viewed.remove(patch.path) }
            } label: {
                let on = viewed.contains(patch.path)
                ZStack {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(on ? theme.primary : theme.foreground.opacity(0.06))
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(on ? theme.primary : theme.mutedForeground.opacity(0.45), lineWidth: 1)
                    if on { ThreadGlyph(name: "check", size: 12).foregroundStyle(theme.primaryForeground) }
                }
                .frame(width: 16, height: 16)
                .padding(.horizontal, 2)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Mark \(patch.path) as viewed")
            .accessibilityValue(viewed.contains(patch.path) ? "Yes" : "No")
        }
        .font(.system(size: 13, weight: .medium)).lineHeight(.exact(points: 18))
        .padding(.horizontal, 10).padding(.vertical, 11)
        .frame(minHeight: 56).buttonStyle(.plain)
        .background(theme.codeBackground)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 1) }
    }

    private var reviewColors: ReviewColors { ReviewColors(appearance) }
}

/// Lab `.m-review-scroll` custom properties.
struct ReviewColors {
    let appearance: ColorScheme
    init(_ appearance: ColorScheme) { self.appearance = appearance }
    private func hex(_ value: UInt32) -> Color {
        Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }
    var addBackground: Color { hex(appearance == .light ? 0xe5f8f5 : 0x0d2f28) }
    var deleteBackground: Color { hex(appearance == .light ? 0xffe6e7 : 0x391415) }
    var addText: Color { hex(appearance == .light ? 0x199f43 : 0x5ecc71) }
    var deleteText: Color { hex(appearance == .light ? 0xd52c36 : 0xff6762) }
    var addBar: Color { hex(0x00cab1) }
    var deleteBar: Color { hex(0xff2e3f) }
}

/// Lab `--review-bar` for a deleted line: a 1 pt line every 2 pt.
private struct StripedBar: View {
    let color: Color
    var body: some View {
        Canvas { context, size in
            var y: CGFloat = 0
            while y < size.height {
                context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(color))
                y += 2
            }
        }
    }
}

struct PatchBody: View {
    let patch: FfiFilePatch
    /// The turn review's rows (lab `FilePatch`): no markers, a 50 pt gutter with a colour bar.
    var review = false
    var comments: [String: [String]] = [:]
    var comment: ((FfiPatchLine) -> Void)? = nil
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance
    @State private var viewportWidth: CGFloat = 0
    @State private var colors: [AttributedString] = []

    var body: some View {
        if patch.lines.isEmpty {
            Text(patch.binary ? "Binary file" : "No line changes").font(.caption).padding(10)
        } else {
            ScrollView(.horizontal) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(patch.lines.indices, id: \.self) { index in
                        let line = patch.lines[index]
                        let tint = line.marker == "+" ? theme.diffAdded : line.marker == "-" ? theme.diffRemoved : theme.mutedForeground
                        Group {
                            if review {
                                reviewRow(line, index: index)
                            } else {
                                HStack(alignment: .firstTextBaseline, spacing: 5) {
                                    Text(line.number.map(String.init) ?? "")
                                        .foregroundStyle(theme.mutedForeground).frame(width: 27, alignment: .trailing)
                                    Text(line.marker == "@@" ? "" : line.marker)
                                    if line.number != nil && colors.indices.contains(index) {
                                        Text(colors[index])
                                    } else {
                                        Text(verbatim: line.text)
                                            .foregroundStyle(line.number == nil ? theme.mutedForeground : theme.codeForeground)
                                    }
                                }
                                .fixedSize(horizontal: true, vertical: false)
                                .font(.system(size: 12, design: .monospaced))
                                .frame(minWidth: viewportWidth, maxWidth: .infinity, minHeight: 19, alignment: .leading)
                                .background(tint.opacity(line.marker == " " ? 0 : 0.12))
                            }
                        }
                        .modifier(ReviewLineAction(action: line.number.flatMap { number in comment.map { submit in
                            (number, { submit(line) })
                        }}))
                        let notes = (line.oldLine.flatMap { comments["left" + String($0)] } ?? [])
                            + (line.newLine.flatMap { comments["right" + String($0)] } ?? [])
                        ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                            Label(note, systemImage: "text.bubble").font(.callout)
                                .frame(maxWidth: 300, alignment: .leading).padding(.leading, 12)
                        }
                    }
                }
                .padding(.top, review ? 0 : 8).padding(.bottom, review ? 12 : 8).textSelection(.enabled)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { viewportWidth = $0 }
            .task(id: theme.themeId) {
                colors = []
                let themeId = theme.themeId
                let highlighted = await Task.detached(priority: .utility) { [patch] in
                    let bytes = patch.lines.reduce(0) { $0 + $1.text.utf8.count + 1 }
                    guard bytes <= 512 * 1024 else { return [AttributedString]() }
                    // Preserve row indices; hunk headers use their own style.
                    let source = patch.lines.map { $0.number == nil ? "" : $0.text }.joined(separator: "\n")
                    let ext = (patch.path as NSString).pathExtension.lowercased()
                    let fragment = ext == "php" && !source.contains("<?")
                    let lines = highlightCode(source: fragment ? "<?php\n" + source : source,
                                              language: ext == "vue" ? "file.html" : patch.path, theme: themeId)
                    return lines.dropFirst(fragment ? 1 : 0).map(attributedCodeLine)
                }.value
                if !Task.isCancelled { colors = highlighted }
            }
        }
    }
}

extension PatchBody {
    /// Lab `.m-review-row`: 22 high, a 50 pt gutter (11 pt number, 7 pt gap) with a 4 pt bar on
    /// added and deleted lines, then the source in 12 pt mono with 7 pt on each side.
    fileprivate func reviewRow(_ line: FfiPatchLine, index: Int) -> some View {
        let palette = ReviewColors(appearance)
        let hunk = line.marker == "@@"
        let added = line.marker == "+"
        let deleted = line.marker == "-"
        let background: Color = added ? palette.addBackground : deleted ? palette.deleteBackground
            : hunk ? theme.codeBackground.mix(with: theme.foreground, by: 0.1, in: .device) : theme.codeBackground
        return HStack(alignment: .top, spacing: 0) {
            Text(hunk ? "" : line.number.map(String.init) ?? "")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(added ? palette.addText : deleted ? palette.deleteText : theme.mutedForeground)
                .frame(width: 43, alignment: .trailing)
                .padding(.trailing, 7)
                .frame(width: 50, height: 22, alignment: .trailing)
                .background(alignment: .leading) {
                    if added { palette.addBar.frame(width: 4) }
                    if deleted { StripedBar(color: palette.deleteBar).frame(width: 4) }
                }
            Group {
                if hunk {
                    Text(verbatim: line.text).font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.foreground)
                } else if line.number != nil && colors.indices.contains(index) {
                    Text(colors[index])
                } else {
                    Text(verbatim: line.text).foregroundStyle(line.number == nil ? theme.mutedForeground : theme.codeForeground)
                }
            }
            .padding(.horizontal, 7)
            .frame(height: 22)
        }
        .fixedSize(horizontal: true, vertical: false)
        .font(.system(size: 12, design: .monospaced))
        .frame(minWidth: viewportWidth, maxWidth: .infinity, alignment: .leading)
        .background(background)
    }
}

private struct ReviewLineAction: ViewModifier {
    let action: (UInt32, () -> Void)?
    func body(content: Content) -> some View {
        if let (number, act) = action {
            Button(action: act) { content.contentShape(Rectangle()) }
                .buttonStyle(.plain).accessibilityLabel("Comment on line " + String(number))
        } else { content }
    }
}
