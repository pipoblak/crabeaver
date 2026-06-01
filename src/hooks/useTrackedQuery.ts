import { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTasks } from '@/context/TasksContext'
import type { QueryResult } from '@/lib/results'

export interface TrackedQueryOpts {
  /** Stable task id — reusing one (e.g. `query:${resultTabId}`) overwrites the prior run. */
  id: string
  label: string
  connectionId: string
  sql: string
  /** Defaults to true: every query is cancellable via the connection-scoped cancel_query. */
  cancellable?: boolean
}

/**
 * Runs `execute_query` while registering it in the activity monitor for the whole
 * duration. Every query path (run, sort, filter, FK navigation, table browse,
 * export) should go through this so the footer shows ALL in-flight queries.
 */
export function useTrackedQuery() {
  const { startTask, endTask } = useTasks()
  return useCallback(async (opts: TrackedQueryOpts): Promise<QueryResult> => {
    startTask({
      id: opts.id,
      kind: 'query',
      label: opts.label,
      detail: opts.sql.replace(/\s+/g, ' ').trim().slice(0, 120),
      connectionId: opts.connectionId,
      cancellable: opts.cancellable ?? true,
    })
    try {
      return await invoke<QueryResult>('execute_query', { connectionId: opts.connectionId, sql: opts.sql })
    } finally {
      endTask(opts.id)
    }
  }, [startTask, endTask])
}
