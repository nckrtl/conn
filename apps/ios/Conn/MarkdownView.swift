import CoreText
import DesignKit
import SwiftUI

struct MarkdownView: View {
    let source: String
    /// An agent's earlier text beside a question: a size smaller, in the muted colour.
    var fillsWidth = true
    var muted = false
    var recordStyle = false
    enum MessageStyle { case assistant, user }
    var messageStyle: MessageStyle?
    @ScaledMetric(relativeTo: .body) private var messageSize: CGFloat = ThreadText.size
    var onTemplate: ((String) -> Void)? = nil
    @Environment(\.connTheme) private var theme

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

    /// Lab `.m-feed .m-md > * + *` is 10.4; `.m-md p` and lists end in a 13 `--m-paragraph-gap`.
    private var blockSpacing: CGFloat {
        if messageStyle != nil { return 10.4 * feedScale }
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
        let blocks = parseBlocks(source)
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
                // Lab: a heading after another block has a 20 margin in place of the 10.4 gap.
                .padding(.top, messageStyle != nil ? (first ? 0 : 9.6 * feedScale) : recordStyle ? 0 : level <= 2 ? Kit.Space.xs : 0)

        case let .paragraph(text):
            inlineMarkdownText(text)
                .font(bodyFont)
                .lineHeight(bodyLineHeight)
                .foregroundStyle(textColor)
                .textSelection(.enabled)

        case let .codeBlock(language, code):
            CodeCard(code: code, language: language)

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
            // Lab `.m-md ul/ol`: 22 in, `li` 6 apart, markers in the text colour (numbers 600).
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.indices, id: \.self) { i in
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(items[i].marker)
                            .font(bodyFont)
                            .fontWeight(items[i].marker == "•" ? .regular : .semibold)
                            .foregroundStyle(textColor)
                            .frame(width: 18, alignment: .trailing)
                        inlineMarkdownText(items[i].text)
                            .font(bodyFont)
                            .foregroundStyle(textColor)
                            .textSelection(.enabled)
                    }
                    .lineHeight(bodyLineHeight)
                }
            }
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
    /// 0.85em mono chip (`.m-feed .m-md-code`: 10% text fill, `0.1em 0.35em` padding).
    private func inlineMarkdownText(_ raw: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        guard let parsed = try? AttributedString(markdown: raw, options: options) else { return Text(raw) }
        let codeSize = bodySize * 0.85
        let chip = theme.foreground.opacity(0.1)
        var out = AttributedString()
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    piece.font = .system(size: codeSize, design: .monospaced)
                    piece.foregroundColor = muted ? theme.mutedForeground : theme.codeForeground
                    if messageStyle != nil {
                        piece.backgroundColor = chip
                        var pad = AttributedString("\u{2009}")
                        pad.font = .system(size: codeSize)
                        pad.backgroundColor = chip
                        piece = pad + piece + pad
                    }
                } else if intent.contains(.stronglyEmphasized) {
                    var rest = intent
                    rest.remove(.stronglyEmphasized)
                    piece.inlinePresentationIntent = rest.isEmpty ? nil : rest
                    piece.font = .system(size: bodySize, weight: .semibold)
                    if !muted, messageStyle == .assistant { piece.foregroundColor = theme.foreground }
                }
            }
            out += piece
        }
        return Text(out)
    }
}

private enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(String)
    case quote(String)
    case table([[String]])
    case template(ArtifactTemplate, String)
    case codeBlock(language: String?, code: String)
    case list([(marker: String, text: String)])
}

private func parseBlocks(_ source: String) -> [MarkdownBlock] {
    let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var blocks: [MarkdownBlock] = []
    var paragraphLines: [String] = []
    var index = 0

    func flushParagraph() {
        let joined = paragraphLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !joined.isEmpty {
            blocks.append(.paragraph(joined))
        }
        paragraphLines.removeAll()
    }

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

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
            blocks.append(.codeBlock(language: lang.isEmpty ? nil : lang, code: codeLines.joined(separator: "\n")))
            continue
        }

        if let template = ArtifactTemplate(directive: trimmed) {
            flushParagraph()
            blocks.append(.template(template, line))
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
            blocks.append(.quote(quote.joined(separator: "\n")))
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
                blocks.append(.table(rows))
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
            blocks.append(.heading(level: level, text: headingText))
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
            blocks.append(.list(items))
            continue
        }

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

private struct ArtifactTemplate {
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
