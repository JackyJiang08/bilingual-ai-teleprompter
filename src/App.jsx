import { useEffect, useRef, useState } from 'react'
import { useAppStore } from './store'
import { API } from './lib/api'
import IdleView from './views/IdleView'
import EditView from './views/EditView'
import ReadView from './views/ReadView'

// Island sizes — 20px side + bottom bleed so box-shadow renders fully
const SB = 20
const BB = 20
const ISLAND_SIZES = {
  idle:      { w: 213,          h: 38       },
  idleHover: { w: 236,          h: 48       },
  edit:      { w: 560 + SB * 2, h: 340 + BB },
  read:      { w: 440 + SB * 2, h: 205 + BB },
}
// Classic: window = island size exactly, OS handles shadow
const CLASSIC_SIZES = {
  idle:      { w: 240, h: 80  },
  idleHover: { w: 260, h: 88  },
  edit:      { w: 580, h: 360 },
  read:      { w: 460, h: 240 },
}

// Sample script for browser-only visual tests (?view=read): exercises
// English, mixed-script, and Chinese rendering plus cue markers
const DEMO_DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Welcome to the bilingual teleprompter demo.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '我们的React项目 launches today [PAUSE] stay tuned.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '今天天气很好 我们出去走走 [BREATHE] 慢慢来。' }] },
  ],
}

