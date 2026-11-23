//! Search text folding, as T3 folds it in two places:
//!
//! - The message search index ([`fold`]): T3 indexes with SQLite's
//!   `trigram remove_diacritics 1` tokenizer (`069_ThreadMessageSearch.ts`). It folds case and
//!   takes the diacritics off Latin letters ("École" is "ecole"), but keeps the marks that tell
//!   other scripts' letters apart ("が" is not "か"). The index stores folded text, so a query
//!   folded the same way matches it in SQL.
//! - Titles, branches and pull requests ([`fold_search_query`], [`fold_field`]): `foldInPlace`
//!   in `paletteSearch.ts`, which drops every mark a compatibility decomposition leaves.
//!
//! Both read words as `isWordStart` does ([`is_word_start`]).

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::{decompose_canonical, decompose_compatible, is_combining_mark};

/// The quotes `WRAPPING_QUOTES` in `paletteSearch.ts` strips from both ends of a query.
pub(crate) const WRAPPING_QUOTES: &[char] = &[
    '"', '\'', '`', '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}',
];

/// `FILLER_WORDS`: words a query may carry that a name leaves out ("fix the sidebar").
const FILLER_WORDS: &[&str] = &[
    "a", "an", "and", "for", "in", "of", "on", "the", "to", "with",
];

/// `text` folded as the message search index stores it: the text every write to an FTS index
/// of message text folds, and every query to it.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        push_indexed(c, &mut out);
    }
    out
}

/// Appends `c` folded as SQLite's trigram tokenizer folds it with `remove_diacritics`: lower
/// case, a Latin letter with diacritics as its ASCII letter, a lone diacritic dropped. T3's
/// index also stores apostrophes straight (`indexedMessageText`), and its matcher folds a final
/// sigma.
pub(crate) fn push_indexed(c: char, out: &mut String) {
    if c.is_ascii() {
        out.push(c.to_ascii_lowercase());
        return;
    }
    match c {
        '\u{2018}' | '\u{2019}' => out.push('\''),
        'ς' => out.push('σ'),
        _ if is_sqlite_diacritic(c) => {}
        _ => match latin_base(c) {
            Some(base) => out.push(base),
            None => out.extend(c.to_lowercase()),
        },
    }
}

/// The ASCII letter that a letter with diacritics decomposes to ("é", "Ș", "ồ"), as SQLite's
/// `fts5_remove_diacritic` table holds it. `None` for every other character.
fn latin_base(c: char) -> Option<char> {
    let mut parts = 0;
    let mut base = None;
    let mut marks_only = true;
    decompose_canonical(c, |part| {
        if parts == 0 {
            base = Some(part);
        } else if !is_sqlite_diacritic(part) {
            marks_only = false;
        }
        parts += 1;
    });
    base.filter(|base| parts > 1 && marks_only && base.is_ascii_alphabetic())
        .map(|base| base.to_ascii_lowercase())
}

/// `sqlite3Fts5UnicodeIsdiacritic`: the combining marks (U+0300 to U+0331) that SQLite's
/// `remove_diacritics` drops. Dakuten, Hangul jamo and other scripts' marks are not among them.
fn is_sqlite_diacritic(c: char) -> bool {
    const LOW: u32 = 0x0802_9fdf;
    const HIGH: u32 = 0x0003_61f8;
    match u32::from(c) {
        code @ 0x300..=0x31f => (LOW >> (code - 0x300)) & 1 == 1,
        code @ 0x320..=0x331 => (HIGH >> (code - 0x320)) & 1 == 1,
        _ => false,
    }
}

/// `foldSearchQuery` in `paletteSearch.ts`: quotes around a pasted query dropped, NFC, folded as
/// [`fold_field`], and whitespace collapsed to single spaces.
pub fn fold_search_query(query: &str) -> String {
    let unquoted: String = query.trim().trim_matches(WRAPPING_QUOTES).nfc().collect();
    fold_field(&unquoted)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `foldInPlace` in `paletteSearch.ts`: each character as [`push_field`] folds it.
pub fn fold_field(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        push_field(c, &mut out);
    }
    out
}

