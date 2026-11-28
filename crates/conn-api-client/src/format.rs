//! Compact human-readable number, duration, and byte-size formatters matching Conn's
//! `formatCount`, `formatMs`, and `formatBytes`.

/// Rounds half away from zero on the exact value, as `toFixed` and `Intl.NumberFormat` do,
/// and writes `digits` decimals.
fn fixed(value: f64, digits: usize) -> String {
    let scale = 10f64.powi(i32::try_from(digits).unwrap_or(0));
    let scaled = value * scale;
    // A true tie (exactly representable): Rust's formatting would round it to even.
    if scaled.fract().abs() == 0.5 && scaled / scale == value {
        return format!("{:.digits$}", scaled.round() / scale);
    }
    format!("{value:.digits$}")
}

/// `Intl.NumberFormat("en-US")` with fixed decimals: grouped thousands.
fn format_number(value: f64, digits: usize) -> String {
    let text = fixed(value, digits);
    let (sign, unsigned) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text.as_str()),
    };
    let (whole, fraction) = match unsigned.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (unsigned, None),
    };
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (index, ch) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    // Intl writes no sign for a value that rounds to zero.
    let sign = if grouped.chars().all(|c| c == '0')
        && fraction.is_none_or(|f| f.chars().all(|c| c == '0'))
    {
        ""
    } else {
        sign
    };
    match fraction {
        Some(fraction) => format!("{sign}{grouped}.{fraction}"),
        None => format!("{sign}{grouped}"),
    }
}

/// `12,345`.
pub fn format_count(value: f64) -> String {
    format_number(value, 0)
}

/// Three significant digits up to a minute, as `4.27 ms`, `245 ms` or `30.2 s`.
pub fn format_ms(value: f64) -> String {
    if value < 10.0 {
        return format!("{} ms", format_number(value, 2));
    }
    if value < 100.0 {
        return format!("{} ms", format_number(value, 1));
    }
    if value < 999.5 {
        return format!("{} ms", format_number(value, 0));
    }
    let seconds = value / 1000.0;
    if seconds < 9.995 {
        return format!("{} s", format_number(seconds, 2));
    }
    if seconds < 59.95 {
        return format!("{} s", format_number(seconds, 1));
    }
    // Math.round: half up.
    let rounded = (seconds + 0.5).floor();
    let minutes = (rounded / 60.0).floor();
    let rest = rounded % 60.0;
    if minutes < 60.0 && rest > 0.0 {
        format!("{minutes} min {rest} s")
    } else {
        format!("{} min", format_count(minutes))
    }
}

/// `512 B`, `9.97 KB`, `1.50 MB`, `-13.83 KB`.
pub fn format_bytes(value: i64) -> String {
    let size = value.unsigned_abs();
    let sign = if value < 0 { "-" } else { "" };
    const KB: u64 = 1024;
    #[expect(
        clippy::cast_precision_loss,
        reason = "byte counts far below 2^53; JavaScript numbers are f64 too"
    )]
    let size_f = size as f64;
    if size >= KB.pow(3) {
        format!("{sign}{} GB", fixed(size_f / (KB.pow(3) as f64), 2))
    } else if size >= KB.pow(2) {
        format!("{sign}{} MB", fixed(size_f / 1024.0 / 1024.0, 2))
    } else if size >= KB {
        format!("{sign}{} KB", fixed(size_f / 1024.0, 2))
    } else {
        format!("{sign}{size} B")
    }
}
