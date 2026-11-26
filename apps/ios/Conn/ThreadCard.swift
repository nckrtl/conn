import SwiftUI
import UniformTypeIdentifiers

struct ThreadCard<Header: View, Content: View>: View {
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance
    @ScaledMetric(relativeTo: .body) private var headerSize: CGFloat = ThreadText.size
    var code = false
    @ViewBuilder let header: Header
    @ViewBuilder let content: Content

    var body: some View {
        let outer = threadCardSurface(theme, appearance)
        let inner = code ? theme.codeBackground : appearance == .light ? Color.white : outer.mix(with: .white, by: 0.06, in: .device)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) { header }
                .font(.system(size: headerSize))
                .foregroundStyle(theme.mutedForeground)
                .padding(.leading, 11)
                .padding(.trailing, 5)
                .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(inner)
                .clipShape(.rect(cornerRadius: 11))
        }
        .padding(3)
        .background(outer, in: .rect(cornerRadius: 14))
        // The outer ring sits outside the text column: the inner card's edges line up with the
        // feed's text, so cards don't read slimmer than the messages around them.
        .padding(.horizontal, -3)
    }
}

/// The outer card colour (lab `--thread-card-surface`).
func threadCardSurface(_ theme: ConnTheme, _ appearance: ColorScheme) -> Color {
    theme.background.mix(with: theme.foreground, by: appearance == .light ? 0.06 : 0.056, in: .device)
}

/// The lighter inner fill of a composer panel body (lab `--composer-panel-inner`).
func composerPanelInner(_ theme: ConnTheme, _ appearance: ColorScheme) -> Color {
    appearance == .light
        ? Color.white.mix(with: theme.foreground, by: 0.03, in: .device)
        : threadCardSurface(theme, appearance).mix(with: .white, by: 0.06, in: .device)
}

/// The work divider line (lab `--thread-divider`): the sidebar colour mixed 89% (dark) or 90% (light)
/// with the text colour in OKLab, which is conn-theme's `shell_divider`.
func threadDividerColor(_ theme: ConnTheme, _ appearance: ColorScheme) -> Color {
    Color(ffi: theme.tokens.shellDivider)
}

/// A card icon's status dot: 5 pt, a 2 pt ring in the card surface, 4 pt past the icon's
/// top-right corner (lab `.m-feed-card-header .m-dot`).
struct CardStatusDot: View {
    let color: Color
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance

    var body: some View {
        Circle().fill(color).frame(width: 5, height: 5)
            .padding(2)
            .background(threadCardSurface(theme, appearance), in: Circle())
            .offset(x: 4, y: -4)
            .allowsHitTesting(false)
    }
}

extension View {
    func cardStatusDot(_ color: Color) -> some View {
        overlay(alignment: .topTrailing) { CardStatusDot(color: color) }
    }
}

/// Lab `.m-card-action`: a 24 pt target with a 14 pt `copy` glyph that turns into a `check`
/// (green on the code card) for a moment after copying.
struct CopyTextButton: View {
    let label: String
    let text: String
    var message = false
    /// 14 on cards; 16 under messages, the size of the work-log icons.
    var glyphSize: CGFloat = 14
    @State private var copied = false
    @Environment(\.connTheme) private var theme

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
        } label: {
            Group {
                if copied && !message {
                    ThreadGlyph(name: "check", size: glyphSize).foregroundStyle(theme.success)
                } else {
                    ThreadGlyph(name: copied ? "check" : "copy", size: glyphSize)
                }
            }
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : label)
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .milliseconds(1200))
            if !Task.isCancelled { copied = false }
        }
    }
}

struct MarkdownDocument: FileDocument {
    static let readableContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
    let text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        text = String(decoding: data, as: UTF8.self)
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

struct CodeCard: View {
    let code: String
    let language: String?
    var title: String? = nil
    /// Long output scrolls inside this height instead of growing the feed (work-log tool details).
    var maxHeight: CGFloat? = nil
    /// The code size; tool details sit a step below the thread's code blocks.
    var codeSize: CGFloat = ThreadText.codeSize
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance
    @State private var wrap = false

