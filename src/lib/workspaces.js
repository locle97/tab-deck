// Saved workspaces live in chrome.storage.local so they survive restarts.

const KEY = 'workspaces';

export async function listWorkspaces() {
  const r = await chrome.storage.local.get(KEY);
  return Array.isArray(r[KEY]) ? r[KEY] : [];
}

async function write(list) {
  await chrome.storage.local.set({ [KEY]: list });
}

export async function addWorkspace(ws) {
  const list = await listWorkspaces();
  await write([ws, ...list.filter(w => w.id !== ws.id)]);
}

export async function removeWorkspace(id) {
  const list = await listWorkspaces();
  await write(list.filter(w => w.id !== id));
}

export function onWorkspacesChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(changes[KEY].newValue || []);
  });
}
