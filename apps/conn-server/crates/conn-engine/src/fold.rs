//! Case and accent folding for message search, as `foldCharacter` in `paletteSearch.ts`:
//! "ecole" finds "École", and "éc" finds "Éc". The search index stores folded text, so a
//! query folded the same way matches it in SQL.

use unicode_normalization::char::{decompose_compatible, is_combining_mark};

/// `text` folded one character at a time.
pub(crate) fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        push_folded(c, &mut out);
    }
    out
}

/// Appends `c` folded: compatibility decomposition, marks dropped, lower case, final sigma and
/// curly apostrophes made plain. A character that decomposes to more than one character only
/// changes case (`ß`, `ﬁ`), as T3 keeps it. A lone mark (decomposed input) folds to nothing.
pub(crate) fn push_folded(c: char, out: &mut String) {
    if c.is_ascii() {
        out.push(c.to_ascii_lowercase());
        return;
    }
    let mut base = None;
    let mut count = 0;
    decompose_compatible(c, |part| {
        if !is_combining_mark(part) {
            count += 1;
            base = Some(part);
        }
    });
    let Some(base) = base else {
        return;
    };
    if count > 1 {
        out.extend(c.to_lowercase());
        return;
    }
    let mut lower = base.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some('ς'), None) => out.push('σ'),
        (Some('\u{2018}' | '\u{2019}'), None) => out.push('\''),
        (Some(single), None) => out.push(single),
        _ => out.extend(c.to_lowercase()),
    }
}

#[cfg(test)]
mod tests {
    use super::fold;

    #[test]
    fn folds_case_and_accents_like_t3() {
        for (text, folded) in [
            ("École fermée à Lyon", "ecole fermee a lyon"),
            ("Școala închisă", "scoala inchisa"),
            ("Hồ Chí Minh", "ho chi minh"),
            ("В логах ОШИБКА", "в логах ошибка"),
            ("e\u{301}cole", "ecole"),
            ("İstanbul", "istanbul"),
            ("gannet\u{2019}s ΟΔΟΣ", "gannet's οδοσ"),
            ("Straße ﬁle 東京", "straße ﬁle 東京"),
        ] {
            assert_eq!(fold(text), folded, "{text}");
            assert_eq!(fold(folded), folded, "folding is idempotent: {folded}");
        }
    }
}
