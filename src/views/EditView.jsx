import { useEffect, useState, useCallback } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { useAppStore } from '../store'
import { API } from '../lib/api'
import { mapAiError, preparedTextToDoc, prepareScript } from '../lib/ai'

const COLORS = [
  { label: 'White',  value: '#ffffff' },
  { label: 'Yellow', value: '#facc15' },
  { label: 'Green',  value: '#4ade80' },
  { label: 'Blue',   value: '#60a5fa' },
  { label: 'Red',    value: '#f87171' },
]
const MARKERS = ['[PAUSE]', '[SLOW]', '[BREATHE]']

function computeStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  if (!words) return ''
  const secs = Math.round((words / 130) * 60)
  const timeStr = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${words} words · ~${timeStr} at 130 WPM`
}

export default function EditView() {
  const {
    setView, scripts, setScripts,
    currentScriptIndex, setCurrentScriptIndex,
    setScriptText, setScriptDoc, config,
  } = useAppStore()

  const isClassic = config?.mode === 'classic'
  const [stats, setStats] = useState('')
  // Prepare-with-AI state: explicit user action only, never automatic
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [review, setReview] = useState(null) // { originalDoc, originalText, prepared }

  const editor = useEditor({
    extensions: [StarterKit, TextStyle, Color],
    content: '<p></p>',
    editorProps: {
      attributes: { class: 'tiptap-editor', spellcheck: 'true' },
    },
    onUpdate({ editor }) {
      setStats(computeStats(editor.getText()))
    },
  })

  // Demo/test hook (snap.mjs + TELEPROMPTER_DEMO_PARAMS): ?aireview=1 renders
  // the Prepare-with-AI review panel with fixed sample content
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('aireview')) return
    const originalText =
      'Hello everyone, today I want to give you an update on our project. ' +
      '我们的项目进展非常顺利，团队在过去六个月里完成了核心功能的开发。'
    setReview({
      originalDoc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: originalText }] }] },
      originalText,
      prepared:
        'Hello everyone [PAUSE]\ntoday I want to give you\nan update on our project\n\n' +
        '我们的项目\n进展非常顺利 [SLOW]\n团队在过去六个月里\n完成了核心功能的开发',
    })
  }, [])

  // Load script when editor is ready
  useEffect(() => {
    if (!editor) return
    const script = scripts[currentScriptIndex]
    if (!script) return
    try {
      editor.commands.setContent(JSON.parse(script.content))
    } catch {
      editor.commands.setContent(`<p>${script.text || ''}</p>`)
    }
    setStats(computeStats(script.text || ''))
  }, [editor])

  const saveCurrentScript = useCallback(() => {
    if (!editor) return
    const text = editor.getText().trim()
    if (!text) return
    const name = text.split('\n')[0].substring(0, 40) || 'Untitled'
    const content = JSON.stringify(editor.getJSON())
    const updated = [...scripts]
    if (currentScriptIndex >= 0) {
      updated[currentScriptIndex] = { ...updated[currentScriptIndex], name, text, content }
    } else {
      updated.unshift({ name, text, content })
      setCurrentScriptIndex(0)
    }
    setScripts(updated)
    API.saveScripts(updated)
  }, [editor, scripts, currentScriptIndex])

  function handleStart() {
    if (!editor) return
    const text = editor.getText().trim()
    if (!text) return
    saveCurrentScript()
    setScriptText(text)
    setScriptDoc(editor.getJSON())
    setView('read')
  }

  function handleCollapse() {
    API.setIgnoreMouse(false)
    setView('idle')
  }

  function handleNew() {
    setCurrentScriptIndex(-1)
    editor?.commands.setContent('<p></p>')
    editor?.commands.focus()
    setStats('')
  }

  function loadScript(i) {
    setCurrentScriptIndex(i)
    if (!editor) return
    const script = scripts[i]
    if (!script) return
    try {
      editor.commands.setContent(JSON.parse(script.content))
    } catch {
      editor.commands.setContent(`<p>${script.text || ''}</p>`)
    }
    setStats(computeStats(script.text || ''))
    editor.commands.focus()
  }

  function deleteScript(e, i) {
    e.stopPropagation()
    const updated = scripts.filter((_, idx) => idx !== i)
    setScripts(updated)
    API.saveScripts(updated)
    if (currentScriptIndex >= i) setCurrentScriptIndex(Math.max(-1, currentScriptIndex - 1))
  }

  function insertMarker(marker) {
    editor?.chain().focus().insertContent(` ${marker} `).run()
  }

  // ── Prepare with AI ─────────────────────────────────────
  async function handlePrepare() {
    if (!editor || aiBusy) return
    const text = editor.getText().trim()
    if (!text) return
    if (!config?.aiProvider) {
      // No provider configured — open settings, which has setup instructions
      setAiError('Set up an AI provider in Settings → Prepare with AI first.')
      API.openSettings()
      return
    }
    setAiError('')
    setAiBusy(true)
    try {
      const prepared = await prepareScript(text)
      setReview({ originalDoc: editor.getJSON(), originalText: text, prepared })
    } catch (e) {
      const mapped = mapAiError(e)
      setAiError(mapped.message)
      if (mapped.needsSetup) API.openSettings()
    } finally {
      setAiBusy(false)
    }
  }

  function acceptReview() {
    if (!editor || !review) return
    // Never silently overwrite: the pre-preparation script is saved to the
    // library as its own entry before the editor content is replaced.
    const firstLine = review.originalText.split('\n')[0].substring(0, 32) || 'Untitled'
    const backup = {
      name: `${firstLine} · original`,
      text: review.originalText,
      content: JSON.stringify(review.originalDoc),
    }
    const updated = [...scripts, backup]
    setScripts(updated)
    API.saveScripts(updated)

    editor.commands.setContent(preparedTextToDoc(review.prepared))
    setStats(computeStats(editor.getText()))
    setReview(null)
  }

  function rejectReview() {
    setReview(null)
  }

  function setColor(color) {
    editor?.chain().focus().setColor(color).run()
  }

  // ── Review mode: side-by-side original vs prepared ──────
  if (review) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="edit-header">
          <button className="pill-btn ghost" onClick={rejectReview}>✕</button>
          <span className="view-title">Review AI Prep</span>
          <button className="pill-btn ghost" onClick={rejectReview}>Reject</button>
          <button className="pill-btn accent" onClick={acceptReview}>Accept</button>
        </div>
        <div id="ai-review">
          <div className="ai-col">
            <div className="ai-col-title">Original (kept in library)</div>
            <div className="ai-original">{review.originalText}</div>
          </div>
          <div className="ai-col">
            <div className="ai-col-title">Prepared — edit before accepting</div>
            <textarea
              className="ai-prepared"
              value={review.prepared}
              onChange={e => setReview({ ...review, prepared: e.target.value })}
              spellCheck={false}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="edit-header">
        <button className="pill-btn ghost" onClick={handleCollapse}>✕</button>
        <span className="view-title">Script</span>
        <button className="pill-btn ghost" onClick={handlePrepare} disabled={aiBusy} title="Prepare for Prompter with AI">
          {aiBusy ? 'Preparing…' : '✦ Prepare'}
        </button>
        <button className="pill-btn ghost" onClick={handleNew}>+ New</button>
        <button className="pill-btn ghost" onClick={saveCurrentScript}>Save</button>
        <button className="pill-btn accent" onClick={handleStart}>Go →</button>
        <button className="pill-btn ghost edit-quit" onClick={() => API.quit()} title="Quit app" aria-label="Quit app">⏻</button>
      </div>

      {aiError && <div id="ai-error">{aiError}</div>}

      {/* Script list */}
      {scripts.length > 0 && (
        <div id="script-list">
          {scripts.map((s, i) => (
            <div key={i} className={`script-item${i === currentScriptIndex ? ' active' : ''}`}>
              <span className="script-name" onClick={() => loadScript(i)}>{s.name}</span>
              <button className="script-del" onClick={(e) => deleteScript(e, i)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="tiptap-toolbar">
        <button
          className={`tb-btn${editor?.isActive('bold') ? ' active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); editor?.chain().focus().toggleBold().run() }}
          title="Bold"
        ><strong>B</strong></button>

        <div className="tb-divider" />

        {COLORS.map((c) => (
          <button
            key={c.value}
            className="tb-color"
            style={{ background: c.value }}
            onMouseDown={(e) => { e.preventDefault(); setColor(c.value) }}
            title={c.label}
          />
        ))}
        <button
          className="tb-btn"
          onMouseDown={(e) => { e.preventDefault(); editor?.chain().focus().unsetColor().run() }}
          title="Clear color"
        >✕</button>

        <div className="tb-divider" />

        {MARKERS.map((m) => (
          <button
            key={m}
            className="tb-marker"
            onMouseDown={(e) => { e.preventDefault(); insertMarker(m) }}
            title={`Insert ${m}`}
          >{m}</button>
        ))}
      </div>

      {/* Editor */}
      <div className="tiptap-wrap">
        <EditorContent editor={editor} />
      </div>

      {/* Stats */}
      <div id="script-stats">{stats}</div>
    </div>
  )
}
