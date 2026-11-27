# Tab Desk

A Chrome extension page for people who keep many tab groups open. It replaces squinting at the tab strip with:

- **Side panel.** Clicking the toolbar icon (or `Alt+Shift+D`) opens Tab Desk in Chrome's side panel, so you can keep an eye on every group's progress while you work in one tab. It shows the dashboard cards in one column: each group's status pill and status bar, its summary, its first tabs with their status edges and summaries, and the Inbox. Statuses update live as summaries finish, whether they run in the panel or in the full page. Click a tab to switch to it; click a status edge to change it. Drag tabs and cards to reorder them, as on the full page. On top: the counts, **Full dashboard** (opens or focuses the full Tab Desk page), the sort menu, *Summarize all*, search and settings. Clicking a group's name, *Open details* or the Inbox opens that view in the full page. The panel stays open as you switch tabs.
  - The full page opens from the panel, from the icon's right-click menu (*Open full dashboard*), or with `Alt+Shift+F`. On the full page, the panel icon at the right of the header opens the side panel.
  - When the full page is open, it runs the automatic summaries, so the panel doesn't do the same work twice.
- **Dashboard.** Every open tab group on one page as a grid of cards, so you can keep track of several projects at once.
  - **Header bar.** On the left, the number of groups and tabs. On the right: a sort menu (*Most urgent*, *Recently used*, *Tab strip order*), a grid/list toggle, *Summarize all* and *Search* (`Ctrl+K`). Sort and layout are remembered.
  - **Cards.** A header tinted with the group's color holds the name and one status pill (e.g. *Working · 2*). A thin bar under it shows how many tabs have each status. The group's AI summary is one muted line (click it to read it all; refresh and edit show on hover). Each tab row shows its status as a colored left edge (click it to change the status), the title, the site in faint text, and Summarize / Move / Close on hover; sleeping tabs are dimmed. A small footer has the tab count, sites, last use and *2 of 4 working*. A group never greys out: an open group is still a work stream, and one with nothing running shows *Idle*. *Switch* and *⋯* (which holds *Summarize group and tabs*, Save & close, color, sort, collapse, ungroup and close) show on hover.
  - Cards show their first 3 tabs (6 in list view); *N more tabs* opens the full list. With *Most urgent*, groups that need you come first with a stronger border, and tabs inside a card are ordered by status too.
  - Finished groups are dimmed, and *Most urgent* sorts them near the end. Ungrouped tabs sit in a slim **Inbox** row under the cards.
  - Cards sit in 3 columns on a wide screen, 2 on a medium one and 1 on a narrow one. Tab Desk always opens on the dashboard. `Alt+0` shows it from anywhere on the page.
- **Group sidebar.** Every open tab group with its color and tab count, plus an **Inbox** of ungrouped tabs.
  - Drag a group up or down to reorder it. The real tab groups move in Chrome's tab strip too (across windows as well). With a group focused, `Alt+↑` / `Alt+↓` does the same from the keyboard.
  - Click the chevron next to a group to list its tabs under it. Click a tab there to switch to it.
  - Drag the sidebar's right edge to make it wider or narrower (200 to 560 px) so long names fit. Double-click the edge to reset it. With the edge focused, the arrow keys resize it. The width is remembered.
- **Drag and drop.** Drag tabs and groups to put them where you want; Chrome's real tab strip follows (across windows too), and every open Tab Desk page and the side panel update at once. Every move can be undone from its toast.
  - **Tabs:** drag a tab on a dashboard card, in the Inbox row, on a group or Inbox page, or in the sidebar's tab lists. Drop it between two tabs (a line shows where) to put it there, in that tab's group or the Inbox. Drop it on a card, a sidebar group, the Inbox row or the sidebar's Inbox to add it to that group or ungroup it. On a group or Inbox page, dragging a selected tab takes all selected tabs along, and `Alt+↑` / `Alt+↓` moves the focused tab one place.
  - **Groups:** drag a card by its header (left or right of another card in the grid, above or below in one column) or a sidebar row.
  - With *Most urgent* or *Recently used*, cards and the tabs in them aren't in tab strip order, so a drop that sets an order switches the dashboard to *Tab strip order* to show the result.
