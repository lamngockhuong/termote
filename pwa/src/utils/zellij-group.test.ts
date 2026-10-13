import { describe, expect, it } from 'vitest'
import { ZELLIJ_DEFAULT_GROUP_ID, zellijGroupId } from './zellij-group'

describe('zellijGroupId', () => {
  it('is "z" + the name in unpadded base64url, as the server makes it', () => {
    expect(ZELLIJ_DEFAULT_GROUP_ID).toBe('zbWFpbg')
    expect(zellijGroupId('dev')).toBe('zZGV2')
    // UTF-8 bytes, and the URL alphabet (no "+", "/" or "=")
    expect(zellijGroupId('é')).toBe('zw6k')
    expect(zellijGroupId('>?')).toBe('zPj8')
    expect(zellijGroupId('~~~')).toBe('zfn5-')
    expect(zellijGroupId('???')).toBe('zPz8_')
  })
})
