# Tab Desk

A Chrome extension page for people who keep many tab groups open. It replaces squinting at the tab strip with:

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
- **AI summaries.** *Summarize* on a tab gives a few key points about the page; *Summarize* on a group says what the group is about.
  - Runs on your device by default with Chrome's built-in Gemini Nano (Chrome 138+ on desktop, with enough memory and disk; Chrome downloads the model once, on your first click). Nothing leaves your computer.
  - Optionally add your own Gemini API key in **AI summaries** (bottom of the sidebar) for better group summaries or when on-device AI isn't available. Before anything is sent to Google, Tab Desk asks once, and every summary is labeled *On-device* or *Gemini · cloud*.
  - **Custom instructions:** general instructions for every summary (for example "Write in Vietnamese"), plus instructions for a specific group from the group's ⋯ menu. Group instructions are saved by group name, so they survive restarts, renames and restoring from Workspaces.
  - Summaries are cached on this device for 7 days. Sleeping tabs aren't reloaded, and pages Chrome won't let extensions read are summarized from their title and address.

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
| `src/lib/ai-core.js` | Pure AI helpers: settings, instructions, engine choice, prompts, Gemini stream parsing, safe Markdown rendering |
| `src/lib/ai.js` | AI engines: on-device Summarizer API, Gemini API, page text extraction, cache |
| `src/ai-ui.js` | Summarize buttons, summary cards, AI settings and instruction dialogs |

```sh
npm test        # unit tests for src/lib/model.js (Node 20+)
npm run smoke   # loads the extension in Chromium via Playwright and drives the page
npm run smoke:ai  # AI summaries end to end, with a fake on-device model and a fake Gemini endpoint
```

`npm run smoke` needs the `playwright` package and a Chromium build available to it.