/// Appends `c` as `foldInPlace` folds it: a character of the Basic Multilingual Plane as
/// `foldCharacter` folds it (NFKD, marks dropped, lower case, final sigma and curly apostrophes
/// made plain) when that leaves one UTF-16 unit, else only lower case: "ß", "ﬁ" and a lone mark
/// stay.
fn push_field(c: char, out: &mut String) {
    if c.is_ascii() {
        out.push(c.to_ascii_lowercase());
        return;
    }
    let mut units = 0;
    let mut single = None;
    if u32::from(c) <= 0xffff {
        decompose_compatible(c, |part| {
            if !is_combining_mark(part) {
                for lower in part.to_lowercase() {
                    units += lower.len_utf16();
                    single = Some(lower);
                }
            }
        });
    }
    match single {
        Some('ς') if units == 1 => out.push('σ'),
        Some('\u{2018}' | '\u{2019}') if units == 1 => out.push('\''),
        Some(single) if units == 1 => out.push(single),
        _ => out.extend(c.to_lowercase()),
    }
}

/// Whether every word of a folded query (`fold_search_query`) starts a word in `text`, as
/// `matchSearchFields` matches a field that takes no mid-word hits: "resume" and "res" find
/// "Résumé indexing", "sume" does not. Filler words may be missing when another word is not one.
pub fn field_holds_words(text: &str, query: &str) -> bool {
    let words: Vec<&str> = query.split(' ').filter(|word| !word.is_empty()).collect();
    let filler_optional = words.iter().any(|word| !FILLER_WORDS.contains(word));
    let field = Folded::new(text, push_field);
    !words.is_empty()
        && words.iter().all(|word| {
            field.has_at_word_start(word) || (filler_optional && FILLER_WORDS.contains(word))
        })
}

/// A text folded one character at a time, which still reads the original's word starts.
pub(crate) struct Folded {
    pub(crate) text: String,
    /// For each byte of `text`, the index of the original character it came from.
    origin: Vec<usize>,
    chars: Vec<char>,
}

impl Folded {
    pub(crate) fn new(text: &str, fold: fn(char, &mut String)) -> Self {
        let mut folded = String::with_capacity(text.len());
        let mut origin = Vec::with_capacity(text.len());
        let chars: Vec<char> = text.chars().collect();
        for (index, &c) in chars.iter().enumerate() {
            let before = folded.len();
            fold(c, &mut folded);
            origin.resize(origin.len() + (folded.len() - before), index);
        }
        Self {
            text: folded,
            origin,
            chars,
        }
    }

    /// The original character where `needle` first occurs.
    pub(crate) fn find(&self, needle: &str) -> Option<usize> {
        self.text
            .find(needle)
            .and_then(|byte| self.origin.get(byte).copied())
    }

    /// Whether `token` occurs where a word starts. A token that opens with punctuation (".ts")
    /// brings its own boundary, so it counts anywhere.
    pub(crate) fn has_at_word_start(&self, token: &str) -> bool {
        let own_boundary = token.chars().next().is_some_and(|c| !is_alphanumeric(c));
        let mut from = 0;
        while let Some(at) = self.text.get(from..).and_then(|rest| rest.find(token)) {
            let at = from + at;
            if own_boundary || self.origin.get(at).is_some_and(|&i| self.starts_word(i)) {
                return true;
            }
            from = at
                + self
                    .text
                    .get(at..)
                    .and_then(|rest| rest.chars().next())
                    .map_or(1, char::len_utf8);
        }
        false
    }

    fn starts_word(&self, index: usize) -> bool {
        let at = |i: Option<usize>| i.and_then(|i| self.chars.get(i)).copied();
        self.chars.get(index).is_some_and(|&c| {
            is_word_start(
                at(index.checked_sub(2)),
                at(index.checked_sub(1)),
                c,
                at(Some(index + 1)),
            )
        })
    }
}

