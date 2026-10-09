const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'"
const hyprKey = key => key.replaceAll('Control', 'CTRL').replaceAll('Super', 'SUPER').replaceAll('Shift', 'SHIFT').replaceAll('Alt', 'ALT').replaceAll('+', ' + ')
const modMask = key => key.split('+').slice(0, -1).reduce((m, k) => m | ({ Shift: 1, Control: 4, Alt: 8, Super: 64 }[k] ?? 0), 0)

function bindingLua (keys, command) {
  return Object.entries(keys).map(([mode, key]) =>
    `o.bind(${JSON.stringify(hyprKey(key))}, ${JSON.stringify(mode === 'active' ? 'FockyTV: Compartilhar tela atual' : 'FockyTV: Compartilhar tela toda')}, ${JSON.stringify(command + ' --share-' + mode)})`).join('\n') + '\n'
}

function installHyprShortcuts (keys, command, userData) {
  const bindings = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'), 'hypr', 'bindings.lua')
  if (!fs.existsSync(bindings)) throw new Error('Este desktop precisa configurar os atalhos pelo portal do sistema.')
  const current = JSON.parse(execFileSync('hyprctl', ['-j', 'binds'], { encoding: 'utf8' }))
  for (const key of Object.values(keys)) {
    if (current.some(b => b.key === key.split('+').at(-1) && b.modmask === modMask(key) && !b.description?.startsWith('FockyTV: Compartilhar tela ')))
      throw new Error('Atalho já usado pelo desktop: ' + key)
  }
  const generated = path.join(userData, 'share-shortcuts.lua')
  const include = `\n-- FockyTV: atalhos configuráveis no app\ndofile(${JSON.stringify(generated)})\n`
  const old = fs.readFileSync(bindings, 'utf8')
  const oldGenerated = fs.existsSync(generated) ? fs.readFileSync(generated, 'utf8') : null
  const restore = () => {
    fs.writeFileSync(bindings, old)
    if (oldGenerated != null) fs.writeFileSync(generated, oldGenerated)
    else fs.rmSync(generated, { force: true })
    execFileSync('hyprctl', ['reload'], { stdio: 'ignore' })
  }
  try {
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(generated, bindingLua(keys, command))
    if (!old.includes(`dofile(${JSON.stringify(generated)})`)) {
      fs.copyFileSync(bindings, bindings + '.fockytv-backup-' + Date.now())
      fs.writeFileSync(bindings, old + include)
    }
    execFileSync('hyprctl', ['reload'], { stdio: 'ignore' })
    const errors = execFileSync('hyprctl', ['configerrors'], { encoding: 'utf8' }).trim()
    if (errors && errors !== 'ok') throw new Error('Configuração do desktop: ' + errors)
  } catch (e) {
    restore()
    throw e
  }
  return restore
}

module.exports = { shellQuote, bindingLua, installHyprShortcuts }
