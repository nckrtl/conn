import CoreText
import DesignKit
import SwiftUI

struct MarkdownView: View, Equatable {
    let source: String
    /// An agent's earlier text beside a question: a size smaller, in the muted colour.
    var fillsWidth = true
    var muted = false
    var recordStyle = false
    enum MessageStyle { case assistant, user }
    var messageStyle: MessageStyle?
    @ScaledMetric(relativeTo: .body) private var messageSize: CGFloat = ThreadText.size
    var onTemplate: ((String) -> Void)? = nil
    /// The feed entry this text belongs to: while it streams, its finished blocks are reused.
    var cacheID: String? = nil
    @Environment(\.connTheme) private var theme

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.source == rhs.source && lhs.fillsWidth == rhs.fillsWidth && lhs.muted == rhs.muted
            && lhs.recordStyle == rhs.recordStyle && lhs.messageStyle == rhs.messageStyle
            && lhs.cacheID == rhs.cacheID && (lhs.onTemplate == nil) == (rhs.onTemplate == nil)
    }

    /// Lab `.m-md`: 16/23, `.m-md[data-muted]`: 15/21, and in the feed the thread text at 1.6.
    private var bodySize: CGFloat {
        if messageStyle != nil { return messageSize }
        return muted || recordStyle ? 15 : 16
    }

    private var bodyFont: Font { .system(size: bodySize) }

    private var bodyLineHeight: AttributedString.LineHeight? {
        if messageStyle != nil { return .exact(points: messageSize * 1.6) }
        if recordStyle { return .exact(points: 22.5) }
        return .exact(points: muted ? 21 : 23)
    }

    /// The feed's type scale, relative to the 15 pt the lab's pixel values were set at.
    private var feedScale: CGFloat { messageSize / ThreadText.size }

    /// Lab `.m-feed .m-md > * + *` is 0.85 of the thread text; `.m-md p` and lists end in a 13
    /// `--m-paragraph-gap`.
    private var blockSpacing: CGFloat {
        if messageStyle != nil { return 0.85 * messageSize }
        // Record bodies space their blocks one by one (recordGap).
        return recordStyle ? 0 : 13
    }

    private var textColor: Color {
        switch messageStyle {
        case .user: theme.messageForeground
        case .assistant: theme.foreground.opacity(0.9)
        case nil: muted ? theme.mutedForeground : theme.foreground
        }
    }

    var body: some View {
        let _ = BodyCount.tick("Markdown")
        if messageStyle == .user {
            Text(verbatim: source)
                .font(bodyFont)
                .foregroundStyle(textColor)
                .lineHeight(bodyLineHeight)
                .frame(maxWidth: fillsWidth ? .infinity : nil, alignment: .leading)
                .textSelection(.enabled)
        } else {
            markdown
        }
    }

    private var markdown: some View {
        let blocks = MarkdownCache.blocks(source, id: cacheID)
        return VStack(alignment: .leading, spacing: blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                blockView(block, first: index == 0)
                    .padding(.top, recordStyle ? recordGap(blocks, index) : 0)
            }
        }
        .frame(maxWidth: fillsWidth ? .infinity : nil, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock, first: Bool) -> some View {
        switch block {
        case let .heading(level, text):
            inlineMarkdownText(text)
                .font(headingFont(for: level))
                .lineHeight(messageStyle != nil ? bodyLineHeight : recordStyle ? .exact(points: 24) : nil)
                .foregroundStyle(messageStyle != nil && level == 6 ? theme.mutedForeground : textColor)
                .textSelection(.enabled)
                // Lab: a heading after another block has a 20/16 margin in place of the block gap.
                .padding(.top, messageStyle != nil ? (first ? 0 : max(0, 20 * feedScale - blockSpacing)) : recordStyle ? 0 : level <= 2 ? Kit.Space.xs : 0)

        case let .paragraph(text):
            inlineMarkdownText(text)
                .font(bodyFont)
                .lineHeight(bodyLineHeight)
                .foregroundStyle(textColor)
                .textSelection(.enabled)

        case let .codeBlock(language, code):
            // A code block gets 16 above and about 16 below in the feed, more than a paragraph's gap.
            CodeCard(code: code, language: language)
                .padding(.top, messageStyle != nil && !first ? max(0, 16 - blockSpacing) : 0)
                .padding(.bottom, messageStyle != nil ? 6 : 0)

        case let .quote(text):
            // Lab `.m-md blockquote`: a 2 pt rule in the text colour at 35%, 12.8 gap, same text colour.
            HStack(alignment: .top, spacing: 12.8) {
                Rectangle().fill(textColor.opacity(0.35)).frame(width: 2)
                inlineMarkdownText(text).font(bodyFont).foregroundStyle(textColor).textSelection(.enabled)
                    .lineHeight(bodyLineHeight)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)

        case let .table(rows):
            // Lab `.m-md table`: fixed equal columns, cells `7.2 12` (header `8.8 12`) with the
            // outer sides flush, and a 1 pt divider under every row.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows.indices, id: \.self) { i in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(rows[i].indices, id: \.self) { j in
                            inlineMarkdownText(rows[i][j])
                                .fontWeight(i == 0 ? .semibold : .regular)
                                .padding(.leading, j == 0 ? 0 : 12)
                                .padding(.trailing, j == rows[i].count - 1 ? 0 : 12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.vertical, i == 0 ? 8.8 : 7.2)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(threadDividerColor(theme, appearance)).frame(height: 1)
                    }
                }
            }
            .lineHeight(messageStyle != nil ? bodyLineHeight : .exact(points: 20))
            .font(bodyFont)
            .foregroundStyle(textColor)
            .textSelection(.enabled)

        case let .template(template, raw):
            if let onTemplate {
                ThreadCard {
                    Label("Artifact template", systemImage: "doc.text")
                } content: {
                    Button { onTemplate(template.prompt) } label: {
                        HStack {
                            Text(template.name)
                            Spacer()
                            Image(systemName: "square.and.pencil")
                        }.padding(12)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Start a draft with " + template.name)
                }
            } else {
                Text(raw).textSelection(.enabled)
            }

        case let .list(items):
            // Lab `.m-md ul/ol`: `li` 6 apart, markers in the text colour (numbers 600). In the feed
            // the marker sits 6 in from the paragraph's left edge and the text follows 8 later.
            let numbered = items.contains { $0.marker != "•" }
            let widest = items.map(\.marker).max { $0.count < $1.count } ?? ""
            let disc = bodySize * 0.375
            let xHeight = UIFont.systemFont(ofSize: bodySize).xHeight
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.indices, id: \.self) { i in
                    HStack(alignment: .firstTextBaseline, spacing: messageStyle != nil ? 8 : 4) {
                        if messageStyle == nil {
                            Text(items[i].marker)
                                .font(bodyFont)
                                .fontWeight(items[i].marker == "•" ? .regular : .semibold)
                                .foregroundStyle(textColor)
                                .frame(width: 18, alignment: .trailing)
                        } else if numbered {
                            // Every marker takes the widest one's width, so the item text lines up.
                            ZStack(alignment: .leading) {
                                Text(widest).hidden()
                                Text(items[i].marker)
                            }
                            .font(.system(size: bodySize, weight: .semibold))
                            .monospacedDigit()
                            .foregroundStyle(textColor)
                            .fixedSize()
                        } else {
                            // A disc 0.375em across, centred on the first line's x-height: the
                            // baseline guide sits half an x-height below the disc's centre.
                            Circle().fill(textColor)
                                .frame(width: disc, height: disc)
                                .alignmentGuide(.firstTextBaseline) { $0.height / 2 + xHeight / 2 }
                        }
                        inlineMarkdownText(items[i].text)
                            .font(bodyFont)
                            .foregroundStyle(textColor)
                            .textSelection(.enabled)
                    }
                    .lineHeight(bodyLineHeight)
                }
            }
            // Feed lists sit 6 in from the paragraph edge (lab `.m-feed .m-md :is(ul, ol)`).
            .padding(.leading, messageStyle != nil ? 6 : 0)
        }
    }

    /// Record bodies (`ios-detail-body .m-md`): 13pt between paragraphs, 18pt above a heading,
    /// 6pt under one (list items sit 6 apart inside their block).
    private func recordGap(_ blocks: [MarkdownBlock], _ index: Int) -> CGFloat {
        guard index > 0 else { return 0 }
        switch (blocks[index - 1], blocks[index]) {
        case (_, .heading): return 18
        case (.heading, _): return 6
        default: return 13
        }
    }

    @Environment(\.colorScheme) private var appearance

    /// The lab sets every feed heading at the thread text size, weight 600; elsewhere the headings
    /// keep their own scale.
    private func headingFont(for level: Int) -> Font {
        if messageStyle != nil { return .system(size: messageSize, weight: .semibold) }
        if recordStyle { return .system(size: 16, weight: .medium) }
        return switch level {
        case 1: .title2.weight(.semibold)
        case 2: .title3.weight(.semibold)
        case 3: .headline
        default: .subheadline.weight(.semibold)
        }
    }

    /// Inline Markdown in the lab's styles: bold is 600 in the full text colour, code is the
    /// 0.85em mono chip. In the feed the chip is a rounded fill drawn by `InlineCodeChipRenderer`
    /// (`.m-feed .m-md-code`: 10% text fill, `0.1em 0.35em` padding, 1 pt border, 4 pt radius).
    @ViewBuilder
    private func inlineMarkdownText(_ raw: String) -> some View {
        let built = inlineText(raw)
        if built.hasChip {
            // A renderer only on text that has a chip: other text keeps its native selection.
            built.text.textRenderer(InlineCodeChipRenderer(
                fill: theme.foreground.opacity(0.1), padX: built.padX, padY: built.padY
            ))
        } else {
            built.text
        }
    }

    private func inlineText(_ raw: String) -> InlineText {
        let key = InlineKey(
            raw: raw, size: bodySize, muted: muted, style: messageStyle.map { $0 == .assistant ? 1 : 2 } ?? 0,
            code: muted ? theme.mutedForeground : theme.codeForeground, strong: theme.foreground
        )
        return MarkdownCache.inline(key) { buildInlineText(raw) }
    }

    private func buildInlineText(_ raw: String) -> InlineText {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let codeSize = bodySize * 0.85
        // `padding: 0.1em 0.35em` of the code size plus the 1 pt transparent border.
        let padX = 0.35 * codeSize + 1
        let padY = 0.1 * codeSize + 1
        BodyCount.tick("md.inline")
        guard let parsed = try? AttributedString(markdown: raw, options: options) else {
            return (Text(raw), false, padX, padY)
        }
        let chips = messageStyle != nil
        var segments: [(text: AttributedString, chip: Bool)] = []
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            var chip = false
            // Links are underlined so they read as tappable (desktop does the same).
            if run.link != nil { piece.underlineStyle = .single }
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    piece.font = .system(size: codeSize, design: .monospaced)
                    piece.foregroundColor = muted ? theme.mutedForeground : theme.codeForeground
                    chip = chips
                } else if intent.contains(.stronglyEmphasized) {
                    var rest = intent
                    rest.remove(.stronglyEmphasized)
                    piece.inlinePresentationIntent = rest.isEmpty ? nil : rest
                    piece.font = .system(size: bodySize, weight: .semibold)
                    if !muted, messageStyle == .assistant { piece.foregroundColor = theme.foreground }
                }
            }
            segments.append((piece, chip))
        }
        // The chip's room is kerning, not characters, so copied text stays plain. The previous
        // character carries the leading room and the chip's last character the trailing room.
        for i in segments.indices where segments[i].chip {
            if i > 0, !segments[i - 1].text.characters.isEmpty {
                let last = segments[i - 1].text.index(segments[i - 1].text.endIndex, offsetByCharacters: -1)
                segments[i - 1].text[last..<segments[i - 1].text.endIndex].kern = padX
            }
            let text = segments[i].text
            if !text.characters.isEmpty {
                let last = text.index(text.endIndex, offsetByCharacters: -1)
                segments[i].text[last..<text.endIndex].kern = padX
            }
        }
        // One Text per run: `customAttribute` marks the chip runs for the renderer. `+` on Text
        // is deprecated in iOS 26, but it is the only way to carry per-run custom attributes.
        var out = Text("")
        for segment in segments {
            let part = Text(segment.text)
            out = out + (segment.chip ? part.customAttribute(InlineCodeChip()) : part)
        }
        return (out, segments.contains { $0.chip }, padX, padY)
    }
}

