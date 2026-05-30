// Frontend mirror of the backend's connector model (domain/capabilities.rs).
// The UI renders only the features a connector declares here, so a connector never
// offers an action its driver would reject with `Unsupported`. Keep these in sync
// with each `DatabaseDriver::capabilities()`; the backend `connector_capabilities`
// command exposes the source of truth for verification.

export type DriverId = 'postgres' | 'sqlite' | 'mysql'

export interface Capabilities {
  schemas:       boolean
  listDatabases: boolean
  tableDetails:  boolean
  sessions:      boolean
  locks:         boolean
  cancel:        boolean
  transactions:  boolean
}

/** Shape of the connection form a connector needs. */
export type ConnectionKind = 'server' | 'file'

export interface ConnectorDescriptor {
  driver:         DriverId
  label:          string
  /** Monaco language id for the query editor. */
  monacoLanguage: string
  /** Dialect string passed to the backend so it lints/completes correctly. */
  dialect:        string
  /** Default TCP port for server connectors; null for file-based ones. */
  defaultPort:    number | null
  /** `server` → host/port/user/password; `file` → a single file path. */
  connectionKind: ConnectionKind
  capabilities:   Capabilities
}
