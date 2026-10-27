import { describe, expect, it } from 'vitest'
import {
  imageToken,
  imageTokensIn,
  insertImageToken,
  messageWithImages,
  removeImageToken,
} from './chat-image-tokens'

describe('insertImageToken', () => {
  it.each([
    ['', 0, 0, '[Image #1]', 10],
    ['ab', 2, 2, 'ab [Image #1]', 13],
    ['ab ', 3, 3, 'ab [Image #1]', 13],
    ['ab', 0, 0, '[Image #1] ab', 11],
    ['a b', 2, 2, 'a [Image #1] b', 13],
    ['ab', 1, 1, 'a [Image #1] b', 13],
    ['a XX b', 2, 4, 'a [Image #1] b', 12],
  ])('%j at %i-%i', (text, start, end, want, caret) => {
    expect(insertImageToken(text, start, end, 1)).toEqual({
      text: want,
      caret,
    })
  })
})

describe('removeImageToken', () => {
  it.each([
    ['a [Image #2] b', 'a b'],
    ['[Image #2] b', 'b'],
    ['a [Image #2]', 'a'],
    ['a[Image #2]b', 'ab'],
    ['a [Image #3] b', 'a [Image #3] b'],
  ])('%j', (text, want) => {
    expect(removeImageToken(text, 2)).toBe(want)
  })
})

describe('imageTokensIn', () => {
  it('finds every token number', () => {
    expect(imageTokensIn(`x ${imageToken(1)} y [Image #12]`)).toEqual(
      new Set([1, 12]),
    )
    expect(imageTokensIn('no [Image #x] here')).toEqual(new Set())
  })
})

describe('messageWithImages', () => {
  it('cuts the tokens out and says where each image goes, in bytes', () => {
    expect(
      messageWithImages('ảnh [Image #2] và [Image #1]', [
        { n: 1, id: 'a' },
        { n: 2, id: 'b' },
      ]),
    ).toEqual({ text: 'ảnh  và ', ids: ['b', 'a'], at: [6, 11] })
  })

  it('leaves a token of no image, or a repeated one, as text', () => {
    expect(
      messageWithImages('[Image #9] x [Image #1] [Image #1]', [
        { n: 1, id: 'a' },
      ]),
    ).toEqual({ text: '[Image #9] x  [Image #1]', ids: ['a'], at: [13] })
  })

  it('puts an image without a token at the end', () => {
    expect(messageWithImages('hi', [{ n: 1, id: 'a' }])).toEqual({
      text: 'hi',
      ids: ['a'],
      at: [2],
    })
  })

  it('text without images is unchanged', () => {
    expect(messageWithImages('see [Image #1]', [])).toEqual({
      text: 'see [Image #1]',
      ids: [],
      at: [],
    })
  })
})