/// Marks a run of inline code for `InlineCodeChipRenderer`.
private struct InlineCodeChip: TextAttribute {}

/// Draws a rounded fill behind each line fragment of an inline-code run, then the text. The fill
/// reaches `padX` and `padY` past the glyphs (the kerning in `inlineText` reserved the room).
/// A chip that wraps is padded at its first start only; it runs flush into the line break and the
/// next line's fragment (the kerning room exists only at the chip's real ends).
private struct InlineCodeChipRenderer: TextRenderer {
    var fill: Color
    var padX: CGFloat
    var padY: CGFloat
    var radius: CGFloat = 4

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let lines = Array(layout)
        // Per line: the chip's frame, whether it starts or ends the line.
        var frames: [[(rect: CGRect, startsLine: Bool, endsLine: Bool)]] = []
        for line in lines {
            var found: [(rect: CGRect, startsLine: Bool, endsLine: Bool)] = []
            let runs = Array(line)
            var current: CGRect?
            var currentStarts = false
            for (index, run) in runs.enumerated() {
                if run[InlineCodeChip.self] != nil {
                    let rect = run.typographicBounds.rect
                    if let existing = current { current = existing.union(rect) } else {
                        current = rect
                        currentStarts = index == 0
                    }
                } else if let rect = current {
                    found.append((rect, currentStarts, false))
                    current = nil
                }
            }
            if let rect = current { found.append((rect, currentStarts, true)) }
            frames.append(found)
        }
        for (lineIndex, line) in frames.enumerated() {
            for chip in line {
                let continuesFromPrevious = chip.startsLine && lineIndex > 0 && frames[lineIndex - 1].last?.endsLine == true
                var rect = chip.rect.insetBy(dx: 0, dy: -padY)
                // The leading room is the previous character's kerning, outside this run's bounds;
                // the trailing room is this run's last character's kerning, inside its bounds.
                if !continuesFromPrevious { rect.origin.x -= padX; rect.size.width += padX }
                context.fill(Path(roundedRect: rect, cornerRadius: radius, style: .continuous), with: .color(fill))
            }
        }
        for line in lines { context.draw(line) }
    }
}

enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(String)
    case quote(String)
    case table([[String]])
    case template(ArtifactTemplate, String)
    case codeBlock(language: String?, code: String)
    case list([(marker: String, text: String)])
}

typealias InlineText = (text: Text, hasChip: Bool, padX: CGFloat, padY: CGFloat)

struct InlineKey: Hashable {
    let raw: String
    let size: CGFloat
    let muted: Bool
    let style: Int
    let code: Color
    let strong: Color
}

/// Parsed Markdown kept between body evaluations: blocks by feed entry (or by source text) and
/// inline text by its text and style. A streaming entry re-parses only its last block.
@MainActor
enum MarkdownCache {
    struct Parsed {
        let source: String
        let blocks: [MarkdownBlock]
        /// The UTF-8 offset of each block's first line.
        let starts: [Int]
    }

    private static var byID: [String: Parsed] = [:]
    private static var bySource: [String: Parsed] = [:]
    private static var inlines: [InlineKey: InlineText] = [:]
    private static let limit = 2000

    static func blocks(_ source: String, id: String?) -> [MarkdownBlock] {
        if let id {
            let previous = byID[id]
            if let previous, previous.source == source { return previous.blocks }
            let parsed = reparse(source, after: previous)
            if byID.count >= limit { byID.removeAll(keepingCapacity: true) }
            byID[id] = parsed
            return parsed.blocks
        }
        if let cached = bySource[source] { return cached.blocks }
        let parsed = reparse(source, after: nil)
        if bySource.count >= limit { bySource.removeAll(keepingCapacity: true) }
        bySource[source] = parsed
        return parsed.blocks
    }

