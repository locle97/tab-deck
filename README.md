# Tab Desk

A Chrome extension page for people who keep many tab groups open. It replaces squinting at the tab strip with:

- **Group sidebar.** Every open tab group with its color and tab count, plus an **Inbox** of ungrouped tabs.
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

Most actions can be undone from the toast that follows them.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `src/` folder.
3. Click the Tab Desk toolbar icon, or press `Alt+Shift+D`. `Alt+Shift+K` opens Tab Desk with the palette ready. You can change both at `chrome://extensions/shortcuts`.

Requires Chrome 121 or later. Permissions: `tabs` and `tabGroups` to read and manage tabs, `storage` for saved workspaces, `favicon` to show site icons.

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

```sh
npm test        # unit tests for src/lib/model.js (Node 20+)
npm run smoke   # loads the extension in Chromium via Playwright and drives the page
```

`npm run smoke` needs the `playwright` package and a Chromium build available to it.
