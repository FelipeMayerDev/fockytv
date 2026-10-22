const lrcTime = /^\[(\d+):(\d+)(?:[.:](\d+))?\]/gm
export function parseLrc (lrc) {
  const lines = []
  for (const raw of lrc.split("\n")) {
    lrcTime.lastIndex = 0
    const stamps = []
    let m, text = raw
    while ((m = lrcTime.exec(raw))) stamps.push(+m[1] * 60 + +m[2] + (+((m[3] ?? "0").padEnd(3, "0")) / 1000))
    text = raw.replace(lrcTime, "").trim()
    if (!text) continue
    for (const t of stamps) lines.push({ t, text })
  }
  return lines.sort((a, b) => a.t - b.t)
}

// Duas letras concordam se a mediana da diferença nas linhas em comum fica abaixo de 1 s.
function agree (a, b) {
  const times = new Map(b.map(l => [l.text.toLowerCase(), l.t]))
  const diffs = a.flatMap(l => times.has(l.text.toLowerCase()) ? [Math.abs(l.t - times.get(l.text.toLowerCase()))] : []).sort((x, y) => x - y)
  return diffs.length >= 3 && diffs[diffs.length >> 1] < 1
}

// Escolhe entre os hits do LRCLIB que já passaram na tolerância de duração.
// Mesma duração: vence a letra que mais concorda com as outras (o LRCLIB tem
// envios com tempos errados). Vídeo mais longo que a letra: clipe com introdução.
export function pickLyrics (hits, duration) {
  const parsed = [...new Map(hits.map(hit => [hit.id, hit])).values()].map(hit => ({ hit, lines: parseLrc(hit.syncedLyrics) }))
  const score = p => parsed.filter(o => o !== p && agree(p.lines, o.lines)).length
  const best = parsed
    .map(p => ({ ...p, off: Math.round(Math.abs(p.hit.duration - duration)), score: score(p) }))
    .sort((a, b) => a.off - b.off || b.score - a.score)[0]
  if (!best?.lines.length) return null
  // ponytail: supõe que o tempo a mais do vídeo é introdução; outro no fim atrasa a letra. Alinhar pelo áudio se incomodar.
  const intro = duration - best.hit.duration
  return intro > 2 ? best.lines.map(l => ({ ...l, t: l.t + intro })) : best.lines
}