    /// Appended text can change the last block, and the one before it when the old text ended in
    /// a partial line (`-` becoming `- b` continues a list); the blocks before those are kept.
    private static func reparse(_ source: String, after previous: Parsed?) -> Parsed {
        let kept = max(0, (previous?.starts.count ?? 0) - 2)
        guard let previous, kept > 0, source.hasPrefix(previous.source) else {
            let parsed = parseBlocks(source)
            return Parsed(source: source, blocks: parsed.map(\.block), starts: parsed.map(\.start))
        }
        let from = previous.starts[kept]
        let utf8 = source.utf8
        let tail = String(Substring(utf8[utf8.index(utf8.startIndex, offsetBy: from)...]))
        let parsed = parseBlocks(tail)
        return Parsed(
            source: source,
            blocks: previous.blocks.prefix(kept) + parsed.map(\.block),
            starts: previous.starts.prefix(kept) + parsed.map { $0.start + from }
        )
    }

    static func inline(_ key: InlineKey, build: () -> InlineText) -> InlineText {
        if let cached = inlines[key] { return cached }
        let built = build()
        if inlines.count >= limit { inlines.removeAll(keepingCapacity: true) }
        inlines[key] = built
        return built
    }
}

/// The blocks of `source`, each with the UTF-8 offset of its first line.
func parseBlocks(_ source: String) -> [(block: MarkdownBlock, start: Int)] {
    BodyCount.tick("md.parseBlocks")
    let pieces = source.split(separator: "\n", omittingEmptySubsequences: false)
    let lines = pieces.map(String.init)
    let offsets = pieces.map { source.utf8.distance(from: source.startIndex, to: $0.startIndex) }
    var blocks: [(block: MarkdownBlock, start: Int)] = []
    var blockStart = 0
    var paragraphLines: [String] = []
    var index = 0

    var paragraphStart = 0
    func flushParagraph() {
        let joined = paragraphLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !joined.isEmpty {
            blocks.append((.paragraph(joined), offsets[paragraphStart]))
        }
        paragraphLines.removeAll()
    }

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        blockStart = offsets[index]

        if let marker = trimmed.first, marker == "`" || marker == "~", trimmed.prefix(while: { $0 == marker }).count >= 3 {
            let fence = trimmed.prefix(while: { $0 == marker })
            flushParagraph()
            let lang = String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
            var codeLines: [String] = []
            index += 1
            while index < lines.count {
                let closer = lines[index].trimmingCharacters(in: .whitespaces)
                if closer.count >= fence.count, closer.allSatisfy({ $0 == marker }) {
                    index += 1
                    break
                }
                codeLines.append(lines[index])
                index += 1
            }
            blocks.append((.codeBlock(language: lang.isEmpty ? nil : lang, code: codeLines.joined(separator: "\n")), blockStart))
            continue
        }

        if let template = ArtifactTemplate(directive: trimmed) {
            flushParagraph()
            blocks.append((.template(template, line), blockStart))
            index += 1
            continue
        }
        if trimmed.hasPrefix(">") {
            flushParagraph()
            var quote: [String] = []
            while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                let line = lines[index].trimmingCharacters(in: .whitespaces).dropFirst()
                quote.append(String(line).trimmingCharacters(in: .whitespaces))
                index += 1
            }
            blocks.append((.quote(quote.joined(separator: "\n")), blockStart))
            continue
        }
        if trimmed.contains("|"), index + 1 < lines.count {
            let separators = tableCells(lines[index + 1])
            let headings = tableCells(trimmed)
            if headings.count > 1, headings.count == separators.count,
               separators.allSatisfy({ $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }) {
                flushParagraph()
                var rows = [headings]
                index += 2
                while index < lines.count, lines[index].contains("|") {
                    rows.append(tableCells(lines[index]))
                    index += 1
                }
                blocks.append((.table(rows), blockStart))
                continue
            }
        }

        if trimmed.isEmpty {
            flushParagraph()
            index += 1
            continue
        }

        if let (level, headingText) = parseHeading(trimmed) {
            flushParagraph()
            blocks.append((.heading(level: level, text: headingText), blockStart))
            index += 1
            continue
        }

        if let (marker, itemText) = parseListItem(trimmed) {
            flushParagraph()
            var items = [(marker: marker, text: itemText)]
            index += 1
            while index < lines.count,
                  let (nextMarker, nextText) = parseListItem(lines[index].trimmingCharacters(in: .whitespaces)) {
                items.append((marker: nextMarker, text: nextText))
                index += 1
            }
            blocks.append((.list(items), blockStart))
            continue
        }

        if paragraphLines.isEmpty { paragraphStart = index }
        paragraphLines.append(line)
        index += 1
    }

    flushParagraph()
    return blocks
}