- **Group detail.** The selected group's tabs with favicon, title, URL and badges (Active, Playing, Duplicate, Sleeping, Pinned). Rename, recolor, sort by site, collapse, ungroup, move or close tabs, alone or several at once.
- **Switch to group.** Expands the group, collapses the other groups in that window and opens its most recent tab.
- **Tidy tab strip (optional).** In **Settings** → *General* → *Tab strip*, turn on *Collapse other groups when I switch to a tab in a group* to keep only the active tab's group open in Chrome's tab bar. It applies however you switch (clicking in the tab bar, a shortcut or Tab Desk), only in that window, and switching to an ungrouped tab leaves the groups alone. Off by default.
- **Workspaces.** *Save & close* stores a group (name, color, URLs) and closes its tabs. *Restore* reopens it as a group later.
- **Command palette.** `Ctrl+K` (`⌘K` on Mac) on the Tab Desk page searches tabs, groups and workspaces:
  - `Enter` switches to a tab, shows a group, or restores a workspace
  - `Shift+Enter` on a group switches to it
  - `Ctrl+Backspace` closes a tab, or saves and closes a group
  - `Ctrl+M` moves a tab to another group, or to a new one if you type a name
  - type `>` to list commands (close duplicates, group Inbox by site, sleep other tabs)
