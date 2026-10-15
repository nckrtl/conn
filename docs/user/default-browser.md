# Use T3 Code as your default browser

On macOS, the desktop app can be your default web browser. Links you open from other apps then
open in T3 Code. When the thread on screen shows its browser panel, the link opens there as a new
tab. Otherwise it starts a new thread without a project, with the browser panel maximized on the
page, so you can ask an agent about it right away.

Choose **T3 Code** under **System Settings → Desktop & Dock → Default web browser**. To go back,
choose another browser there.

HTML files you open from Finder open the same way. [Prompt links](prompt-links.md) to
app.t3.codes open in the app as a draft.

A link that launches T3 Code waits until the app has connected to its environment, then opens.

## Use desktop tabs with an agent

An agent can use its thread's desktop tabs as soon as they open, including when the desktop connects to another trusted environment. Ask the agent to inspect text or screenshots, navigate, fill forms, upload files from the tab host, and use the other browser actions. Desktop recording is not supported. Stop the thread to stop the agent.

Open tabs stay on your desktop when an environment disconnects or restarts. Agent tools can use the same tabs again after reconnecting. Requests interrupted by the disconnect fail and are not replayed.

For a project’s Playwright script, ask the agent for `preview_cdp_endpoint` and connect with `chromium.connectOverCDP(endpoint)`. Each request creates a fresh temporary endpoint for that thread’s selected desktop tab. It closes when you stop the thread, close the tab, or disconnect its desktop host. The endpoint is local to the machine hosting the tab: a thread on a local headless server on the same Mac can drive that Mac's desktop tabs, but a script on another machine cannot connect. Server tabs do not offer this endpoint.

Personal Vault logins stay private: after a Vault fill, agent scripts and new CDP endpoints are blocked for that document, screenshots are withheld, and existing endpoints close before the value is inserted. Agents can still use Conn’s built-in test logins.
