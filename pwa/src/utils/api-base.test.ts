import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiBase,
  currentMachine,
  isMachineId,
  LOCAL_API,
  machineFromSearch,
  machineURL,
  setCurrentMachineForTest,
  switchMachine,
} from './api-base'

const ID = '0123456789abcdef'

describe('api-base', () => {
  afterEach(() => {
    setCurrentMachineForTest('')
    vi.unstubAllGlobals()
  })

  it('reads the machine from the search, ids only', () => {
    expect(machineFromSearch(`?machine=${ID}`)).toBe(ID)
    expect(machineFromSearch('?machine=../x')).toBe('')
    expect(machineFromSearch('?machine=0123456789ABCDEF')).toBe('')
    expect(machineFromSearch('')).toBe('')
    expect(isMachineId(ID)).toBe(true)
    expect(isMachineId(42)).toBe(false)
  })

  it("routes to this server, or through it to the open machine's", () => {
    expect(currentMachine()).toBe('')
    expect(apiBase()).toBe(LOCAL_API)
    setCurrentMachineForTest(ID)
    expect(currentMachine()).toBe(ID)
    expect(apiBase()).toBe(`/api/machines/${ID}/mux`)
    setCurrentMachineForTest('nope')
    expect(apiBase()).toBe(LOCAL_API)
  })

  it('builds the URL of a machine, keeping the link', () => {
    expect(machineURL(ID, '#/s/g/t')).toBe(`/?machine=${ID}#/s/g/t`)
    expect(machineURL('', '#/s/g/t')).toBe('/#/s/g/t')
    expect(machineURL('bad')).toBe('/')
  })

  it('loads the page on another machine only', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    switchMachine('')
    expect(assign).not.toHaveBeenCalled()
    switchMachine(ID)
    expect(assign).toHaveBeenCalledWith(`/?machine=${ID}`)
    setCurrentMachineForTest(ID)
    switchMachine(ID, '#/s/g/t')
    expect(assign).toHaveBeenLastCalledWith(`/?machine=${ID}#/s/g/t`)
    switchMachine('')
    expect(assign).toHaveBeenLastCalledWith('/')
  })
})
