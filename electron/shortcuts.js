const DEFAULT_SHORTCUTS = { active: 'Control+Shift+F11', screen: 'Control+Shift+F12' }

function validateShortcuts (keys) {
  const result = {}
  for (const mode of Object.keys(DEFAULT_SHORTCUTS)) {
    const key = keys?.[mode]
    if (typeof key !== 'string' || !/^(?:(?:Control|Alt|Shift|Super)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key))
      throw new Error('Use Ctrl, Alt, Shift ou Super com uma letra, número ou F1–F24.')
    const parts = key.split('+'), last = parts.pop()
    result[mode] = [...['Control', 'Alt', 'Shift', 'Super'].filter(m => parts.includes(m)), last].join('+')
  }
  if (result.active === result.screen) throw new Error('Escolha atalhos diferentes para cada ação.')
  return result
}

// Nunca cair na primeira fonte: uma janela que fechou não pode virar tela inteira.
function selectQuickSource (sources, mode, focused, displayId) {
  const source = mode === 'active'
    ? sources.find(s => s.id.split(':')[0] === 'window' && s.id.split(':')[1] === String(focused.hwnd))
    : sources.find(s => s.id.startsWith('screen:') && s.display_id === String(displayId))
  if (!source) throw new Error(mode === 'active' ? 'A janela em foco não está disponível para captura.' : 'O monitor não está disponível para captura.')
  return source
}

// Registra o conjunto inteiro ou restaura os anteriores, inclusive em caso de conflito.
function bindShortcuts (registry, previous, next, trigger) {
  for (const key of Object.values(previous)) registry.unregister(key)
  try {
    for (const [mode, key] of Object.entries(next)) {
      if (!registry.register(key, () => trigger(mode))) throw new Error('Atalho em uso: ' + key)
    }
  } catch (e) {
    for (const key of Object.values(next)) registry.unregister(key)
    for (const [mode, key] of Object.entries(previous)) registry.register(key, () => trigger(mode))
    throw e
  }
}

module.exports = { DEFAULT_SHORTCUTS, validateShortcuts, selectQuickSource, bindShortcuts }
