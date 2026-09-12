const { app, BrowserWindow, Menu, Tray, ipcMain, desktopCapturer, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn, execFile, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const hasTool = t => { try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }); return true } catch { return false } }
const linuxAudio = process.platform === 'linux' && hasTool('pw-dump') && hasTool('pw-cat')

// config.json editável fica ao lado do arquivo que o usuário abriu.
// No AppImage, exe aponta pro mount temporário — o caminho real é $APPIMAGE.
// Segunda instância publicaria com a mesma stream key e colidiria no servidor.
if (!app.requestSingleInstanceLock()) app.quit()

const wayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY

const configPath = [
  process.env.APPIMAGE && path.join(path.dirname(process.env.APPIMAGE), 'config.json'),
  path.join(path.dirname(app.getPath('exe')), 'config.json'),
  path.join(__dirname, '..', 'config.json'),   // dev, e default embutido
].find(p => p && fs.existsSync(p))
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

let win, tray, quitting = false
let sources = []    // fontes da última consulta; o handler resolve contra ELAS
let picked = null   // id escolhido no overlay

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)   // sem File/Edit/View

  ipcMain.handle('config', () => ({
    ...config,
    version: app.getVersion(),   // o renderer compara com a última atualização vista
    // no Wayland é o getSources que abre o portal — muda o fluxo da troca
    wayland,
    win: process.platform === 'win32',
    linux: process.platform === 'linux',
    // filtro de áudio por app: helper WASAPI no Windows, PipeWire no Linux
    // (ou seno de teste, pra dev). windowFilter exige saber o PID da janela:
    // X11 via wmctrl; no Wayland o portal não conta quem foi escolhido.
    audioFilter: process.platform === 'win32' || linuxAudio || process.env.FOCKY_AUDIO_TEST === '1',
    windowFilter: process.platform === 'win32' || (linuxAudio && hasTool('wmctrl') && !wayland),
    // sala de músicos: microfone pelo helper WASAPI exclusivo (10ms, sem
    // pipeline de voz do Windows); a UI esconde a opção fora do Windows
    nativeMic: process.platform === 'win32',
  }))

  ipcMain.handle('sources', async () => {
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        // NÃO baixar isto pra 0x0 "porque no Wayland a lista não é exibida":
        // com 0x0 o capturer PipeWire morre logo após a 1ª chamada (medido,
        // 4/4 runs). Os ~2s por chamada são o preço do portal.
        thumbnailSize: { width: 320, height: 200 },
      })
    } catch (err) {
      sources = []
      throw new Error('Não foi possível listar as telas: ' + err.message)
    }
    return sources.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }))
  })

  ipcMain.handle('pick', (_e, id) => { picked = id })

  // O renderer já escolheu antes de chamar getDisplayMedia, então aqui é só entregar.
  // NÃO chamar getSources de novo: no Wayland cada chamada abre uma sessão nova do
  // portal e os ids não batem entre chamadas. Resolve contra o que já foi listado.
  session.defaultSession.setDisplayMediaRequestHandler((req, callback) => {
    const src = sources.find(s => s.id === picked) ?? sources[0]
    if (!src) return callback({})
    // gotcha #5: áudio do sistema só no Windows; no Linux depende de PipeWire, fica pra depois.
    // audioRequested importa: com o filtro por app ligado o renderer pede audio:false, e
    // entregar loopback assim mesmo punha o som do sistema (Discord junto) numa 2ª trilha —
    // que era justamente a que o publish mandava pro WHIP.
    callback(process.platform === 'win32' && req.audioRequested
      ? { video: src, audio: 'loopback' } : { video: src })
  })

  // ── áudio filtrado por aplicativo (Windows) ─────────────────────────────
  // O loopback do Chromium é sempre do dispositivo inteiro; filtrar por app
  // (janela escolhida, ou "tudo menos o Discord") é o helper WASAPI, que
  // escreve PCM em stdout. O renderer transforma isso numa MediaStreamTrack
  // (audioStart/audioStop + eventos audio-meta/audio-pcm). O Chromium não
  // renegocia o WHIP, então a track entra no lugar da do getDisplayMedia.
  ipcMain.handle('audio-start', (_e, opts) => audioStart(opts))
  ipcMain.handle('audio-stop', () => audioStop())

  const icon = path.join(__dirname, '..', 'build', 'icon.png')

  win = new BrowserWindow({
    width: 1100, height: 720,
    backgroundColor: '#111',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // sem isto o Chromium bloqueia o som de abertura (não houve clique ainda)
      autoplayPolicy: 'no-user-gesture-required',
      // a composição tela+câmera desenha num canvas por timer: minimizado na
      // bandeja, o Chromium congelaria o timer e a transmissão pararia.
      backgroundThrottling: false,
    },
  })
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'))

  // Fechar a janela esconde; sair é só pela tray. Assim a transmissão
  // continua no ar com a janela fora do caminho.
  win.on('close', e => {
    if (quitting) return
    e.preventDefault()
    win.hide()
  })

  const show = () => { win.show(); win.focus() }

  tray = new Tray(icon)
  tray.setToolTip('FockyTV')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir FockyTV', click: show },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit() } },
  ]))
  // No Windows o clique simples abre; no Linux muitas bandejas só entregam o menu.
  tray.on('click', show)

  app.on('second-instance', show)

  setupUpdates()
})

