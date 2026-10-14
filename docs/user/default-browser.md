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

An agent can use its thread's desktop tabs as soon as they open, including when the desktop connects to another trusted environment. Ask the agent to navigate, inspect text, click, or type. Stop the thread to stop the agent. Other browser tools and screenshots are not supported on desktop tabs yet.

Open tabs stay on your desktop when an environment disconnects or restarts. Agent tools can use the same tabs again after reconnecting. Requests interrupted by the disconnect fail and are not replayed.
