// FockyTV fixed lives: duas streams permanentes ("tv" e "music") publicadas no
// broadcast-box via WHIP. yt-dlp busca/baixa do YouTube (com buffer em disco),
// ffmpeg transcoda pra H264+Opus e manda RTP em localhost pro werift publicar.
// Sem viewer por 60 s a stream morre — e a playlist da música zera junto.
import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { open, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocketServer } from "ws"
import express from "express"
import { MediaStreamTrackFactory, RTCPeerConnection, useH264, useOPUS } from "werift"
import { logTrackPlayed, musicHistory, addChatMsg, chatPage, chatLatest } from "./db.js"

const BB_URL = process.env.BB_URL ?? "http://broadcast-box:8080"
const PORT = +(process.env.PORT ?? 3000)
const IDLE_MS = +(process.env.IDLE_MS ?? 60_000)
const log = (...a) => console.log(new Date().toISOString(), ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ffmpeg escolhe sequência, timestamp e SSRC novos a cada seek. O track
// WebRTC continua vivo, então conserva os três campos entre processos.
const continuousRtp = () => {
  let source = null, output = null, offset = 0, lastStamp = null, nextSequence = null
  return packet => {
    if (packet.length < 12 || packet[0] >> 6 !== 2) return packet
    const stamp = packet.readUInt32BE(4)
    const input = packet.readUInt32BE(8)
    if (input !== source) {
      source = input
      output ??= input
      offset = lastStamp === null ? 0 : (lastStamp + 1 - stamp) >>> 0
    }
    const copy = Buffer.from(packet)
    const outStamp = (stamp + offset) >>> 0
    nextSequence ??= copy.readUInt16BE(2)
    copy.writeUInt16BE(nextSequence, 2)
    copy.writeUInt32BE(outStamp, 4)
    copy.writeUInt32BE(output, 8)
    nextSequence = (nextSequence + 1) & 0xffff
    lastStamp = outStamp
    return copy
  }
}

// ── cookies do YouTube ───────────────────────────────────────────────────
// IP de datacenter recebe "Sign in to confirm you're not a bot" em vídeos
// populares. Com um cookies.txt exportado de um navegador logado (formato
// Netscape, montado em /app/cookies.txt) o yt-dlp volta a passar. Só usa o
// arquivo se parecer válido — vazio/placeholder é ignorado sem quebrar nada.
const COOKIE_FILE = process.env.COOKIES ?? "/app/cookies.txt"
const cookieState = { needed: false }
const needsCookies = text => /sign in to confirm (?:you(?:'|’)re| are) not a bot|login_required/i.test(text)
const noteYtdlpError = text => { if (needsCookies(text)) cookieState.needed = true }
const cookieFlags = () => {
  try {
    const c = readFileSync(COOKIE_FILE, "utf8")
    if (c.includes("youtube.com") && c.includes("\t")) return ["--cookies", COOKIE_FILE]
  } catch {}
  return []
}

// ── yt-dlp ──────────────────────────────────────────────────────────────
const run = (cmd, args) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    const out = [], err = []
    p.stdout.on("data", d => out.push(d))
    p.stderr.on("data", d => err.push(d))
    p.on("error", rej)
    p.on("close", code => {
      if (code === 0) return res(Buffer.concat(out))
      const message = Buffer.concat(err).toString()
      noteYtdlpError(message)
      rej(new Error(message.trim().split("\n").pop() || `${cmd} saiu com ${code}`))
    })
  })

const ytdlJson = args => run("yt-dlp", ["--no-warnings", ...cookieFlags(), ...args]).then(b => JSON.parse(b))

const searchCache = new Map() // q:limit -> {at, results}
async function search (q, limit = 8) {
  const cacheKey = `${q}:${limit}`
  const hit = searchCache.get(cacheKey)
  if (hit && Date.now() - hit.at < 60_000) return hit.results
  const j = await ytdlJson(["--flat-playlist", "-J", `ytsearch${limit}:${q}`])
  const results = (j.entries ?? [])
    .filter(e => e?.id && e.duration)
    .map(e => ({
      id: e.id,
      title: e.title ?? e.id,
      channel: e.channel ?? e.uploader ?? "",
      duration: e.duration,
      thumb: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    }))
  searchCache.set(cacheKey, { at: Date.now(), results })
  return results
}

const metaCache = new Map() // id -> {id,title,duration,thumb,hasAudio}
async function metaOf (id, audioOnly = false) {
  const ck = id + (audioOnly ? ":a" : "")
  if (metaCache.has(ck)) return metaCache.get(ck)
  // mesmas flags da hora de tocar: os formatos do -J têm que ser os que o
  // download vai puxar, senão os tamanhos não batem com o que chega no progresso
  const j = await ytdlJson(["-J", "--no-playlist", ...(audioOnly ? ["-f", "ba/b"] : ["-S", "vcodec:h264,res:720"]), `https://www.youtube.com/watch?v=${id}`])
  if (!j.duration) throw new Error("vídeo sem duração (ao vivo?)")
  const m = {
    id: j.id,
    title: j.title,
    duration: j.duration,
    thumb: j.thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    hasAudio: (j.formats ?? []).some(f => f.acodec !== "none"),
    // HLS não tem filesize: estima pelo bitrate × duração (tbr é kbit/s) pra
    // barra de download ter um total desde o primeiro byte
    downloadSizes: Object.fromEntries((j.requested_formats ?? [j.format].filter(Boolean))
      .map(f => [f.format_id, f.filesize ?? f.filesize_approx
        ?? (f.tbr ? f.tbr * 125 * j.duration : 0)])
      .filter(([, size]) => size)),
  }
  metaCache.set(ck, m)
  return m
}

// ── letras sincronizadas (LRCLIB, API pública sem chave) ────────────────
// Busca best-effort: título do YouTube limpo ("Artista - Música (Official
// Video)" → artista/música) + duração parecida. Sem letra, o player só não
// mostra nada — a música toca igual.
const titleJunk = /\s*[\(\[][^\)\]]*(official|video|lyrics?|audio|remaster|hd|4k|mv|visualizer|clipe)[^\)\]]*[\)\]]/gi
const cleanTitle = t => t
  // sufixo de canal do YouTube ("... | Warner Vault", "... | Topic") sobra
  // no título e contamina a busca de letra como se fosse nome da música
  .replace(/\s*[|｜]\s*[^|｜]*$/, "")
  .replace(titleJunk, "")
  .replace(/\s{2,}/g, " ")
  .replace(/\s*[-–—|]\s*$/, "")
  .trim()

