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
