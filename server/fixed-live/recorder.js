// gravador de lives: para cada stream de pessoa no ar, conecta como viewer
// WHEP (SEM ?viewer=, então não conta como espectador no zera-stream) e
// reencaminha o RTP recebido pra sockets UDP locais que o ffmpeg escuta via
// SDP — cópia direta (sem reencode) direto pra MP4. Quando a stream cai,
// SIGINT finaliza o MP4 e registra no banco.
import { RTCPeerConnection, useH264, useOPUS } from "werift"
import { createSocket } from "node:dgram"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync, existsSync, statSync, rmSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { addVod, addClip, getClip } from "./db.js"

const BB_URL = process.env.BB_URL ?? "http://broadcast-box:8080"
// candidatos do broadcast-box saem com o IP público/LAN (NAT_1_TO_1_IP); da
// rede interna do compose esse caminho pode não existir (hairpin UDP). Onde
// houver esse IP na resposta do WHEP, troca pelo hostname do container.
const BB_PUBLIC_IP = process.env.BB_PUBLIC_IP ?? ""
const BB_CANDIDATE_HOST = process.env.BB_CANDIDATE_HOST ?? "broadcast-box"
const REC_DIR = join(process.env.DATA_DIR ?? "/app/data", "vods")
mkdirSync(REC_DIR, { recursive: true })

const log_ = (...a) => console.log(new Date().toISOString(), "[rec]", ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// sessão ativa por streamKey (Promise que resolve na sessão) + falhas recentes
const sessions = new Map()
const cooldown = new Map()   // key → timestamp liberado

const gatherComplete = pc => new Promise(res => {
  if (pc.iceGatheringState === "complete") return res()
  pc.iceGatheringStateChange.subscribe(s => { if (s === "complete") res() })
  setTimeout(res, 5_000)   // fallback: candidatos host bastam na LAN/direto
})

// porta UDP livre pro ffmpeg escutar: reservamos (bind), lemos o número e
// LARGAMOS o socket — quem escuta é o ffmpeg. Corrida de porta é improvável
// em localhost e o pior caso é o retry da próxima varredura.
const localPort = () => new Promise(res => {
  const s = createSocket("udp4")
  s.bind(0, "127.0.0.1", () => {
    const { port } = s.address()
    s.close(() => res(port))
  })
})

// uma m-line por trilha, apontando pras portas UDP que o ffmpeg vai escutar
const buildSdp = sections => {
  const lines = ["v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=fockytv-rec", "t=0 0"]
  for (const s of sections) {
    lines.push(`m=${s.kind} ${s.port} RTP/AVP ${s.pt}`,
               "c=IN IP4 127.0.0.1",
               `a=rtpmap:${s.pt} ${s.name}/${s.clockRate}${s.channels ? "/" + s.channels : ""}`)
    let fmtp = s.fmtp ?? ""
    // sem sprop-parameter-sets o ffmpeg não monta o h264 (non-existing PPS)
    if (s.kind === "video" && s.sps && s.pps)
      fmtp = (fmtp ? fmtp + ";" : "") + `sprop-parameter-sets=${s.sps},${s.pps}`
    if (fmtp) lines.push(`a=fmtp:${s.pt} ${fmtp}`)
  }
  return lines.join("\r\n") + "\r\n"
}

// caça SPS (NAL 7) e PPS (NAL 8) nos pacotes H264 — o fmtp do SDP precisa
// deles base64 antes de o ffmpeg abrir o arquivo. STAP-A agrega vários NALs;
// NALs únicos são o resto (FU-A de SPS/PPS é raro demais pra remontar aqui).
const h264ParamSets = (rtp, pipe) => {
  if (pipe.sps && pipe.pps) return
  const p = rtp.payload
  if (!p?.length) return
  const nals = []
  const t = p[0] & 0x1f
  if (t === 24) {
    let i = 1
    while (i + 2 <= p.length) {
      const size = (p[i] << 8) | p[i + 1]
      i += 2
      if (size < 1 || i + size > p.length) break
      nals.push(p.subarray(i, i + size))
      i += size
    }
  } else if (t > 0 && t <= 23) nals.push(p)
  for (const nal of nals) {
    const nt = nal[0] & 0x1f
    if (nt === 7) pipe.sps = nal.toString("base64")
    if (nt === 8) pipe.pps = nal.toString("base64")
  }
}

const SEGMENT_S = 5   // granularidade do buffer de clips (e do corte com -c copy)

const startFfmpeg = (sections, outPath, livePrefix) => {
  const sdpPath = outPath.replace(/\.mp4$/, ".sdp")
  writeFileSync(sdpPath, buildSdp(sections))
  const args = ["-hide_banner", "-loglevel", "warning",
    "-protocol_whitelist", "file,udp,rtp",
    "-fflags", "+genpts",
    "-i", sdpPath,
    "-c", "copy",
    // buffer de clips: segmentos fechados de 5s (cada um começa num keyframe)
    "-f", "segment", "-segment_time", String(SEGMENT_S), "-reset_timestamps", "1",
    "-segment_format", "mp4", livePrefix + "-live-%05d.mp4",
    "-f", "mp4", outPath]
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })
  let err = ""
  proc.stderr.on("data", d => { err = (err + d).slice(-4000) })
  proc.ffmpegErr = () => err
  return proc
}

