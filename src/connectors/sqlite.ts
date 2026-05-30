import type { ConnectorDescriptor } from './types'

// Mirrors SqliteDriver::capabilities() in src-tauri. An embedded file engine:
// no server sessions/locks and no remote query cancellation.
export const sqlite: ConnectorDescriptor = {
  driver:         'sqlite',
  label:          'SQLite',
  monacoLanguage: 'sql',
  dialect:        'sqlite',
  defaultPort:    null,
  connectionKind: 'file',
  capabilities: {
    schemas:       true,
    listDatabases: true,
    tableDetails:  true,
    schemaDetails: true,
    sessions:      false,
    locks:         false,
    cancel:        false,
    transactions:  true,
  },
  schemaObjectKinds: ['tables', 'views'],
}
