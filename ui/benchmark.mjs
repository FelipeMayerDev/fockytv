import { videoSample } from './benchmark-stats.mjs?v=1'

const $ = selector => document.querySelector(selector)
let source = null, session = null, busy = false, animation = null
const runs = []
$('#api-url').value = location.origin

function controls() {
  $('#setup').querySelectorAll('input, select, button').forEach(el => { el.disabled = busy || !!session })
  $('#stop').disabled = busy || !session
  $('#release').disabled = busy || !!session || !source
  $('#export').disabled = busy || !runs.some(run => run.samples.length)
}

function endpoint(value, protocols) {
  const url = new URL(value)
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use uma URL de servidor sem credenciais, parâmetros ou fragmentos.')
  return url.href.replace(/\/$/, '')
}

function releaseSource() {
  cancelAnimationFrame(animation)
  source?.getTracks().forEach(track => track.stop())
  source = null
  $('#video').srcObject = null
  controls()
}

async function prepareSource() {
  releaseSource()
  if ($('#source').value === 'pattern') {
    const canvas = document.createElement('canvas')
    canvas.width = 1920
    canvas.height = 1080
    const ctx = canvas.getContext('2d')
    const draw = time => {
      ctx.fillStyle = '#101820'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < 80; i++) {
        ctx.fillStyle = `hsl(${i * 37 % 360} 75% 55%)`
        ctx.fillRect((time * (i % 5 + 1) / 8 + i * 173) % 1920, i * 103 % 1080, 100, 70)
      }
      ctx.fillStyle = '#ffffff'
      ctx.font = '48px monospace'
      ctx.fillText(`1080p60 · ${Math.round(time)} ms`, 30, 70)
      animation = requestAnimationFrame(draw)
    }
    draw(performance.now())
    source = canvas.captureStream(60)
  } else {
    source = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 60, max: 60 } },
      audio: false,
    })
  }
  source.getVideoTracks()[0].contentHint = 'motion'
  source.getVideoTracks()[0].addEventListener('ended', () => {
    stop()
    releaseSource()
  }, { once: true })
  $('#video').srcObject = source
  await $('#video').play()
  const settings = source.getVideoTracks()[0].getSettings()
  $('#status').textContent = `Fonte preparada: ${settings.width} × ${settings.height}, pedido de ${settings.frameRate ?? 60} fps. Mantenha esta fonte entre os testes.`
}

