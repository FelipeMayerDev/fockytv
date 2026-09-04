const { app, BrowserWindow, Menu, ipcMain, desktopCapturer, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// config.json editável fica ao lado do arquivo que o usuário abriu.
// No AppImage, exe aponta pro mount temporário — o caminho real é $APPIMAGE.
const wayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY

const configPath = [
  process.env.APPIMAGE && path.join(path.dirname(process.env.APPIMAGE), 'config.json'),
  path.join(path.dirname(app.getPath('exe')), 'config.json'),
  path.join(__dirname, '..', 'config.json'),   // dev, e default embutido
].find(p => p && fs.existsSync(p))
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

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

  new BrowserWindow({
    width: 1100, height: 720,
    backgroundColor: '#111',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  }).loadFile(path.join(__dirname, '..', 'ui', 'index.html'))
})

app.on('window-all-closed', () => app.quit())