// uma sessão de gravação: WHEP in → RTP → UDP → ffmpeg
async function startSession (key) {
  const startedAt = Date.now()
  const outPath = join(REC_DIR, `${key}-${startedAt}.mp4`)

  const pc = new RTCPeerConnection({
    codecs: {
      video: [useH264()],   // exatamente o que o broadcast-box publica (B=42e01f, pmode=1)
      audio: [useOPUS()],
    },
  })
  pc.addTransceiver("video", { direction: "recvonly" })
  pc.addTransceiver("audio", { direction: "recvonly" })

  const sections = []     // uma por trilha, na ordem que chegarem
  const pipes = []        // sockets udp que enviam RTP pro ffmpeg

  pc.onTrack.subscribe(track => {
    const c = track.codec
    if (!c) return
    const pipe = {
      kind: track.kind, pt: c.payloadType, name: c.name, clockRate: c.clockRate,
      channels: track.kind === "audio" ? (c.channels ?? 2) : undefined,
      fmtp: c.parameters || undefined,
    }
    localPort().then(port => {
      pipe.port = port
      sections.push(pipe)
      // ssrc fixo por seção: o SDP do ffmpeg não conhece o do broadcast-box
      const fakeSsrc = 1000 + sections.length
      const out = createSocket("udp4")
      pipe.stats = { got: 0, sent: 0, errs: 0 }
      pipe.first = new Promise(res => {
        track.onReceiveRtp.subscribe(rtp => {
          pipe.stats.got++
          if (pipe.kind === "video") h264ParamSets(rtp, pipe)
          try {
            rtp.header.ssrc = fakeSsrc
            out.send(rtp.serialize(), port, "127.0.0.1", () => pipe.stats.sent++)
          } catch { pipe.stats.errs++ }
          res()
        })
      })
      pipes.push(out)
    })
  })

  await pc.setLocalDescription(await pc.createOffer())
  await gatherComplete(pc)
  const res = await fetch(BB_URL + "/api/whep", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/sdp" },
    body: pc.localDescription.sdp,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`WHEP respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`)
  let answer = await res.text()
  if (BB_PUBLIC_IP) answer = answer.split(BB_PUBLIC_IP).join(BB_CANDIDATE_HOST)
  await pc.setRemoteDescription({ type: "answer", sdp: answer })

  // espera as trilhas (vídeo + áudio) terem porta UDP pro SDP do ffmpeg
  const t0 = Date.now()
  while (sections.length < 2 && Date.now() - t0 < 10_000) await sleep(200)
  if (!sections.length) throw new Error("nenhuma trilha recebida")

  // o ffmpeg só registra no MP4 o que chega enquanto ele sonda (primeiros
  // instantes). O vídeo costuma atrasar (keyframe pedido via PLI), então o
  // spawn espera o primeiro pacote de cada trilha antes de abrir o arquivo.
  await Promise.race([
    Promise.allSettled(sections.map(s => s.first)),
    sleep(30_000),
  ])
  // dá um tempo pro SPS/PPS aparecer no vídeo (vém junto do keyframe)
  const vd = sections.find(s => s.kind === "video")
  const t1 = Date.now()
  while (vd && !(vd.sps && vd.pps) && Date.now() - t1 < 10_000) await sleep(100)
  const livePrefix = join(REC_DIR, `${key}-${startedAt}`)
  const proc = startFfmpeg(sections, outPath, livePrefix)
  log_(`gravando "${key}" → ${outPath} (${sections.map(s => s.kind).join("+")})`)

  // heartbeat: onde o fluxo está (werift recebendo? udp entregue? ffmpeg crescendo?)
  const hb = setInterval(() => {
    const size = existsSync(outPath) ? statSync(outPath).size : 0
    log_(`hb "${key}": ` + sections.map(s =>
      `${s.kind} got=${s.stats.got} sent=${s.stats.sent} err=${s.stats.errs}`).join(" | ") +
      ` | mp4=${(size / 1e6).toFixed(1)}MB`)
    pruneSegments(livePrefix, 45)
  }, 30_000)

  let ended = false
  const finish = async reason => {
    if (ended) return
    ended = true
    clearInterval(hb)
    sessions.delete(key)
    setTimeout(() => pruneSegments(livePrefix, 0), 15_000)
    try { pc.close() } catch {}
    for (const s of pipes) try { s.close() } catch {}
    proc.kill("SIGINT")   // ffmpeg finaliza o MP4 com moov válido
    const code = await new Promise(r => { proc.once("exit", (c) => r(c)); setTimeout(() => r("timeout"), 12_000) })
    log_(`ffmpeg saiu com ${code}`)
    const duration = (Date.now() - startedAt) / 1000
    // registro só com MP4 de verdade: tentativa falha não vira VOD fantasma
    const ok = existsSync(outPath) && statSync(outPath).size > 10_000
    if (ok) {
      addVod({ stream_key: key, file: outPath, duration, started_at: startedAt, ended_at: Date.now() })
      thumbOf(outPath)
      log_(`gravação de "${key}" pronta (${reason}, ${Math.round(duration)}s)`)
    } else {
      log_(`gravação de "${key}" falhou (${reason}) — ${proc.ffmpegErr().split("\n").pop()}`)
      try { rmSync(outPath) } catch {}
      if (Date.now() - startedAt < 20_000) cooldown.set(key, Date.now() + 60_000)
    }
  }

  pc.connectionStateChange.subscribe(s => { if (["failed", "closed"].includes(s)) finish("pc " + s) })
  proc.once("exit", code => { if (!ended) { log_(`ffmpeg saiu (${code}): ${proc.ffmpegErr()}`); finish("ffmpeg") } })
  return { finish, startedAt }
}

