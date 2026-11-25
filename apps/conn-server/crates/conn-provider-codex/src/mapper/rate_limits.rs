//! Codex sometimes supplies its allowance reset only in the error text, in the
//! app-server's local time zone and rounded down to the minute.
use jiff::{
    Timestamp,
    civil::{Date, Time},
    tz::TimeZone,
};

pub(super) fn message_reset(message: &str, failed: &str, zone: Option<&str>) -> Option<String> {
    let marker = ["Try again at ", "try again at "]
        .into_iter()
        .find_map(|p| message.split_once(p).map(|(_, rest)| rest))?;
    let (when, _) = marker.split_once('.')?;
    let words: Vec<_> = when.split_whitespace().collect();
    let failed: Timestamp = failed.parse().ok()?;
    let zone = zone
        .and_then(|s| TimeZone::get(s.trim_start_matches(':')).ok())
        .unwrap_or_else(TimeZone::system);
    let (date, clock, period) = match words.as_slice() {
        [clock, period] => (failed.to_zoned(zone.clone()).date(), *clock, *period),
        [month, day, year, clock, period] => {
            let month = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ]
            .iter()
            .position(|m| m == month)?
                + 1;
            let day = day.strip_suffix(',')?;
            let day = ["st", "nd", "rd", "th"]
                .into_iter()
                .find_map(|suffix| day.strip_suffix(suffix))?;
            (
                Date::new(
                    year.parse().ok()?,
                    i8::try_from(month).ok()?,
                    day.parse().ok()?,
                )
                .ok()?,
                *clock,
                *period,
            )
        }
        _ => return None,
    };
    let (hour, minute) = clock.split_once(':')?;
    let hour: i8 = hour.parse().ok()?;
    if !(1..=12).contains(&hour) || minute.len() != 2 {
        return None;
    }
    let hour = hour % 12
        + match period {
            "PM" => 12,
            "AM" => 0,
            _ => return None,
        };
    let local = date.to_datetime(Time::new(hour, minute.parse().ok()?, 0, 0).ok()?);
    let timestamp = zone
        .to_ambiguous_timestamp(local)
        .later()
        .ok()?
        .checked_add(std::time::Duration::from_secs(60))
        .ok()?;
    (timestamp > failed)
        .then(|| {
            u64::try_from(timestamp.as_millisecond())
                .ok()
                .map(conn_provider_support::ids::iso_from_ms)
        })
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::message_reset;

    #[test]
    fn reads_codexs_local_clock_and_dated_reset_without_guessing_a_past_time() {
        let failed = "2026-11-01T04:00:00.000Z";
        assert_eq!(
            message_reset("Try again at 1:15 AM.", failed, Some("America/New_York")).as_deref(),
            Some("2026-11-01T06:16:00.000Z")
        );
        assert_eq!(
            message_reset("try again at Nov 11th, 2026 3:37 PM.", failed, Some("UTC")).as_deref(),
            Some("2026-11-11T15:38:00.000Z")
        );
        assert!(message_reset("Try again at 2:00 AM.", failed, Some("UTC")).is_none());
    }
}
