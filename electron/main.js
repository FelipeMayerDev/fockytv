const { app, BrowserWindow, Menu, Tray, ipcMain, desktopCapturer, session } = require('electron')
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
    // no Wayland é o getSources que abre o portal — muda o fluxo da troca
    wayland,
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

  const icon = path.join(__dirname, '..', 'build', 'icon.png')

  win = new BrowserWindow({
    width: 1100, height: 720,
    backgroundColor: '#111',
    icon,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
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
})

app.on('before-quit', () => { quitting = true })

// A janela nunca é destruída (o close vira hide), então isto só dispara se algo
// a matar de fato — nesse caso não há UI pra voltar, então encerra.
app.on('window-all-closed', () => app.quit())