const lrcTime = /^\[(\d+):(\d+)(?:[.:](\d+))?\]/gm
function parseLrc (lrc) {
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

const lyricsCache = new Map() // id -> lines[] | null (null = sem letra)
async function lyricsOf (meta) {
  if (lyricsCache.has(meta.id)) return lyricsCache.get(meta.id)
  let lines = null
  try {
    const get = params => fetch("https://lrclib.net/api/search?" + new URLSearchParams(params), {
      headers: { "User-Agent": "FockyTV/1.0" }, signal: AbortSignal.timeout(10_000),
    }).then(async r => {
      if (!r.ok) throw new Error(`LRCLIB ${r.status}`)
      const j = await r.json()
      if (!Array.isArray(j)) throw new Error("resposta inesperada do LRCLIB")
      return j
    })

    const [artist, ...rest] = cleanTitle(meta.title).split(/\s+[-–—|]\s+/)
    const track = rest.join(" ") || cleanTitle(meta.title)
    const tol = 12 // versão do clipe vs do álbum: alguns segundos de diferença
    const qualifies = h => h.syncedLyrics && Math.abs((h.duration ?? 0) - meta.duration) < tol

    let hits = artist && track
      ? await get({ artist_name: artist, track_name: track })
      : await get({ q: cleanTitle(meta.title) })
    // busca por artista+música é exigente: se ninguém casou, tenta o título
    // completo como fallback antes de desistir
    if (!hits.some(qualifies) && artist && track)
      hits = hits.concat(await get({ q: `${artist} ${track}` }).catch(() => []))

    const hit = hits.filter(qualifies)
      .sort((a, b) => Math.abs(a.duration - meta.duration) - Math.abs(b.duration - meta.duration))[0]
    if (hit) lines = parseLrc(hit.syncedLyrics)
    if (lines?.length) log(`[music] letra encontrada (${lines.length} linhas): ${meta.title}`)
    else log(`[music] sem letra no LRCLIB: ${meta.title}`)
    lyricsCache.set(meta.id, lines) // resultado definitivo (achou ou não)
  } catch (e) {
    // falha transitória (429, rede): NÃO cacheia — a próxima chamada tenta de
    // novo. Cachear aqui seria enterrar a letra de uma música famosa pra sempre
    log("[music] busca de letra falhou (vai retryar):", e.message)
  }
  return lines
}

// ── runner: yt-dlp | ffmpeg -> RTP (localhost) -> werift -> WHIP ─────────
// A conexão WHIP sobrevive à pausa: só os processos morrem, os sockets RTP e
// o pc continuam de pé — o retorno entra pelos mesmos sockets, sem renegociar.

// tail -f: copia um arquivo que ainda cresce pro stdin do ffmpeg. O yt-dlp
// escreve no disco o quanto a rede deixa (bem mais rápido que 1x quando está
// boa) e o ffmpeg consome no ritmo dele (-re): os bytes na frente do ffmpeg
// são o "buffer inteligente" que absorve quedas de rede sem travar o áudio.
async function tailInto (path, out, stillGrowing) {
  const fh = await open(path, "r")
  let pos = 0
  const buf = Buffer.alloc(128 * 1024)
  try {
    while (!out.destroyed) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead > 0) {
        pos += bytesRead
        // CÓPIA obrigatória: write() enfileira uma referência ao Buffer e o
        // loop já leria o próximo chunk por cima dele antes do flush —
        // corrompia a entrada a cada 128KB e o ffmpeg encerrava no meio.
        out.write(Buffer.from(buf.subarray(0, bytesRead)))
        // não enche a memória: espera o ffmpeg beber quando a fila passa de 1MB
        if (out.writableLength > 1 << 20)
          await new Promise(res => {
            const done = () => { clearTimeout(t); out.removeListener("drain", done); res() }
            const t = setTimeout(done, 1000)
            out.once("drain", done)
          })
      } else if (stillGrowing()) {
        await sleep(100) // ponta do arquivo: espera o download escrever mais
      } else {
        out.end() // download e escrita acabaram: fim da entrada
        break
      }
    }
  } catch {} finally { await fh.close().catch(() => {}) }
}

class Runner {
  constructor (key) {
    this.key = key
    this.pc = null
    this.ports = null
    this.disposers = []
    this.procs = []
    this.resource = null
    this.ended = null       // callback de fim natural da mídia
    this.playing = false    // processos vivos?
    this.offset = 0         // onde o trecho atual começa (s)
    this.mediaTime = 0      // quanto a mídia já tocou de fato (do -progress)
    this.duration = 0
    this.tmp = null
    this.bufPath = null
    this.mediaFile = null   // mídia inteira em disco (seek sem rede)
    this.mediaFileId = null
    this.downloadProgress = 0
    this.downloadTotal = 0
    this.downloadSpeed = 0
    this.downloadedBytes = {}
    this.dl = null          // yt-dlp do pipeline de streaming atual
    this.whipTries = 0
    this.gen = 0              // pipeline atual; closes de pipelines velhos ignoram
    // fila única: duas startMedia soltas (next + add, seek duplo) criavam dois
    // pipelines pros mesmos sockets RTP — killProcs do 2º rodava antes do 1º
    // spawnar e a música saía dobrada. Tudo passa por aqui, uma por vez.
    this.chain = Promise.resolve()
  }

  get live () { return !!this.pc }
  // posição real = offset + o que o ffmpeg já emitiu. Pela parede não dá:
  // entre o spawn e o primeiro frame passam segundos de download/buffer, e a
  // letra (e a barra) correriam adiante da música.
  position () { return this.offset + this.mediaTime }

