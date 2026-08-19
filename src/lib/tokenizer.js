// Converts Tiptap JSON doc → flat token array for word-by-word rendering
// Token: { type: 'word'|'marker'|'newline', text, bold, color, marker, cjk, spaceAfter }
//
// CJK text has no spaces, so runs of CJK ideographs are split into one token
// per character (cjk: true) — this is what lets the speech-tracking cursor
// match Mandarin scripts character-by-character. Latin runs embedded in CJK
// text ("我们的React项目") stay together as single word tokens.

const MARKER_RE = /^\[(PAUSE|SLOW|BREATHE)\]$/i

// CJK Unified Ideographs, Extension A, and compatibility ideographs.
// Deliberately excludes CJK punctuation (、。！ etc.) — punctuation stays
// attached to its neighbor token and is ignored by matcher normalization.
export const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/

// Split a whitespace-delimited chunk into word pieces: each CJK ideograph is
// its own piece; contiguous non-CJK characters stay together.
export function splitCJK(chunk) {
  const out = []
  let latin = ''
  for (const ch of chunk) {
    if (CJK_RE.test(ch)) {
      if (latin) { out.push(latin); latin = '' }
      out.push(ch)
    } else {
      latin += ch
    }
  }
  if (latin) out.push(latin)
  return out
}

// Explicit text colors that can become invisible against a theme background
// (white text / light theme, black text / dark theme) are treated as "no
// color set" — the text falls back to the theme's default script color.
// Covers legacy docs saved when a White swatch existed.
const NEUTRAL_COLOR_RE = /^(#fff(f{3})?|#000(0{3})?|white|black|transparent|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,[^)]*)?\)|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(,[^)]*)?\))$/

export function sanitizeColor(color) {
  if (!color) return null
  return NEUTRAL_COLOR_RE.test(String(color).trim().toLowerCase()) ? null : color
}

// Walk a Tiptap doc and drop neutral (invisible-risk) color marks so loaded
// content is theme-safe in the editor as well as the read view.
export function sanitizeDocColors(node) {
  if (!node || typeof node !== 'object') return node
  const out = { ...node }
  if (Array.isArray(out.marks)) {
    out.marks = out.marks.filter(m =>
      !(m.type === 'textStyle' && m.attrs && 'color' in m.attrs && sanitizeColor(m.attrs.color) === null)
    )
    if (!out.marks.length) delete out.marks
  }
  if (Array.isArray(out.content)) out.content = out.content.map(sanitizeDocColors)
  return out
}

export function tokenizeDoc(doc) {
  const tokens = []

  function walkNode(node) {
    if (!node) return

    if (node.type === 'text') {
      const text = node.text || ''
      const isBold = node.marks?.some(m => m.type === 'bold') ?? false
      const color = sanitizeColor(node.marks?.find(m => m.type === 'textStyle')?.attrs?.color ?? null)

      // Split into words preserving markers
      const words = text.split(/(\s+)/)
      for (const word of words) {
        if (!word || /^\s+$/.test(word)) continue
        const markerMatch = word.match(MARKER_RE)
        if (markerMatch) {
          tokens.push({ type: 'marker', text: word, marker: markerMatch[1].toUpperCase() })
          continue
        }
        // Only the last piece of a whitespace-delimited chunk had whitespace
        // after it in the source — pieces split out of the middle of a chunk
        // (CJK chars, embedded Latin runs) must render with no gap.
        const pieces = splitCJK(word)
        pieces.forEach((piece, pi) => {
          tokens.push({
            type: 'word',
            text: piece,
            bold: isBold,
            color,
            cjk: CJK_RE.test(piece),
            spaceAfter: pi === pieces.length - 1,
          })
        })
      }
      return
    }

    if (node.type === 'paragraph') {
      if (node.content) node.content.forEach(walkNode)
      tokens.push({ type: 'newline' })
      return
    }

    if (node.content) node.content.forEach(walkNode)
  }

  if (doc?.content) doc.content.forEach(walkNode)
  return tokens
}
