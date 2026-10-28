import test from 'node:test'
import assert from 'node:assert/strict'
import { SKIN_THEMES, normalizeAppearance, chooseAppearance } from '../main/appearance-state.mjs'

test('restores each skin theme without changing the other remembered choices', () => {
  let state = normalizeAppearance(null)
  state = chooseAppearance(state, { theme: 'soft-dark' })
  state = chooseAppearance(state, { skin: 'glass' })
  assert.equal(state.theme, 'glass-day')
  state = chooseAppearance(state, { theme: 'glass-dusk' })
  state = chooseAppearance(state, { skin: 'soft' })
  assert.equal(state.theme, 'soft-dark')
  state = normalizeAppearance(JSON.parse(JSON.stringify(state)))
  assert.equal(chooseAppearance(state, { skin: 'glass' }).theme, 'glass-dusk')
})
test('all fourteen themes belong to exactly one skin and survive serialization', () => {
  let count = 0
  for (const [skin, themes] of Object.entries(SKIN_THEMES)) for (const theme of themes) {
    const state = chooseAppearance(null, { skin, theme })
    assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(state))), state)
    assert.equal(state.skinThemes[skin], theme)
    count++
  }
  assert.equal(count, 14)
})
test('rejects cross-skin themes, prototype keys, and invalid renderer choices', () => {
  for (const patch of [{skin:'__proto__'}, {skin:'constructor'}, {skin:'glass',theme:'soft-light'}, {theme:123}]) {
    assert.throws(() => chooseAppearance(null, patch))
  }
  assert.deepEqual(normalizeAppearance({skin:'unknown',theme:'bad',skinThemes:{glass:'bad'}}), normalizeAppearance(null))
  assert.deepEqual(normalizeAppearance(['glass']), normalizeAppearance(null))
})
test('selecting a theme does not mutate a previously read settings object', () => {
  const before = normalizeAppearance(null), snapshot = JSON.stringify(before)
  chooseAppearance(before, {theme:'soft-dark'})
  assert.equal(JSON.stringify(before), snapshot)
})