/// `isWordStart` in `paletteSearch.ts`: whether `c` starts a word after `previous` and
/// `before_previous` (`None` at the start of the text). A word starts after a character that is
/// no letter or digit, at a camelCase or digit boundary, at the last capital of an acronym
/// ("JSONSchema"), and at every Chinese or Japanese character, but not after an apostrophe
/// inside a word ("Julius’s"). Emoji do not start words here; T3 lets them.
fn is_word_start(
    before_previous: Option<char>,
    previous: Option<char>,
    c: char,
    next: Option<char>,
) -> bool {
    let after_apostrophe =
        matches!(previous, Some('\'' | '\u{2019}')) && before_previous.is_some_and(is_alphanumeric);
    if !is_alphanumeric(c) || after_apostrophe {
        return false;
    }
    let Some(previous) = previous else {
        return true;
    };
    !is_alphanumeric(previous)
        || (previous.is_lowercase() && c.is_uppercase())
        || (previous.is_uppercase() && c.is_uppercase() && next.is_some_and(char::is_lowercase))
        || previous.is_numeric() != c.is_numeric()
        || is_cjk(c)
}

/// `ALPHANUMERIC` in `paletteSearch.ts`: a letter or a digit (`\p{L}`, `\p{N}`), not a mark.
fn is_alphanumeric(c: char) -> bool {
    (c.is_alphabetic() && !is_combining_mark(c)) || c.is_numeric()
}

/// `isCjk`: kana and CJK ideographs, which start a word each.
fn is_cjk(c: char) -> bool {
    matches!(
        u32::from(c),
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff
    )
}

#[cfg(test)]
mod tests {
    use super::{Folded, field_holds_words, fold, fold_field, fold_search_query, push_field};

    #[test]
    fn the_index_folds_latin_diacritics_only_as_sqlite_does() {
        for (text, folded) in [
            ("École fermée à Lyon", "ecole fermee a lyon"),
            ("Le garçon était déjà prêt", "le garcon etait deja pret"),
            ("Școala închisă", "scoala inchisa"),
            ("Hồ Chí Minh", "ho chi minh"),
            ("В логах ОШИБКА", "в логах ошибка"),
            ("e\u{301}cole", "ecole"),
            ("İstanbul", "istanbul"),
            ("gannet\u{2019}s ΟΔΟΣ", "gannet's οδοσ"),
            // Letters that are no base letter with a diacritic stay apart.
            ("Straße ørsted ﬁle 東京", "straße ørsted ﬁle 東京"),
            // Marks that tell other scripts' letters apart stay.
            ("かがく", "かがく"),
            ("か\u{3099}", "か\u{3099}"),
            ("한글", "한글"),
        ] {
            assert_eq!(fold(text), folded, "{text}");
            assert_eq!(fold(folded), folded, "folding is idempotent: {folded}");
        }
    }

    #[test]
    fn titles_fold_as_fold_in_place() {
        for (text, folded) in [
            ("Résumé indexing", "resume indexing"),
            ("Straße ﬁle", "straße ﬁle"),
            ("かがく", "かかく"),
            ("e\u{301}", "e\u{301}"),
            ("ＡＢ", "ab"),
            ("𝐀", "𝐀"),
        ] {
            assert_eq!(fold_field(text), folded, "{text}");
        }
        assert_eq!(fold_search_query("  “Résumé   index”  "), "resume index");
        assert_eq!(
            fold_search_query("\"example/fixture#7483\""),
            "example/fixture#7483"
        );
        assert_eq!(fold_search_query("e\u{301}cole"), "ecole", "NFC first");
    }

    #[test]
    fn words_start_as_t3_starts_them() {
        let starts = |text: &str| -> Vec<usize> {
            let field = Folded::new(text, push_field);
            (0..field.chars.len())
                .filter(|&i| field.starts_word(i))
                .collect()
        };
        assert_eq!(starts("marker fermé"), [0, 7]);
        assert_eq!(starts("JSONSchema t3code"), [0, 4, 11, 12, 13]);
        assert_eq!(starts("Julius’s drafts"), [0, 9]);
        assert_eq!(starts("東京"), [0, 1]);
    }

    #[test]
    fn a_field_holds_the_words_at_word_starts() {
        let title = "#7483 Résumé indexing";
        for query in [
            "resume",
            "res",
            "7483",
            "748",
            "indexing resume",
            "the resume",
        ] {
            assert!(field_holds_words(title, query), "{query}");
        }
        for query in ["sume", "dexing", "7484", "resume draft", "the", ""] {
            assert!(!field_holds_words(title, query), "{query}");
        }
        assert!(field_holds_words("fix parser.ts", ".ts"), "own boundary");
        assert!(field_holds_words("parseJSONSchema", "schema"));
    }
}
