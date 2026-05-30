import type { ConnectorDescriptor } from './types'

// Mirrors PostgresDriver::capabilities() in src-tauri.
export const postgres: ConnectorDescriptor = {
  driver:         'postgres',
  label:          'PostgreSQL',
  monacoLanguage: 'sql',
  dialect:        'postgres',
  defaultPort:    5432,
  connectionKind: 'server',
  capabilities: {
    schemas:       true,
    listDatabases: true,
    tableDetails:  true,
    sessions:      true,
    locks:         true,
    cancel:        true,
    transactions:  true,
  },
}
