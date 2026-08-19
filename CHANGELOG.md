# Changelog

## v1.0.0 — 2026-08-19

First release of **Bilingual AI Teleprompter**, a fork of
[openTeleprompt](https://github.com/ArunNGun/openTeleprompt) by
[ArunNGun](https://github.com/ArunNGun) (MIT). Version numbering restarts at
1.0.0 for the fork; the upstream base is openTeleprompt v3.0.0.

### Inherited from openTeleprompt v3.0.0

- Dynamic Island notch overlay with real concave corners and Apple spring
  physics; classic draggable-pill mode for Macs without a notch
- Voice-activated scrolling via frequency analysis (85–3400 Hz) — retained
  in this fork as the fallback engine
- React + Vite + Zustand frontend; Tauri v2 / Rust backend
- Rich text script editor (Tiptap): bold, color highlights, and
  `[PAUSE]` / `[SLOW]` / `[BREATHE]` cue markers
- Script library with auto-save (local only — no cloud, no accounts)
- Invisible during screen share (Zoom, Meet, Loom)
- Light & dark themes, opacity control, live speed/font-size controls,
  global shortcuts (⌘⇧Space, ⌘⇧↑↓, ⌘⇧R)

### New in this fork

**Word-level speech tracking (English + Mandarin)**

- On-device speech recognition (Apple Speech framework, via a supervised
  Swift sidecar) replaces volume-only activation: the prompter recognizes
  what you say, dims spoken text, highlights the current word, and drives
  the scroll from your actual reading position
- English (`en-US`) and Mandarin (`zh-CN`), selectable in settings; Chinese
  is matched per character, and mixed Chinese-English scripts are handled
- Forward-only cursor matching tolerates skipped words, fillers, and
  misreads; never jumps backward
- Fully private: `requiresOnDeviceRecognition` is enforced — no audio or
  transcripts leave the machine
- Graceful degradation to the original frequency-based activation when
  Speech permission is denied or the language model is unavailable, with a
  clear status message in settings

**Prepare with AI (optional)**

- "✦ Prepare" rewrites a raw script (English or Chinese) into teleprompter
  form: short lines for the narrow panel, natural spoken phrasing, and cue
  markers at rhetorically appropriate points; Chinese lines break at
  prosodic boundaries
- Side-by-side review (original vs editable prepared text) with
  Accept/Reject; the original is saved to the library before any replace
- Two providers: Anthropic API (key stored in the macOS Keychain, never in
  plaintext config) or any local OpenAI-compatible endpoint (e.g. Ollama)
  for offline use
- Strictly opt-in: off by default, and scripts are sent only on explicit
  user action

**Fixes and maintenance**

- Visual snapshot suite repaired: the harness navigated to URL states the
  app never read, so non-idle states were untestable; browser-only test
  hooks added and coverage extended from 6 to 10 states (AI review panel,
  word-tracking read view). `puppeteer-core` declared as the dev dependency
  the harness always required
- CJK-aware tokenizer: Chinese script text is tokenized per character with
  original spacing preserved (upstream treated an unsegmented Chinese
  paragraph as one giant word)
- 50 unit tests (vitest) covering the tokenizer, cursor matcher, and AI
  prompt/parsing logic, including mixed-language cases
- Release workflow rebuilt for this repository; sidecar cross-compilation
  wired for CI (Intel builds on Apple Silicon runners)

### Attribution

All upstream functionality is the work of the original author. See
[NOTICE](NOTICE) and [LICENSE](LICENSE); the full upstream commit history is
preserved in this repository.
