# Conn desktop design lab

Run `vp run lab:gpui` from the repository root and open http://127.0.0.1:5800/.
The mock in `src/mock` renders the GPUI shell with local thread and task fixtures.
Its dark palette and 16px icons come from the native client. Composer messages
stay in the page and never start an agent run.

The default is the conversation with the right panel closed. Use `?panel=tasks`,
`?panel=files`, `?panel=pull-requests`, `?panel=database`, `?panel=mcp`, or `?panel=api` to open a panel. Use `?theme=light` for the light appearance. Select a
thread to update the link, or pass its fixture ID in `?thread=`.

## Panel references

- [Files walkthrough](http://127.0.0.1:5800/?thread=files-walkthrough&panel=files&file=app/Http/Controllers/OrderController.php&start=16&end=20). Command-click a PHP symbol or Laravel view, or focus it and press Enter. Select lines in the gutter with Shift, then choose Add selection. The source link in chat reveals the Blade template.
- [Pull requests](http://127.0.0.1:5800/?panel=pull-requests) and [PR #1931 changed files](http://127.0.0.1:5800/?panel=pull-requests&item=nckrtl%2Fconn%231931&section=code).
- [Thread details](http://127.0.0.1:5800/?thread=stalled-threads&details=1) and [task #476 subtasks](http://127.0.0.1:5800/?thread=stalled-threads&panel=tasks&item=476&section=subtasks).

- [Tasks overview](http://127.0.0.1:5800/?panel=tasks). Open a statistic for its history or use board settings to change the period.
- [Database](http://127.0.0.1:5800/?panel=database). Browse tables and run read-only SQL against the local fixture.
- [MCP inspector](http://127.0.0.1:5800/?panel=mcp). Call a fixture tool, read a resource, or get a prompt and inspect the protocol log.
- [API client](http://127.0.0.1:5800/?panel=api). Send a saved fixture request and inspect its response headers and Laravel Toolbar data.

To compare a screen against the full Conn web app, run
`PORT=5802 vp run --filter @t3tools/lab-gpui dev:web-reference` from the root.
