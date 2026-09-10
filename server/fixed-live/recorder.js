// gravador de lives: para cada stream de pessoa no ar, conecta como viewer
// WHEP (SEM ?viewer=, então não conta como espectador no zera-stream) e
// reencaminha o RTP recebido pra sockets UDP locais que o ffmpeg escuta via
// SDP — cópia direta (sem reencode) direto pra MP4. Quando a stream cai,
// SIGINT finaliza o MP4 e registra no banco.
import { RTCPeerConnection } from "werift"
import { createSocket } from "node:dgram"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { addVod } from "./db.js"

const BB_URL = process.env.BB_URL ?? "http://broadcast-box:8080"
const REC_DIR = join(process.env.DATA_DIR ?? "/app/data", "vods")
mkdirSync(REC_DIR, { recursive: true })

const log_ = (...a) => console.log(new Date().toISOString(), "[rec]", ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// sessão ativa por streamKey (Promise que resolve na sessão)
const sessions = new Map()

const gatherComplete = pc => new Promise(res => {
  if (pc.iceGatheringState === "complete") return res()
  pc.iceGatheringStateChange.subscribe(s => { if (s === "complete") res() })
  setTimeout(res, 5_000)   // fallback: candidatos host bastam na LAN/direto
})

const localPort = () => new Promise(res => {
  const s = createSocket("udp4")
  s.bind(0, "127.0.0.1", () => res({ s, port: s.address().port }))
})

// uma m-line por trilha, apontando pras portas UDP que o ffmpeg vai escutar
const buildSdp = sections => {
  const lines = ["v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=fockytv-rec", "t=0 0"]
  for (const s of sections) {
    lines.push(`m=${s.kind} ${s.port} RTP/AVP ${s.pt}`,
               "c=IN IP4 127.0.0.1",
               `a=rtpmap:${s.pt} ${s.name}/${s.clockRate}${s.channels ? "/" + s.channels : ""}`)
    if (s.fmtp) lines.push(`a=fmtp:${s.pt} ${s.fmtp}`)
  }
  return lines.join("\r\n") + "\r\n"
}

const startFfmpeg = (sections, outPath) => {
  const sdpPath = outPath.replace(/\.mp4$/, ".sdp")
  writeFileSync(sdpPath, buildSdp(sections))
  const args = ["-hide_banner", "-loglevel", "warning",
    "-protocol_whitelist", "file,udp,rtp",
    "-fflags", "+genpts",
    "-i", sdpPath,
    "-c", "copy",
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

  const pc = new RTCPeerConnection()
  pc.addTransceiver("video", { direction: "recvonly" })
  pc.addTransceiver("audio", { direction: "recvonly" })

  const sections = []     // uma por trilha, na ordem que chegarem
  const pipes = new Map() // track → socket udp

  pc.onTrack.subscribe(track => {
    const c = track.codec
    if (!c) return
    const pipe = {
      kind: track.kind, pt: c.payloadType, name: c.name, clockRate: c.clockRate,
      channels: track.kind === "audio" ? (c.channels ?? 2) : undefined,
      fmtp: c.parameters || undefined,
    }
    localPort().then(({ s, port }) => {
      pipe.port = port
      pipes.set(track, s)
      sections.push(pipe)
      // ssrc fixo por seção: o SDP do ffmpeg não conhece o do broadcast-box
      const fakeSsrc = 1000 + sections.length
      track.onReceiveRtp.subscribe(rtp => {
        try {
          rtp.header.ssrc = fakeSsrc
          s.send(rtp.serialize(), port, "127.0.0.1")
        } catch {}
      })
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
  if (!res.ok) throw new Error(`WHEP respondeu ${res.status}`)
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() })

  // espera as trilhas (vídeo + áudio) terem porta UDP pro SDP do ffmpeg
  const t0 = Date.now()
  while (sections.length < 2 && Date.now() - t0 < 10_000) await sleep(200)
  if (!sections.length) throw new Error("nenhuma trilha recebida")

  const proc = startFfmpeg(sections, outPath)
  log_(`gravando "${key}" → ${outPath}`)

  let ended = false
  const finish = async reason => {
    if (ended) return
    ended = true
    sessions.delete(key)
    try { pc.close() } catch {}
    for (const s of pipes.values()) try { s.close() } catch {}
    proc.kill("SIGINT")   // ffmpeg finaliza o MP4 com moov válido
    await new Promise(r => { proc.once("exit", r); setTimeout(r, 5_000) })
    const duration = (Date.now() - startedAt) / 1000
    addVod({ stream_key: key, file: outPath, duration, started_at: startedAt, ended_at: Date.now() })
    thumbOf(outPath)
    log_(`gravação de "${key}" encerrada (${reason}, ${Math.round(duration)}s)`)
  }

  pc.connectionStateChange.subscribe(s => { if (["failed", "closed"].includes(s)) finish("pc " + s) })
  proc.once("exit", code => { if (!ended) { log_(`ffmpeg saiu (${code}): ${proc.ffmpegErr()}`); finish("ffmpeg") } })
  return { finish }
}

export const recorder = {
  // chamado a cada varredura do /api/status no watchdog
  sync (liveKeys) {
    for (const k of liveKeys) {
      if (sessions.has(k)) continue
      sessions.set(k, startSession(k).catch(e => { sessions.delete(k); log_(`"${k}": ${e.message}`) }))
    }
    for (const [k, s] of sessions)
      if (!liveKeys.has(k)) Promise.resolve(s).then(x => x?.finish("stream acabou"))
  },
  async stopAll () {
    await Promise.allSettled([...sessions.keys()].map(k =>
      Promise.resolve(sessions.get(k)).then(x => x?.finish("shutdown"))))
  },
}

// thumb: frame de 2s (best effort; sem thumb não quebra nada)
function thumbOf (outPath) {
  spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "2", "-i", outPath,
                   "-frames:v", "1", "-q:v", "4", outPath.replace(/\.mp4$/, ".jpg")],
        { stdio: "ignore" })
}
