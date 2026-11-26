import { describe, it, expect } from 'vitest'
import { resolveTheme } from './theme'
import { authMessage } from './authText'
import { colourOf, ACCOUNT_COLOURS } from './accountColours'

describe('theme', () => {
  it('follows the phone only on Match my phone', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('auto', true)).toBe('dark')
    expect(resolveTheme('auto', false)).toBe('light')
  })
})

describe('sign-in messages', () => {
  it('says a wrong password plainly', () => {
    expect(authMessage(new Error('Invalid login credentials'))).toBe('That email and password don’t match.')
  })
  it('asks to open the link before signing in', () => {
    expect(authMessage(new Error('Email not confirmed'))).toMatch(/link/)
  })
  it('keeps any other message', () => {
    expect(authMessage(new Error('Something odd'))).toBe('Something odd')
  })
})

describe('account colours', () => {
  it('uses the saved colour', () => { expect(colourOf({ colour: 4 }, 0)).toBe(4) })
  it('falls back to the list order for an account saved before colours', () => {
    expect(colourOf({ colour: null }, 1)).toBe(1)
    expect(colourOf({ colour: undefined }, ACCOUNT_COLOURS.length + 2)).toBe(2)
  })
  it('ignores a colour out of range', () => { expect(colourOf({ colour: 9 }, 3)).toBe(3) })
})
