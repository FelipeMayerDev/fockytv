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

const FRAME_MS = 5
const FRAME_48 = 240
const BITRATE = 256_000   // Opus estéreo música; DTX/FEC fora de propósito

// Dois perfis (join({ mode })) sobre UM pipeline só: estéreo, frames de 5ms.
//  'music' — Estúdio: 256k, jitter de 30ms.
//  'voice' — canais de conversa: 96k e jitter folgado de 80ms.
// Mono/20ms/DTX já foram tentados aqui e não sobrevivem ao jitter buffer
// próprio (DTX seca o buffer entre sílabas) nem ao remonta de frame — o
// ganho de banda não paga o pipeline separado.
// AEC/NS/AGC ficam por conta das constraints pedidas pelo chamador; a sala
// nunca processa voz por conta própria.
const MODES = {
  music: { bitrate: BITRATE, jitterMs: 30 },
  voice: { bitrate: 96_000, jitterMs: 80 },
}

export async function initJam ({ serverUrl }) {
  const wsUrl = serverUrl.replace(/^http/, 'ws')
  let ws = null
  let me = null
  let room = null
  let onState = () => {}
  let onChat = () => {}
  let onLevels = () => {}
  let selfLevel = 0

  const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
  await ctx.audioWorklet.addModule(new URL('./jam-worklet.js?v=8', import.meta.url))

  const mixNode = new AudioWorkletNode(ctx, 'jam-mix', { outputChannelCount: [2] })
  mixNode.connect(ctx.destination)                    // monitor local
  const meters = new Map()                            // id -> último meter
  mixNode.port.onmessage = e => {
    if (e.data.type !== 'meters') return
    for (const [id, m] of Object.entries(e.data.meters)) meters.set(id, m)
    fireLevels()
  }

  // ── envio ───────────────────────────────────────────────────────────────
  let mode = 'music'
  let micStream = null
  // o source do mic fica guardado: é a ÚNICA alça pra soltar a entrada do tap
  // na troca de microfone. `tap.disconnect()` desfaz as saídas do tap, nunca
  // as entradas — usar ele aqui derrubava o tap do mixNode (e com ele o
  // worklet, que só continua sendo puxado por ter caminho até o destino).
  let micSrc = null
  // portão de ruído: fica SEMPRE no grafo (micSrc → gate → tap), ligado ou
  // não. Mexer em conexão com o mic no ar foi de onde veio o bug do
  // replaceMic; aqui ligar/desligar é só uma mensagem de config.
  let gate = null
  let gateCfg = { on: false, cut: true }
  let onGate = () => {}
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
          // rede congestionada: descarta na fonte — atraso crescente soa pior
          // que perda, e o SCTP com maxRetransmits:0 não guarda fila infinita
          if (peer.dc?.readyState === 'open' && peer.dc.bufferedAmount < 65536)
            peer.dc.send(pkt)
      },
      error: e => console.warn('[jam] encoder:', e.message),
    })
    encoder.configure({
      codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: MODES[mode].bitrate,
      opus: { frameDuration: FRAME_MS * 1000, usedtx: false },
    })
    tap = new AudioWorkletNode(ctx, 'jam-tap')
    tap.port.onmessage = e => {
      if (e.data.type === 'level') { selfLevel = e.data.v; fireLevels() }
      else feedEncoder(e.data)
    }
    gate = new AudioWorkletNode(ctx, 'jam-gate', { outputChannelCount: [2] })
    gate.port.onmessage = e => { if (e.data.type === 'gate') onGate(e.data) }
    gate.port.postMessage({ type: 'config', ...gateCfg })
    gate.connect(tap)
    micSrc = ctx.createMediaStreamSource(stream)
    micSrc.connect(gate)
    tap.connect(mixNode) // silencioso no mix (gain 0): só mantém o worklet vivo
  }

  const stopSend = () => {
    try { micSrc?.disconnect() } catch {}
    try { gate?.disconnect() } catch {}
    try { tap?.disconnect() } catch {}
    try { encoder?.close() } catch {}
    micStream?.getTracks().forEach(t => t.stop())
    micSrc = null; gate = null; tap = null; encoder = null; micStream = null
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
      if (this.expected === null) { this.expected = seq; this.waitingSince = Date.now() }
      if (seq < this.expected) return   // atrasado de vez: fora do buffer
      this.queue.push({ seq, payload })
      this.queue.sort((a, b) => a.seq - b.seq)
      this.pump()
    }

    // alimenta o decoder em sequência. O canal é unordered: fora de ordem é o
    // normal, então um buraco espera 30ms pelo pacote perdido antes de saltar
    // — sem isso cada reordenação virava perda de frame (áudio picotado).
    async pump () {
      if (this.decoding) return
      this.decoding = true
      while (this.queue.length) {
        const head = this.queue[0]
        if (head.seq < this.expected) { this.queue.shift(); continue } // duplicado/velho
        if (head.seq !== this.expected) {
          if (Date.now() - this.waitingSince < 30) break   // ainda pode chegar
          this.expected = head.seq   // perdido de verdade: salta (silêncio curto)
        }
        this.queue.shift()
        this.expected++
        this.waitingSince = Date.now()
        try {
          this.decoder.decode(new EncodedAudioChunk({
            type: 'key', timestamp: this.nextTs, data: head.payload,
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
    emit()
  }

  const onSignal = async msg => {
    if (msg.type === 'pong') return   // keepalive: só serve pra manter o WS vivo
    if (msg.type === 'peers') {
      // lista autoritativa do servidor. Numa RECONEXÃO ela também corrige o
      // que perdemos enquanto o WS esteve fora: quem saiu nesse intervalo não
      // vem aqui e o peer-left correspondente nunca chegou.
      const vivos = new Set(msg.peers)
      for (const [nick, p] of peers) if (!vivos.has(nick)) { p.close(); peers.delete(nick) }
      for (const p of msg.peers) await connectTo(p)
      return
    }
    if (msg.type === 'peer-joined') {
      expectPeer(msg.nick)
      return onChat({ type: 'chat', from: 'sistema', text: `${msg.nick} entrou na sala` })
    }
    if (msg.type === 'peer-left') {
      const p = peers.get(msg.nick)
      if (p) { p.close(); peers.delete(msg.nick) }
      emit()
      return onChat({ type: 'chat', from: 'sistema', text: `${msg.nick} saiu da sala` })
    }
    if (msg.type === 'chat' || msg.type === 'yt') return onChat(msg)
    if (msg.type === 'evicted') {
      // outro cliente assumiu o nick: desconecta em silêncio
      room = null
      wsStopKeepalive()
      for (const p of peers.values()) p.close()
      peers.clear()
      stopSend()
      return emit()
    }
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

  const fireLevels = () => {
    const peers = {}
    for (const [id, m] of meters) peers[id] = m
    onLevels({ self: selfLevel, peers })
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

  // ── sobrevivência do WebSocket de sinalização ───────────────────────────
  // O WS fica MUDO depois que a sinalização acaba: offer/answer/ICE são as
  // únicas mensagens, e a mídia é P2P. Com Cloudflare na frente do domínio,
  // um WebSocket ocioso é encerrado em ~100s — e o servidor, ao ver o close,
  // tira o nick do jamRooms e manda member-left pra todo mundo. Resultado:
  // a pessoa some da listagem enquanto continua sendo ouvida, porque o áudio
  // não passa por ali. Era exatamente o "usuários somem do canal".
  //
  // Duas defesas: ping de aplicação (o servidor já respondia pong, ninguém
  // mandava) e reconexão com backoff enquanto ainda estivermos numa sala.
  const WS_PING_MS = 25_000
  let wsPing = null
  let wsRetry = null
  let wsBackoff = 1000

  const wsStopKeepalive = () => {
    clearInterval(wsPing); wsPing = null
    clearTimeout(wsRetry); wsRetry = null
  }

  const wireWs = sock => {
    sock.onmessage = e => { try { onSignal(JSON.parse(e.data)) } catch {} }
    sock.onclose = () => {
      clearInterval(wsPing); wsPing = null
      if (!room) return            // saída normal: nada a refazer
      emit()
      if (wsRetry) return
      wsRetry = setTimeout(() => { wsRetry = null; wsReconnect() }, wsBackoff)
      wsBackoff = Math.min(wsBackoff * 2, 10_000)
    }
    sock.onopen = () => {
      wsBackoff = 1000
      clearInterval(wsPing)
      wsPing = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN)
          sock.send(JSON.stringify({ type: 'ping', t: Date.now() }))
      }, WS_PING_MS)
    }
  }

  const wsUrlFor = () =>
    `${wsUrl}/api/fixed/ws/jam?room=${encodeURIComponent(room)}&nick=${encodeURIComponent(me)}&type=${mode}`

  // reconexão: o servidor nos readiciona ao jamRooms e reenvia a lista de
  // peers. connectTo ignora quem já tem pc, então as conexões P2P vivas —
  // que nunca caíram — seguem intactas; só a presença é restaurada.
  const wsReconnect = () => {
    if (!room) return
    try { ws?.close() } catch {}
    ws = new WebSocket(wsUrlFor())
    wireWs(ws)
    ws.onerror = () => {}   // o onclose cuida do retry
  }

  // ── API pública ─────────────────────────────────────────────────────────
  return {
    async join (_room, _nick, _onState, { micStream: extMic = null, deviceId = null, audio = null, mode: _mode = 'music' } = {}) {
      mode = MODES[_mode] ? _mode : 'music'
      room = _room; me = _nick; onState = _onState || onState
      // WS e microfone em PARALELO: os dois custos de entrada são
      // independentes — em série custam o dobro no melhor caso.
      // O modo vai na query como tipo da sala: o servidor tipa a room no
      // primeiro join e a UI separa Estúdio (music) de canal de conversa
      // (voice) pelo tipo, não por convenção de nome.
      let micErr = null
      wsStopKeepalive()
      wsBackoff = 1000
      const wsOpen = new Promise((res, rej) => {
        ws = new WebSocket(wsUrlFor())
        wireWs(ws)
        const opened = ws.onopen
        ws.onopen = e => { opened(e); res(e) }   // keepalive + resolve do join
        ws.onerror = () => rej(micErr ?? new Error('sinalização indisponível'))
      })
      const micReady = (extMic
        ? Promise.resolve(extMic)
        : navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false, noiseSuppression: false, autoGainControl: false,
              // mono na conversa: o APM do Chromium (AEC/NS/AGC) roda no
              // caminho mono de captura — pedir estéreo junto faz o
              // processamento ser ignorado, e a supressão de ruído não
              // engatava nunca no join. O jam-tap faz o up-mix pra estéreo.
              channelCount: mode === 'voice' ? 1 : 2, sampleRate: 48000,
              ...(audio ?? {}),
              ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            },
          })
      ).catch(e => {
        micErr = e
        throw e
      })
      try {
        micStream = await micReady
        await wsOpen
      } catch (e) {
        // sem zerar `room` aqui, o onclose do WS entenderia a falha de join
        // como queda e entraria em loop de reconexão pra uma sala que nunca
        // chegou a existir
        room = null
        wsStopKeepalive()
        try { ws?.close() } catch {}
        ws = null
        micStream?.getTracks().forEach(t => t.stop())
        micStream = null
        throw e
      }
      await ctx.resume()
      await startSend(micStream)
      // jitter alvo do modo: conversa tolera mais buffer, música não
      mixNode.port.postMessage({ type: 'target', ms: MODES[mode].jitterMs })
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
      // solta a fonte ANTIGA (entrada do tap). O tap continua ligado no
      // mixNode: é esse caminho até o destino que mantém o worklet sendo
      // puxado a cada render quantum — sem ele o encoder para de receber
      // frames e o mic morre em silêncio.
      try { micSrc?.disconnect() } catch {}
      micSrc = null
      micStream?.getTracks().forEach(t => { if (t !== stream.getAudioTracks()[0]) t.stop() })
      micStream = stream
      if (!encoder) return startSend(stream)
      micSrc = ctx.createMediaStreamSource(stream)
      micSrc.connect(gate ?? tap)
    },

    // Solta o dispositivo ANTES de pedir outro. Sem isto, o getUserMedia
    // seguinte cai na MESMA fonte de captura que ainda está aberta, e o
    // Chromium devolve a track com o processamento já negociado — as
    // constraints novas (AEC/NS/AGC) são silenciosamente ignoradas. Era por
    // isso que mudar a configuração só valia depois de sair e voltar da sala:
    // sair parava a track, e só aí o pedido seguinte abria fonte nova.
    // O grafo (gate, tap, encoder) fica de pé; só a fonte é solta.
    releaseMic () {
      try { micSrc?.disconnect() } catch {}
      micSrc = null
      micStream?.getTracks().forEach(t => t.stop())
      micStream = null
    },

    // portão de ruído: aplica na hora, sem tocar no mic nem no encoder.
    // O objeto vira o estado corrente — um startSend posterior (troca de mic,
    // rejoin) reconfigura o nó novo com ele.
    setGate (cfg) {
      gateCfg = { ...gateCfg, ...cfg }
      gate?.port.postMessage({ type: 'config', ...gateCfg })
    },
    getGate () { return { ...gateCfg } },
    onGate (cb) { onGate = cb || (() => {}) },

    sendChat (text) {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'chat', text: String(text).slice(0, 500) }))
    },
    sendYt (payload) {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'yt', ...payload }))
    },
    onChat (cb) { onChat = cb },
    setMicGain (v) { tap?.port.postMessage({ type: 'gain', v }) },
    onLevels (cb) { onLevels = cb },
    setGain (id, v) { mixNode.port.postMessage({ type: 'gain', id, v }) },
    setTargetMs (ms) { mixNode.port.postMessage({ type: 'target', ms }) },

    async leave () {
      room = null
      wsStopKeepalive()
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
    get mixer () { return mixNode },   // diagnóstico: analisar a recepção
  }
}
