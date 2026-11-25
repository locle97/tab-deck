# AI tab and group summaries — design spec

Status: Implemented (v1). See §17 for what changed from the draft.
Date: 2026-11-25
Scope: Tab Desk extension (Manifest V3). Docs only; no code in this change.

## 1. Summary

Add two actions to Tab Desk:

- **Summarize tab**: a short summary of one open tab's page.
- **Summarize group**: a short "what is this group about" overview of all tabs in a group (or a saved workspace).

Summaries run **on-device by default** using Chrome's built-in Summarizer API (Gemini Nano). No account, no key, nothing leaves the machine. Users who want better quality, more languages or richer group summaries can **optionally add their own Gemini API key** in Settings; cloud calls only happen after an explicit, per-use-visible opt-in.

## 2. Goals and non-goals

Goals

- Zero-setup summaries on supported hardware, fully local.
- Optional cloud mode with the user's own Gemini key, clearly labeled.
- Fits the existing UI: sidebar of groups, group detail pane, saved workspaces, Ctrl+K palette.
- Fast repeat views through caching; no surprise network or model downloads.

Non-goals (v1)

- Chat / Q&A over tabs, auto-grouping by AI, translation.
- Summarizing tabs in the background without a user action.
- Any server operated by us. There is no backend; the key goes straight from the extension to Google.
- Other providers (OpenAI, Claude, etc.). The provider layer is shaped so one could be added later.

## 3. User experience

### 3.1 Entry points

| Where | Control | Action |
|---|---|---|
| Group detail pane, tab row | Sparkle icon button (next to Move / Close), tooltip "Summarize tab" | Summarize that tab |
| Group detail pane, header | `Summarize group` button (ghost style, next to Rename) | Summarize the group |
| Saved workspace detail | `Summarize workspace` button | Summarize from stored titles/URLs and cached tab summaries (tabs are closed, so no live page text) |
| Ctrl+K palette | Commands "Summarize current tab", "Summarize group: <name>" | Same actions |
| Bulk selection bar | `Summarize` (when 2–20 tabs selected) | Group-style summary of the selection |

### 3.2 Where results appear

- **Tab summary**: expands inline under the tab row as a collapsible card (key points, 3–5 bullets). Card footer shows the engine badge (`On-device` or `Gemini · cloud`), age ("2 min ago"), and `Refresh` / `Copy`.
- **Group summary**: a card at the top of the group detail pane with a one-paragraph overview ("This group is about…") followed by 3–5 key themes, plus a list of tabs that could not be read (see §5.4). Same footer.
- Text streams in as it is generated so the user sees progress immediately.
- Summaries are rendered as plain text / sanitized Markdown (bullets, bold only). Never inject model output as raw HTML.

### 3.3 States

