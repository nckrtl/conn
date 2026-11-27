//! One spacing system for the thread timeline (Nick, 2026-11-27).
//!
//! Each timeline block draws with no outer padding. It says where its first and last painted
//! pixel sit inside its own layout ([`Lead`] and [`Tail`]): the half-leading above a text line,
//! the space under a baseline, a hover actions row that keeps its place. The space between two
//! blocks is then one rule for the pair ([`gap`]) less those insets, and the block above carries
//! it as its bottom padding ([`space_between`]).
//!
//! Gaps are visible gaps, as Nick sees them at rest: from the last painted pixel of one block
//! (a baseline, a divider, a card's edge) to the first painted pixel of the next (a cap top, a row
//! icon, a card's edge). A hover actions row is invisible at rest, so the space it keeps is part
//! of the gap, and a gap never shrinks it.
//!
//! - [`BLOCK_GAP_PX`] between any two blocks: paragraphs, cards, folds, notices, tool groups.
//! - [`DIVIDER_GAP_PX`] on both sides of a "Worked for" or "Working for" divider, whatever
//!   follows it.
//! - [`USER_GAP_PX`] above and below a user message, [`GROUPED_USER_GAP_PX`] between two in a row.
//! - [`ROW_GAP_PX`] between rows of one list: tool rows in a group, stacked warnings.
//! - [`END_GAP_PX`] from the last block to the composer.

use conn_state::{NoticeLevel, TimelineEntry};

use super::cache::{CachedRow, VirtualItem};
use super::card_face::{CARD_HEADER_HEIGHT_PX, CARD_ICON_PX, CARD_INSET_PX};

/// The visible gap between two top-level blocks. It fits the hover actions row under a turn's
/// last paragraph, so that row never pushes the next block further away.
pub(super) const BLOCK_GAP_PX: f32 = 40.0;
/// The visible gap on each side of a "Worked for" or "Working for" divider: from the label's
/// baseline down to the line, and from the line down to what follows (Nick's "Working for",
/// divider, tool row reference).
pub(super) const DIVIDER_GAP_PX: f32 = 8.0 + BODY_INK_BOTTOM_PX;
/// The visible gap above and below a user message (#449).
pub(super) const USER_GAP_PX: f32 = 48.0;
/// The gap between messages the user sent in a row, which read as one group.
pub(super) const GROUPED_USER_GAP_PX: f32 = 4.0;
/// The visible gap between stacked warnings, which list as 24px work rows with no space between.
pub(super) const ROW_GAP_PX: f32 = 2.0 * ALERT_ROW_INK_PX;
/// From the bottom of the last block's layout to the composer card (#448). A message's actions
/// row is part of its block here: it shows on hover, so it keeps the whole gap.
pub(super) const END_GAP_PX: f32 = 28.0;
/// The space above the first block.
pub(super) const START_GAP_PX: f32 = 16.0;

/// Where a body text line (`14px` / `22.75px`) paints inside its line box: the cap top under the
/// box top, and the box bottom under the baseline.
pub(super) const BODY_INK_TOP_PX: f32 = 6.0;
pub(super) const BODY_INK_BOTTOM_PX: f32 = 5.5;
/// Where a 24px work-log row paints: its icon, centred in the row, and its label both start
/// about 6px under the top and end about 6px over the bottom.
pub(super) const WORK_ROW_INK_TOP_PX: f32 = 6.0;
pub(super) const WORK_ROW_INK_BOTTOM_PX: f32 = 6.0;
/// A work row whose icon fills more of its 16px box paints closer to the row's edges: the
/// warning and error circle, and the background command's terminal, which sits low.
pub(super) const ALERT_ROW_INK_PX: f32 = 5.0;
pub(super) const TERMINAL_ROW_INK_BOTTOM_PX: f32 = 4.0;
/// A plain card in light has a frame the colour of the page, so it shows from its header's icon
/// down to the bottom of its white body.
pub(super) const PLAIN_LIGHT_CARD_INK_TOP_PX: f32 =
    CARD_INSET_PX + (CARD_HEADER_HEIGHT_PX - CARD_ICON_PX) / 2.0 + 1.0;
pub(super) const PLAIN_LIGHT_CARD_INK_BOTTOM_PX: f32 = CARD_INSET_PX;

/// How a block takes part in the gap rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Role {
    Block,
    /// A message the user sent.
    User,
    /// A warning row, which stacks with the next warning as a list.
    Warning,
}

/// What a block shows the block above it: its role, and the space over its first painted pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Lead {
    pub(super) role: Role,
    pub(super) top: f32,
}

/// What a block shows the block below it: its role, the space under its last painted pixel, and
/// whether that pixel is a divider.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Tail {
    pub(super) role: Role,
    pub(super) bottom: f32,
    pub(super) divider: bool,
}

impl Tail {
    pub(super) const fn block(bottom: f32) -> Self {
        Self {
            role: Role::Block,
            bottom,
            divider: false,
        }
    }

    pub(super) const fn divider() -> Self {
        Self {
            role: Role::Block,
            bottom: 0.0,
            divider: true,
        }
    }
}