// ── áudio por aplicativo: ciclo de vida do helper ─────────────────────────
// Dentro do asar não dá para executar: o audio-helper vai em asarUnpacked.
const helperPath = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'),
  'audio-helper', 'audio-helper.exe')

// Diagnóstico (picotado, app vazando no áudio): fica em <userData>/audio-filter.log
const alogPath = () => path.join(app.getPath('userData'), 'audio-filter.log')
// diagnóstico não pode virar um arquivo de 1GB numa máquina que fica meses
// aberta: passou de 1MB, recomeça (o histórico antigo nunca serviu pra nada).
const appendLog = (file, m) => {
  try {
    if ((fs.statSync(file).size ?? 0) > 1 << 20) fs.rmSync(file, { force: true })
  } catch {}
  try { fs.appendFileSync(file, new Date().toISOString() + ' ' + m + '\n') } catch {}
}
const alog = m => appendLog(alogPath(), m)

let audioProc = null, headerBuf = null, metaSent = false, pcmPending = [], pcmFlush = null

let audioGen = 0

async function audioStart (opts) {
  audioStop()
  const gen = ++audioGen
  const args =
    opts.mode === 'test' ? ['--test'] :
    opts.mode === 'window' ? ['--hwnd', String(opts.hwnd)] :
    opts.mode === 'exclude' ? ['--exclude-name', opts.name ?? 'Discord'] :
    opts.mode === 'mic' ? ['--mic'] : null
  if (opts.mode === 'mic' && process.platform !== 'win32')
    return { ok: false, error: 'captura nativa do microfone é só no Windows (WASAPI)' }
  if (opts.mode !== 'test' && process.platform === 'linux') {
    // window|exclude|screen: no PipeWire dá pra capturar (e misturar) os
    // streams de app direto; o modo screen pega todos sem exceção
    if (linuxAudio) return startLinuxAudio(opts)
    // dev fora do Windows: FOCKY_AUDIO_TEST=1 troca o helper por um seno,
    // para exercitar o pipeline do renderer (a UI nem mostra a opção sem isso)
    if (process.env.FOCKY_AUDIO_TEST === '1') {
      startTestTone()
      return { ok: true, rate: 48000, channels: 2 }
    }
    alog('sem pw-dump/pw-cat')
    return { ok: false, error: 'filtro de áudio precisa de PipeWire (pw-cat/pw-dump)' }
  }
  if (!args) return { ok: false, error: 'modo inválido' }
  alog('start ' + args.join(' '))
  headerBuf = null
  metaSent = false
  pcmPending = []
  return new Promise(res => {
    let settled = false
    const done = r => { if (!settled) { settled = true; alog('ready ' + JSON.stringify(r)); res(r) } }

    if (opts.mode === 'test' && process.platform !== 'win32') {
      // dev: valida o pipeline do renderer fora do Windows com um seno em JS
      startTestTone()
      return done({ ok: true, rate: 48000, channels: 2 })
    }

    try {
      audioProc = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      alog('spawn falhou: ' + e.message)
      return done({ ok: false, error: 'helper: ' + e.message })
    }
    const timer = setTimeout(() => { alog('timeout esperando header'); done({ ok: false, error: 'helper não respondeu' }) }, 10000)

    // rajadas de stdout viram mensagens IPC de ~40ms: menos jitter no caminho.
    // O pipe corta em qualquer byte: mandar frame pela metade desloca o
    // interleave do resto da transmissão (é o "som quebrado"). Sobra fica.
    let frameBytes = 0
    const flush = () => {
      if (!frameBytes || !pcmPending.length) return
      const buf = Buffer.concat(pcmPending)
      const cut = buf.length - buf.length % frameBytes
      pcmPending = cut < buf.length ? [buf.subarray(cut)] : []
      if (cut) win?.webContents.send('audio-pcm', buf.subarray(0, cut))
    }

    audioProc.stdout.on('data', chunk => {
      // primeiro pedaço traz o header próprio: "FPCM" + rate + channels
      let buf = chunk
      if (!metaSent) {
        headerBuf = headerBuf ?? Buffer.alloc(0)
        headerBuf = Buffer.concat([headerBuf, buf])
        if (headerBuf.length < 16) return
        buf = headerBuf
        headerBuf = null
        if (buf.readUInt32BE(0) !== 0x4650434D) {   // "FPCM"
          alog('header desconhecido')
          audioProc.kill()
          clearTimeout(timer)
          return done({ ok: false, error: 'protocolo do helper não reconhecido' })
        }
        const rate = buf.readUInt32LE(4), channels = buf.readUInt32LE(8)
        frameBytes = channels * 4
        win?.webContents.send('audio-meta', { rate, channels })
        metaSent = true
        clearInterval(pcmFlush)
        // sala de músicos (mic): cada 40ms de flush é latência a mais na
        // conta — lá o caminho é curto o suficiente pra valer tick de 10ms
        pcmFlush = setInterval(flush, opts.mode === 'mic' ? 10 : 40)
        clearTimeout(timer)
        done({ ok: true, rate, channels })
        buf = buf.subarray(16)
      }
      if (buf.length) pcmPending.push(buf)
    })
    let err = ''
    audioProc.stderr.on('data', d => { err += d; alog('stderr: ' + d.toString().trim()) })
    audioProc.on('error', e => { clearTimeout(timer); alog('erro: ' + e.message); done({ ok: false, error: e.message }) })
    audioProc.on('exit', code => {
      clearInterval(pcmFlush); pcmFlush = null
      clearTimeout(timer)
      alog('exit ' + code + (err.trim() ? ' stderr=' + err.trim() : ''))
      if (!settled && code !== 0)
        return done({ ok: false, error: 'helper saiu (' + code + '): ' + err.trim() })
      if (settled && code !== 0) {
        // morreu no meio da transmissão (processo alvo fechou, crash): tenta
        // de novo — o Discord reiniciando não pode matar o áudio da stream
        const mode = opts.mode, hwnd = opts.hwnd, name = opts.name
        alog('respawn em 3s')
        // só se ninguém pediu stop nem começou outra captura no meio tempo:
        // audioProc==null também é o estado logo depois do stop
        setTimeout(() => { if (gen === audioGen && !audioProc) audioStart({ mode, hwnd, name }) }, 3000)
      }
      audioProc = null
    })
  })
}

