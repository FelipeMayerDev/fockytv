const { app, BrowserWindow, Menu, Tray, ipcMain, desktopCapturer, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

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
    // filtro de áudio por app: helper WASAPI (ou seno de teste, pra dev)
    audioFilter: process.platform === 'win32' || process.env.FOCKY_AUDIO_TEST === '1',
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
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    const src = sources.find(s => s.id === picked) ?? sources[0]
    if (!src) return callback({})
    // gotcha #5: áudio do sistema só no Windows; no Linux depende de PipeWire, fica pra depois
    callback(process.platform === 'win32' ? { video: src, audio: 'loopback' } : { video: src })
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
const alog = m => { try { fs.appendFileSync(alogPath(), new Date().toISOString() + ' ' + m + '\n') } catch {} }

let audioProc = null, headerBuf = null, metaSent = false, pcmPending = [], pcmFlush = null

async function audioStart (opts) {
  audioStop()
  const args =
    opts.mode === 'test' ? ['--test'] :
    opts.mode === 'window' ? ['--hwnd', String(opts.hwnd)] :
    opts.mode === 'exclude' ? ['--exclude-name', opts.name ?? 'Discord'] : null
  if (!args) return { ok: false, error: 'modo inválido' }
  alog('start ' + args.join(' '))
  if (opts.mode !== 'test' && process.platform !== 'win32') {
    // dev fora do Windows: FOCKY_AUDIO_TEST=1 troca o helper por um seno,
    // para exercitar o pipeline do renderer (a UI nem mostra a opção sem isso)
    if (process.env.FOCKY_AUDIO_TEST === '1') {
      startTestTone()
      return { ok: true, rate: 48000, channels: 2 }
    }
    alog('fora do windows sem FOCKY_AUDIO_TEST')
    return { ok: false, error: 'filtro de áudio só no Windows' }
  }
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

    // rajadas de stdout viram mensagens IPC de ~40ms: menos jitter no caminho
    const flush = () => {
      if (!pcmPending.length) return
      const buf = Buffer.concat(pcmPending)
      pcmPending = []
      win?.webContents.send('audio-pcm', buf)
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
        win?.webContents.send('audio-meta', { rate, channels })
        metaSent = true
        clearInterval(pcmFlush)
        pcmFlush = setInterval(flush, 40)
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
        setTimeout(() => { if (!audioProc) audioStart({ mode, hwnd, name }) }, 3000)
      }
      audioProc = null
    })
  })
}

function audioStop () {
  stopTestTone()
  clearInterval(pcmFlush); pcmFlush = null
  if (audioProc) { const p = audioProc; audioProc = null; alog('stop'); p.kill() }
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

app.on('before-quit', () => { quitting = true; audioStop() })

// A janela nunca é destruída (o close vira hide), então isto só dispara se algo
// a matar de fato — nesse caso não há UI pra voltar, então encerra.
app.on('window-all-closed', () => app.quit())
