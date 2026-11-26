// The toolbar icon opens the Tab Desk side panel. The full Tab Desk page opens from the panel's
// "Full dashboard" button, the icon's right-click menu or a shortcut, reusing an existing Tab Desk
// tab when there is one.

const PAGE = chrome.runtime.getURL('dashboard.html');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(e => console.error(e));

/**
 * Open or focus the full page. `view` is a hash like "group=12", "inbox" or "workspaces" (see
 * viewFromHash in dashboard.js); `windowId` is where a new Tab Desk tab goes.
 */
async function openDashboard({ palette = false, view = '', windowId } = {}) {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => (t.url || t.pendingUrl || '').startsWith(PAGE));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    if (palette) chrome.runtime.sendMessage({ type: 'open-palette' }).catch(() => {});
    else if (view) chrome.runtime.sendMessage({ type: 'show-view', view }).catch(() => {});
    return;
  }
  const hash = palette ? 'palette' : view;
  await chrome.tabs.create({ url: PAGE + (hash ? `#${hash}` : ''), ...(windowId != null && { windowId }) });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'open-dashboard', title: 'Open full dashboard', contexts: ['action'] }, () => void chrome.runtime.lastError);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-dashboard') openDashboard({ windowId: tab?.windowId });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-dashboard') openDashboard({ windowId: tab?.windowId });
  if (command === 'open-palette') openDashboard({ palette: true, windowId: tab?.windowId });
});

// From the side panel.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'open-dashboard') return;
  openDashboard({ view: msg.view || '', windowId: msg.windowId }).then(() => reply(true), e => reply(String(e)));
  return true;
});
