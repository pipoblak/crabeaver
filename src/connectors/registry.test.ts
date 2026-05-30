import { describe, it, expect } from 'vitest'
import { descriptorFor, capabilitiesFor, CONNECTORS } from './registry'

describe('connector registry', () => {
  it('resolves known drivers (with aliases)', () => {
    expect(descriptorFor('postgres').label).toBe('PostgreSQL')
    expect(descriptorFor('sqlite').label).toBe('SQLite')
    expect(descriptorFor('postgresql').driver).toBe('postgres')
    expect(descriptorFor('SQLite').driver).toBe('sqlite') // case-insensitive
  })

  it('falls back to postgres for unknown/missing drivers (no throw)', () => {
    expect(descriptorFor(undefined).driver).toBe('postgres')
    expect(descriptorFor(null).driver).toBe('postgres')
    expect(descriptorFor('nope').driver).toBe('postgres')
  })

  it('gates server-only features by capability', () => {
    expect(capabilitiesFor('postgres').sessions).toBe(true)
    expect(capabilitiesFor('postgres').locks).toBe(true)
    expect(capabilitiesFor('sqlite').sessions).toBe(false)
    expect(capabilitiesFor('sqlite').locks).toBe(false)
    expect(capabilitiesFor('sqlite').cancel).toBe(false)
    // Both support schema introspection + table details.
    expect(capabilitiesFor('sqlite').tableDetails).toBe(true)
    expect(capabilitiesFor('sqlite').schemas).toBe(true)
  })

  it('sqlite is file-based, postgres is server-based', () => {
    expect(descriptorFor('sqlite').connectionKind).toBe('file')
    expect(descriptorFor('sqlite').defaultPort).toBeNull()
    expect(descriptorFor('postgres').connectionKind).toBe('server')
    expect(descriptorFor('postgres').defaultPort).toBe(5432)
  })

  it('lists every connector and keeps dialect == driver', () => {
    expect(CONNECTORS.length).toBeGreaterThanOrEqual(2)
    for (const c of CONNECTORS) expect(c.dialect).toBe(c.driver)
  })
})
