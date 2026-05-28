import { describe, it, expect } from 'vitest'
import { openTab, closeTab, updateContent, initialState } from './tabs'

describe('initialState', () => {
  it('starts with one Query 1 tab active', () => {
    const s = initialState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].title).toBe('Query 1')
    expect(s.activeId).toBe(1)
  })
})

describe('openTab', () => {
  it('appends tab and activates it', () => {
    const s = openTab(initialState(), 2)
    expect(s.tabs).toHaveLength(2)
    expect(s.activeId).toBe(2)
  })

  it('derives title from tab count at open time', () => {
    const s1 = openTab(initialState(), 2)
    const s2 = openTab(s1, 3)
    expect(s2.tabs[1].title).toBe('Query 2')
    expect(s2.tabs[2].title).toBe('Query 3')
  })

  it('preserves existing tab content', () => {
    const filled = updateContent(initialState(), 1, 'SELECT 1')
    const s = openTab(filled, 2)
    expect(s.tabs[0].content).toBe('SELECT 1')
  })

  it('new tab starts with empty content', () => {
    const s = openTab(initialState(), 2)
    expect(s.tabs[1].content).toBe('')
  })
})

describe('closeTab', () => {
  it('cannot close the last tab', () => {
    const s = initialState()
    expect(closeTab(s, 1)).toBe(s)
  })

  it('removes the tab', () => {
    const s = openTab(initialState(), 2)
    const next = closeTab(s, 2)
    expect(next.tabs).toHaveLength(1)
    expect(next.tabs[0].id).toBe(1)
  })

  it('activates previous tab when closing active', () => {
    const s = openTab(openTab(initialState(), 2), 3) // [1,2,3], active=3
    const next = closeTab(s, 3)
    expect(next.activeId).toBe(2)
  })

  it('keeps active unchanged when closing non-active tab', () => {
    const s = openTab(initialState(), 2) // [1,2], active=2
    const next = closeTab(s, 1)
    expect(next.activeId).toBe(2)
  })

  it('closing middle tab clamps active within bounds', () => {
    const s0 = openTab(openTab(initialState(), 2), 3) // [1,2,3], active=3
    const s1 = { ...s0, activeId: 2 }                // active=2
    const next = closeTab(s1, 1)                      // remove idx 0 → [2,3], active stays 2
    expect(next.activeId).toBe(2)
    expect(next.tabs.map(t => t.id)).toEqual([2, 3])
  })

  it('closing first tab when active selects next', () => {
    const s = { ...openTab(initialState(), 2), activeId: 1 } // [1,2], active=1
    const next = closeTab(s, 1)
    expect(next.activeId).toBe(2)
  })
})

describe('updateContent', () => {
  it('updates content of target tab only', () => {
    const s = openTab(initialState(), 2)
    const next = updateContent(s, 1, 'SELECT 1')
    expect(next.tabs[0].content).toBe('SELECT 1')
    expect(next.tabs[1].content).toBe('')
  })

  it('ignores unknown id', () => {
    const s = initialState()
    const next = updateContent(s, 999, 'x')
    expect(next.tabs[0].content).toBe('')
  })

  it('does not change activeId', () => {
    const s = openTab(initialState(), 2) // active=2
    const next = updateContent(s, 1, 'x')
    expect(next.activeId).toBe(2)
  })
})
