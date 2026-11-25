# Tab Desk

A Chrome extension page for people who keep many tab groups open. It replaces squinting at the tab strip with:

- **Dashboard.** Every open tab group on one page as a grid of cards, so you can keep track of several projects at once. Each card shows the group's color on its edge, its name, tab count and sites, and its tabs with favicon and title (the first 8, then *+ N more*). Click a tab to switch to it, click the group name for its detail page, *Switch* to switch to the group, and *⋯* for Save & close, color, sort, collapse, ungroup and close. With AI summaries on, the sparkle button on a card summarizes the group right in the card (and each tab row can summarize its tab); a summary made on the group's detail page shows on its card too. Ungrouped tabs get an Inbox card. Cards sit in 3 columns on a wide screen, 2 on a medium one and 1 on a narrow one. Tab Desk always opens on the dashboard. `Alt+0` shows it from anywhere on the page.
- **Group sidebar.** Every open tab group with its color and tab count, plus an **Inbox** of ungrouped tabs.
  - Drag a group up or down to reorder it. The real tab groups move in Chrome's tab strip too (across windows as well). With a group focused, `Alt+↑` / `Alt+↓` does the same from the keyboard.
  - Click the chevron next to a group to list its tabs under it. Click a tab there to switch to it.
  - Drag the sidebar's right edge to make it wider or narrower (200 to 560 px) so long names fit. Double-click the edge to reset it. With the edge focused, the arrow keys resize it. The width is remembered.
- **Group detail.** The selected group's tabs with favicon, title, URL and badges (Active, Playing, Duplicate, Sleeping, Pinned). Rename, recolor, sort by site, collapse, ungroup, move or close tabs, alone or several at once.
- **Switch to group.** Expands the group, collapses the other groups in that window and opens its most recent tab.
- **Workspaces.** *Save & close* stores a group (name, color, URLs) and closes its tabs. *Restore* reopens it as a group later.
- **Command palette.** `Ctrl+K` (`⌘K` on Mac) on the Tab Desk page searches tabs, groups and workspaces:
  - `Enter` switches to a tab, shows a group, or restores a workspace
  - `Shift+Enter` on a group switches to it
  - `Ctrl+Backspace` closes a tab, or saves and closes a group
  - `Ctrl+M` moves a tab to another group, or to a new one if you type a name
  - type `>` to list commands (close duplicates, group Inbox by site, sleep other tabs)