function audioStop () {
  audioGen++
  stopTestTone()
  stopLinuxAudio()
  clearInterval(pcmFlush); pcmFlush = null
  if (audioProc) { const p = audioProc; audioProc = null; alog('stop'); p.kill() }
}

// ── áudio por aplicativo no Linux (PipeWire) ──────────────────────────────
// Cada app que toca som é um nó "Stream/Output/Audio" no PipeWire com
// binary/pid nas props. O supervisor enumera (pw-dump), grava cada nó da
// seleção (pw-cat --target <serial>, f32 48k estéreo) e mistura em JS.
// Sem app tocando sai silêncio — o clock do RTP segue andando.
let linuxPoller = null, linuxMixTimer = null
const linuxProcs = new Map()   // serial → { proc, bufs: Buffer[] }

function linuxSelect (props, opts) {
  if (props['media.class'] !== 'Stream/Output/Audio') return false
  if (opts.mode === 'window') return +props['application.process.pid'] === opts.pid
  if (opts.mode === 'exclude') return !/^discord/i.test(props['application.process.binary'] ?? '')
  return true   // tela toda com som
}

function linuxPidOfHwnd (hwnd) {
  try {
    const out = execFileSync('wmctrl', ['-lp'], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const m = line.match(/^(0x[0-9a-fA-F]+)\s+\S+\s+(\d+)/)
      if (m && parseInt(m[1], 16) === Number(hwnd)) return +m[2]
    }
  } catch {}
  return 0
}