  async ensurePC () {
    if (this.pc) return
    const [vTrack, vPort, vDispose] = await MediaStreamTrackFactory.rtpSource({ kind: "video", cb: continuousRtp() })
    const [aTrack, aPort, aDispose] = await MediaStreamTrackFactory.rtpSource({ kind: "audio", cb: continuousRtp() })
    this.ports = { v: vPort, a: aPort }
    this.disposers = [vDispose, aDispose]

    const pc = new RTCPeerConnection({
      iceServers: [], // broadcast-box está na mesma rede do compose
      // o broadcast-box só registra H264/AV1/VP9/H265 como vídeo — VP8 nem
      // negocia. libx264 baseline 3.1 casa com o profile-level-id 42e01f dele.
      codecs: { video: [useH264()], audio: [useOPUS()] },
      headerExtensions: { audio: [], video: [] },
    })
    // pc morto (broadcast-box reiniciou, rede caiu) = stream acabou: derruba o
    // runner pra não ficar "live" transcodando pra um túmulo morto. Guard de
    // identidade: o close de um pc descartado (erro de WHIP, retry) não conta.
    pc.connectionStateChange.subscribe(state => {
      if (this.pc !== pc) return
      if (state === "failed" || state === "closed") {
        log(`[${this.key}] conexão WHIP ${state}, encerrando`)
        this.dead?.()
        this.stop().catch(() => {})
      }
    })
    pc.addTrack(vTrack)
    pc.addTrack(aTrack)

    await pc.setLocalDescription(await pc.createOffer())
    if (pc.iceGatheringState !== "complete") await new Promise(res => {
      const t = setTimeout(res, 5000)
      pc.iceGatheringStateChange.subscribe(() => {
        if (pc.iceGatheringState === "complete") { clearTimeout(t); res() }
      })
    })

    const res = await fetch(BB_URL + "/api/whip", {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { "Content-Type": "application/sdp", Authorization: `Bearer ${this.key}` },
      body: pc.localDescription.sdp,
    })
    if (!res.ok) {
      const why = (await res.text()).trim()
      this.disposers.forEach(d => d())
      pc.close()
      // host fantasma (container antigo morto sem DELETE): o broadcast-box
      // derruba sozinho quando o ICE dele falha — espera e tenta de novo
      if (res.status === 400 && why.includes("already has a host") && this.whipTries < 10) {
        this.whipTries++
        log(`[${this.key}] host antigo ainda registrado, retry ${this.whipTries}/10 em 3s`)
        await new Promise(r => setTimeout(r, 3000))
        return this.ensurePC()
      }
      this.whipTries = 0
      throw new Error(`WHIP ${res.status}: ${why || "sem detalhes"}`)
    }
    this.whipTries = 0
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() })
    this.resource = res.headers.get("Location")
    this.pc = pc
    log(`[${this.key}] no ar (rtp :${this.ports.v}/:${this.ports.a})`)
  }

  // `video`: true = vídeo+áudio do YouTube; false = só áudio, a capa vira vídeo
  async startMedia (meta, opts) {
    const run = this.chain.then(() => this._startMedia(meta, opts))
    this.chain = run.catch(() => {}) // a fila nunca trava por um erro
    return run
  }

  async _startMedia (meta, { offset = 0, video = true, preload = false }) {
    this.killProcs()
    // geração deste pipeline: o close de um ffmpeg morto pode chegar DEPOIS
    // de o próximo já ter subido (kill é assíncrono) e disparar um ended()
    // tardio — música saía dobrada/pulada. Close de geração velha é ignorado.
    const gen = ++this.gen
    this.offset = offset
    this.duration = meta.duration
    this.tmp ??= mkdtempSync(join(tmpdir(), "fockytv-")) // capa + buffer de mídia
    let art = null // capa da música no lugar de vídeo (a grade exige videoTracks)
    if (!video) {
      try {
        const r = await fetch(meta.thumb, { signal: AbortSignal.timeout(10_000) })
        if (r.ok) { art = join(this.tmp, "art.jpg"); await writeFile(art, Buffer.from(await r.arrayBuffer())) }
      } catch {}
    }

    // música não usa o vídeo do YouTube: baixar só o áudio corta ~90% dos
    // bytes (3MB vs 30MB) e é o que mais acelera o início da faixa
    const audioOnly = !video && meta.hasAudio
    const fmt = audioOnly
      ? ["-f", "ba/b"]                // bestaudio: a capa vira o vídeo
      : ["-S", "vcodec:h264,res:720"] // já vem H264 ≤720p: menos transcode
    const url = `https://www.youtube.com/watch?v=${meta.id}`

    // mídia inteira em disco: seek/pausa/retomo não tocam mais na rede.
    let inputFile = null
    if (preload) {
      if (this.mediaFileId !== meta.id || !this.mediaFile) {
        if (this.mediaFile) { try { rmSync(this.mediaFile) } catch {} }
        this.downloadProgress = 0
        this.downloadTotal = Object.values(meta.downloadSizes ?? {}).reduce((sum, size) => sum + size, 0)
        this.downloadedBytes = {}
        const t0 = Date.now()
        log(`[${this.key}] baixando a mídia inteira antes de tocar…`)
        await new Promise((res, rej) => {
          const d = spawn("yt-dlp", [
            "-o", join(this.tmp, "media.%(ext)s"), "--no-warnings", "--no-playlist", "--newline", "--no-colors",
            "--progress-template", "download:PROGRESS:%(progress.fragment_index)s/%(progress.fragment_count)s:%(progress.downloaded_bytes)s/%(progress.total_bytes_estimate)s:%(progress.speed)s", "--progress-delta", "0.5",
            ...cookieFlags(), ...fmt, url,
          ], { stdio: ["ignore", "pipe", "pipe"], detached: true })
          let err = ""
          let formatId = null
          const readProgress = x => {
            const text = x.toString().replace(/\x1b\[[0-9;]*m/g, "")
            err += text
            const destination = text.match(/media\.f(\d+)\./)
            if (destination) formatId = destination[1]
            const progress = text.match(/PROGRESS:(\d+|NA)\/(\d+|NA):([\d.]+|NA)\/(\d+|NA)(?::([\d.]+|NA))?/)
            if (progress) {
              // HLS não informa total nem fragmentos: os bytes baixados
              // (grupo 3) são o único número que existe — use-os sempre
              const speed = +(progress[5] ?? 0)
              this.downloadSpeed = Number.isFinite(speed) ? speed : 0
              const bytes = +progress[3]
              const done = bytes > 0 ? bytes : +progress[1]
              if (!Number.isFinite(done)) return
              if (this.downloadTotal && formatId) {
                this.downloadedBytes[formatId] = done
                this.downloadProgress = Math.min(99, 100 * Object.values(this.downloadedBytes)
                  .reduce((sum, bytes) => sum + bytes, 0) / this.downloadTotal)
              } else {
                const total = +progress[4] || +progress[2]
                if (total) this.downloadProgress = Math.min(99, 100 * done / total)
              }
            }
            process.stderr.write(x)
          }
          d.stdout.on("data", readProgress)
          d.stderr.on("data", readProgress)
          this.procs = [d] // pausa/troca durante o download mata junto
          d.on("error", rej)
          d.on("close", c => {
            if (c === 0) return res()
            noteYtdlpError(err)
            rej(new Error(`download saiu com ${c}`))
          })
        })
        const f = readdirSync(this.tmp).find(x => x.startsWith("media."))
        if (!f) throw new Error("download não produziu arquivo")
        this.mediaFile = join(this.tmp, f)
        this.mediaFileId = meta.id
        this.downloadProgress = 100
        log(`[${this.key}] mídia em disco (${((Date.now() - t0) / 1000).toFixed(1)}s): navegação livre`)
      }
      inputFile = this.mediaFile
    }

    // Um vídeo inteiro pode levar mais que o timeout de ICE. Só publica o
    // WebRTC quando já há mídia pronta para enviar, senão o host cai antes do
    // primeiro frame.
    log(`[${this.key}] abrindo pc…`)
    await this.ensurePC()
    log(`[${this.key}] pc ok, spawnando mídia (offset ${offset.toFixed(0)}s)`)
    const spawnedAt = Date.now()

    let feed = null
    if (!inputFile) {
      const dl = spawn("yt-dlp", [
        "-o", "-", "--no-warnings", "--no-playlist",
        ...fmt, ...cookieFlags(),
        // corte server-side (yt-dlp: "*início-fim", sem os dois-pontos):
        // retomar dali sem baixar tudo de novo
        ...(offset > 1 ? ["--download-sections", `*${offset.toFixed(2)}-inf`] : []),
        url,
      ], { stdio: ["ignore", "pipe", "pipe"], detached: true })
      let err = ""
      dl.stderr.on("data", x => { err += x; process.stderr.write(x) })
      dl.on("close", () => noteYtdlpError(err))

      // buffer em disco no lugar do pipe direto: um pipe segura o yt-dlp nos
      // 64KB do SO (ele nunca corre à frente), então qualquer oscilação de rede
      // vira gap no áudio. No arquivo ele baixa tudo que der e o ffmpeg atrás.
      if (this.bufPath) { try { rmSync(this.bufPath) } catch {} }
      this.bufPath = join(this.tmp, "buffer.mkv")
      const writer = createWriteStream(this.bufPath)
      feed = { dlDone: false, fileDone: false }
      dl.on("close", () => { feed.dlDone = true })
      writer.on("close", () => { feed.fileDone = true })
      dl.stdout.pipe(writer)
      dl.stdout.on("error", () => {}) // EPIPE é esperado no fim
      this.dl = dl

      // pré-buffer: uns 10s de mídia em disco antes de ligar o ffmpeg. Se a
      // rede abrir lenta, não trava a faixa no primeiro segundo.
      const wantBytes = audioOnly ? 192 * 1024 : 3 * 1024 * 1024
      let buffered = 0
      for (let i = 0; i < 60; i++) {
        try { buffered = statSync(this.bufPath).size } catch { buffered = 0 }
        if (buffered >= wantBytes || (feed.dlDone && feed.fileDone)) break
        await sleep(100)
      }
      log(`[${this.key}] pré-buffer ${(buffered / 1024).toFixed(0)}KB, ligando o ffmpeg`)
    }

    // entrada 0: o arquivo pré-baixado ou o pipe. Música:
    // entrada 1 = capa/cor. áudio mudo (sem trilha no vídeo): anullsrc no fim.
    const args = ["-hide_banner", "-loglevel", "error", "-re"]
    if (inputFile) args.push("-ss", offset.toFixed(2), "-i", inputFile) // seek local: sem rede
    else args.push("-i", "pipe:0")
    const videoIn = video ? "0:v:0" : "1:v:0"
    if (!video) args.push(...(art ? ["-loop", "1", "-i", art] : ["-f", "lavfi", "-i", "color=c=black:s=640x360:r=2"]))
    const audioIn = meta.hasAudio ? "0:a:0" : `${video ? 1 : 2}:a:0`
    if (!meta.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo")
    // bounds: com capa em loop o vídeo não teria fim sem isso
    const left = Math.max(1, meta.duration - offset)
    const aenc = ["-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2"]

    const ff = spawn("ffmpeg", [
      ...args,
      "-map", videoIn,
      ...(video
        ? ["-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
           "-preset", "veryfast", "-tune", "zerolatency", "-b:v", "2500k", "-g", "60",
           "-vf", "scale='min(1280,iw)':-2,setsar=1"]
        : ["-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
           "-preset", "veryfast", "-tune", "zerolatency", "-b:v", "200k", "-g", "120", "-r", "2"]),
      "-t", left, "-f", "rtp", `rtp://127.0.0.1:${this.ports.v}`,
      "-map", audioIn, ...aenc, "-t", left, "-f", "rtp", `rtp://127.0.0.1:${this.ports.a}`,
      // posição real da mídia no stdout: é ela que sincroniza a letra
      "-progress", "pipe:1", "-nostats",
    ], { stdio: [inputFile ? "ignore" : "pipe", "pipe", "inherit"] })

    if (feed) {
      // o tailer acompanha o arquivo crescendo; o ffmpeg puxa no ritmo dele
      tailInto(this.bufPath, ff.stdin, () => !(feed.dlDone && feed.fileDone))
        .catch(() => {})
      ff.stdin.on("error", () => {}) // EPIPE é esperado no fim
      this.dl.on("error", e => { log(`[${this.key}] yt-dlp:`, e.message) })
      this.procs = [this.dl, ff]
    } else {
      this.procs = [ff]
    }
    ff.on("error", e => log(`[${this.key}] ffmpeg:`, e.message))
    let prog = ""
    ff.stdout.on("data", d => {
      prog += d.toString()
      const lines = prog.split("\n")
      prog = lines.pop()   // última incompleta espera o próximo chunk
      for (const ln of lines) {
        const m = ln.match(/^out_time_us=(\d+)/)
        if (m) {
          if (!this.firstMedia) {
            this.firstMedia = true
            log(`[${this.key}] primeira mídia no ar (${((Date.now() - spawnedAt) / 1000).toFixed(1)}s após o spawn)`)
          }
          this.mediaTime = +m[1] / 1e6
        }
      }
    })

    this.playing = true
    this.mediaTime = 0
    this.firstMedia = false

    // fim natural vs kill manual: killProcs zera `playing` antes do close
    // chegar. Registrado ANTES do gate abaixo: se a fonte morrer rápido, o
    // close dispararia antes do handler existir e o ended() nunca viria.
    ff.on("close", code => {
      try { this.dl?.kill("SIGKILL") } catch {}
      if (gen !== this.gen) return // pipeline velho: já veio outro no lugar
      if (!this.playing) return
      this.playing = false
      this.offset = this.duration // chegou até o fim
      log(`[${this.key}] mídia encerrou (ffmpeg ${code})`)
      this.ended?.()
    })

    // "live" de verdade é quando a mídia começa a sair: o status (e o
    // "carregando…" do UI) só muda com áudio fluindo. Teto de 30s e o
    // próprio close do ffmpeg resolvem caso a fonte não ande.
    await new Promise(res => {
      const done = () => { clearTimeout(t); clearInterval(iv); res() }
      const t = setTimeout(done, 30_000)
      const iv = setInterval(() => { if (this.firstMedia) done() }, 100)
      ff.once("close", done)
    })
  }

  // pausa: mata os processos e congela a posição, o pc fica no ar. Mata o
  // grupo: o yt-dlp abre um ffmpeg próprio (remux) que sobrevive ao SIGKILL
  // no pai e continuaria baixando sozinho.
  killProcs () {
    if (this.procs.length && this.playing) this.offset += this.mediaTime
    this.mediaTime = 0
    this.playing = false
    for (const p of this.procs) {
      try { process.kill(-p.pid, "SIGKILL") } catch { try { p.kill("SIGKILL") } catch {} }
    }
    this.procs = []
  }

  async stop () {
    const run = this.chain.then(() => this._stop())
    this.chain = run.catch(() => {})
    return run
  }

  async _stop () {
    this.killProcs()
    this.offset = 0
    this.duration = 0
    if (this.pc) {
      const pc = this.pc
      this.pc = null
      if (this.resource) fetch(new URL(this.resource, BB_URL), {
        method: "DELETE", headers: { Authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(3_000),
      }).catch(() => {})
      try { pc.close() } catch {}
    }
    this.disposers.forEach(d => { try { d() } catch {} })
    this.disposers = []
    this.ports = null
    if (this.tmp) {
      rmSync(this.tmp, { recursive: true, force: true })
      this.tmp = null; this.bufPath = null; this.mediaFile = null; this.mediaFileId = null
    }
  }
}

// ── tv: um vídeo por vez ────────────────────────────────────────────────
const tv = { runner: new Runner("tv"), current: null, status: "idle" } // idle|starting|live|paused
tv.runner.ended = () => {
  // acabou: desliga a stream inteira (some da grade) e volta ao início
  tv.current = null
  tv.status = "idle"
  tv.runner.stop().catch(e => log("[tv]", e.message))
}
// pc do host morreu (server reiniciou etc.): a TV continua de onde estava —
// o resume religa a partir do idle. current só se perde no stop/fim.
tv.runner.dead = () => {
  if (tv.current) tv.current.position = Math.floor(tv.runner.position())
  tv.status = "idle"
}
const tvState = () => ({
  status: tv.status,
  progress: tv.runner.downloadProgress,
  speed: Math.round(tv.runner.downloadSpeed),
  total: tv.runner.downloadTotal,
  current: tv.current && { ...tv.current, position: Math.floor(tv.runner.position()) },
})

async function tvPlay (id) {
  const meta = await metaOf(id)
  tv.current = { id: meta.id, title: meta.title, duration: meta.duration, thumb: meta.thumb }
  tv.status = "starting"
  try {
    await tv.runner.startMedia(meta, { video: true, preload: true })
    tv.status = "live"
  } catch (e) {
    tv.status = "idle"
    tv.current = null
    throw e
  }
}

// ── music: playlist colaborativa ────────────────────────────────────────
const music = {
  runner: new Runner("music"),
  queue: [],        // [{id,title,duration,thumb,addedBy}]
  index: 0,
  status: "idle",   // idle|starting|live|paused
}
music.runner.ended = () => {
  // próxima da fila, ou desliga a stream (fila permanece)
  if (music.index < music.queue.length - 1) {
    music.index++
    playCurrent().catch(e => { log("[music]", e.message); musicIdle() })
  } else musicIdle()
}
function musicIdle () {
  music.status = "idle"
  music.runner.stop().catch(e => log("[music]", e.message))
}
// pc do host morreu (server reiniciou etc.): estado volta a idle, fila fica.
// diedAt marca a queda: a janela de 15 min sem zerar a fila dá tempo do
// broadcast-box voltar e um ouvinte religar o canal.
music.runner.dead = () => { music.status = "idle"; music.diedAt = Date.now() }
async function playCurrent () {
  const item = music.queue[music.index]
  if (!item) return musicIdle()
  music.status = "starting"
  music.diedAt = null
  music.stopped = false
  // a meta veio no add (ou já está em cache): sem mais um round-trip de yt-dlp
  const meta = item.meta ?? await metaOf(item.id, true)
  try {
    await music.runner.startMedia(meta, { video: false, preload: true })
    music.status = "live"
    // histórico: só grava quando a faixa começou a tocar de verdade (não no add)
    logTrackPlayed({ video_id: item.id, title: item.title, thumb: item.thumb,
                     added_by: item.addedBy ?? null, played_at: Date.now() })
  } catch (e) {
    log("[music]", e.message)
    musicIdle()
  }
}
const musicState = () => ({
  status: music.status,
  cookiesNeeded: cookieState.needed,
  queue: music.queue,
  index: music.index,
  position: Math.floor(music.runner.position()),
  duration: music.queue[music.index]?.duration ?? 0,
  // religar automático: só se caiu por queda do host (não por stop explícito)
  stopped: !!music.stopped && !music.diedAt,
})

// ── vigia de viewers: 0 espectadores por 60 s = stream desligada ────────
// As sessões WHEP da própria grade (miniatura) não mandam `viewer`, então
// só conta quem está com o player aberto de verdade.
const zeroSince = { tv: null, music: null }
const stalledSince = { tv: null, music: null }
setInterval(async () => {
  let live
  try {
    live = (await (await fetch(BB_URL + "/api/status", { signal: AbortSignal.timeout(8_000) })).json()) ?? []
  } catch { return }

  // "live" sem processo algum por 8 s = o pipeline morreu sem passar pelo
  // ended (kill num instante ruim, close tardio ignorado pela guarda de
  // geração). Avança como fim de faixa em vez de ficar "live" mudo.
  for (const key of ["tv", "music"]) {
    const r = key === "tv" ? tv.runner : music.runner
    const st = key === "tv" ? tv : music
    if (st.status === "live" && r.live && !r.playing) {
      stalledSince[key] ??= Date.now()
      if (Date.now() - stalledSince[key] >= 8_000) {
        stalledSince[key] = null
        log(`[${key}] live sem mídia fluindo, avançando (watchdog)`)
        r.ended?.()
      }
    } else stalledSince[key] = null
  }

  for (const key of ["tv", "music"]) {
    const st = live.find(s => s.streamKey === key && s.videoTracks?.length)
    const viewers = st ? new Set((st.sessions ?? []).map(s => s.viewer).filter(Boolean)).size : 0

    const runner = key === "tv" ? tv.runner : music.runner
    if (!runner.live) {
      // canal desligado sem ouvintes: a fila morre junto — mas com janela de
      // 15 min (a mesma da queda do host), senão o zera-fila atira no add que
      // ainda está ligando (runner "not live" por ~3s entre o clique e o pc
      // subir) e em quem acabou de sair e vai voltar.
      const diedRecently = music.diedAt && Date.now() - music.diedAt < 15 * 60_000
      if (key === "music" && viewers === 0 && music.queue.length && !diedRecently) {
        zeroSince[key] ??= Date.now()
        if (Date.now() - zeroSince[key] >= 15 * 60_000) {
          zeroSince[key] = null
          log("[music] canal desligado sem ouvintes, playlist zerada")
          music.queue = []
          music.index = 0
        }
      } else zeroSince[key] = null
      continue
    }
    if (viewers > 0) { zeroSince[key] = null; continue }
    zeroSince[key] ??= Date.now()
    if (Date.now() - zeroSince[key] >= IDLE_MS) {
      zeroSince[key] = null
      log(`[${key}] sem viewers por ${IDLE_MS / 1000}s, desligando`)
      if (key === "tv") {
        tv.current = null; tv.status = "idle"; runner.stop().catch(() => {})
      } else {
        // ninguém ouvindo por 60s: desliga a stream (economia de recursos),
        // mas a fila fica — sair da aba por 1 min não pode apagar a playlist.
        // Quem voltar religa pelo resume (ou pelo relight da UI).
        log("[music] sem ouvintes por 60s, desligando (fila fica)")
        musicIdle()
      }
    }
  }
}, 5000)

// ── API ─────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json({ limit: "256kb" }))
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }))