private func parseHeading(_ line: String) -> (Int, String)? {
    var hashes = 0
    for ch in line {
        if ch == "#" { hashes += 1 } else { break }
    }
    guard (1...6).contains(hashes) else { return nil }
    let rest = line.dropFirst(hashes)
    guard rest.first == " " else { return nil }
    return (hashes, String(rest.dropFirst()).trimmingCharacters(in: .whitespaces))
}

private func parseListItem(_ line: String) -> (String, String)? {
    if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
        return ("•", String(line.dropFirst(2)))
    }
    var digits = ""
    for ch in line {
        if ch.isNumber {
            digits.append(ch)
        } else if ch == "." && !digits.isEmpty {
            let afterDot = line.dropFirst(digits.count + 1)
            if afterDot.first == " " {
                return ("\(digits).", String(afterDot.dropFirst()))
            }
            return nil
        } else {
            return nil
        }
    }
    return nil
}

private func tableCells(_ line: String) -> [String] {
    line.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "|"))
        .components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
}

struct ArtifactTemplate {
    let name: String
    let prompt: String
    init?(directive: String) {
        guard directive.hasPrefix("::artifact-template{"), directive.hasSuffix("}") else { return nil }
        var attributes: [String:String] = [:]
        for match in directive.matches(of: /([a-z_]+)="([^"]*)"/) {
            attributes[String(match.1)] = String(match.2)
        }
        guard let skill = attributes["skill_name"], skill.wholeMatch(of: /artifact-template-[A-Za-z0-9_-]+/) != nil,
              let display = attributes["display_name"], !display.isEmpty,
              let directory = attributes["skill_directory"], directory.hasPrefix("/") || directory.contains(":\\"),
              let kind = attributes["artifact_kind"] else { return nil }
        let kinds = ["document":"document", "presentation":"presentation", "spreadsheet":"spreadsheet",
                     "site":"Site", "google-docs":"Google Doc", "google-slides":"Google Slides presentation",
                     "google-sheets":"Google Sheet", "image":"image", "email":"email", "slack":"Slack message"]
        guard let artifact = kinds[kind] else { return nil }
        self.name = display
        prompt = "Use $\(skill) to create a new \(artifact) about…"
    }
}
