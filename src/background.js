// Opens the Tab Desk page, reusing an existing Tab Desk tab when there is one.

const PAGE = chrome.runtime.getURL('dashboard.html');

async function openDashboard({ palette = false } = {}) {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => (t.url || t.pendingUrl || '').startsWith(PAGE));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    if (palette) chrome.runtime.sendMessage({ type: 'open-palette' }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url: PAGE + (palette ? '#palette' : '') });
}

chrome.action.onClicked.addListener(() => openDashboard());

chrome.commands.onCommand.addListener(command => {
  if (command === 'open-palette') openDashboard({ palette: true });
});