// dev: quando o app aponta direto pro sidecar (sem broadcast-box na frente),
// /api/status precisa existir pra UI não quebrar com 404 de HTML
app.get("/api/status", (req, res) => res.json([]))

// ── /yt da sala: áudio do YouTube pelo mesmo pipeline do canal de música ──
// yt-dlp extrai a URL do bestaudio; o stream é proxado pra evitar o 403 de
// IP-lock do googlevideo nos clientes e dar suporte a Range (seek).
const ytCache = new Map()      // videoId -> { at, title, duration, url }
const ytPending = new Map()    // videoId -> Promise (dedup entre os membros)

async function jamYtMeta (id) {
  const hit = ytCache.get(id)
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit
  const prom = ytPending.get(id) ?? (async () => {
    const j = await ytdlJson(["-J", "--no-playlist", "-f", "ba/b", ...cookieFlags(),
                              `https://www.youtube.com/watch?v=${id}`])
    const url = j.requested_formats?.[0]?.url ?? j.url
    if (!url) throw new Error("sem stream de áudio")
    const meta = { at: Date.now(), title: j.title ?? id, duration: j.duration ?? 0, url }
    ytCache.set(id, meta)
    return meta
  })()
  ytPending.set(id, prom)
  try { return await prom } finally { ytPending.delete(id) }
}