    /// Lab `FENCE_DISPLAY_NAMES`; unlisted fences are capitalised, and no fence is "Text".
    private static let names = [
        "css": "CSS", "html": "HTML", "js": "JavaScript", "json": "JSON", "jsx": "JSX", "md": "Markdown",
        "py": "Python", "rs": "Rust", "sh": "Shell", "ts": "TypeScript", "tsx": "TSX",
        "typescript": "TypeScript", "javascript": "JavaScript", "yaml": "YAML", "yml": "YAML",
        "cc": "C++", "cpp": "C++", "cxx": "C++", "cs": "C#", "csharp": "C#", "graphql": "GraphQL",
        "objc": "Objective-C", "objectivec": "Objective-C", "php": "PHP", "rb": "Ruby", "scss": "SCSS",
        "sql": "SQL", "toml": "TOML", "xml": "XML",
    ]

    private var label: String {
        guard let lang = language?.lowercased(), !["", "text", "txt", "plain", "plaintext"].contains(lang) else { return "Text" }
        return Self.names[lang] ?? lang.prefix(1).uppercased() + lang.dropFirst()
    }

    /// Lab `.m-code-label[data-lang]`: only Rust and TypeScript carry a file icon, in their own colour.
    private var fileIcon: (name: String, color: Color)? {
        switch language?.lowercased() {
        case "rs", "rust": ("file-rust", appearance == .light ? Color(red: 0.831, green: 0.463, blue: 0.157) : Color(red: 1, green: 0.639, blue: 0.349))
        case "typescript", "ts", "tsx": ("file-typescript", appearance == .light ? Color(red: 0.102, green: 0.522, blue: 0.831) : Color(red: 0.412, green: 0.694, blue: 1))
        default: nil
        }
    }

