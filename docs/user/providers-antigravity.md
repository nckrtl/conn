# Antigravity

T3 Code runs Google's official Antigravity ACP agent on your selected environment.
Orbit installs and updates the Antigravity CLI; T3 Code finds it on the environment's `PATH`
and manages sign-in, separate from your terminal or IDE. Google controls
which models and account access are available through this agent.

## Set up Antigravity

On web or desktop, open **Settings > Providers**, choose the environment that runs
your project, and enable Antigravity. Choose **Sign in** and complete the browser
sign-in. Wait for T3 Code to confirm account access and load models before
starting a thread. You can also sign in from **Settings > Providers** in the
mobile app.

If Antigravity is not on the environment's `PATH`, Orbit has not installed it
there yet. Setup requires permission to operate the environment.

### Sign in from a remote device

Google finishes on an Antigravity page that shows a code. Paste that code, or the
page's full address, into the code field in the client where you started sign-in.
This works the same from any device.

The code is temporary. Paste it only into the setup field. The page alone does not
confirm account access; wait for T3 Code's confirmation.

### Other sign-in methods

Choose **Sign-in method** in the Antigravity provider settings:

| Method                     | Credentials                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Google account             | Personal Google sign-in in the browser                                                       |
| Gemini Enterprise          | Browser sign-in, GCP project, and GCP location                                               |
| Gemini API key             | API key; choose Connect without a browser                                                    |
| Agent Platform / Vertex AI | API key, or GCP project and location with Application Default Credentials on the environment |

The environment stores the Antigravity API key outside its settings file, and
clients only see whether one is saved. The agent uses the method and credentials selected for this instance;
ambient `GEMINI_API_KEY` and Google credential variables do not override them.
Changing the method stops the instance's sessions. Sign out before replacing an
account.

## The Antigravity CLI

Orbit installs and updates the Antigravity CLI on each environment. T3 Code shows
its version in provider settings and never installs, updates, or removes it.
To use another executable, set **Binary path**; leave it blank to use `agy` on
`PATH`.

T3 needs Antigravity 1.5 or newer and recommends 1.5.12 or newer. Sessions do not
start on an older runtime: Orbit updates `agy` on the environment, or update the
executable a custom binary path points at. You may need to sign in again after
updating from a runtime older than 1.5. Threads already running finish with their
original runtime; new sessions use the updated release.

## Models and threads

The model list comes from your Antigravity account, including Claude and GPT models
when your plan has them. Pick a thinking level beside the model list in the model picker; it
shows only the levels the selected model supports. A resumed thread keeps its
selected model. If access to that model ends, select another available model
before continuing.

Antigravity creates empty `.gemini/skills` and `.agents/skills` folders in the
workspace when a session starts. Git does not track empty folders, so they never
appear in commits.

Use Antigravity's native `/plan` command for planning. Tool approvals follow [Permission modes](./permission-modes.md).
Questions with fixed choices still need one of the offered answers, even in
**Full access**.

On web and desktop, [Edit from here](./composer.md#edit-an-earlier-prompt) works with
Antigravity. Antigravity cannot rewind its own conversation, so the next turn
starts a fresh Antigravity session and T3 Code sends it the kept conversation,
without the turns you removed.

Use `/compact` to summarize a long conversation when your Antigravity runtime
offers that command. If it is unavailable, update Antigravity in provider settings
or send `/clear` when you need a fresh context.

### Skills and attachments

Put project skills in `.agents/skills`. T3 Code also reads `.gemini/skills` and the
legacy `.agent/skills` directory. Among these project locations, the first copy
wins in this order: `.gemini/skills`, `.agents/skills`, `.agent/skills`. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

Skills for every project go in `~/.gemini/config/skills` or
`~/.gemini/antigravity-cli/skills`. Antigravity does not read `~/.agents/skills`
on its own; to share a folder like that one, list it in `~/.gemini/config/skills.json`
(or a project's `.agents/skills.json`), and T3 Code shows the skills it declares,
honoring `inherits`, `include_only`, and `exclude`.

Antigravity receives images and audio directly, and reads PDFs and text files as
documents. Other attachments, including videos, are passed as a saved file path for
the agent to inspect with its tools.

### Subagents

Antigravity groups subagent activity into batches. Open a batch and select
**Subagent work** (**Work** on mobile) to read each child's role, prompt, and recent steps. This view
is read only: you cannot message or control individual subagents, and an idle
batch does not confirm that every child succeeded. If Antigravity did not record
which children a batch started, the view says so. See
[agent work](./thread-sidebar.md#inspect-agent-work) for where to inspect
activity.

## Accounts and removal

Add an Antigravity provider instance for each Google account in
**Settings > Providers** on web or desktop. Each has its own sign-in; the CLI is
shared on the environment.

| Action   | Effect                                                            |
| -------- | ----------------------------------------------------------------- |
| Disable  | Stops the instance's sessions and keeps its Google sign-in.       |
| Sign out | Stops the instance's sessions and removes its saved Google login. |

Both keep thread history and workspace files. Sending `/logout` by itself in
a thread signs out its instance, including stopping that instance's other sessions.
That needs a client allowed to manage providers, and it has to be your own message:
`/logout` from an agent or a scheduled task is refused.
Sign out, then sign in again to replace an account.

## Run a native goal

When your Antigravity runtime offers `/goal`, send `/goal` followed by a verifiable
objective. Antigravity keeps working until it completes the goal or you cancel it.

Use Stop to interrupt a running goal, then ask Antigravity to stop pursuing it
before starting more work. Ordinary follow-ups wait until the running turn ends.
T3 does not support Antigravity goal status, pause, resume, or clear commands.

## Check access and troubleshoot

Open **Usage > Limits** to see the remaining Gemini and shared Claude/GPT allowances
for Google sign-ins. Each group has separate five-hour and weekly limits and reset
times. Limits refresh with provider status and include usage outside T3 Code.

A server restart keeps your Google sign-in. The provider shows the saved account
until a session, a refresh, or a sign-out reports something new.

To check access and reload models, use **Refresh provider status** in web or desktop
provider settings, or **Refresh models** in mobile thread settings. If asked to
sign in again, use provider settings on web or desktop, or **Settings > Providers** on mobile.

If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a usage limit,
follow the provider's message and any retry time. See [Google's account plans][plans]
for eligibility.

[plans]: https://antigravity.google/docs/plans