- **Cleanup.** A duplicate-tab cleaner, and one-click *Group by site* for the Inbox.
- **AI summaries and statuses.** Every tab gets a one-sentence summary under its title, on the group page and on dashboard cards, plus a status: **Needs you**, **In progress**, **Waiting**, **Done** or **Reference**. Each group gets a one-sentence summary, and its card shows its most urgent tab status. *Most urgent first* on the dashboard puts groups that need you at the top.
  - The AI picks the status. Click a status to set it yourself; a status you set wins until you choose *Let the AI decide*.
  - *Summarize* on a group summarizes the group and each of its tabs. The sparkle on a tab summarizes that tab again. With *Summarize tabs automatically* on (the default), new and changed tabs are summarized in the background once the on-device model is ready.
  - Runs on your device by default with Chrome's built-in Gemini Nano (Chrome 138+ on desktop, with enough memory and disk). Chrome downloads the model once, on your first click. Nothing leaves your computer. Statuses use Chrome's Prompt API; where only the Summarizer API is available, on-device summaries come without a status.
  - Optionally add your own Gemini API key in **Settings** (bottom of the sidebar) → *General*. Before anything is sent to Google, Tab Desk asks once, and summaries made by Gemini are marked *Gemini · cloud*.
  - **How the prompt is built:** every tab summary starts with a fixed base prompt that asks for JSON in the order `facts`, `summary`, `status`. After it comes **one** set of detailed instructions, the most specific one that applies: a matching page rule, else the group's instructions, else the general instructions, else the built-in default. They replace each other; they don't add up. You can see the base prompt and the default instructions under **Settings** → *Summary instructions*.
  - **Custom instructions:** general instructions, instructions for a group (from its ⋯ menu, saved by group name), and **instructions for sites and pages**, all under **Settings** → *Summary instructions*, written in a short template (*This page is / Facts / Summary / Status*). A rule matches a site (`github.com`), a page pattern on the address without `https://` (`*` is one part of the path, `**` is anything: `github.com/*/*` is a repo's home, `github.com/*/*/pulls` its pull request list, `github.com/*/*/pull/*` one pull request), or a `/regular expression/`. When several rules match, the most specific one is used (a page pattern beats a whole site). **Draft with AI** on a rule looks at a matching open tab and fills in the template for you to edit; *Insert template* gives the empty template. A tab's status menu has *AI instructions for pages like this…* with the pattern filled in.
  - **Page fields and status rules (any site):** a rule can also list a few values to read from the page, one per line as `name: CSS selector` (add ` @attribute` to read an attribute, `name[]:` for every match, `name: label: Status` for the value next to a label), and status rules such as `done when state matches /merged|closed/`, `needs you when reviewers has {viewer}`, `ai otherwise` (first match wins). When a rule decides the status, it's set by code from what the page shows, and the AI only writes the sentence from those values and a short excerpt. **Test on an open tab** shows each value and the status it gives. Built-in presets do this for **GitHub pull requests** (any subpage) and **Actions runs**, using your signed-in login to tell whose turn it is; turn them off, or copy one into a rule to change it.
  - **Prompt log (debugging):** every prompt sent to the AI and its answer are kept in the extension (the last 30, never the API key). Open Tab Desk, right-click → *Inspect* → *Console*, and run `tabDeskAiLog()` for a list, `tabDeskAiLog(3)` for the full system prompt, input and answer of entry 3, or `tabDeskAiLog.clear()`. With the console level set to *Verbose*, each call is also printed as it happens.
  - Summaries are saved on this device by address, so they show again after a restart, and a page whose text hasn't changed isn't sent to the model again. Sleeping tabs aren't reloaded, and pages Chrome won't let extensions read are summarized from their title and address.

Most actions can be undone from the toast that follows them.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `src/` folder.
3. Click the Tab Desk toolbar icon, or press `Alt+Shift+D`. `Alt+Shift+K` opens Tab Desk with the palette ready. You can change both at `chrome://extensions/shortcuts`.

Requires Chrome 121 or later (AI summaries on-device need Chrome 138+). Permissions: `tabs` and `tabGroups` to read and manage tabs, `storage` for saved workspaces and settings, `favicon` to show site icons, `scripting` to read the text of a page you summarize. Access to page content (`<all_urls>`) and to the Gemini API are optional and only requested when you first use them.

## Development

No build step. The code is plain ES modules:

| Path | What it does |
| --- | --- |
| `src/manifest.json` | Manifest V3 |
| `src/background.js` | Opens or focuses the Tab Desk page |
| `src/dashboard.html`, `.css`, `.js` | The Tab Desk page |
| `src/lib/model.js` | Pure helpers: building the view model, duplicates, site grouping, fuzzy search |
| `src/lib/actions.js` | Every change made to real tabs, each returning an undo function |
| `src/lib/workspaces.js` | Saved workspaces in `chrome.storage.local` |
| `src/lib/fields.js` | Pure helpers for page fields and status rules: parsing, deciding the status, built-in GitHub presets |
| `src/lib/ai-core.js` | Pure AI helpers: settings, instructions, engine choice, prompts, Gemini stream parsing, safe Markdown rendering |
| `src/lib/ai.js` | AI engines: on-device Summarizer API, Gemini API, page text extraction, cache |
| `src/ai-ui.js` | Summarize buttons, summary cards, AI settings and instruction dialogs |

```sh
npm test        # unit tests for src/lib/model.js (Node 20+)
npm run smoke   # loads the extension in Chromium via Playwright and drives the page
npm run smoke:ai  # AI summaries end to end, with a fake on-device model and a fake Gemini endpoint
```

`npm run smoke` needs the `playwright` package and a Chromium build available to it.
