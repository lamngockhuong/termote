import { describe, expect, it } from 'vitest'
import { SYMBOLS_FONT, terminalFontFamily } from './terminal-font'

describe('terminalFontFamily', () => {
  it('ends with the bundled icons, then the generic monospace', () => {
    expect(terminalFontFamily()).toMatch(
      new RegExp(`"${SYMBOLS_FONT}", monospace$`),
    )
    expect(terminalFontFamily()).toMatch(/^ui-monospace, /)
  })

  it('puts the custom font first, quoted', () => {
    expect(terminalFontFamily('Fira Code 5')).toMatch(/^"Fira Code 5", /)
  })

  it('quotes each name of a list, keeping quoted names and generics', () => {
    expect(terminalFontFamily(` Hack , 'My Font', monospace,, "A"B" `)).toMatch(
      /^"Hack", 'My Font', monospace, "A"B", ui-monospace/,
    )
    expect(terminalFontFamily('Bad"Name')).toMatch(/^"BadName", /)
  })

  it('ignores a blank custom font', () => {
    expect(terminalFontFamily('   ')).toBe(terminalFontFamily())
  })
})
