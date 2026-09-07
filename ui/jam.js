// Sala de músicos: mesh P2P de áudio de alta qualidade e baixa latência.
//
// Pipeline (nada aqui passa pela pipeline de voz do navegador — sem NetEQ,
// sem AEC/NS/AGC, sem Opus mono de 32kbps):
//
//   mic (getUserMedia cru) → jam-tap (worklet) → AudioEncoder Opus estéreo
//     → RTCDataChannel unreliable (seq + payload) → [ICE P2P direto]
//     → jitter buffer (ring no jam-mix) → AudioDecoder → saída latencyHint
//       'interactive'
//
// Sinalização: WebSocket /ws/jam no fixed-live só retransmite offer/answer/ICE
// endereçado entre os peers. A mídia nunca toca o servidor.
//
// Uso: const jam = await initJam({ serverUrl }); await jam.join(room, nick, onState)

const FRAME_MS = 10
const FRAME_48 = 480
const BITRATE = 256_000   // Opus estéreo música; DTX/FEC fora de propósito

export async function initJam ({ serverUrl }) {
  const wsUrl = serverUrl.replace(/^http/, 'ws')
  let ws = null
  let me = null
  let room = null
  let onState = () => {}

  const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
  await ctx.audioWorklet.addModule(new URL('./jam-worklet.js', import.meta.url))

  const mixNode = new AudioWorkletNode(ctx, 'jam-mix', { outputChannelCount: [2] })
  mixNode.connect(ctx.destination)                    // monitor local
  const meters = new Map()                            // id -> último meter
  mixNode.port.onmessage = e => {
    if (e.data.type !== 'meters') return
    for (const [id, m] of Object.entries(e.data.meters)) meters.set(id, m)
  }

  // ── envio ───────────────────────────────────────────────────────────────
  let micStream = null
  let tap = null
  let encoder = null
  let outSeq = 0

  const feedEncoder = block => {
    if (encoder?.state !== 'configured') return
    encoder.encode(new AudioData({
      format: 'f32', sampleRate: 48000, numberOfFrames: FRAME_48, numberOfChannels: 2,
      timestamp: outSeq * FRAME_MS * 1000, data: block,
    }))
  }

  const startSend = async stream => {
    encoder = new AudioEncoder({
      output: (chunk, meta) => {
        encoderEncoded++
        const payload = new Uint8Array(chunk.byteLength)
        chunk.copyTo(payload)
        // cabeçalho próprio: seq 32 bits. DataChannel unreliable descarta o
        // que perder; o receptor apaga buracos (gap = silêncio curto).
        const pkt = new Uint8Array(4 + payload.length)
        new DataView(pkt.buffer).setUint32(0, outSeq)
        pkt.set(payload, 4)
        outSeq++
        for (const peer of peers.values())
          if (peer.dc?.readyState === 'open') peer.dc.send(pkt)
      },
      error: e => console.warn('[jam] encoder:', e.message),
    })
    encoder.configure({
      codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: BITRATE,
      opus: { frameDuration: FRAME_MS * 1000, usedtx: false },
    })
    tap = new AudioWorkletNode(ctx, 'jam-tap')
    tap.port.onmessage = e => feedEncoder(e.data)
    ctx.createMediaStreamSource(stream).connect(tap)
    tap.connect(mixNode) // silencioso no mix (gain 0): só mantém o worklet vivo
  }

  const stopSend = () => {
    try { tap?.disconnect() } catch {}
    try { encoder?.close() } catch {}
    micStream?.getTracks().forEach(t => t.stop())
    tap = null; encoder = null; micStream = null
  }

  // ── recepção ────────────────────────────────────────────────────────────
  class Peer {
    constructor (id) {
      this.id = id
      this.expected = null   // próximo seq que esperamos
      this.queue = []        // pacotes fora de ordem, por seq
      this.decoding = false
      this.nextTs = 0
      this.rtt = null
      this.rx = 0
      this.decoded = 0
      this.decoder = new AudioDecoder({
        output: ad => this.play(ad),
        error: e => console.warn(`[jam] decoder ${id}:`, e.message),
      })
      this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 })
      mixNode.port.postMessage({ type: 'add', id })
    }

    receive (pkt) {
      this.rx++
      const seq = new DataView(pkt.buffer, pkt.byteOffset).getUint32(0)
      const payload = pkt.subarray(pkt.byteOffset + 4)
      if (this.expected === null) this.expected = seq
      if (seq < this.expected) return   // atrasado de vez: fora do buffer
      this.queue.push({ seq, payload })
      this.queue.sort((a, b) => a.seq - b.seq)
      this.pump()
    }

    // alimenta o decoder em sequência; buraco de seq = pula (silêncio curto)
    async pump () {
      if (this.decoding) return
      this.decoding = true
      while (this.queue.length) {
        const { seq, payload } = this.queue[0]
        if (seq !== this.expected) { this.expected++; continue } // gap → avança mudo
        this.queue.shift()
        this.expected++
        try {
          this.decoder.decode(new EncodedAudioChunk({
            type: 'key', timestamp: this.nextTs, data: payload,
          }))
          this.nextTs += FRAME_MS * 1000
          this.decoded++
        } catch {}
      }
      this.decoding = false
    }

    play (ad) {
      // o decoder devolve 'f32-planar' (ou 'f32' interleaved); sempre sai
      // interleaved de 2 canais pro ring do mixer. allocationSize manda no
      // tamanho — a conversão de formato pode não ter n*channels samples.
      const n = ad.numberOfFrames
      const itl = new Float32Array(n * 2)
      if (ad.format === 'f32') {
        ad.copyTo(itl.subarray(0, ad.allocationSize({ planeIndex: 0 }) / 4), { planeIndex: 0 })
      } else {
        for (let c = 0; c < Math.min(2, ad.numberOfChannels); c++) {
          const plane = new Float32Array(ad.allocationSize({ planeIndex: c, format: 'f32' }) / 4)
          ad.copyTo(plane, { planeIndex: c, format: 'f32' })
          for (let i = 0; i < plane.length && i < n; i++) itl[i * 2 + c] = plane[i]
        }
      }
      ad.close()
      mixNode.port.postMessage({ type: 'audio', id: this.id, data: itl }, [itl.buffer])
    }

    sendSignal = type => async data => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to: this.id, type, ...data }))
    }

    close () {
      mixNode.port.postMessage({ type: 'remove', id: this.id })
      try { this.pc?.close() } catch {}
      try { this.decoder.close() } catch {}
    }
  }

  const peers = new Map()   // nick -> Peer
  let encoderEncoded = 0

  // Um canal por par. Do lado de quem oferece ele nasce do createDataChannel;
  // do outro lado chega pelo ondatachannel — os dois caem aqui.
  const wireChannel = (peer, dc) => {
    peer.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.onmessage = e => {
      if (e.data instanceof ArrayBuffer) return peer.receive(new Uint8Array(e.data))
      const msg = JSON.parse(e.data)
      if (msg.type === 'pong') peer.rtt = Math.round(performance.now() - msg.t)
      else if (msg.type === 'ping') peer.dc.send(JSON.stringify({ type: 'pong', t: msg.t }))
    }
  }

  const makePC = peer => {
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ] })
    // DataChannel unreliable = UDP efetivo: sem retransmissão, sem ordem
    wireChannel(peer, pc.createDataChannel('jam', { ordered: false, maxRetransmits: 0 }))
    pc.ondatachannel = ev => wireChannel(peer, ev.channel)
    pc.onicecandidate = ev => {
      if (ev.candidate) peer.sendSignal('ice')({ candidate: ev.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        console.warn(`[jam] P2P com ${peer.id} falhou`)
        emit()
      }
      emit()
    }
    return pc
  }

  const connectTo = async nick => {
    let peer = peers.get(nick)
    if (peer?.pc) return
    if (!peer) { peer = new Peer(nick); peers.set(nick, peer) }
    const pc = makePC(peer)
    peer.pc = pc
    // offer: sempre quem estava na sala antes responde (joiner inicia) —
    // decidido no servidor: `peers` do joiner dispara connectTo
    await pc.setLocalDescription(await pc.createOffer())
    peer.sendSignal('offer')({ sdp: pc.localDescription.sdp })
    emit()
  }

  // peer-joined: só registra o destino — quem chega é quem oferece
  const expectPeer = nick => {
    if (!peers.has(nick)) peers.set(nick, new Peer(nick))
  }

  const onSignal = async msg => {
    if (msg.type === 'peers') { for (const p of msg.peers) await connectTo(p); return }
    if (msg.type === 'peer-joined') return expectPeer(msg.nick)
    const peer = peers.get(msg.from)
    if (!peer) return
    if (msg.type === 'offer') {
      // glare (join simultâneo dos dois lados): o nick menor cede e ignora a
      // offer do outro — a resposta vai pela offer dele que já está a caminho
      if (peer.pc?.signalingState === 'have-local-offer' && me < msg.from) return
      if (!peer.pc) { peer.pc = makePC(peer) }
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
      await peer.pc.setLocalDescription(await peer.pc.createAnswer())
      peer.sendSignal('answer')({ sdp: peer.pc.localDescription.sdp })
      emit()
    } else if (msg.type === 'answer') {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
      emit()
    } else if (msg.type === 'ice' && msg.candidate) {
      try { await peer.pc.addIceCandidate(msg.candidate) } catch {}
    }
  }

  const emit = () => onState(state())

  const state = () => ({
    room, nick: me,
    peers: [...peers.entries()].map(([id, p]) => ({
      id, rtt: p.rtt, connected: p.pc?.connectionState === 'connected',
      tx: outSeq, rx: p.rx, decoded: p.decoded, encoded: encoderEncoded,
      ...meters.get(id),
    })),
  })

  // ── API pública ─────────────────────────────────────────────────────────
  return {
    async join (_room, _nick, _onState) {
      room = _room; me = _nick; onState = _onState || onState
      ws = new WebSocket(`${wsUrl}/ws/jam?room=${encodeURIComponent(room)}&nick=${encodeURIComponent(me)}`)
      ws.onmessage = e => {
        try { onSignal(JSON.parse(e.data)) } catch {}
      }
      ws.onclose = () => { if (room) emit() }
      await new Promise((res, rej) => {
        ws.onopen = res
        ws.onerror = () => rej(new Error('sinalização indisponível'))
      })

      // mic sem nenhum processamento de voz; fones são obrigatórios (sem AEC
      // o alto-falante vira eco). channelCount 2 fica quando o dispositivo
      // tiver — mono entra no encoder como estéreo duplicado.
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 2, sampleRate: 48000,
        },
      })
      await ctx.resume()
      await startSend(micStream)
      // RTT por par: ping no DataChannel a cada 2s (resposta vem no mesmo canal)
      if (!this._ping) this._ping = setInterval(() => {
        const t = performance.now()
        for (const p of peers.values())
          if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify({ type: 'ping', t }))
      }, 2000)
      emit()
      return this
    },

    // áudio alternativo (helper do Electron: MediaStreamTrackGenerator): troca
    // a fonte do encoder sem renegociar nada
    async replaceMic (stream) {
      if (tap) { try { tap.disconnect() } catch {} }
      micStream?.getTracks().forEach(t => { if (t !== stream.getAudioTracks()[0]) t.stop() })
      micStream = stream
      if (!encoder) return startSend(stream)
      ctx.createMediaStreamSource(stream).connect(tap)
    },

    setGain (id, v) { mixNode.port.postMessage({ type: 'gain', id, v }) },
    setTargetMs (ms) { mixNode.port.postMessage({ type: 'target', ms }) },

    async leave () {
      room = null
      try { ws?.close() } catch {}
      ws = null
      for (const p of peers.values()) p.close()
      peers.clear()
      stopSend()
      emit()
    },

    get joined () { return !!room },
    get state () { return state() },
    get context () { return ctx },
  }
}