app.get("/api/fixed/jam/yt", wrap(async (req, res) => {
  const id = (req.query.id ?? "").toString()
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: "id inválido" })
  const meta = await jamYtMeta(id)
  res.json({ title: meta.title, duration: meta.duration, url: meta.url })
}))

app.get("/api/fixed/jam/yt/stream", wrap(async (req, res) => {
  let u
  try { u = new URL((req.query.u ?? "").toString()) } catch { return res.status(400).json({ error: "url inválida" }) }
  if (!u.hostname.endsWith(".googlevideo.com")) return res.status(400).json({ error: "host não permitido" })
  const headers = {}
  if (req.headers.range) headers.Range = req.headers.range
  const r = await fetch(u, { headers, signal: AbortSignal.timeout(30_000) })
  const pass = {}
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"])
    if (r.headers.get(h)) pass[h] = r.headers.get(h)
  res.writeHead(r.status, pass)
  if (r.body) Readable.fromWeb(r.body).pipe(res)
  else res.end()
}))

app.get("/api/fixed/search", wrap(async (req, res) => {
  const q = (req.query.q ?? "").toString().trim()
  if (q.length < 2) return res.json([])
  const limit = Math.min(20, Math.max(1, +(req.query.limit ?? 8) || 8))
  res.json(await search(q, limit))
}))