async function signal(connection, path, base, key) {
  await connection.setLocalDescription(await connection.createOffer())
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Tempo esgotado na coleta ICE.')), 10_000)
    const finish = error => {
      clearTimeout(timer)
      connection.removeEventListener('icegatheringstatechange', changed)
      error ? reject(error) : resolve()
    }
    const changed = () => { if (connection.iceGatheringState === 'complete') finish() }
    connection.addEventListener('icegatheringstatechange', changed)
    changed()
  })
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${key}` },
    body: connection.localDescription.sdp, signal: AbortSignal.timeout(20_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(body.trim() || `Sinalização: HTTP ${response.status}`)
  const location = response.headers.get('Location')
  if (!location) throw new Error('Servidor não informou o recurso da sessão.')
  const resource = new URL(location, base)
  if (resource.origin !== new URL(base).origin) throw new Error('Recurso de sessão fora do servidor escolhido.')
  session.resource = resource.href
  await connection.setRemoteDescription({ type: 'answer', sdp: body })
}

function tuneReceiver(receiver) {
  const buffer = session.run.requested.jitterBufferMs
  if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = buffer
  else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = buffer / 1000
}

async function start(role) {
  if (!$('#setup').reportValidity()) return
  const engine = $('#engine').value
  const bitrate = Number($('#bitrate').value) * 1_000_000
  const jitterBufferMs = Number($('#buffer').value)
  const key = $('#room').value
  if (!/^compare-[\w.-]{1,24}$/.test(key)) throw new Error('Use uma sala começando com compare- (até 32 caracteres).')
  if (role === 'publisher' && !source) throw new Error('Prepare a fonte antes de transmitir.')
  const run = { engine, role, room: key, startedAt: new Date().toISOString(), requested: { width: 1920, height: 1080, fps: 60, codec: 'h264', maxBitrate: bitrate, jitterBufferMs, simulcast: false }, samples: [] }
  if (role === 'publisher') {
    const settings = source.getVideoTracks()[0].getSettings()
    run.capture = { width: settings.width, height: settings.height, frameRate: settings.frameRate, source: $('#source').value }
  }
  session = { run, key, previous: null, timer: null }
  runs.push(run)
  try {
    if (engine === 'mediamtx') {
      const base = endpoint($('#api-url').value, ['http:', 'https:'])
      const connection = new RTCPeerConnection()
      session.pc = connection
      session.stats = () => connection.getStats()
      connection.addEventListener('connectionstatechange', () => {
        if (session?.pc === connection) $('#status').textContent = `MediaMTX: ${connection.connectionState}`
      })
      if (role === 'publisher') {
        session.track = source.getVideoTracks()[0].clone()
        session.track.contentHint = 'motion'
        const sender = connection.addTrack(session.track, source)
        const codecs = RTCRtpSender.getCapabilities('video').codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264')
        if (!codecs.length) throw new Error('Este navegador não oferece H.264 para WebRTC.')
        connection.getTransceivers()[0].setCodecPreferences(codecs)
        const parameters = sender.getParameters()
        parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]
        Object.assign(parameters.encodings[0], { maxBitrate: bitrate, maxFramerate: 60, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' })
        parameters.degradationPreference = 'maintain-framerate'
        await sender.setParameters(parameters)
      } else {
        const transceiver = connection.addTransceiver('video', { direction: 'recvonly' })
        tuneReceiver(transceiver.receiver)
        connection.addEventListener('track', event => {
          if (session?.pc !== connection) return
          $('#video').srcObject = new MediaStream([event.track])
          $('#video').play().catch(error => { $('#error').textContent = error.message })
        })
      }
      await signal(connection, role === 'publisher' ? '/api/whip' : '/api/whep?viewer=benchmark', base, key)
      if (role === 'publisher') {
        // WHIP aceita a sessão antes de ICE/RTP tornar a stream disponível ao WHEP.
        const deadline = Date.now() + 20_000
        while (true) {
          const response = await fetch(base + '/api/status', { signal: AbortSignal.timeout(5000) })
          if (!response.ok) throw new Error(`Disponibilidade da transmissão: HTTP ${response.status}`)
          const streams = await response.json()
          if (streams.some(stream => stream.streamKey === key && stream.videoTracks?.length)) break
          if (Date.now() >= deadline) throw new Error('A sessão WHIP abriu, mas o vídeo não chegou ao servidor em 20 segundos.')
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
    } else {
      const url = endpoint($('#livekit-url').value, ['ws:', 'wss:'])
      const token = $('#token').value.trim()
      if (!token) throw new Error('Cole o token LiveKit da sua função.')
      const sdk = window.LivekitClient
      if (!sdk) throw new Error('SDK ausente: execute npm run build:benchmark na raiz do projeto.')
      const room = new sdk.Room({ adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: false })
      session.room = room
      room.on(sdk.RoomEvent.ConnectionStateChanged, state => {
        if (session?.room === room) $('#status').textContent = `LiveKit: ${state}`
      })
      room.on(sdk.RoomEvent.TrackSubscribed, track => {
        if (session?.room !== room || track.kind !== sdk.Track.Kind.Video) return
        session.stats = () => track.getRTCStatsReport()
        tuneReceiver(track.receiver)
        track.attach($('#video'))
        $('#video').play().catch(error => { $('#error').textContent = error.message })
      })
      await room.connect(url, token, { autoSubscribe: role === 'viewer' })
      if (room.name !== key) throw new Error('O token não pertence à sala escolhida.')
      if (role === 'publisher') {
        session.track = source.getVideoTracks()[0].clone()
        session.track.contentHint = 'motion'
        const publication = await room.localParticipant.publishTrack(session.track, {
          source: sdk.Track.Source.ScreenShare, videoCodec: 'h264', simulcast: false,
          screenShareEncoding: { maxBitrate: bitrate, maxFramerate: 60, priority: 'high' },
          degradationPreference: 'maintain-framerate',
        })
        session.stats = () => publication.track.getRTCStatsReport()
      }
    }
    $('#status').textContent = `${engine === 'livekit' ? 'LiveKit' : 'MediaMTX'}: ${role === 'publisher' ? 'transmitindo' : 'assistindo'}. Colete pelo menos 60 segundos.`
    sample(session)
  } catch (error) {
    run.error = error.message
    stop()
    throw error
  }
}

async function sample(active) {
  if (!active || session !== active) return
  try {
    const report = await active.stats?.()
    if (session !== active) return
    const result = report && videoSample(report, active.run.role === 'publisher' ? 'outbound' : 'inbound', active.previous)
    if (result) {
      active.previous = result.raw
      active.run.samples.push({ elapsedSeconds: (Date.now() - Date.parse(active.run.startedAt)) / 1000, ...result.metrics })
      $('#metrics').textContent = JSON.stringify(result.metrics, null, 2)
      controls()
    }
  } catch (error) {
    if (session === active) $('#error').textContent = `Medição: ${error.message}`
  }
  if (session === active) active.timer = setTimeout(() => sample(active), 1000)
}

function stop() {
  const active = session
  session = null
  if (active) {
    clearTimeout(active.timer)
    active.run.stoppedAt = new Date().toISOString()
    if (active.resource) fetch(active.resource, { method: 'DELETE', headers: { Authorization: `Bearer ${active.key}` }, keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => {})
    active.pc?.close()
    active.room?.disconnect(false).catch(() => {})
    active.track?.stop()
  }
  $('#video').srcObject = source
  $('#video').play().catch(() => {})
  $('#status').textContent = 'Teste parado. A fonte está disponível para o próximo caminho.'
  controls()
}

async function action(fn) {
  if (busy) return
  busy = true
  $('#error').textContent = ''
  controls()
  try { await fn() } catch (error) { $('#error').textContent = error.message }
  finally { busy = false; controls() }
}

$('#engine').onchange = () => {
  const livekit = $('#engine').value === 'livekit'
  $('#livekit-config').hidden = !livekit
  $('#mediamtx-config').hidden = livekit
  $('#api-url').required = !livekit
  $('#token').required = livekit
  $('#livekit-url').required = livekit
}
$('#capture').onclick = () => action(prepareSource)
$('#publish').onclick = () => action(() => start('publisher'))
$('#watch').onclick = () => action(() => start('viewer'))
$('#stop').onclick = stop
$('#release').onclick = releaseSource
$('#setup').onsubmit = event => event.preventDefault()
$('#export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ userAgent: navigator.userAgent, runs }, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'fockytv-comparacao.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
window.addEventListener('pagehide', () => { stop(); releaseSource() })
controls()