function startLinuxAudio (opts) {
  alog('linux start ' + JSON.stringify(opts))
  if (opts.mode === 'window') {
    opts = { ...opts, pid: linuxPidOfHwnd(opts.hwnd) }
    if (!opts.pid) return { ok: false, error: 'não achei o processo da janela' }
  }
  const RATE = 48000, CH = 2, FRAMES = 960   // 20ms por tick
  win?.webContents.send('audio-meta', { rate: RATE, channels: CH })

  linuxPoller = setInterval(() => {
    execFile('pw-dump', { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !linuxPoller) return
      let nodes
      try { nodes = JSON.parse(stdout).filter(o => o.type === 'PipeWire:Interface:Node') } catch { return }
      const wanted = new Set()
      for (const n of nodes) {
        const p = n.info?.props ?? {}
        if (!linuxSelect(p, opts)) continue
        const serial = +(p['object.serial'] ?? 0)
        if (!serial || linuxProcs.has(serial)) { if (serial) wanted.add(serial); continue }
        wanted.add(serial)
        alog('capturando serial ' + serial + ' (' + (p['application.process.binary'] ?? p['node.name'] ?? '?') + ')')
        const proc = spawn('pw-cat',
          ['record', '--raw', '--format', 'f32', '--rate', '48000', '--channels', '2',
           '--target', String(serial), '-'],
          { stdio: ['ignore', 'pipe', 'inherit'] })
        const entry = { proc, bufs: [] }
        proc.stdout.on('data', d => entry.bufs.push(d))
        proc.on('exit', () => { linuxProcs.delete(serial); alog('serial ' + serial + ' saiu') })
        linuxProcs.set(serial, entry)
      }
      for (const [serial, e] of linuxProcs)
        if (!wanted.has(serial)) { alog('largando serial ' + serial); e.proc.kill(); linuxProcs.delete(serial) }
    })
  }, 1000)
  linuxPoller.refresh()   // enumera já, sem esperar 1s

  const mix = Buffer.allocUnsafe(FRAMES * CH * 4)
  linuxMixTimer = setInterval(() => {
    mix.fill(0)
    const out = new Float32Array(mix.buffer, 0, FRAMES * CH)
    for (const e of linuxProcs.values()) {
      // consome FRAMES frames da fonte; o que faltar entra como zero
      let need = FRAMES * CH * 4
      const src = []
      while (need > 0 && e.bufs.length) {
        const b = e.bufs[0]
        if (b.length <= need) { src.push(b); need -= b.length; e.bufs.shift() }
        else { src.push(b.subarray(0, need)); e.bufs[0] = b.subarray(need); need = 0 }
      }
      let off = 0
      for (const b of src) {
        for (let i = 0; i + 4 <= b.length && off < out.length; i += 4, off++)
          out[off] += b.readFloatLE(i)
      }
      if (e.bufs.length > 64) e.bufs.splice(0, e.bufs.length - 64)   // atrasou: descarta
    }
    for (let i = 0; i < out.length; i++)
      if (out[i] > 1) out[i] = 1; else if (out[i] < -1) out[i] = -1
    win?.webContents.send('audio-pcm', mix)
  }, 20)
  return { ok: true, rate: RATE, channels: CH }
}

function stopLinuxAudio () {
  clearInterval(linuxPoller); linuxPoller = null
  clearInterval(linuxMixTimer); linuxMixTimer = null
  for (const e of linuxProcs.values()) e.proc.kill()
  linuxProcs.clear()
}

