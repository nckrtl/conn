//! The composer grammar for a skill mention. A currency sign prefixes the native skill name.

/// Unicode general category Sc (currency symbols), Unicode 17 as in Node 26's `\p{Sc}`.
pub fn is_currency(c: char) -> bool {
    const RANGES: [(u32, u32); 21] = [
        (0x24, 0x24),
        (0xA2, 0xA5),
        (0x58F, 0x58F),
        (0x60B, 0x60B),
        (0x7FE, 0x7FF),
        (0x9F2, 0x9F3),
        (0x9FB, 0x9FB),
        (0xAF1, 0xAF1),
        (0xBF9, 0xBF9),
        (0xE3F, 0xE3F),
        (0x17DB, 0x17DB),
        (0x20A0, 0x20C1),
        (0xA838, 0xA838),
        (0xFDFC, 0xFDFC),
        (0xFE69, 0xFE69),
        (0xFF04, 0xFF04),
        (0xFFE0, 0xFFE1),
        (0xFFE5, 0xFFE6),
        (0x11FDD, 0x11FE0),
        (0x1E2FF, 0x1E2FF),
        (0x1ECB0, 0x1ECB0),
    ];
    let point = u32::from(c);
    RANGES
        .iter()
        .any(|&(low, high)| (low..=high).contains(&point))
}

pub fn is_skill_name(name: &str) -> bool {
    let valid = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
        && name.chars().any(|c| c.is_ascii_alphabetic());
    valid && !is_amount(name)
}

/// `[0-9][0-9_]*` with an optional `k`/`m`/`b`/`t` or `e<digits>` suffix.
fn is_amount(name: &str) -> bool {
    let digits = name.trim_start_matches(|c: char| c.is_ascii_digit() || c == '_');
    if !name.starts_with(|c: char| c.is_ascii_digit()) {
        return false;
    }
    digits.is_empty()
        || matches!(digits, "k" | "K" | "m" | "M" | "b" | "B" | "t" | "T")
        || (digits.len() > 1
            && digits.starts_with(['e', 'E'])
            && digits[1..].chars().all(|c| c.is_ascii_digit()))
}
