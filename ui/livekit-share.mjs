// Transporte usado pelo Fluxer; os filtros de captura continuam antes da publicação.
export function shareOptions(track, fps, codec) {
  const { width = 1920, height = 1080 } = track.getSettings()
  const pixels = width * height
  const floors = [[426*240, [300,500,700]], [854*480,[1200,2000,3000]], [1280*720,[2000,3000,4500]], [1920*1080,[3000,4500,6000]], [2560*1440,[4000,5500,6000]], [3840*2160,[4500,6000,6000]]]
  const rung = floors.filter(([size]) => size <= pixels).at(-1) ?? floors[0]
  const maxBitrate = Math.min(9_000_000, Math.max(rung[1][fps >= 60 ? 2 : fps >= 30 ? 1 : 0]*1000, Math.round(pixels*fps*0.02)))
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
      const track = stream.getVideoTracks()[0]; track.contentHint = ''
      await session.videoSender.replaceTrack(track)
      const audio = stream.getAudioTracks()[0]; if (audio) await session.audioSender.replaceTrack(audio)
    }
    return session
  } catch (error) { session.close(); throw error }
}