// Proxy de imagens externas (capas do YouTube etc.): dentro da Activity do
// Discord o CSP bloqueia img de outras origens — a UI reescreve para cá.
app.get("/api/fixed/img", wrap(async (req, res) => {
  const url = (req.query.url ?? "").toString()
  let u
  try { u = new URL(url) } catch { return res.status(400).json({ error: "url inválida" }) }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: "protocolo" })
  const r = await fetch(u, { signal: AbortSignal.timeout(8_000) })
  if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/"))
    return res.status(502).json({ error: "não é imagem" })
  res.setHeader("content-type", r.headers.get("content-type"))
  res.setHeader("cache-control", "public, max-age=86400")
  // fetch devolve web stream; express espera stream do node
  Readable.fromWeb(r.body).pipe(res)
}))

app.get("/api/fixed/tv", (req, res) => res.json(tvState()))
app.post("/api/fixed/tv/play", wrap(async (req, res) => {
  if (!req.body?.id) return res.status(400).json({ error: "id obrigatório" })
  await tvPlay(req.body.id)
  res.json(tvState())
}))
app.post("/api/fixed/tv/stop", wrap(async (req, res) => {
  tv.current = null; tv.status = "idle"
  await tv.runner.stop()
  res.json(tvState())
}))
// seek na TV: clicar/arrastar a barra do player
app.post("/api/fixed/tv/seek", wrap(async (req, res) => {
  const pos = Math.max(0, +(req.body?.position ?? -1))
  if (pos < 0 || !tv.current || !tv.runner.live)
    return res.status(400).json({ error: "nada tocando" })
  await tv.runner.startMedia(await metaOf(tv.current.id),
    { offset: Math.min(pos, Math.max(0, tv.current.duration - 5)), video: true, preload: true })
  tv.status = "live"
  res.json(tvState())
}))
app.post("/api/fixed/tv/pause", (req, res) => {
  if (tv.status === "live") { tv.runner.killProcs(); tv.status = "paused" }
  res.json(tvState())
})
app.post("/api/fixed/tv/resume", wrap(async (req, res) => {
  if (tv.status === "paused" || (tv.status === "idle" && tv.current)) {
    // idle+current = o host caiu no meio (broadcast-box reiniciou): religa
    // de onde parou, ou do começo se a posição não sobreviveu
    const off = tv.status === "paused" ? tv.runner.position()
      : Math.min(tv.current.position ?? 0, Math.max(0, tv.current.duration - 5))
    await tv.runner.startMedia(await metaOf(tv.current.id),
      { offset: off, video: true, preload: true })
    tv.status = "live"
  }
  res.json(tvState())
}))

