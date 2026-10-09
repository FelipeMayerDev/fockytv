const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DEFAULT_SHORTCUTS, validateShortcuts, selectQuickSource, bindShortcuts } = require('../shortcuts')
const { shellQuote, bindingLua, installHyprShortcuts } = require('../hypr-shortcuts')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('atalhos normalizados, distintos e sem comandos injetáveis', () => {
  assert.deepEqual(validateShortcuts(DEFAULT_SHORTCUTS), DEFAULT_SHORTCUTS)
  assert.equal(validateShortcuts({ active: 'Shift+Control+F11', screen: 'Alt+S' }).active, 'Control+Shift+F11')
  assert.throws(() => validateShortcuts({ active: 'Control+F11', screen: 'Control+Control+F11' }), /diferentes/)
  assert.throws(() => validateShortcuts({ active: 'Control+F11;exec evil', screen: 'Alt+S' }), /Use/)
  assert.throws(() => validateShortcuts({ active: 'F11', screen: 'Alt+S' }), /Use/)
})

test('a janela em foco é exata; janela removida nunca vira tela inteira', () => {
  const sources = [{ id: 'screen:0:0', display_id: '10' }, { id: 'window:123:0' }, { id: 'window:456:0' }, { id: 'screen:1:0', display_id: '20' }]
  assert.equal(selectQuickSource(sources, 'active', { hwnd: 456 }, 10).id, 'window:456:0')
  assert.equal(selectQuickSource(sources, 'screen', {}, 20).id, 'screen:1:0')
  assert.throws(() => selectQuickSource(sources, 'active', { hwnd: 999 }, 10), /janela em foco/)
  assert.throws(() => selectQuickSource(sources, 'screen', {}, 99), /monitor/)
})

test('conflito restaura atalhos anteriores e remove registro parcial', () => {
  const registered = new Map()
  const registry = {
    register: (key, fn) => { if (key === 'Alt+S') return false; registered.set(key, fn); return true },
    unregister: key => registered.delete(key),
  }
  const triggered = []
  const trigger = mode => triggered.push(mode)
  bindShortcuts(registry, {}, DEFAULT_SHORTCUTS, trigger)
  assert.throws(() => bindShortcuts(registry, DEFAULT_SHORTCUTS, { active: 'Alt+A', screen: 'Alt+S' }, trigger), /em uso/)
  assert.deepEqual([...registered.keys()], Object.values(DEFAULT_SHORTCUTS))
  registered.get(DEFAULT_SHORTCUTS.active)()
  registered.get(DEFAULT_SHORTCUTS.screen)()
  assert.deepEqual(triggered, ['active', 'screen'])
})

test('binds Hyprland usam as mesmas teclas e encaminham comandos sem focar o app', () => {
  const command = shellQuote("/home/a user's/FockyTV.AppImage") + ' --no-sandbox'
  const lua = bindingLua(DEFAULT_SHORTCUTS, command)
  assert.match(lua, /CTRL \+ SHIFT \+ F11/)
  assert.match(lua, /--share-active/)
  assert.match(lua, /--share-screen/)
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
})

test('instalação Hyprland faz backup; erro de validação e rollback preservam configuração', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fockytv-binds-'))
  const oldPath = process.env.PATH, oldConfig = process.env.XDG_CONFIG_HOME
  const config = path.join(root, 'config'), data = path.join(root, 'data'), bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(config,'hypr'),{recursive:true})
  fs.mkdirSync(bin)
  const bindings = path.join(config,'hypr','bindings.lua'), original = '-- meus atalhos\n'
  fs.writeFileSync(bindings,original)
  fs.writeFileSync(path.join(bin,'hyprctl'),`#!${process.execPath}\nif(process.argv.includes('binds'))console.log('[]');if(process.argv.includes('configerrors'))console.log(process.env.FOCKY_TEST_HYPR_ERRORS||'');\n`,{mode:0o755})
  process.env.PATH = bin + path.delimiter + oldPath
  process.env.XDG_CONFIG_HOME = config
  try {
    const undo = installHyprShortcuts(DEFAULT_SHORTCUTS,"'/opt/FockyTV.AppImage'",data)
    assert.match(fs.readFileSync(bindings,'utf8'),/dofile/)
    assert(fs.readdirSync(path.dirname(bindings)).some(n=>n.includes('.fockytv-backup-')))
    undo()
    assert.equal(fs.readFileSync(bindings,'utf8'),original)
    assert(!fs.existsSync(path.join(data,'share-shortcuts.lua')))
    process.env.FOCKY_TEST_HYPR_ERRORS = 'bind inválido'
    assert.throws(()=>installHyprShortcuts(DEFAULT_SHORTCUTS,"'/opt/FockyTV.AppImage'",data),/bind inválido/)
    assert.equal(fs.readFileSync(bindings,'utf8'),original)
    assert(!fs.existsSync(path.join(data,'share-shortcuts.lua')))
  } finally {
    process.env.PATH = oldPath
    if(oldConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldConfig
    delete process.env.FOCKY_TEST_HYPR_ERRORS
    fs.rmSync(root,{recursive:true,force:true})
  }
})