- **Cleanup.** A duplicate-tab cleaner, and one-click *Group by site* for the Inbox.
- **AI summaries and statuses.** Every tab gets a one-sentence summary under its title, on the group page and on dashboard cards, plus a status that treats tabs as agents or work streams: **Need action** (waiting for you to do something), **Working** (running a task, or waiting on others), **Idle** (finished, waiting for you to assign the next task) or **Reference** (something to read). Statuses saved by older versions are carried over: Done becomes Idle, Waiting becomes Working. Each group gets a one-sentence summary, and its card shows its most urgent tab status. The *Most urgent* sort on the dashboard orders groups Need action, Working, Idle, then Reference.
  - The AI picks the status. Click a status to set it yourself; a status you set wins until you choose *Let the AI decide*.
  - *Summarize* on a group summarizes the group and each of its tabs. The sparkle on a tab summarizes that tab again. With *Summarize tabs automatically* on (the default), new and changed tabs are summarized in the background once the on-device model is ready.
  - Runs on your device by default with Chrome's built-in Gemini Nano (Chrome 138+ on desktop, with enough memory and disk). Chrome downloads the model once, on your first click. Nothing leaves your computer. Statuses use Chrome's Prompt API; where only the Summarizer API is available, on-device summaries come without a status.
  - Optionally use a cloud model with your own API key in **Settings** (bottom of the sidebar) → *General* → *Cloud*: **Gemini API** (key from Google AI Studio) or **Claude Haiku** (`claude-haiku-5-5`, key from the Claude Console). Each key is stored on this device only. Before anything is sent to Google or Anthropic, Tab Desk asks once for that provider, and cloud summaries are marked *Gemini · cloud* or *Claude · cloud*.
  - **How the prompt is built:** every tab summary starts with a fixed base prompt that asks for JSON in the order `facts`, `summary`, `status`. After it comes **one** set of detailed instructions, the most specific one that applies: a matching page rule, else the group's instructions, else the general instructions, else the built-in default. They replace each other; they don't add up. You can see the base prompt and the default instructions under **Settings** → *Summary instructions*.
  - **Custom instructions:** general instructions, instructions for a group (from its ⋯ menu, saved by group name), and **instructions for sites and pages**, all under **Settings** → *Summary instructions*, written in a short template (*This page is / Facts / Summary / Status*). A rule matches a site (`github.com`), a page pattern on the address without `https://` (`*` is one part of the path, `**` is anything: `github.com/*/*` is a repo's home, `github.com/*/*/pulls` its pull request list, `github.com/*/*/pull/*` one pull request), or a `/regular expression/`. When several rules match, the most specific one is used (a page pattern beats a whole site). **Draft with AI** on a rule looks at a matching open tab and fills in the template for you to edit; *Insert template* gives the empty template. A tab's status menu has *AI instructions for pages like this…* with the pattern filled in.
  - **Page fields and status rules (any site):** a rule can also list a few values to read from the page, one per line as `name: CSS selector` (add ` @attribute` to read an attribute, `name[]:` for every match, `name: label: Status` for the value next to a label), and status rules such as `done when state matches /merged|closed/`, `needs you when reviewers has {viewer}`, `ai otherwise` (first match wins). When a rule decides the status, it's set by code from what the page shows, and the AI only writes the sentence from those values and a short excerpt. **Test on an open tab** shows each value and the status it gives. Built-in presets do this for **GitHub pull requests** (any subpage) and **Actions runs**, using your signed-in login to tell whose turn it is; turn them off, or copy one into a rule to change it.
  - **Prompt log (debugging):** every prompt sent to the AI and its answer are kept in the extension (the last 30, never the API key). Open Tab Desk, right-click → *Inspect* → *Console*, and run `tabDeskAiLog()` for a list, `tabDeskAiLog(3)` for the full system prompt, input and answer of entry 3, or `tabDeskAiLog.clear()`. With the console level set to *Verbose*, each call is also printed as it happens.
  - Summaries are saved on this device by address, so they show again after a restart, and a page whose text hasn't changed isn't sent to the model again. Sleeping tabs aren't reloaded, and pages Chrome won't let extensions read are summarized from their title and address.

Most actions can be undone from the toast that follows them.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `src/` folder.
3. Click the Tab Desk toolbar icon, or press `Alt+Shift+D`, to open the side panel. `Alt+Shift+F` opens the full page, and `Alt+Shift+K` opens it with the palette ready. Right-click the icon for *Open full dashboard*. You can change the shortcuts at `chrome://extensions/shortcuts`.

Requires Chrome 121 or later (AI summaries on-device need Chrome 138+). Permissions: `tabs` and `tabGroups` to read and manage tabs, `storage` for saved workspaces and settings, `favicon` to show site icons, `scripting` to read the text of a page you summarize, `sidePanel` for the side panel, `contextMenus` for the icon's right-click menu. Access to page content (`<all_urls>`), to the Gemini API and to the Claude API are optional and only requested when you first use them.

## Development

No build step. The code is plain ES modules:

| Path | What it does |
| --- | --- |
| `src/manifest.json` | Manifest V3 |
| `src/background.js` | Makes the toolbar icon open the side panel; opens or focuses the full Tab Desk page; collapses other groups on tab switch when that setting is on |
| `src/dashboard.html`, `.css`, `.js` | The Tab Desk page |
| `src/panel.html` | The side panel: the same page and code in a compact, dashboard-only mode |
| `src/lib/model.js` | Pure helpers: building the view model, duplicates, site grouping, fuzzy search |
| `src/lib/actions.js` | Every change made to real tabs, each returning an undo function |
| `src/lib/workspaces.js` | Saved workspaces in `chrome.storage.local` |
| `src/lib/tab-strip.js` | Tab strip settings and which groups to collapse when you switch tabs |
| `src/lib/fields.js` | Pure helpers for page fields and status rules: parsing, deciding the status, built-in GitHub presets |
| `src/lib/ai-core.js` | Pure AI helpers: settings, instructions, engine choice, prompts, Gemini and Claude requests and stream parsing, safe Markdown rendering |
| `src/lib/ai.js` | AI engines: on-device Summarizer API, Gemini API, Claude API, page text extraction, cache |
| `src/ai-ui.js` | Summarize buttons, summary cards, AI settings and instruction dialogs |

```sh
npm test        # unit tests for src/lib/model.js (Node 20+)
npm run smoke   # loads the extension in Chromium via Playwright and drives the page
npm run smoke:ai  # AI summaries end to end, with a fake on-device model and fake Gemini and Claude endpoints
```

`npm run smoke` needs the `playwright` package and a Chromium build available to it.