export default function App() {
  const { view, config, setConfig, setScripts, setView, setScriptDoc, setScriptText } = useAppStore()
  // ?hoverdemo=1 (demo/test hook) starts the pill in its hover state.
  // Params are only ever present via the snapshot harness (browser) or the
  // dev-only TELEPROMPTER_DEMO_PARAMS env var (screenshot captures in Tauri).
  const [isHovered, setIsHovered] = useState(() =>
    new URLSearchParams(window.location.search).has('hoverdemo'))
  const isClassic = config.mode === 'classic'

  // ── Bootstrap ──────────────────────────────────────────────
  useEffect(() => {
    // Load config
    API.getConfig().then((cfg) => {
      if (!cfg) return
      setConfig({
        mode:        cfg.mode        ?? 'notch',
        theme:       cfg.theme       ?? 'dark',
        scrollSpeed: cfg.scrollSpeed ?? cfg.scroll_speed ?? 1,
        fontSize:    cfg.fontSize    ?? cfg.font_size    ?? 16,
        opacity:     cfg.opacity     ?? 1,
        threshold:   cfg.threshold   ?? 0.018,
        autoScroll:  cfg.autoScroll  ?? cfg.auto_scroll  ?? false,
        micDeviceId: cfg.micDeviceId ?? cfg.mic_device_id ?? 'default',
        speechLang:   cfg.speechLang   ?? cfg.speech_lang   ?? 'en-US',
        wordTracking: cfg.wordTracking ?? cfg.word_tracking ?? true,
        aiProvider:   cfg.aiProvider   ?? cfg.ai_provider   ?? '',
        aiModel:      cfg.aiModel      ?? cfg.ai_model      ?? '',
        aiLocalUrl:   cfg.aiLocalUrl   ?? cfg.ai_local_url  ?? 'http://localhost:11434',
      })
      API.setIgnoreMouse(false)
    })

    // Load scripts
    API.getScripts().then((s) => { if (s) setScripts(s) })

    // Live config updates from settings window
    API.onConfigUpdate((cfg) => {
      if (!cfg) return
      const patch = {}
      const keys = ['mode','theme','scrollSpeed','scroll_speed','opacity','threshold',
                    'autoScroll','auto_scroll','micDeviceId','mic_device_id','fontSize','font_size',
                    'speechLang','speech_lang','wordTracking','word_tracking',
                    'aiProvider','ai_provider','aiModel','ai_model','aiLocalUrl','ai_local_url']
      keys.forEach(k => { if (cfg[k] !== undefined) patch[k] = cfg[k] })
      // Normalise snake_case → camelCase
      if (patch.scroll_speed  !== undefined) { patch.scrollSpeed  = patch.scroll_speed;  delete patch.scroll_speed }
      if (patch.auto_scroll   !== undefined) { patch.autoScroll   = patch.auto_scroll;   delete patch.auto_scroll  }
      if (patch.mic_device_id !== undefined) { patch.micDeviceId  = patch.mic_device_id; delete patch.mic_device_id }
      if (patch.font_size     !== undefined) { patch.fontSize     = patch.font_size;     delete patch.font_size     }
      if (patch.speech_lang   !== undefined) { patch.speechLang   = patch.speech_lang;   delete patch.speech_lang   }
      if (patch.word_tracking !== undefined) { patch.wordTracking = patch.word_tracking; delete patch.word_tracking }
      if (patch.ai_provider   !== undefined) { patch.aiProvider   = patch.ai_provider;   delete patch.ai_provider   }
      if (patch.ai_model      !== undefined) { patch.aiModel      = patch.ai_model;      delete patch.ai_model      }
      if (patch.ai_local_url  !== undefined) { patch.aiLocalUrl   = patch.ai_local_url;  delete patch.ai_local_url  }
      if (Object.keys(patch).length) setConfig(patch)
    })

    // Global shortcut ⌘⇧E: open the script editor (explicit user action).
    // Read-mode shortcuts are handled in ReadView; this one is app-level so
    // it works from the idle pill.
    API.onShortcut((action) => {
      if (action === 'edit' && useAppStore.getState().view === 'idle') {
        setView('edit')
      }
    })

    // Probe mic permission once so browser doesn't ask mid-session
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(s => s.getTracks().forEach(t => t.stop()))
      .catch(() => {})

    // Demo/test hooks: drive view/mode/theme via URL params, e.g.
    // /?view=read&mode=notch&theme=light. Used by scripts/snap.mjs (browser)
    // and TELEPROMPTER_DEMO_PARAMS (dev-only, Tauri screenshot captures).
    // Normal launches carry no params, so this is inert in production.
    {
      const q = new URLSearchParams(window.location.search)
      const patch = {}
      if (q.get('mode')) patch.mode = q.get('mode')
      if (q.get('theme')) patch.theme = q.get('theme')
      if (Object.keys(patch).length) setConfig(patch)
      const v = q.get('view')
      if (v === 'read') {
        setScriptDoc(DEMO_DOC)
        setScriptText('Welcome to the bilingual teleprompter demo.')
      }
      if (v) setView(v)
    }
  }, [])

  // ── Side-effects from config ───────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'dark')
  }, [config.theme])

  useEffect(() => {
    document.body.classList.toggle('mode-classic', isClassic)
    API.setIgnoreMouse(false)
  }, [config.mode])

  useEffect(() => {
    document.documentElement.style.opacity = config.opacity ?? 1
  }, [config.opacity])

  // ── Window resize ──────────────────────────────────────────
  useEffect(() => {
    const sizes = isClassic ? CLASSIC_SIZES : ISLAND_SIZES
    const size  = view === 'edit' ? sizes.edit
                : view === 'read' ? sizes.read
                : isHovered       ? sizes.idleHover
                : sizes.idle
    API.resizePrompter({ width: size.w, height: size.h })
  }, [view, isHovered, config.mode])

  // ── Event handlers ─────────────────────────────────────────
  function handleMouseEnter() {
    setIsHovered(true)
    if (!isClassic) API.focusPrompter()
  }
  function handleMouseLeave() { setIsHovered(false) }
  function handleMouseDown(e) {
    if (!isClassic) return
    if (e.target.closest('button, input, textarea, select, svg')) return
    e.preventDefault()
    API.startDrag()
  }

  // ── Derived render values ──────────────────────────────────
  const isExpanded   = !isClassic && (view === 'edit' || view === 'read')
  const islandW      = view === 'edit' ? 560 : view === 'read' ? 440 : 0
  const cornerLeft   = isExpanded ? `calc(50% - ${islandW / 2}px - 20px)` : '0'
  const cornerRight  = isExpanded ? `calc(50% + ${islandW / 2}px)` : '0'
  const islandClass  = [
    isClassic       ? 'mode-classic' : '',
    view === 'edit' ? 'state-edit'   : '',
    view === 'read' ? 'state-read'   : '',
  ].filter(Boolean).join(' ')

  const isBrowser = !window.__TAURI__

  return (
    <>
      {/* Concave anti-notch corners (notch mode only) */}
      <div className={`notch-corner notch-corner-left${isExpanded ? ' visible' : ''}`}  style={{ left: cornerLeft }} />
      <div className={`notch-corner notch-corner-right${isExpanded ? ' visible' : ''}`} style={{ left: cornerRight }} />

      <div
        id="island"
        className={islandClass}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
      >
        {view === 'idle' && <IdleView isHovered={isHovered} />}
        {view === 'edit' && <EditView />}
        {view === 'read' && <ReadView />}
      </div>

      {/* Dev panel — browser only, hidden in Tauri */}
      {isBrowser && (
        <div id="dev-panel">
          <div className="dev-label">DEV</div>
          <div className="dev-row">
            <span>View</span>
            <select value={view} onChange={e => setView(e.target.value)}>
              <option value="idle">Idle</option>
              <option value="edit">Edit</option>
              <option value="read">Read</option>
            </select>
          </div>
          <div className="dev-row">
            <span>Mode</span>
            <select value={config.mode || 'notch'} onChange={e => setConfig({ mode: e.target.value })}>
              <option value="notch">Notch</option>
              <option value="classic">Classic</option>
            </select>
          </div>
          <div className="dev-row">
            <span>Theme</span>
            <select value={config.theme || 'dark'} onChange={e => setConfig({ theme: e.target.value })}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
        </div>
      )}
    </>
  )
}
