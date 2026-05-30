import { postgres } from './postgres'
import { sqlite } from './sqlite'
import type { Capabilities, ConnectorDescriptor } from './types'

export type { Capabilities, ConnectorDescriptor, DriverId } from './types'

/// All connectors selectable when creating a connection.
export const CONNECTORS: ConnectorDescriptor[] = [postgres, sqlite]

const BY_DRIVER: Record<string, ConnectorDescriptor> = {
  postgres,
  postgresql: postgres,
  sqlite,
}

/**
 * Descriptor for a driver string. Falls back to Postgres for unknown/missing
 * drivers so existing single-engine behavior is preserved.
 */
export function descriptorFor(driver?: string | null): ConnectorDescriptor {
  return BY_DRIVER[(driver ?? '').toLowerCase()] ?? postgres
}

export function capabilitiesFor(driver?: string | null): Capabilities {
  return descriptorFor(driver).capabilities
}