| State | What the user sees |
|---|---|
| Ready | Buttons enabled. |
| Model downloadable | First click shows an inline prompt: "Summaries run on your device. Chrome needs to download a ~2–4 GB model once (Wi‑Fi recommended). Download now?" `[Download]` `[Use Gemini API key instead]` `[Not now]`. |
| Model downloading | Progress bar in the card ("Preparing on-device AI… 42%"). Button shows a spinner; the request runs automatically when done. |
| Unavailable on-device, no key | Buttons visible but muted; click explains why (unsupported device/language) and offers "Add a Gemini API key in Settings". |
| Generating | Streaming text with a `Stop` control. |
| Error | Short message + `Try again`. Rate limit / invalid key errors link to Settings. |
| Restricted page | "Chrome doesn't allow extensions to read this page" (chrome://, Web Store, other extensions' pages). Falls back to title-only for group summaries. |

## 4. Architecture

### 4.1 Where the code runs

The Summarizer API is exposed on `self` in window contexts only. It is **not available in workers**, so it cannot run in the MV3 service worker. Model download (`create()` while `downloadable`) also **requires a user gesture**.

Therefore:

- All summarization runs in the **Tab Desk UI page** (the extension page that hosts the sidebar/detail pane, whether shown as a full tab or in the side panel). Clicks there provide user activation.
- The **service worker** keeps its current job (tab/group events, storage) and does not call AI APIs. If a later feature needs background summaries, add an `offscreen` document; out of scope for v1.
- Cloud (Gemini API) calls are plain `fetch` from the same UI page, so both engines share one code path.

### 4.2 Modules

```
src/ai/
  summarize.ts        // public entry: summarizeTab(tabId), summarizeGroup(groupId)
  engines/
    onDevice.ts       // Chrome Summarizer API wrapper
    geminiCloud.ts    // Gemini REST client (user key)
    types.ts          // SummaryEngine interface
  extract.ts          // page text extraction via chrome.scripting
  cache.ts            // chrome.storage.local + in-memory LRU
  settings.ts         // AI settings + key storage
  prompts.ts          // cloud prompt templates, length limits
```

```ts
interface SummaryEngine {
  id: 'on-device' | 'gemini-cloud';
  availability(req: SummaryRequest): Promise<'ready' | 'needs-download' | 'downloading' | 'unavailable'>;
  summarize(req: SummaryRequest, opts: { signal: AbortSignal; onChunk(text: string): void;
                                         onDownloadProgress?(fraction: number): void }): Promise<string>;
}
```

Paths are suggestions; align with whatever layout the base implementation lands on.

### 4.3 Engine selection

Settings field **AI engine**: `Auto` (default) · `On-device only` · `Gemini API only`.

`Auto` rule:

1. If no key is saved → on-device.
2. If a key is saved and cloud consent is given → **tab summaries** use on-device when `ready`, else cloud; **group summaries** use cloud (better at synthesizing many sources and has a far larger context window).
3. If on-device is `unavailable` and there is no key → show the unavailable state.

The engine used is always shown on the result card, so the user can tell local from cloud at a glance.

## 5. On-device engine (Chrome Summarizer API)

Verified against Chrome docs (developer.chrome.com/docs/ai/summarizer-api, extensions AI overview) on 2026-11-25. Pages were last updated mid-2025; re-check before implementation.

### 5.1 Facts we rely on

- Stable since **Chrome 138**; supported for extensions (Google ships an official on-device summarization extension sample).
- Desktop only: Windows 10/11, macOS 13+, Linux, ChromeOS on Chromebook Plus. Not Android/iOS.
- Hardware: >4 GB VRAM GPU, or 16 GB RAM + 4 cores; ≥22 GB free on the profile volume (Chrome removes the model if free space drops below 10 GB). Unmetered network for the one-time download.
- Input languages currently: en, es, ja, de, fr (more planned).
- No manifest permission is needed for the API itself. Not available in Web Workers.

### 5.2 API usage

```ts
const options = {
  type: 'key-points',          // tab: key-points; group pre-pass: tldr
  format: 'markdown',
  length: 'short',             // 3 bullets; user can pick medium (5) in Settings
  sharedContext: 'A web page the user has open in a browser tab.',
  expectedInputLanguages: [pageLang],   // from document.documentElement.lang, fallback 'en'
  outputLanguage: uiLang,               // chrome.i18n.getUILanguage(), if supported, else 'en'
};

if (!('Summarizer' in self)) return 'unavailable';
const a = await Summarizer.availability(options);   // 'unavailable' | 'downloadable' | 'downloading' | 'available'

// Only inside a click handler when a is 'downloadable' or 'downloading':
const summarizer = await Summarizer.create({
  ...options,
  monitor(m) { m.addEventListener('downloadprogress', e => onDownloadProgress(e.loaded / e.total)); },
});

for await (const chunk of summarizer.summarizeStreaming(text, { context: `Title: ${title}` })) onChunk(chunk);
```

Rules:

- Pass the **same options** to `availability()` and `create()` (availability depends on languages).
- Options are fixed per instance. Keep a small pool keyed by options (e.g. `key-points/short/en`), reuse across requests, and call `destroy()` when the page unloads or after 5 minutes idle.
- Never call `create()` on page load; only from a user action, otherwise it throws `NotAllowedError` while the model is not yet downloaded.
- Check `availability()` once when the page opens to set button state; do not trigger downloads then.
- Unsupported page language → map to `unavailable` for that request and offer cloud if a key exists.

### 5.3 Long pages

The on-device context window is small (thousands of tokens). Before calling the model:

1. Use `summarizer.measureInputUsage(text)` against `summarizer.inputQuota` when available.
2. If it fits, summarize directly.
3. If not, split at paragraph/heading boundaries into ~3,000-character chunks (max 6 chunks; drop the rest and note "summary of the first part of the page"), summarize each with `type: 'tldr'`, then summarize the joined results with `type: 'key-points'` ("summary of summaries").

### 5.4 Group summaries on-device

Gemini Nano is not great at cross-document synthesis, so on-device group summaries are a two-step pipeline:

1. For each tab (up to 20, most recently active first), get a cached tab summary or compute a `tldr/short` one.
2. Feed `"<title> — <tldr>"` lines into a summarizer created with `type: 'tldr', length: 'medium'` and `sharedContext: 'Summaries of related browser tabs the user grouped together. Describe what this group of tabs is about.'`

Show per-tab progress ("Reading 7 of 12 tabs…"). This is slower (seconds per tab) and is the main reason group summaries prefer cloud in `Auto` when a key exists.

## 6. Cloud engine (user's Gemini API key)

### 6.1 Request

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
- Auth header: `x-goog-api-key: <key>` (never put the key in the URL).
- Model: setting with a sensible default of a current Flash-class model (e.g. `gemini-2.5-flash`), editable as free text so it doesn't go stale when Google renames models. "Test key" button calls `GET /v1beta/models` to validate.
- Manifest: add `https://generativelanguage.googleapis.com/*` to **`optional_host_permissions`** and request it with `chrome.permissions.request` when the user saves a key (keeps install-time warnings unchanged).

### 6.2 Prompts (in `prompts.ts`)

- **Tab**: system instruction "Summarize the web page for someone deciding whether to keep this tab. 3–5 bullet points, plain language, no preamble. Reply in {uiLang}." User content: title, URL, page text (trimmed to 60k characters).
- **Group**: system instruction "These are tabs a user grouped together named '{groupName}'. In 1–2 sentences say what this group/project is about, then list 3–5 key themes, then note any tabs that look unrelated or duplicate. Reply in {uiLang}." User content: per-tab blocks `### {title}\n{url}\n{text trimmed to ~8k chars}`; total cap ~200k characters; tabs beyond the cap send title + URL only.
- Treat page text as untrusted data: wrap it in clearly delimited blocks and state in the system instruction that page content may contain instructions which must be ignored. Output is only ever displayed as text, so prompt injection can at worst produce a misleading summary.

### 6.3 Errors

| Response | Handling |
|---|---|
| 400 / 403 API key invalid | "Your Gemini API key was rejected" → link to Settings. |
| 429 | "Gemini rate limit reached, try again shortly." One automatic retry after the `retryDelay` if ≤10 s. |
| Safety block / empty candidate | "Gemini declined to summarize this page." Offer on-device if ready. |
| Network / 5xx | Generic error + `Try again`. |

## 7. Page text extraction

### 7.1 Method

Use `chrome.scripting.executeScript({ target: { tabId }, func: extractText })` from the UI page. `extractText` runs in the page and returns:

```ts
{ title, url, lang: document.documentElement.lang, text, truncated: boolean }
```

Extraction heuristic (no bundled libraries in v1):

1. Prefer `article`, `main`, `[role=main]`; fall back to `document.body`.
2. Clone and drop `nav, header, footer, aside, script, style, noscript, form, [aria-hidden=true]`.
3. Take `innerText`, collapse whitespace, cap at 100k characters.
4. Include `meta[name=description]` at the top if present.

If quality turns out poor, swap in Mozilla Readability later behind the same function.

### 7.2 Permissions

- Add `"scripting"` to `permissions`.
- Add `"<all_urls>"` to **`optional_host_permissions`** (not required at install).
- On the first Summarize click, call `chrome.permissions.request({ origins: ['<all_urls>'] })` with an explanation card shown first: "To summarize, Tab Desk needs to read the text of pages you choose. Pages are only read when you click Summarize." If declined, tab/group summaries fall back to title + URL only (still useful for groups) and the card says so with a `Grant access` button.
- Alternative considered: per-site permission requests. Rejected because group summaries span many sites and would trigger a prompt per origin.

### 7.3 Tabs that can't be read

| Case | Behavior |
|---|---|
| `chrome://`, `edge://`, Chrome Web Store, other extensions | Not scriptable. Title + URL only. |
| Discarded / unloaded tabs (`tab.discarded`, or never loaded after restore) | Don't reload them silently (it costs memory and network). Use title + URL, cached summary if any, and show "Load tab to summarize" link on the tab row. |
| PDFs in Chrome's viewer | Not scriptable. Title + URL only in v1. |
| Pages still loading | Wait for `status === 'complete'` up to 5 s, then extract what is there. |
| `file://` | Only if the user enabled file access; otherwise title + URL. |
| Injection throws | Treat as unreadable. |

## 8. Caching

- Key: `sha256(engine + model + options + url + textHash)` where `textHash` is a hash of the extracted text. A changed page produces a new key automatically.
- Group key: hash of sorted member `(url, textHash)` pairs + engine + group name.
- Store in `chrome.storage.local` under `aiCache:<key>` with `{ summary, engine, createdAt, url, title }`. Keep an in-memory LRU for the session.
- Lookup by URL too, so the tab row can show "Summary available" without re-extracting. Workspace summaries read these cached per-tab summaries.
- TTL 7 days; max 500 entries, LRU-evicted. Settings has `Clear AI summaries`.
- Clicking `Refresh` bypasses the cache.
- Cache stays local. It is excluded from any future sync/export unless the user opts in.

## 9. Settings

New **AI summaries** section in Settings:

| Setting | Default | Notes |
|---|---|---|
| Enable AI summaries | On | Off hides all summarize controls. |
| Engine | Auto | Auto / On-device only / Gemini API only. |
| Summary length | Short | Short (3 bullets) / Medium (5). |
| On-device model status | — | Shows availability; `Download model` button when `downloadable` (click = user gesture). |
| Gemini API key | empty | Password field with show/hide, `Test`, `Remove`. Link to Google AI Studio to create a key. |
| Gemini model | `gemini-2.5-flash` | Free text. |
| Page access | — | Shows whether `<all_urls>` is granted; `Grant` / `Revoke`. |
| Clear AI summaries | — | Clears cache. |

## 10. Key storage

- Store the key in **`chrome.storage.local`** (never `storage.sync`, so it does not travel to other devices through the user's Google account).
- Only extension pages can read it; content scripts never receive it (extraction scripts get no key and return text only).
- Never log the key, include it in error reports, or put it in URLs.
- Be honest in the UI: "Your key is stored on this device in Chrome's extension storage, unencrypted. Anyone with access to this Chrome profile could read it. Use a key restricted to the Gemini API." Encrypting with a key stored next to it adds no real protection, so we don't pretend to.
- Recommend in the help text that users restrict the key to the Generative Language API in Google Cloud console and set a quota.
- `Remove` deletes the key and revokes the optional Gemini host permission.

## 11. Privacy

### 11.1 On-device

- Page text never leaves the device. Card badge: `On-device`.
- The only network use is Chrome's own one-time model download.

### 11.2 Cloud consent

Before the **first** cloud request (and again if the user removes and re-adds a key), show a blocking dialog:

> **Send page content to Google Gemini?**
> When you use your Gemini API key, the text of the pages you summarize (and for group summaries, all readable tabs in the group) is sent to Google's Gemini API. Google processes it under the Gemini API terms tied to your key. On the free tier, Google may use submitted content to improve its products. Tab Desk has no server and never sees your data.
> `[Cancel]` `[Send to Gemini]`

- Consent is stored as `aiCloudConsent: { at, keyFingerprint }`.
- Every cloud result card shows `Gemini · cloud`.
- **Never send automatically**: cloud requests only on an explicit click.
- **Sensitive site guard**: by default, do not send page text from tabs whose URL matches an exclude list (banking, mail, `localhost`, intranet-style hosts, URLs with `token=`/`session=` query params). Those tabs fall back to title + URL in cloud requests. The list is user-editable in Settings.
- Incognito tabs (if the extension is allowed in incognito) are never sent to the cloud and their summaries are never cached.

## 12. Manifest changes (delta)

```jsonc
{
  "permissions": ["scripting"],              // plus whatever the base already has (tabs, tabGroups, storage, ...)
  "optional_host_permissions": [
    "<all_urls>",                             // page text extraction, requested on first Summarize
    "https://generativelanguage.googleapis.com/*"  // only when a key is saved
  ],
  "minimum_chrome_version": "138"             // or keep lower and feature-detect; see open questions
}
```

## 13. Telemetry

None. No analytics are sent. Debug logging (behind a dev flag) records engine, timing and error type, never page text or keys.

## 14. Testing

- Unit: engine selection rules, chunking, cache key/TTL/eviction, sensitive-URL matcher, prompt building with caps, error mapping (mock `fetch`).
- Mock `Summarizer` global to test each availability state and download-progress UI, including `NotAllowedError` when not in a gesture.
- Manual matrix: supported desktop with model available; model downloadable (fresh profile); unsupported hardware; non-English page; restricted pages; discarded tabs; permission declined; invalid key; 429.

## 15. Rollout

1. Phase 1: on-device tab summaries + extraction + cache.
2. Phase 2: on-device group summaries, workspace summaries, palette commands.
3. Phase 3: Gemini key, cloud engine, consent, sensitive-site guard.

Each phase is shippable alone; Phase 1 can be behind the `Enable AI summaries` toggle (default off until Phase 2 lands, then on).

## 16. Open questions

1. **Minimum Chrome version**: set `minimum_chrome_version: 138`, or keep the base extension's minimum and hide AI controls when `Summarizer` is missing? Recommendation: feature-detect, don't raise the minimum.
2. **`<all_urls>` vs `activeTab`**: `activeTab` alone only covers the current tab after a click, which doesn't work for summarizing tabs from the dashboard. Recommendation: optional `<all_urls>` as above.
3. **Default model name**: confirm the current recommended Flash model at implementation time.
4. **Should group summaries be saved with workspaces** (so a restored workspace keeps its description)? Recommendation: yes, store the latest group summary text on the workspace record.

## References

- Summarizer API: https://developer.chrome.com/docs/ai/summarizer-api
- Built-in AI in extensions: https://developer.chrome.com/docs/extensions/ai
- Summarizing long content: https://developer.chrome.com/docs/ai/scale-summarization
- Gemini API: https://ai.google.dev/gemini-api/docs

## 17. As built (v1)

Implemented in `src/lib/ai-core.js`, `src/lib/ai.js` and `src/ai-ui.js`. Differences from the draft above:

- **Custom instructions (new).** Settings has *General instructions* applied to every summary, and each group can have its own instructions (group ⋯ menu, palette, or the pencil on a group summary). Group instructions are keyed by normalized group name, not Chrome's group id, so they survive browser restarts and apply when a workspace with that name is restored; renaming a group moves its instructions. Both are capped at 2,000 characters. They go into the Gemini system instruction (after our own rules, which tell the model to ignore instructions inside page text) and into the on-device Summarizer's `sharedContext`. They are part of the cache key, so editing them gives fresh summaries.
- **Default model** is `gemini-flash-latest` (Google's rolling alias) so it doesn't go stale; editable in settings.
- **Workspace summaries, the bulk-selection Summarize, and the sensitive-site exclude list are not in v1.** Incognito tabs are never read.
- **Page access** is asked through an explanation dialog first ("Allow page access" / "Use titles only"). Declining is remembered; settings can grant or revoke it later.
- **Group summaries** read the 20 most recent tabs for the cloud and 12 on-device.

## 18. Round 2: one sentence, every tab, statuses, URL rules

- **One sentence.** Tab and group summaries are one sentence (the "Summary length" setting is gone). Gemini is asked for JSON `{summary, status}` with a response schema; on-device uses Chrome's Prompt API (`LanguageModel`, Chrome 138+ for extensions) with a `responseConstraint` JSON schema, falling back to the Summarizer API (`tldr`, short, so no status) where the Prompt API is missing. Output is trimmed to one sentence either way.
- **Under every tab.** Tab summaries are saved by URL (without `#hash`) in `chrome.storage.local` (`aiTabInsights`, up to 1,000 entries, 30 days) and shown as a line under each tab title on the group page and on dashboard cards. Group sentences are saved by group name (`aiGroupInsights`). *Summarize* on a group runs every tab, then the group sentence.
- **Automatic.** Setting `auto`: `local` (default: in the background, only when the on-device model is already downloaded), `all` (also with Gemini when that's the tab engine, after consent) or `off`. A tab is looked at when it finishes loading, at most once per URL per session unless its summary is older than an hour. If its text, title, instructions and engine haven't changed, the model isn't called.
- **Statuses.** `review` (Need review), `working` (In progress), `done`, or none. Statuses saved before this (`action`, `waiting`, `info`) become `review`, `working` and none. The AI sets `status`; a hand-set `manual` status overrides it until cleared. A group's badge is its most urgent tab status; the dashboard can sort by it.
- **URL rules.** `rules: [{pattern, instructions}]`, up to 50. Patterns: `/regex/flags` (case-insensitive) against the full URL; a bare host for a whole site and its subdomains; otherwise a whole-address pattern on host + path (`*` = one path segment, `**` = anything; scheme, `www.`, trailing slash and hash ignored; query ignored unless the pattern has `?`). All matching rules apply in order, after general and group instructions.
