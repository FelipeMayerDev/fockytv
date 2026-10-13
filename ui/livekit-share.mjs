// Transporte usado pelo Fluxer; os filtros de captura continuam antes da publicação.
export function shareOptions(track, fps, codec) {
  const { width = 1920, height = 1080 } = track.getSettings()
  const pixels = width * height
  // teto fixo de 32 Mbps (o do antes da migração): o perfil do Fluxer (6 Mbps
  // em 1080p60) deixava a tela borrada. O Chrome só usa o que o GCC deixar.
  const maxBitrate = 32_000_000
  return {
    videoCodec: codec.replace('video/', '').toLowerCase(), simulcast: false,
    ...( /av1|vp9/i.test(codec) ? { scalabilityMode: 'L1T3' } : {} ),
    screenShareEncoding: { maxBitrate, maxFramerate: fps, priority: 'high' },
    degradationPreference: pixels >= 3840*2160 || fps < 60 ? 'maintain-resolution' : 'maintain-framerate',
  }
}

export async function connectShare(base, key, role, viewer, videoEl, tuneReceiver, stream, fps, codec) {
  const sdk = window.LivekitClient
  if (!sdk) throw new Error('SDK LiveKit ausente. Execute npm run build:benchmark.')
  const response = await fetch(base + '/api/livekit/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: key, role, viewer }), signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error((await response.text()).trim())
  const { token, path } = await response.json()
  const url = new URL(base || location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = path
  const room = new sdk.Room({ adaptiveStream: false, dynacast: true, stopLocalTrackOnUnpublish: false })
  const remote = new Set(), local = new Map(), media = new MediaStream()
  let closed = false
  const session = {
    livekit: true,
    get connectionState() { return closed ? 'closed' : room.state === 'disconnected' ? 'failed' : room.state },
    getReceivers: () => [...remote].map(t => t.receiver).filter(Boolean),
    async getStats() {
      const reports = await Promise.all([...local.values(), ...remote].map(t => t.getRTCStatsReport?.()))
      const out = new Map()
      reports.forEach(report => report?.forEach((v,k) => out.set(k,v)))
      return out
    },
    close() { closed = true; remote.clear(); room.disconnect(false).catch(console.warn); if (videoEl?.srcObject === media) videoEl.srcObject = null },
  }
  room.on(sdk.RoomEvent.TrackSubscribed, track => {
    remote.add(track); if (track.receiver) tuneReceiver(track.receiver)
    media.addTrack(track.mediaStreamTrack); videoEl.srcObject = media; videoEl.play?.().catch(() => {})
  })
  room.on(sdk.RoomEvent.TrackUnsubscribed, track => { remote.delete(track); media.removeTrack(track.mediaStreamTrack) })
  function sender(kind) {
    return {
      get track() { return local.get(kind)?.mediaStreamTrack },
      async replaceTrack(track) {
        const previous = local.get(kind)
        if (!track) {
          if (previous) await room.localParticipant.unpublishTrack(previous, false)
          local.delete(kind); return
        }
        if (previous) { await previous.replaceTrack(track, true); return }
        const options = kind === 'video'
          ? { ...shareOptions(track, fps, codec), source: sdk.Track.Source.ScreenShare }
          : { source: sdk.Track.Source.ScreenShareAudio, audioPreset: sdk.AudioPresets.musicHighQualityStereo, dtx: false, red: true, forceStereo: true }
        const publication = await room.localParticipant.publishTrack(track, options)
        local.set(kind, publication.track)
      },
    }
  }
  session.videoSender = sender('video'); session.audioSender = sender('audio')
  try {
    await room.connect(url.href, token, { autoSubscribe: role === 'viewer' })
    if (role === 'publisher') {
      const track = stream.getVideoTracks()[0]; track.contentHint = 'motion'
      await session.videoSender.replaceTrack(track)
      const audio = stream.getAudioTracks()[0]; if (audio) await session.audioSender.replaceTrack(audio)
    }
    return session
  } catch (error) { session.close(); throw error }
}
