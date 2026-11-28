//! The Laravel debug bar's logic (php-data-bridge, nckrtl/laravel-toolbar), GPUI-free: Conn's
//! `apps/web/src/laravelToolbar/*` ported to Rust. `headers` decodes toolbar headers and API
//! receipts, `model` maps the payload to what the bar and panels show, `store` keeps each tab's
//! request history, `feed` orders the sources of a browser tab's data, and the UI that draws it
//! lives in `conn-app`'s `panels/laravel_toolbar`.
#![forbid(unsafe_code)]

pub mod feed;
pub mod headers;
pub mod layout;
pub mod model;
pub mod orbit;
pub mod sql;
pub mod store;
