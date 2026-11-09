import { describe, expect, it } from 'vitest'
import schemaJson from '../../../server/pwa_settings_schema.json?raw'
import { COMMAND_LABEL, SETTING_LABEL, VALUE_LABEL } from './setting-labels'
import { REGISTRY } from './settings-registry'
import { COMMAND_IDS } from './shortcuts'

const schema = JSON.parse(schemaJson) as {
  keys: { key: string; type: string; values?: unknown[] }[]
}

describe('setting labels', () => {
  it('name every setting the registry knows, and nothing else', () => {
    expect(Object.keys(SETTING_LABEL).sort()).toEqual(
      Object.keys(REGISTRY).sort(),
    )
  })

  it('name every command', () => {
    expect(Object.keys(COMMAND_LABEL).sort()).toEqual(
      Object.keys(COMMAND_IDS).sort(),
    )
  })

  it('word every value of a text choice', () => {
    for (const k of schema.keys) {
      if (k.type !== 'enum' || typeof k.values?.[0] !== 'string') continue
      expect(Object.keys(VALUE_LABEL[k.key] ?? {}).sort(), k.key).toEqual(
        [...(k.values as string[])].sort(),
      )
    }
  })
})
