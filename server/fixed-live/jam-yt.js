import { spawn } from "node:child_process"

// Relógio da watch party no mesmo protocolo yt do jam. Nunca usa o relógio do cliente.
export function jamYtState (now = Date.now) {
  let state = null
  const snapshot = () => state && ({ ...state, action: 'state', pos: state.pos + (state.playing ? Math.max(0, now() - state.at) / 1000 : 0), at: now() })
  return {
    snapshot,
    command (msg, from) {
      if (typeof msg.videoId !== 'string' || !/^[\w-]{11}$/.test(msg.videoId)) return null
      if (msg.action === 'load') {
        state = { type: 'yt', action: 'state', videoId: msg.videoId, playing: true, pos: 0, at: now(), from }
      } else {
        if (!state || msg.videoId !== state.videoId || !['state', 'seek'].includes(msg.action) ||
            typeof msg.playing !== 'boolean' || !Number.isFinite(msg.pos) || msg.pos < 0 || msg.pos > 86400) return null
        state = { ...state, pos: msg.pos, playing: msg.playing, at: now(), from }
      }
      return snapshot()
    }
  }
}

// MP4 fragmentado permite juntar as faixas sem arquivo temporário nem recodificação.
export function muxYt (video, audio, res, start = spawn) {
  const process = start('ffmpeg', ['-nostdin', '-loglevel', 'error', '-rw_timeout', '30000000', '-i', video,
    '-rw_timeout', '30000000', '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const fail = () => {
    if (!res.headersSent) res.status(502).json({ error: 'Não deu para juntar vídeo e áudio.' })
    else res.destroy()
  }
  const timer = setTimeout(() => { process.kill('SIGKILL'); fail() }, 180_000)
  process.on('error', fail)
  process.on('close', code => { clearTimeout(timer); if (code !== 0 && !res.destroyed) fail() })
  res.on('close', () => { clearTimeout(timer); process.kill('SIGKILL') })
  res.setHeader('content-type', 'video/mp4')
  process.stdout.pipe(res)
}