/// The visible gap between a block that ends with `tail` and the next that starts with `lead`.
pub(super) fn gap(tail: Tail, lead: Lead) -> f32 {
    match (tail.role, lead.role) {
        (Role::User, Role::User) => GROUPED_USER_GAP_PX,
        (Role::User, _) | (_, Role::User) => USER_GAP_PX,
        (Role::Warning, Role::Warning) => ROW_GAP_PX,
        _ if tail.divider => DIVIDER_GAP_PX,
        _ => BLOCK_GAP_PX,
    }
}

/// The padding between two blocks' layouts that makes their visible gap [`gap`].
pub(super) fn space_between(tail: Tail, lead: Lead) -> f32 {
    (gap(tail, lead) - tail.bottom - lead.top).max(0.0)
}

/// What `item` shows the block above it, in a `light` or dark theme. `None` for a row that draws
/// nothing (a pending approval lives in the request stack), which the gap rules skip.
pub(super) fn lead(item: &VirtualItem, rows: &[CachedRow], light: bool) -> Option<Lead> {
    let block = |top| Lead {
        role: Role::Block,
        top,
    };
    Some(match item {
        VirtualItem::Approval { .. } => return None,
        VirtualItem::LoadEarlier { .. }
        | VirtualItem::ChangedFiles { .. }
        | VirtualItem::WorktreeSetup { .. } => block(0.0),
        VirtualItem::User { row_idx, .. } => match &rows[*row_idx].entry {
            TimelineEntry::User {
                created_by_agent: true,
                ..
            } => block(0.0),
            _ => Lead {
                role: Role::User,
                top: 0.0,
            },
        },
        // A paragraph, the "Worked for" and the "Working for" labels start on a body text line.
        VirtualItem::Assistant { .. }
        | VirtualItem::Working
        | VirtualItem::WorkGroup {
            has_active: false, ..
        } => block(BODY_INK_TOP_PX),
        VirtualItem::WorkGroup {
            has_active: true, ..
        } => block(WORK_ROW_INK_TOP_PX),
        VirtualItem::Card { row_idx } => block(card_ink(&rows[*row_idx].entry, light).0),
        VirtualItem::Notice { row_idx } => match notice_level(&rows[*row_idx].entry) {
            NoticeLevel::Warning => Lead {
                role: Role::Warning,
                top: ALERT_ROW_INK_PX,
            },
            level if level.is_error() => block(ALERT_ROW_INK_PX),
            // The divider pill starts on its border.
            _ => block(0.0),
        },
    })
}

/// The space between a card item's layout edges and its ink, above and below: a bordered card
/// paints to its edges, and an item drawn as one work-log row (icon and label) does not.
pub(super) fn card_ink(entry: &TimelineEntry, light: bool) -> (f32, f32) {
    match entry {
        TimelineEntry::BackgroundCommand { .. } => {
            (WORK_ROW_INK_TOP_PX, TERMINAL_ROW_INK_BOTTOM_PX)
        }
        TimelineEntry::UserInputRequest { .. } | TimelineEntry::SecretRequest { .. } => {
            (WORK_ROW_INK_TOP_PX, WORK_ROW_INK_BOTTOM_PX)
        }
        TimelineEntry::ProposedPlan { .. } | TimelineEntry::EmbeddedDocument { .. } if light => {
            (PLAIN_LIGHT_CARD_INK_TOP_PX, PLAIN_LIGHT_CARD_INK_BOTTOM_PX)
        }
        _ => (0.0, 0.0),
    }
}

pub(super) fn notice_level(entry: &TimelineEntry) -> NoticeLevel {
    match entry {
        TimelineEntry::Notice { level, .. } => *level,
        _ => NoticeLevel::Info,
    }
}

/// The next item after `index` that draws something.
pub(super) fn next_lead(
    items: &[VirtualItem],
    index: usize,
    rows: &[CachedRow],
    light: bool,
) -> Option<Lead> {
    items
        .get(index + 1..)?
        .iter()
        .find_map(|item| lead(item, rows, light))
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn user_lead() -> Lead {
        Lead {
            role: Role::User,
            top: 0.0,
        }
    }

    #[test]
    fn the_rules_pick_one_gap_per_pair() {
        let text = Lead {
            role: Role::Block,
            top: BODY_INK_TOP_PX,
        };
        let user_tail = Tail {
            role: Role::User,
            bottom: 0.0,
            divider: false,
        };
        assert_eq!(gap(Tail::block(0.0), text), BLOCK_GAP_PX);
        assert_eq!(gap(Tail::divider(), text), DIVIDER_GAP_PX);
        assert_eq!(gap(Tail::divider(), user_lead()), USER_GAP_PX);
        assert_eq!(gap(user_tail, text), USER_GAP_PX);
        assert_eq!(gap(user_tail, user_lead()), GROUPED_USER_GAP_PX);
    }

    #[test]
    fn a_hover_row_fits_in_the_block_gap() {
        // The tallest tail with a reserved row, over the tallest lead, still fits the gap.
        let tail = Tail::block(BODY_INK_BOTTOM_PX + super::super::ASSISTANT_META_HEIGHT_PX);
        let lead = Lead {
            role: Role::Block,
            top: BODY_INK_TOP_PX,
        };
        assert!(tail.bottom + lead.top <= BLOCK_GAP_PX);
        assert!(space_between(tail, lead) >= 0.0);
    }
}