// ── seno de teste (dev em não-Windows): mesma interface do helper ─────────
let testTimer = null
function startTestTone () {
  stopTestTone()
  const rate = 48000, ch = 2, frames = 480   // 10ms
  win?.webContents.send('audio-meta', { rate, channels: ch })
  let phase = 0
  testTimer = setInterval(() => {
    const buf = Buffer.allocUnsafe(frames * ch * 4)
    for (let i = 0; i < frames; i++) {
      const v = Math.sin(2 * Math.PI * 440 * phase / rate) * 0.2
      phase = (phase + 1) % rate
      for (let c = 0; c < ch; c++) buf.writeFloatLE(v, (i * ch + c) * 4)
    }
    win?.webContents.send('audio-pcm', buf)
  }, 10)
}
function stopTestTone () { clearInterval(testTimer); testTimer = null }

// ── auto-update (AppImage e NSIS; o feed são as Releases do GitHub) ──────
function setupUpdates () {
  if (!app.isPackaged) return          // em dev não há feed nem assinatura

  const send = (state, info) =>
    // releaseNotes é o corpo da release no GitHub (HTML): vira o resumo que o
    // app mostra no primeiro boot depois de atualizar
    win?.webContents.send('update',
      { state, version: info?.version, notes: info?.releaseNotes })

  autoUpdater.on('update-available', i => send('available', i))
  autoUpdater.on('update-downloaded', i => send('ready', i))
  autoUpdater.on('error', e => send('error', { version: e.message }))

  ipcMain.handle('install-update', () => {
    quitting = true
    // (isSilent, isForceRunAfter): sem o silent, o NSIS assistido reabre o
    // wizard inteiro a cada update — com ele o instalador roda com /S, na pasta
    // que já está no registro, e o --force-run traz o app de volta sozinho.
    // No Linux o AppImage já se troca sem UI nenhuma.
    autoUpdater.quitAndInstall(true, true)
  })

  autoUpdater.checkForUpdates().catch(() => {})
  // ponytail: intervalo fixo de 6h. Se um dia precisar de release urgente,
  // trocar por um push do servidor em vez de encurtar o intervalo.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000)
}

// ── Rich Presence no Discord (opcional, toggle nas configurações) ────────
// Pipe local discord-ipc: se o Discord não está rodando, fica quieto e
// tenta de novo com backoff — nunca atrapalha o resto do app.
const RPC_CLIENT_ID = process.env.FOCKY_RPC_CLIENT_ID || '1546036535881637898'
let rpcClient = null, rpcActivity = null, rpcTimer = null

// diagnóstico em <userData>/rpc.log (mesmo esquema do audio-filter.log)
const rlog = m => appendLog(path.join(app.getPath('userData'), 'rpc.log'), m)

async function rpcApply () {
  clearTimeout(rpcTimer); rpcTimer = null
  if (!rpcActivity) {                     // pedido pra limpar
    if (rpcClient) rpcClient.user?.clearActivity().catch(e => rlog('clear: ' + e.message))
    return
  }
  try {
    if (!rpcClient) {
      const { Client } = require('@xhayper/discord-rpc')
      rpcClient = new Client({ clientId: RPC_CLIENT_ID })
      rpcClient.on('disconnected', () => {
        rlog('disconnected')
        rpcClient = null
        if (rpcActivity) rpcTimer = setTimeout(rpcApply, 15_000)
      })
      await rpcClient.login()
      rlog('conectado ao Discord')
    }
    // setActivity vive no ClientUser, não no Client
    await rpcClient.user?.setActivity(rpcActivity)
    rlog('set: ' + (rpcActivity.details ?? '') + ' / ' + (rpcActivity.state ?? ''))
  } catch (e) {                           // Discord fechado/sem login: tenta de novo
    rlog('falhou: ' + e.message)
    rpcClient = null
    rpcTimer = setTimeout(rpcApply, 15_000)
  }
}

ipcMain.handle('rpc', (_e, activity) => {
  rpcActivity = activity
  return rpcApply()
})

app.on('before-quit', () => { quitting = true; audioStop() })

// A janela nunca é destruída (o close vira hide), então isto só dispara se algo
// a matar de fato — nesse caso não há UI pra voltar, então encerra.
app.on('window-all-closed', () => app.quit())