app.get("/api/fixed/music", (req, res) => res.json(musicState()))
app.post("/api/fixed/cookies", wrap(async (req, res) => {
  const cookies = req.body?.cookies
  if (typeof cookies !== "string" || cookies.length > 256 * 1024 || !cookies.includes("youtube.com") || !cookies.includes("\t"))
    return res.status(400).json({ error: "envie um cookies.txt do YouTube no formato Netscape" })
  await writeFile(COOKIE_FILE, cookies, { mode: 0o600 })
  cookieState.needed = false
  if (music.status === "idle" && music.queue.length) playCurrent()
  res.json({ ok: true })
}))
app.post("/api/fixed/music/add", wrap(async (req, res) => {
  const { id, addedBy } = req.body ?? {}
  if (!id) return res.status(400).json({ error: "id obrigatório" })
  const meta = await metaOf(id, true)
  music.queue.push({ id: meta.id, title: meta.title, duration: meta.duration, thumb: meta.thumb, addedBy, meta })
  // dispara sem esperar: a resposta volta na hora (o UI mostra "carregando…"),
  // e cliques repetidos não acumulam outra playCurrent — status já é "starting"
  if (music.status === "idle") playCurrent()
  res.json(musicState())
}))
app.post("/api/fixed/music/remove", wrap(async (req, res) => {
  const i = +(req.body?.index ?? -1)
  if (i < 0 || i >= music.queue.length) return res.status(400).json({ error: "índice inválido" })
  if (i === music.index) return res.status(400).json({ error: "use next ou stop para tirar a que está tocando" })
  music.queue.splice(i, 1)
  if (i < music.index) music.index--
  res.json(musicState())
}))
app.post("/api/fixed/music/next", wrap(async (req, res) => {
  if (music.index < music.queue.length - 1) {
    music.index++
    await playCurrent()
  } else musicIdle()
  res.json(musicState())
}))
app.post("/api/fixed/music/pause", (req, res) => {
  if (music.status === "live") { music.runner.killProcs(); music.status = "paused" }
  res.json(musicState())
})
// pular direto pra uma faixa da fila (clique na playlist)
app.post("/api/fixed/music/jump", wrap(async (req, res) => {
  const i = +(req.body?.index ?? -1)
  if (i < 0 || i >= music.queue.length) return res.status(400).json({ error: "índice inválido" })
  music.index = i
  await playCurrent()
  res.json(musicState())
}))
// seek: clicar numa linha da letra (ou onde for) reinicia o trecho dali
app.post("/api/fixed/music/seek", wrap(async (req, res) => {
  const pos = Math.max(0, +(req.body?.position ?? -1))
  const item = music.queue[music.index]
  if (pos < 0 || !item || !music.runner.live)
    return res.status(400).json({ error: "nada tocando" })
  await music.runner.startMedia(await metaOf(item.id, true),
    { offset: Math.min(pos, Math.max(0, item.duration - 5)), video: false, preload: true })
  music.status = "live"   // seek despausa: a mídia volta a fluir
  res.json(musicState())
}))
// letra sincronizada da faixa atual (vazia se não houver)
app.get("/api/fixed/music/lyrics", wrap(async (req, res) => {
  const item = music.queue[music.index]
  if (!item) return res.json({ id: null, lines: [] })
  res.json({ id: item.id, lines: (await lyricsOf(item)) ?? [] })
}))
// histórico do canal de música: ?days=7 (padrão) limita a janela
app.get("/api/fixed/music/history", (req, res) => {
  const days = Math.min(90, Math.max(1, +(req.query.days ?? 7) || 7))
  res.json(musicHistory(Date.now() - days * 86_400_000))
})
app.post("/api/fixed/music/resume", wrap(async (req, res) => {
  // broadcast-box reiniciou etc. deixou o canal em idle com a fila viva: o
  // resume tem que religar, senão o ouvinte fica controlando a timeline
  // de um canal que nunca volta a tocar (e 60s depois a fila zera).
  if (music.status === "idle" && music.queue.length) {
    await playCurrent()
    return res.json(musicState())
  }
  if (music.status !== "paused") return res.json(musicState())
  await music.runner.startMedia(await metaOf(music.queue[music.index].id, true),
    { offset: music.runner.position(), video: false, preload: true })
  music.status = "live"
  res.json(musicState())
}))
app.post("/api/fixed/music/stop", wrap(async (req, res) => {
  musicIdle()
  music.index = 0 // para de vez: a próxima toca do começo da fila
  music.stopped = true   // não religa sozinho: foi escolha de quem parou
  res.json(musicState())
}))

// ── sala de músicos: sinalização P2P ────────────────────────────────────
// A sala é mesh: cada músico abre RTCPeerConnection direto pra cada outro
// (só DataChannel, áudio via WebCodecs neles). Aqui é só o maestro de SDP/ICE:
// WebSocket retransmite mensagens entre os pares da sala. Nada de mídia passa
// por este servidor, salas são efêmeras (somem quando o último sai).
const jamWss = new WebSocketServer({ noServer: true })
// sala -> Map(nick -> ws). Reuso de nick derruba o antigo (reconexão).
const jamRooms = new Map()

const jamSend = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }

jamWss.on("error", e => log("[jam] wss error:", e.message))

