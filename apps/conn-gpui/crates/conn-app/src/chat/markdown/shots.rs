//! Env-gated offscreen renders of the Files panel's Markdown preview
//! (`render_markdown_preview_screenshots`). The fixture is the lab's `README.md`
//! (`filesFixture.ts`).

use std::path::Path;

use conn_theme::Tokens;
use gpui_kit::{
    AppContext as _, Bounds, Context, IntoElement, ParentElement as _, Point, Render, Styled as _,
    Window, WindowBounds, WindowOptions, div, px, size,
};

use super::{MarkdownOptions, render_markdown};
use crate::chat::color::{chat_page, hsla};

const README: &str = "\
# Orders

A small Laravel app that shows an order and its total. It is the example project for the
*Files* walkthrough, so it stays tiny on purpose. Read the [Laravel docs](https://laravel.com/docs)
for anything it leaves out.

## Run it

1. Install the dependencies with `composer install`.
2. Copy `.env.example` to `.env` and set **DB_CONNECTION**.
3. Start the server:

   ```bash
   php artisan migrate --seed
   php artisan serve
   ```

4. Open **/orders/1** to see the order page.

## How totals work

Totals are stored in cents, never as floats. `Order::totalInCents()` adds up the line items:

```php
public function totalInCents(): int
{
    return $this->items->sum(fn (Item $item) => $item->price_cents * $item->quantity);
}
```

> **Note:** the view formats cents with `Number::currency()`. Don't divide by 100 in Blade,
> or rounding drifts on large orders.

### What an order holds

- A customer, with a name and an email address
- One or more line items
  - Each item has a price in cents and a quantity
  - Discounts are items with a negative price
- A status: ~~draft~~ or *placed*

| Column | Type | Notes |
| --- | --- | --- |
| `number` | integer | Shown to customers |
| `customer_id` | foreign key | Links to `customers` |
| `total_cents` | integer | Cached sum of the items |

## To do

- [x] Show the order total
- [x] Store prices in cents
- [ ] Email a receipt when an order is placed
- [ ] Support refunds

---

Questions? Ask in the thread, or see `app/Models/Order.php`.
";

const CODE_CLOSE_UP: &str = "\
```php
// Cents, never floats.
public function totalInCents(): int
{
    return $this->items->sum(fn (Item $item) => $item->price_cents * $item->quantity);
}
```

```rust
fn main() {
    let total: u32 = 4599; // cents
    println!(\"{}\", \"order\");
}
```
";

const TABLE_CLOSE_UP: &str = "\
| Column | Type | Notes |
| --- | --- | --- |
| `number` | integer | Shown to customers |
| `customer_id` | foreign key | Links to `customers` |
| `total_cents` | integer | Cached sum of the items |
";

/// The preview on the panel's background, padded as the Files panel pads it (16 by 12).
struct Probe {
    markdown: &'static str,
    tokens: Tokens,
}

impl Render for Probe {
    fn render(&mut self, _: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(hsla(chat_page(&self.tokens)))
            .text_color(hsla(self.tokens.foreground))
            .px(px(16.0))
            .py(px(12.0))
            .child(render_markdown(
                "shot",
                self.markdown,
                &self.tokens,
                &MarkdownOptions::files_preview(),
            ))
    }
}

/// Renders the preview offscreen to PNG in Dark Ocean and Light. It opens no window on screen and
/// takes no focus: GPUI's headless renderer draws into a texture.
///
/// `CONN_MD_SHOTS_DIR=<dir> cargo test -p conn-app render_markdown_preview_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_MD_SHOTS_DIR"]
fn render_markdown_preview_screenshots() {
    use gpui_kit::test::TestWindowExt as _;

    let Some(dir) = std::env::var_os("CONN_MD_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let full_height: f32 = std::env::var("CONN_MD_SHOTS_HEIGHT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1250.0);
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    let shots: [(&str, &'static str, f32, f32); 3] = [
        ("page", README, 640.0, full_height),
        ("code", CODE_CLOSE_UP, 640.0, 340.0),
        ("table", TABLE_CLOSE_UP, 640.0, 150.0),
    ];
    for (theme_id, label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
        let tokens = Tokens::derive(&theme);
        for (name, markdown, width, height) in shots {
            let probe_tokens = tokens.clone();
            let (window, _view) = ctx.update(|cx| {
                gpui_kit::init(cx);
                crate::fonts::register(cx);
                crate::theme::apply_kit_theme(&tokens, cx);
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Point::default(),
                            size(px(width), px(height)),
                        ))),
                        focus: false,
                        show: false,
                        ..Default::default()
                    },
                    cx,
                    |_, cx| {
                        cx.new(|_| Probe {
                            markdown,
                            tokens: probe_tokens,
                        })
                    },
                )
                .expect("a window")
            });
            for _ in 0..4 {
                ctx.update_window(window, |_, w, c| w.render_frame(c))
                    .expect("a frame");
                ctx.run_until_parked();
            }
            let image = ctx.capture_screenshot(window).expect("a screenshot");
            image
                .save(dir.join(format!("{name}-{label}.png")))
                .expect("a saved PNG");
        }
    }
}