// apaga segmentos do prefixo mais velhos que maxAge s (0 = todos)
const pruneSegments = (prefix, maxAge) => {
  try {
    const now = Date.now()
    for (const f of readdirSync(REC_DIR))
      if (f.startsWith(prefix.replace(REC_DIR + "/", "") + "-live-")) {
        const full = join(REC_DIR, f)
        if (now - statSync(full).mtimeMs > (maxAge + 2) * 1000) rmSync(full, { force: true })
      }
  } catch {}
}

// clip dos últimos `dur` segundos da live: concatena os segmentos fechados
// (cópia direta, cada um começa num keyframe) e corta no fim
async function clipLast (key, dur) {
  const entry = sessions.get(key)
  if (!entry) throw new Error("não está gravando agora")
  const session = await entry
  const livePrefix = join(REC_DIR, `${key}-${session.startedAt}`)
  const cutoff = Date.now() - 6_000   // o segmento em aberto não tem moov ainda
  const segs = readdirSync(REC_DIR)
    .filter(f => f.startsWith(`${key}-${session.startedAt}-live-`))
    .map(f => join(REC_DIR, f))
    .filter(f => statSync(f).mtimeMs < cutoff)
    .sort()
  if (!segs.length) throw new Error("buffer ainda vazio, tenta em alguns segundos")
  const take = Math.min(segs.length, Math.ceil((dur + 2) / SEGMENT_S))
  const list = segs.slice(-take)
  const outFile = join(REC_DIR, `${key}-${Date.now()}-clip.mp4`)
  const lst = outFile.replace(/\.mp4$/, ".txt")
  writeFileSync(lst, list.map(f => `file '${f}'`).join("\n"))
  await new Promise((res, rej) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", lst, "-t", String(dur),
      "-c", "copy", "-movflags", "+faststart", outFile], { stdio: ["ignore", "ignore", "pipe"] })
    let err = ""
    p.stderr.on("data", d => { err += d })
    p.once("exit", c => c === 0 ? res() : rej(new Error("ffmpeg: " + err.slice(-200))))
    setTimeout(() => { try { p.kill("SIGKILL") } catch {}; rej(new Error("timeout")) }, 60_000)
  })
  rmSync(lst, { force: true })
  const { lastInsertRowid: id } = addClip({ vod_id: 0, stream_key: key, file: outFile,
                                            at: 0, duration: dur, created_at: Date.now() })
  return getClip(id)
}

export const recorder = {
  // chamado a cada varredura do /api/status no watchdog
  sync (liveKeys) {
    const now = Date.now()
    for (const k of liveKeys) {
      if (sessions.has(k)) continue
      if ((cooldown.get(k) ?? 0) > now) continue
      sessions.set(k, startSession(k).catch(e => { sessions.delete(k); log_(`"${k}": ${e.message}`) }))
    }
    for (const [k, s] of sessions)
      if (!liveKeys.has(k)) Promise.resolve(s).then(x => x?.finish("stream acabou"))
  },
  clipLast,
  async stopAll () {
    await Promise.allSettled([...sessions.keys()].map(k =>
      Promise.resolve(sessions.get(k)).then(x => x?.finish("shutdown"))))
  },
}

// thumb: frame de 2s (best effort; sem thumb a UI mostra card sem imagem)
function thumbOf (outPath) {
  const thumb = outPath.replace(/\.mp4$/, ".jpg")
  const grab = delay => {
    const p = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-analyzeduration", "20M", "-probesize", "20M",
      "-ss", String(delay), "-i", outPath, "-frames:v", "1", "-q:v", "4", thumb,
    ], { stdio: ["ignore", "ignore", "pipe"] })
    let err = ""
    p.stderr.on("data", d => { err = (err + d).slice(-2000) })
    p.once("exit", code => {
      if (code !== 0 && delay < 10) {
        log_(`thumb tentativa ${delay}s falhou: ${err.trim().split("\n").pop()}`)
        sleep(1000).then(() => grab(delay + 5))
      }
    })
  }
  // 1s de propósito: o moov do MP4 pode ainda estar caindo no disco quando
  // o ffmpeg da gravação acabou de sair
  sleep(1000).then(() => grab(2))
}