jamWss.on("connection", (ws, req) => {
  // frame malformado/reset: mata a conexão, nunca o processo
  ws.on("error", e => log(`[jam] ws error (${req?.url?.slice(0, 40)}):`, e.message))
  const u = new URL(req.url, "http://x")
  const room = (u.searchParams.get("room") ?? "").trim().slice(0, 64)
  const nick = (u.searchParams.get("nick") ?? "").trim().slice(0, 32)
  if (!room || !nick) return ws.close(4001, "room e nick obrigatórios")

  const members = jamRooms.get(room) ?? new Map()
  const old = members.get(nick)
  if (old && old !== ws) { jamSend(old, { type: "evicted" }); old.close() }
  members.set(nick, ws)
  jamRooms.set(room, members)
  log(`[jam] ${nick} entrou em "${room}" (${members.size})`)

  // quem já está na sala aprende sobre o novo; o novo recebe a lista pra abrir
  // as offers (joiner conecta aos veteranos — evita offer dupla no par)
  for (const [other, ows] of members) if (ows !== ws) jamSend(ows, { type: "peer-joined", nick })
  jamSend(ws, { type: "peers", peers: [...members.keys()].filter(n => n !== nick) })

  ws.on("message", data => {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg.type === "ping") return jamSend(ws, { type: "pong", t: msg.t })
    // chat da sala: broadcast pra todos (o remetente renderiza o dele local)
    if (msg.type === "chat" && typeof msg.text === "string") {
      const text = msg.text.slice(0, 500)
      for (const ows of members.values()) if (ows !== ws) jamSend(ows, { type: "chat", from: nick, text })
      return
    }
    // /yt do chat: estado do player compartilhado (load/state/seek)
    if (msg.type === "yt") {
      const relay = { type: "yt", from: nick, ...msg }
      for (const ows of members.values()) if (ows !== ws) jamSend(ows, relay)
      return
    }
    // offer/answer/ice vão endereçados; relay cego pro destino
    const dst = typeof msg.to === "string" ? members.get(msg.to) : null
    if (dst) jamSend(dst, { ...msg, from: nick })
  })

  const leave = () => {
    if (members.get(nick) !== ws) return // reconexão já assumiu o nick
    members.delete(nick)
    if (members.size) jamRooms.set(room, members)
    else jamRooms.delete(room)
    for (const ows of members.values()) jamSend(ows, { type: "peer-left", nick })
    log(`[jam] ${nick} saiu de "${room}" (${members.size})`)
  }
  ws.on("close", leave)
})

// upgrade do WebSocket na mesma porta do express
const httpServer = app.listen(PORT, () => log(`fixed-live na porta ${PORT}, broadcast-box em ${BB_URL}`))
httpServer.on("upgrade", (req, sock, head) => {
  // sob o prefixo do proxy do broadcast-box (ReverseProxy repassa o upgrade do WS)
  if (req.url.startsWith("/api/fixed/ws/jam")) jamWss.handleUpgrade(req, sock, head, ws => jamWss.emit("connection", ws, req))
  else if (req.url.startsWith("/api/fixed/ws/chat")) chatWss.handleUpgrade(req, sock, head, ws => chatWss.emit("connection", ws, req))
  else sock.destroy()
})

// ── chat global: uma sala só, todas as streams ───────────────────────────
// Relay + persistência (SQLite): o histórico sobrevive a restart e a UI
// pagina pra trás com ?before=. Mensagem vai também pro remetente — o cliente
// renderiza a dele pelo eco, nunca localmente (uma fonte só de verdade).
const chatWss = new WebSocketServer({ noServer: true })
const chatClients = new Set()

const chatBroadcast = obj => {
  const data = JSON.stringify(obj)
  for (const ws of chatClients) if (ws.readyState === ws.OPEN) ws.send(data)
}
const chatCount = () => chatBroadcast({ type: "count", n: chatClients.size })

chatWss.on("error", e => log("[chat] wss error:", e.message))

chatWss.on("connection", (ws, req) => {
  ws.on("error", e => log("[chat] ws error:", e.message))
  const u = new URL(req.url, "http://x")
  const nick = (u.searchParams.get("nick") ?? "").trim().slice(0, 32)
  if (!nick) return ws.close(4001, "nick obrigatório")

  ws.nick = nick
  ws.lastMsg = 0
  chatClients.add(ws)
  ws.send(JSON.stringify({ type: "history", msgs: chatLatest(50) }))
  chatCount()
  log(`[chat] ${nick} entrou (${chatClients.size})`)

  ws.on("message", data => {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong", t: msg.t }))
    if (msg.type !== "chat" || typeof msg.text !== "string") return
    const text = msg.text.trim().slice(0, 500)
    if (!text) return
    // spam mínimo: 3 mensagens por segundo vira silêncio (sem erro, só ignora)
    if (Date.now() - ws.lastMsg < 300) return
    ws.lastMsg = Date.now()
    const at = Date.now()
    let id
    try { ({ lastInsertRowid: id } = addChatMsg(nick, text, at)) } catch (e) { log("[chat] db:", e.message); return }
    chatBroadcast({ type: "chat", id, from: nick, text, at })
  })

  ws.on("close", () => {
    chatClients.delete(ws)
    chatCount()
    log(`[chat] ${nick} saiu (${chatClients.size})`)
  })
})

// scrollback: página anterior a uma mensagem (infinito pra trás na UI)
app.get("/api/fixed/chat", (req, res) => {
  const before = +(req.query.before ?? 0) || Number.MAX_SAFE_INTEGER
  res.json(chatPage(before, Math.min(100, Math.max(1, +(req.query.limit ?? 50) || 50))))
})

// lista de salas pra UI, no formato de canal fixo (status + conteúdo)
app.get("/api/fixed/jam", (req, res) => {
  const rooms = [...jamRooms.entries()].map(([room, members]) =>
    ({ room, members: [...members.keys()] }))
  res.json({ status: rooms.length ? "live" : "idle", rooms,
             total: rooms.reduce((n, r) => n + r.members.length, 0) })
})


// docker stop/recreate: mata os hosts com DELETE, senão o broadcast-box fica
// com sessão fantasma ("already has a host"). Registrado UMA vez aqui — no
// ensurePC ele se multiplicava a cada pc novo e disparavam todos em corrida.
// _stop direto, fora da fila: um startMedia esperando mídia (até 30s) atrasaria
// o delete além dos 10s que o docker espera antes do SIGKILL.
process.once("SIGTERM", () => {
  log("SIGTERM: encerrando hosts")
  Promise.race([
    Promise.allSettled([tv.runner._stop(), music.runner._stop()]),
    sleep(5_000),
  ]).finally(() => process.exit(0))
})
