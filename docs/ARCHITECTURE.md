# Architecture

Technical architecture of this codebase (upstream: [openTeleprompt](https://github.com/ArunNGun/openTeleprompt) v3.0.0). A Tauri v2 desktop app: Rust backend, React 19 + Vite frontend, Zustand state, Tiptap rich-text editing. All file/line references are to this repository at the fork point.

> **Scope note.** `frontend/renderer/` is the legacy Electron v1.x renderer (plain JS, `frontend/renderer/app.js`). It is still referenced by the Rust backend for the Windows settings panel and the first-launch welcome window (see §1.4), but the active macOS app is the React frontend in `src/`. `docs/` (other than this file) is the GitHub Pages landing site.

---

## 1. High-level architecture

### 1.1 Process model

There is one Rust process and up to three WebView windows, each identified by a Tauri window label:

| Window label | Content | Created at |
|---|---|---|
| `prompter` | React app (`index.html` → `src/main.jsx` → `src/App.jsx`) — the notch island / classic pill | `setup()` at `src-tauri/src/lib.rs:693-708`, and recreated by `create_prompter_window()` at `lib.rs:511-578` on mode switch |
| `settings` | React settings panel (`settings.html` → `src/settings-main.jsx` → `src/views/SettingsView.jsx`) | lazily by `show_settings()` at `lib.rs:601-631` on tray click |
| `welcome` | Legacy static page `frontend/renderer/welcome.html` | first launch only, `lib.rs:722-761` |

Entry point: `src-tauri/src/main.rs:4-6` calls `open_teleprompter_lib::run()` (`lib.rs:646-858`), which registers three plugins — `tauri_plugin_global_shortcut`, `tauri_plugin_fs`, `tauri_plugin_positioner` (`lib.rs:656-658`) — installs `AppState`, registers 21 commands (`lib.rs:660-670`), and builds the tray + global shortcuts in `setup()`.

The two React windows are separate Vite entry points, declared in `vite.config.js:14-17` (`rollupOptions.input: { main: 'index.html', settings: 'settings.html' }`). They do **not** share JS state; they synchronize only through the Rust backend (see §1.3).

### 1.2 IPC layer

`tauri.conf.json:13` sets `"withGlobalTauri": true`, and the frontend has **no `@tauri-apps/api` npm dependency** (see `package.json` dependencies). All IPC goes through the injected global:

- `src/lib/api.js:1-2` — `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen`, with no-op fallbacks so the UI also runs in a plain browser (`src/App.jsx:120` uses `!window.__TAURI__` to show a dev panel).
- `src/views/SettingsView.jsx:3-16` duplicates a smaller inline `API` object for the settings window.

Direction of traffic:

- **JS → Rust (commands):** the 21 handlers in `lib.rs:660-670` (`get_config`, `set_config`, `switch_mode`, `get_scripts`, `save_scripts`, `set_ignore_mouse`, `resize_prompter`, `toggle_prompter`, `resize_settings`, `quit_app`, `open_devtools`, `hide_settings`, `start_drag`, `set_movable`, `move_window`, `get_window_pos`, `close_welcome`, `open_url`, `open_settings`, `focus_prompter`, `elevate_notch_window`).
- **Rust → JS (events):** exactly two event names.
  - `config-update` — broadcast by `set_config` (`lib.rs:305`); consumed by `App.jsx:52-64` (which normalizes snake_case→camelCase) and `SettingsView.jsx:66`.
  - `shortcut` — emitted to the `prompter` window with a string payload `"pause" | "faster" | "slower" | "reset"` from the global-shortcut handler (`lib.rs:832-842`), and `"stop"` from `switch_mode` (`lib.rs:316`) and `toggle_prompter` (`lib.rs:399`); consumed in `ReadView.jsx:152-161`.

Permissions for the WebView side are scoped in `src-tauri/capabilities/default.json` to the `prompter` and `settings` windows (core window ops, `global-shortcut:*`, `fs:*`, `positioner:*`).

### 1.3 State ownership

Three state stores, with the Rust side as source of truth for anything persistent:

1. **Rust `AppState`** (`lib.rs:116-120`): `Mutex<Config>` + `Mutex<Option<(f64,f64)>>` (last classic-mode window position). `Config` (`lib.rs:72-104`) holds `scroll_speed`, `threshold`, `screenshare_hidden`, `mode`, `opacity`, `auto_scroll`, `mic_device_id`, `theme`; serialized camelCase.
2. **Disk**: three dotfiles in the user's home directory (`lib.rs:123-139`): `~/.teleprompter-config.json`, `~/.teleprompter-scripts.json`, `~/.teleprompter-launched` (first-launch marker). Writes happen in `save_config` (`lib.rs:147-151`) and `save_scripts_to_disk` (`lib.rs:251-255`).
3. **Zustand store** (`src/store/index.js`): a single `useAppStore` with `view` (`'idle' | 'edit' | 'read'`), a `config` mirror, `scripts` + `currentScriptIndex`, the active script (`scriptText` plain text, `scriptDoc` Tiptap JSON), and playback flags.

**Caveat (verified):** the playback flags in the store (`isSpeaking`, `isPaused`, `isHoverPaused`, `isRunning`, `speedIndex`, `store/index.js:29-39`) are written by nothing — `ReadView.jsx:16-17` shadows them with local `useState`, and all `setIsSpeaking`/`setIsPaused` calls in `ReadView` are those local setters. `IdleView.jsx:4` reads the store's `isSpeaking`/`isPaused`, which therefore remain at their initial `false`. Treat the store flags as dead code inherited from a refactor; real playback state lives in `ReadView` local state + refs (§3.3).

### 1.4 Known upstream quirks (relevant when extending)

Documented here because they affect where new code can safely go; none were changed in this fork:

- `setup()` builds the initial prompter window with release URL `renderer/index.html` (`lib.rs:691`), while `create_prompter_window()` uses `index.html` (`lib.rs:541`). The Vite build (`frontendDist: "../dist"`, `tauri.conf.json:10`) emits only `index.html` and `settings.html`; nothing copies `frontend/renderer/` into `dist/`, so the `renderer/*` App URLs (initial prompter, `welcome`, Windows settings at `lib.rs:603`) point at paths absent from the bundled frontend.
- `src/lib/api.js:5` — `elevateNotchWindow` calls a bare `invoke` (undefined identifier; would throw if invoked). Nothing calls it: notch elevation actually happens Rust-side (§2.2). The `elevate_notch_window` command (`lib.rs:267-279`) is effectively unreachable from JS as wired.
- `src-tauri/Cargo.toml:23-33`: `serde`, `serde_json`, `dirs`, `open` and all three Tauri plugins are declared under `[target.'cfg(target_os = "macos")'.dependencies]`, so the crate as committed only builds on macOS (consistent with the README's "Windows v3 coming soon").

---

## 2. Window management (notch overlay)

### 2.1 Window creation flags

Both creation sites (`lib.rs:543-558` and `lib.rs:693-708`) use `tauri::WebviewWindowBuilder` with:

```
.decorations(false)  .transparent(true)  .always_on_top(true)
.skip_taskbar(true)  .resizable(mode == "classic")  .accept_first_mouse(true)
.visible_on_all_workspaces(true)  .content_protected(false)
```

In notch mode the window is created **full screen width × 200 px at (0, 0)** (`lib.rs:528`, `lib.rs:684`); CSS renders only the island inside it. Transparency on macOS requires `"macOSPrivateApi": true` (`tauri.conf.json:19`) plus the `macos-private-api` cargo feature (`Cargo.toml:20`). The app is a menu-bar-style accessory: `set_activation_policy(ActivationPolicy::Accessory)` (`lib.rs:675`) and `LSUIElement=true` in `src-tauri/Info.plist`.

### 2.2 Elevation above the menu bar (the notch trick)

`elevate_to_notch_level()` (`lib.rs:13-52`, macOS only) drops below Tauri to raw AppKit via `objc2`/`objc2-app-kit`:

1. `window.ns_window()` obtains the `NSWindow` pointer (`lib.rs:16`).
2. `setLevel(27)` — `NSMainMenuWindowLevel` (24) + 3, so the window floats **above the menu bar** (`lib.rs:25`).
3. `setCollectionBehavior((1<<0)|(1<<4)|(1<<6)|(1<<8))` — `canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary` (`lib.rs:27-29`).
4. `setHasShadow(false)` (`lib.rs:30`).
5. `setFrame_display` repositions the window flush with the physical screen top using `NSScreen::mainScreen` bottom-left coordinates (`lib.rs:37-47`). The window is 200 px tall = ~160 px notch content + 40 px overlap kept on-screen because WKWebView stops rendering when fully above the visible area (comment at `lib.rs:7-12`).

Called from `setup()` (`lib.rs:713-715`) and from `create_prompter_window()` (`lib.rs:572-575`); `switch_mode` dispatches recreation via `run_on_main_thread` because NSWindow APIs must run on the main thread (`lib.rs:327-331`).

### 2.3 Hidden from screen capture

`apply_screenshare_mode()` (`lib.rs:260-262`) calls Tauri's `WebviewWindow::set_content_protected(bool)` — on macOS this sets `NSWindow.sharingType = .none`, which excludes the window from screen recording/sharing. It is applied at window creation (`lib.rs:567`, `lib.rs:717-719`) and re-applied whenever `set_config` receives `screenshareHidden` (`lib.rs:302-304`). Default is ON (`Config::default`, `lib.rs:96`).

### 2.4 Resizing, click-through, dragging

- **Resize protocol:** the frontend owns geometry. `App.jsx:11-23` defines per-view sizes (`ISLAND_SIZES` / `CLASSIC_SIZES`); the effect at `App.jsx:87-94` calls `API.resizePrompter` on every view/hover/mode change. Rust's `resize_prompter` (`lib.rs:355-392`) in notch mode sizes the window to exactly the island and horizontally centers it at y = 0 (so the small idle pill doesn't intercept clicks across the whole screen top); in classic mode it resizes in place.
- **Click-through:** `set_ignore_mouse` → `set_ignore_cursor_events` (`lib.rs:342-352`), force-disabled in classic mode. Never set at creation time — a code comment (`lib.rs:565-566`) notes doing so breaks WKWebView rendering; `App.jsx:45` re-enables mouse after mount.
- **Classic dragging:** mousedown on non-interactive elements calls `API.startDrag()` → `start_dragging()` (`App.jsx:102-107`, `lib.rs:480-485`); position persisted in `AppState.classic_pos` via `move_window` (`lib.rs:458-467`).
- **Settings window placement:** anchored to the tray icon via `tauri-plugin-positioner` `Position::TrayCenter`, gated by the `TRAY_CLICKED` atomic because the positioner panics before it has seen a tray event (`lib.rs:63`, `lib.rs:591-598`); falls back to bottom-right. Settings hides instead of closing (`CloseRequested` handler, `lib.rs:847-855`) and auto-hides on blur (`SettingsView.jsx:73-76`).

---

## 3. Voice-activation pipeline (current, frequency-only)

There is **no speech recognition anywhere in the current code**. "Voice activation" is an energy heuristic that answers one boolean per frame: *is the user speaking?* Scrolling is constant-speed while that boolean is true — it is not aligned to what was said.

### 3.1 Capture

Audio is captured **in the prompter WebView**, not in Rust, via `navigator.mediaDevices.getUserMedia` (`src/lib/mic.js:52`) with `echoCancellation`, `noiseSuppression`, `autoGainControl`, `suppressLocalAudioPlayback` (`mic.js:41-46`) and an optional exact `deviceId` from `config.micDeviceId` (with `OverconstrainedError` fallback, `mic.js:53-58`). OS permission is granted through `NSMicrophoneUsageDescription` (`src-tauri/Info.plist`) and the `com.apple.security.(device.)audio-input` entitlements (`src-tauri/entitlements.plist`); `App.jsx:66-69` pre-probes permission on mount. The settings window opens its own independent stream for the level meter (`SettingsView.jsx:118-139`).

### 3.2 Detection — `createMicEngine` (`src/lib/mic.js:8-110`)

Factory returning `{ start(micDeviceId), stop(), setThreshold(v) }`. Inside `start()`:

- Web Audio graph: `MediaStreamSource → AnalyserNode`, `fftSize = 2048`, `smoothingTimeConstant = 0.3` (`mic.js:64-69`).
- A 16 ms `setInterval` loop (`mic.js:75-93`) computes RMS over the time-domain buffer; gate #1 is `rms > VOLUME_THRESHOLD` (default `0.018`, user-tunable — see §5).
- Gate #2 is `isVoiceFrequency()` (`mic.js:17-38`), the **85–3400 Hz analysis**: from `getFloatFrequencyData` (dB values), it converts bins to linear energy (`10^(dB/20)`) and averages two bands — the voice band `85–3400 Hz` and a high band `4000–8000 Hz` (bin indices derived from `binHz = sampleRate / fftSize`, `mic.js:73`). Speech passes if `voiceAvg / highAvg > 2.5` (keyboard clicks and broadband noise have proportionally more high-band energy).
- **Hysteresis:** a frame counter increments +1 on pass, decrements −2 on fail, clamped to `[0, 8]`; speech is asserted only at `VOICE_FRAMES_REQUIRED = 8` consecutive-ish frames (`mic.js:6`, `mic.js:34-37`), i.e. ~130 ms of sustained voice.
- **Debounce down:** on the first non-speech frame while speaking, a 400 ms timer (`SILENCE_DELAY_MS`, `mic.js:5`) fires `onSilence`; any speech frame cancels it. `onSpeaking` fires on the rising edge.

### 3.3 Where scroll state lives

The engine is instantiated in `ReadView`'s mount effect (`src/views/ReadView.jsx:141-148`); its callbacks set **local** state/refs: `isSpeakingRef` + `useState isSpeaking` + `micStatus` (`ReadView.jsx:143-144`). A mic-device change tears down and recreates the engine (`ReadView.jsx:59-69`); threshold changes are pushed live via `setThreshold` (`ReadView.jsx:57`).

The scroll loop is a `requestAnimationFrame` loop (`ReadView.jsx:118-138`):

```
shouldScroll = config.autoScroll ? !paused : (isSpeakingRef.current && !paused)
scrollPosRef.current += SCROLL_SPEED_BASE(0.1) * SPEEDS[speedIdx] * frameDelta
scriptTextRef.current.style.transform = translateY(-scrollPos)
```

with `paused = isPausedRef || isHoverPausedRef`. Scroll position is a ref (`scrollPosRef`), applied as a CSS transform — it never touches React state or the Zustand store. As noted in §1.3, the Zustand playback flags are dead; Zustand's real responsibilities in read mode are only `scriptText`/`scriptDoc` (input) and `setView` (exit). Cue markers (`[PAUSE]`, `[BREATHE]`, `[SLOW]`) fire when their DOM element enters the top 40 % of the viewport (`checkMarkers`, `ReadView.jsx:75-115`), driving timed pauses or a speed step-down. Manual wheel scrubbing writes the same `scrollPosRef` (`ReadView.jsx:203-209`).

---

## 4. Script editor and library

### 4.1 Data model

One `Script` = `{ name, text, content }` (`lib.rs:107-113`): `name` is display title, `text` is the plain-text flattening, `content` is the **Tiptap JSON document serialized as a string**. The frontend mirrors this shape untyped. Three seeded demo scripts are generated in `default_scripts()` (`lib.rs:153-243`) when no scripts file exists.

### 4.2 Persistence

Whole-array read/write through two commands: `get_scripts` → `load_scripts()` and `save_scripts` → `save_scripts_to_disk()` (`lib.rs:335-339`, `245-255`), storing pretty-printed JSON at `~/.teleprompter-scripts.json`. There is no partial update, no IDs (scripts are addressed by array index — see `currentScriptIndex`, `store/index.js:20`), and no debounce; every save rewrites the file.

### 4.3 Tiptap integration (`src/views/EditView.jsx`)

- Editor: `useEditor` with `StarterKit`, `TextStyle`, `Color` extensions (`EditView.jsx:36-45`); toolbar offers bold, five fixed colors, and cue-marker insertion (`MARKERS = ['[PAUSE]','[SLOW]','[BREATHE]']`, `EditView.jsx:16`; markers are inserted as plain text tokens, `insertMarker`, `EditView.jsx:121-123`).
- Save: `saveCurrentScript` (`EditView.jsx:60-75`) derives `name` from the first line (≤ 40 chars), `text` from `editor.getText()`, `content` from `JSON.stringify(editor.getJSON())`, updates the array in Zustand, and calls `API.saveScripts` (write-through).
- Load: `loadScript(i)` / mount effect parse `script.content` back into the editor, falling back to wrapping `script.text` in a paragraph on parse failure (`EditView.jsx:48-58`, `99-111`).
- Handoff to the prompter: `handleStart` (`EditView.jsx:77-85`) saves, then `setScriptText(text)` + `setScriptDoc(editor.getJSON())` + `setView('read')`.
- Rendering for reading: `tokenizeDoc` (`src/lib/tokenizer.js:6-42`) walks the Tiptap JSON and flattens it to tokens `{ type: 'word'|'marker'|'newline', text, bold, color, marker }`. Words are produced by `text.split(/(\s+)/)` (`tokenizer.js:18`) — **whitespace segmentation**, which is the key limitation for Chinese text (§7a). `ReadView.jsx:235-258` renders one `<span>` per token; word-count stats assume `\s+`-separated words at 130 WPM (`EditView.jsx:18-24`).

---

## 5. Settings system and global shortcuts

### 5.1 Config flow

`SettingsView` (own window, §1.1) reads config on mount and writes individual patches through `set_config` (`lib.rs:287-306`), which merges the patch into `AppState`, persists to disk, re-applies content protection, and broadcasts `config-update` — closing the loop to the prompter window (`App.jsx:52-64`) and back to any other settings instance. Notable mappings:

- The UI "Voice Input" toggle is the **inverse** of `autoScroll` (`SettingsView.jsx:88`, `164-167`): voice input ON ⇒ `autoScroll: false` (scroll only while speaking); OFF ⇒ `autoScroll: true` (scroll continuously).
- Voice sensitivity: a log-scale slider mapping `0.003–0.562` RMS (`sliderToThreshold`, `SettingsView.jsx:19-22`), displayed in dB, with a live RMS meter from its own mic stream (`startMeter`, `SettingsView.jsx:118-139`).
- Mode switching calls the dedicated `switch_mode` command (not `set_config`) because the prompter window must be destroyed and recreated (`SettingsView.jsx:154-157`, `lib.rs:309-333`).
- Mic enumeration via `enumerateDevices` after a temporary permission-priming stream (`SettingsView.jsx:105-116`).

### 5.2 Global shortcuts

Registered in `setup()` using `tauri-plugin-global-shortcut` (`lib.rs:809-843`). On macOS both `⌘⇧` (SUPER) and `⌃⇧` (CONTROL) variants are registered for `Space`, `ArrowUp`, `ArrowDown`, `KeyR`; Windows builds register only `Ctrl+Shift` variants. Registration failures are silently skipped (`let _ =`, `lib.rs:832`) so OS-taken combos don't crash startup. The handler maps key → action string and `emit_to("prompter", "shortcut", action)` (`lib.rs:834-841`); `ReadView.jsx:152-161` translates actions into the same local state used by the on-screen controls (`pause`→`togglePause`, `faster`/`slower`→speed index, `reset`→scroll to top, `stop`→`handleDone`). Shortcuts therefore only have an effect while `ReadView` is mounted, except `stop`, which is also emitted by the backend before hiding/recreating the window.

---

## 6. Frontend dependency map

```
index.html ─→ src/main.jsx ─→ src/App.jsx
                               │  bootstraps config+scripts (lib/api.js → Tauri invoke)
                               │  owns: view routing, hover, window resize, theme/opacity
                               │
              ┌────────────────┼──────────────────┐
              ▼                ▼                  ▼
      views/IdleView.jsx  views/EditView.jsx  views/ReadView.jsx
        store: view,        store: scripts,     store: scriptText/Doc,
        isSpeaking*,        currentScriptIndex, config, setView
        isPaused*, config   scriptText/Doc,     lib/tokenizer.js (doc→tokens)
        (*never updated)    config              lib/mic.js (VAD engine)
              │                │                lib/api.js (shortcuts, resize)
              │                ├─ @tiptap/react + starter-kit
              │                │  + extension-text-style + extension-color
              └────────┬───────┴──────────┬─────┘
                       ▼                  ▼
              src/store/index.js   src/lib/api.js ──→ window.__TAURI__ ──→ src-tauri/src/lib.rs
              (Zustand useAppStore)                    (invoke/listen)

settings.html ─→ src/settings-main.jsx ─→ src/views/SettingsView.jsx
                 (separate window & bundle; inline API copy at SettingsView.jsx:6-16;
                  no Zustand — local useState only; syncs via config-update event)
```

Shared modules: `store/index.js` (all three prompter views + App), `lib/api.js` (App, EditView, ReadView — **not** SettingsView), `lib/mic.js` and `lib/tokenizer.js` (ReadView only). Styling: `src/style.css` (prompter), `src/settings.css` (settings).

---

## 7. Extension points

### 7a. Speech-recognition-driven word tracker (replacing frequency-only detection)

The current design conveniently isolates everything you need behind three seams:

1. **The engine seam — `createMicEngine` in `src/lib/mic.js:8`.** ReadView interacts with the engine only through the factory's contract: construction with `{ threshold, onSpeaking, onSilence, onError }` and the returned `{ start(micDeviceId), stop(), setThreshold(v) }` (call sites: `ReadView.jsx:141-148` on mount, `ReadView.jsx:59-69` on device change, `ReadView.jsx:166` cleanup). A recognizer-based engine (e.g. Web Speech API, or a Rust-side Whisper/`SFSpeechRecognizer` streaming words over a Tauri event) can implement the same surface plus a new callback such as `onWordMatched(tokenIndex)`. Keep the existing RMS/band gate as a cheap front-end VAD if desired — `isVoiceFrequency` (`mic.js:17-38`) is self-contained.

2. **The scroll-application seam — the RAF loop in `src/views/ReadView.jsx:118-138`.** All scrolling reduces to writing `scrollPosRef.current` and setting `transform: translateY(...)` on `scriptTextRef` (the wheel handler at `ReadView.jsx:203-209` and reset at `187-191` are the other writers). A word tracker replaces the constant-speed increment (`ReadView.jsx:127`) with position control: compute a target offset from the matched token's DOM position and ease `scrollPosRef` toward it. The mechanism for mapping token index → DOM element already exists for cue markers: per-token refs collected into `markerRefs.current[i]` (`ReadView.jsx:240`) and measured with `getBoundingClientRect()` against the viewport (`checkMarkers`, `ReadView.jsx:75-86`). Extend that ref-collection to word tokens (rendered at `ReadView.jsx:247-257`) and the geometry problem is solved.

3. **The token seam — `tokenizeDoc` in `src/lib/tokenizer.js:6-42`.** The recognizer must align transcript words against the same token list ReadView renders (`const tokens = tokenizeDoc(scriptDoc)`, `ReadView.jsx:9`). Two required changes for Chinese/bilingual scripts: (i) word splitting is `text.split(/(\s+)/)` (`tokenizer.js:18`), which yields one giant "word" for unsegmented Chinese — swap in `Intl.Segmenter('zh', { granularity: 'word' })` or an equivalent segmenter, per-run by script detection for mixed text; (ii) the 130-WPM stat in `EditView.jsx:18-24` shares the same whitespace assumption.

   Supporting plumbing if the recognizer needs configuration or runs natively: add fields to `Config` (`lib.rs:74-83`) + the patch matcher in `set_config` (`lib.rs:289-296`) + store defaults (`store/index.js:7-16`) + a control in `SettingsView.jsx`; register any new Rust command in `invoke_handler` (`lib.rs:660-670`) and add a wrapper in `src/lib/api.js`. Rust→JS streaming should follow the existing event pattern (`emit_to("prompter", ...)`, cf. `lib.rs:841`). Note the mic stream currently lives in the WebView (§3.1) — a native recognizer would open its own capture (CoreAudio/AVAudioEngine) rather than receiving audio over IPC.

### 7b. Script preprocessing before a script is loaded into the prompter

There is a single choke point where an edited script becomes the active prompter content: **`handleStart` in `src/views/EditView.jsx:77-85`**. It computes `text` and `editor.getJSON()`, then calls `setScriptText` / `setScriptDoc` (`store/index.js:24-27`) and `setView('read')`. An AI preprocessing step (cleanup, sentence segmentation, automatic `[PAUSE]`/`[BREATHE]` insertion, pinyin/translation annotation) slots in as an async transform of the Tiptap JSON between `editor.getJSON()` and `setScriptDoc`, ideally with a loading state on the "Go →" button. Because `ReadView` consumes only `scriptDoc`/`scriptText` from the store (`ReadView.jsx:8-9`), no other component needs to change.

Secondary hook options, depending on where the transform should live:

- **Token level (display-only transforms):** wrap `tokenizeDoc(scriptDoc)` at `ReadView.jsx:9` — appropriate for segmentation/annotation that shouldn't alter the saved document.
- **Persistence level (transform once, store the result):** the save path `saveCurrentScript` (`EditView.jsx:60-75`) → `API.saveScripts` → `save_scripts` command (`lib.rs:339`); preprocess before `JSON.stringify(editor.getJSON())` so the library stores the processed doc. Editor load paths that would then receive processed content: the mount effect (`EditView.jsx:48-58`) and `loadScript` (`EditView.jsx:99-111`).
- **Backend level (if preprocessing calls an LLM or heavy native code):** add a new `#[tauri::command] async fn preprocess_script(doc: String) -> Result<String, String>` in `src-tauri/src/lib.rs`, register it in the `invoke_handler` list (`lib.rs:660-670`), expose it in `src/lib/api.js`, and await it inside `handleStart`. The `Script.content`-as-JSON-string convention (`lib.rs:112`) means the command can operate on the serialized doc directly.

The cue-marker system is the natural output format for AI-inserted delivery hints: markers are plain-text tokens recognized by `MARKER_RE` (`tokenizer.js:4`) and acted on in `checkMarkers` (`ReadView.jsx:87-113`), so a preprocessor only needs to inject ` [PAUSE] ` text nodes — no renderer changes. Adding new marker types requires touching only `MARKER_RE`, the `checkMarkers` dispatch, and (optionally) the editor toolbar list (`EditView.jsx:16`).
