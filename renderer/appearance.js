/* Appearance is independent from app data, queries and selected tabs. */
(() => {
  'use strict'
  const catalog = {"skins":[{"id":"soft","name":"Soft"},{"id":"zen","name":"Zen"},{"id":"glass","name":"Glass"},{"id":"poster","name":"Poster"}],"themes":[{"id":"soft-light","name":"Light","skin":"soft","mode":"light"},{"id":"soft-sand","name":"Sand","skin":"soft","mode":"light"},{"id":"soft-dark","name":"Dark","skin":"soft","mode":"dark"},{"id":"zen-sage","name":"Sage","skin":"zen","mode":"light"},{"id":"zen-paper","name":"Paper","skin":"zen","mode":"light"},{"id":"zen-ink","name":"Ink","skin":"zen","mode":"dark"},{"id":"glass-day","name":"Day","skin":"glass","mode":"light"},{"id":"glass-night","name":"Night","skin":"glass","mode":"dark"},{"id":"glass-dusk","name":"Dusk","skin":"glass","mode":"dark"},{"id":"poster","name":"Poster","skin":"poster","mode":"light"},{"id":"paper","name":"Paper","skin":"poster","mode":"light"},{"id":"sage","name":"Sage","skin":"poster","mode":"light"},{"id":"sumi","name":"Sumi","skin":"poster","mode":"dark"},{"id":"night","name":"Night","skin":"poster","mode":"dark"}]}
  const bridge = window.whenAppearance
  const memoryKey = 'when-appearance-preview-v1'
  const choices = skin => catalog.themes.filter(t => t.skin === skin)
  const validSkin = skin => catalog.skins.some(s => s.id === skin)
  function normalize(value) {
    const input = value && typeof value === 'object' ? value : {}
    const skin = validSkin(input.skin) ? input.skin : 'soft'
    const skinThemes = {}
    for (const s of catalog.skins) {
      const remembered = input.skinThemes?.[s.id]
      skinThemes[s.id] = choices(s.id).some(t => t.id === remembered) ? remembered : choices(s.id)[0].id
    }
    const theme = choices(skin).some(t => t.id === input.theme) ? input.theme : skinThemes[skin]
    skinThemes[skin] = theme
    return { skin, theme, skinThemes }
  }
  let stored
  if (!bridge) { try { stored = JSON.parse(localStorage.getItem(memoryKey)) } catch { /* browser preview */ } }
  let state = normalize(bridge ? bridge.initial : stored)
  const panels = new Set()
  function refresh() {
    const root = document.documentElement
    root.dataset.skin = state.skin
    root.dataset.palette = state.theme
    root.dataset.theme = catalog.themes.find(t => t.id === state.theme).mode
    for (const panel of panels) {
      if (!panel.host.isConnected) { panels.delete(panel); continue }
      panel.skin.value = state.skin
      const options = choices(state.skin)
      if (panel.theme.dataset.skin !== state.skin) {
        panel.theme.replaceChildren(...options.map(t => new Option(t.name + (t.mode === 'dark' ? ' · 어두움' : ' · 밝음'), t.id)))
        panel.theme.dataset.skin = state.skin
      }
      panel.theme.value = state.theme
    }
  }
  refresh()
  bridge?.onChange(value => { state = normalize(value); refresh() })
  async function change(patch, panel) {
    panel.status.textContent = '저장 중…'
    try {
      if (bridge) {
        const result = await bridge.set(patch)
        if (!result?.ok) throw new Error(result?.error || '저장하지 못했습니다.')
        state = normalize(result.state)
      } else {
        const skin = validSkin(patch.skin) ? patch.skin : state.skin
        state = normalize({ ...state, skin, theme: patch.theme || state.skinThemes[skin] })
        localStorage.setItem(memoryKey, JSON.stringify(state))
      }
      refresh()
      panel.status.textContent = '저장됨'
    } catch (error) {
      refresh()
      panel.status.textContent = error.message || '저장하지 못했습니다.'
    }
  }
  function mount(container) {
    let host = container.matches('[data-when-appearance]') ? container : container.querySelector(':scope > [data-when-appearance]')
    if (!host) { host = document.createElement('section'); host.dataset.whenAppearance = ''; container.append(host) }
    if (host.dataset.appearanceMounted) return
    host.dataset.appearanceMounted = 'true'
    host.classList.add('when-appearance')
    const title = document.createElement('h3'); title.textContent = '스킨과 테마'
    const hint = document.createElement('p'); hint.textContent = '스킨별 마지막 테마를 기억하고 이 앱의 모든 창에 함께 적용합니다.'
    const skin = document.createElement('select'), theme = document.createElement('select')
    for (const s of catalog.skins) skin.add(new Option(s.name, s.id))
    const row = document.createElement('div'); row.className = 'when-appearance-fields'
    for (const [label, control] of [['스킨', skin], ['테마', theme]]) {
      const field = document.createElement('label'), caption = document.createElement('span')
      caption.textContent = label; field.append(caption, control); row.append(field)
    }
    const status = document.createElement('span'); status.className = 'when-appearance-status'; status.setAttribute('role', 'status')
    host.append(title, hint, row, status)
    const panel = { host, skin, theme, status }; panels.add(panel)
    skin.addEventListener('change', () => void change({ skin: skin.value }, panel))
    theme.addEventListener('change', () => void change({ theme: theme.value }, panel))
    refresh()
  }
  window.whenAppearanceUI = { mount }
  document.addEventListener('keydown', event => {
    if (event.target instanceof Element && event.target.closest('[data-when-appearance]') && event.key !== 'Tab') event.stopPropagation()
  }, true)
  const discover = () => document.querySelectorAll('[data-when-appearance]').forEach(mount)
  const observe = () => { discover(); new MutationObserver(discover).observe(document.body, { childList: true, subtree: true }) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true })
  else observe()
})()