    var body: some View {
        ThreadCard(code: true) {
            if let icon = fileIcon {
                Image(icon.name).renderingMode(.template).resizable().scaledToFit()
                    .frame(width: 14, height: 14).foregroundStyle(icon.color)
            }
            Text(title ?? label)
            Spacer()
            HStack(spacing: 2) {
                Button {
                    wrap.toggle()
                } label: {
                    ThreadGlyph(name: "wrap-lines", size: 16)
                        .foregroundStyle(wrap ? theme.codeForeground : theme.mutedForeground)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Toggle word wrap")
                .accessibilityValue(wrap ? "On" : "Off")
                CopyTextButton(label: "Copy code", text: code)
            }
        } content: {
            if let maxHeight {
                // Short output keeps its height; long output scrolls inside the cap.
                ViewThatFits(in: .vertical) {
                    lines
                    ScrollView(.vertical) { lines }.frame(height: maxHeight)
                }
                .frame(maxHeight: maxHeight)
            } else {
                lines
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var lines: some View {
        if wrap {
            source
        } else {
            ScrollView(.horizontal) { source.fixedSize(horizontal: true, vertical: false) }
        }
    }

    /// Lab `.m-code-body`: `12.8 14.4` padding.
    private var source: some View {
        HighlightedSource(code: code, language: language ?? "", baseSize: codeSize)
            .padding(.horizontal, 14.4).padding(.vertical, 12.8)
    }
}

struct HighlightedSource: View {
    let code: String
    let language: String
    @Environment(\.connTheme) private var theme
    /// The base size, 13 like the lab's `.m-code-body`; Dynamic Type scales it.
    var baseSize: CGFloat = ThreadText.codeSize
    @State private var formatted: AttributedString?
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    private var size: CGFloat { baseSize * scale }

    private struct Input: Equatable { let code, language, theme: String }

    var body: some View {
        let input = Input(code: code, language: language, theme: theme.themeId)
        Text(formatted ?? AttributedString(code))
            .font(.system(size: size, design: .monospaced))
            .lineHeight(.exact(points: size * 1.625))
            .foregroundStyle(theme.codeForeground)
            .textSelection(.enabled)
            .task(id: input) {
                formatted = nil
                guard !language.isEmpty, code.utf8.count <= 512 * 1024 else { return }
                let highlighted = await Task.detached(priority: .utility) {
                    let lines = highlightCode(source: input.code, language: input.language, theme: input.theme)
                    var result = AttributedString()
                    for (i, line) in lines.enumerated() {
                        if i > 0 { result += AttributedString("\n") }
                        result += attributedCodeLine(line)
                    }
                    return result
                }.value
                if !Task.isCancelled && !highlighted.characters.isEmpty { formatted = highlighted }
            }
    }
}

func attributedCodeLine(_ spans: [FfiCodeSpan]) -> AttributedString {
    var line = AttributedString()
    for span in spans {
        var token = AttributedString(span.text)
        token.foregroundColor = Color(ffi: span.color)
        var intent: InlinePresentationIntent = []
        if span.bold { intent.insert(.stronglyEmphasized) }
        if span.italic { intent.insert(.emphasized) }
        if !intent.isEmpty { token.inlinePresentationIntent = intent }
        line += token
    }
    return line
}

/// Lab `.m-composer-panel` / `-body` top edge: a 1 pt border in `--composer-panel-edge` that fades
/// out round the corners, as a CSS `border-top` does.
struct ComposerPanelEdge: ViewModifier {
    let radius: CGFloat
    let visible: Bool
    @Environment(\.colorScheme) private var appearance
    @Environment(\.connTheme) private var theme

    func body(content: Content) -> some View {
        content.overlay {
            if visible {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(appearance == .light ? Color.white.opacity(0.45) : theme.foreground.opacity(0.05), lineWidth: 1)
                    .mask(alignment: .top) {
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: radius)
                    }
                    .allowsHitTesting(false)
            }
        }
    }
}

extension View {
    func composerPanelEdge(radius: CGFloat, visible: Bool = true) -> some View {
        modifier(ComposerPanelEdge(radius: radius, visible: visible))
    }
}

struct ComposerDeck: ViewModifier {
    let remaining: Int
    @Environment(\.colorScheme) private var appearance
    @Environment(\.connTheme) private var theme

    func body(content: Content) -> some View {
        let layers = min(max(remaining - 1, 0), 2)
        let surface = threadCardSurface(theme, appearance)
        let shadow = Color.black.opacity(appearance == .light ? 0.07 : 0.16)
        content
            .shadow(color: layers > 0 ? shadow : .clear, radius: 16, y: 1)
            .padding(.top, CGFloat(layers * 6))
            .background {
                ForEach((1..<(layers + 1)).reversed(), id: \.self) { depth in
                    // Lab `.m-composer-deck::before` (85% panel surface) and `::after` (70%) over the page.
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(surface.mix(with: theme.background, by: depth == 1 ? 0.15 : 0.30, in: .device))
                        .composerPanelEdge(radius: 28)
                        .shadow(color: shadow, radius: 16, y: 1)
                        .padding(.horizontal, CGFloat(depth * 8))
                        .padding(.top, CGFloat((layers - depth) * 6))
                        .padding(.bottom, CGFloat(depth * 6))
                }
            }
    }
}

func threadDate(_ text: String?) -> Date? {
    guard let text else { return nil }
    return (try? Date(text, strategy: .iso8601.time(includingFractionalSeconds: true)))
        ?? (try? Date(text, strategy: .iso8601))
}

func threadElapsed(_ start: String?, _ end: String?) -> String? {
    guard let a = threadDate(start), let b = threadDate(end), b >= a else { return nil }
    return durationText(UInt64(b.timeIntervalSince(a) * 1000))
}
