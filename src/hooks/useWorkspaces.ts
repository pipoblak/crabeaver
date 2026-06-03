import { useState, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface WorkspaceQuery { name: string; path: string }
export interface Workspace { name: string; queries: WorkspaceQuery[] }

/**
 * Data hook for the sidebar Workspaces tree: the workspace list plus mutation
 * wrappers that refresh it. Mutations throw their backend error string so the
 * caller can surface it inline.
 */
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])

  const refresh = useCallback(async () => {
    const ws = await invoke<Workspace[]>('list_workspaces').catch(() => null)
    if (ws) setWorkspaces(ws)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const createWorkspace = useCallback(async (name: string) => {
    await invoke('create_workspace', { name }); await refresh()
  }, [refresh])

  const renameWorkspace = useCallback(async (oldName: string, newName: string) => {
    await invoke('rename_workspace', { oldName, newName }); await refresh()
  }, [refresh])

  const deleteWorkspace = useCallback(async (name: string) => {
    await invoke('delete_workspace', { name }); await refresh()
  }, [refresh])

  // Returns the created query's full path (caller opens it, then refreshes).
  const createQuery = useCallback(async (workspace: string, name: string): Promise<string> => {
    const path = await invoke<string>('create_query', { workspace, name }); await refresh(); return path
  }, [refresh])

  const deleteQuery = useCallback(async (path: string) => {
    await invoke('delete_query_file', { path }); await refresh()
  }, [refresh])

  const renameQuery = useCallback(async (oldPath: string, newPath: string) => {
    await invoke('rename_query_file', { oldPath, newPath }); await refresh()
  }, [refresh])

  return { workspaces, refresh, createWorkspace, renameWorkspace, deleteWorkspace, createQuery, deleteQuery, renameQuery }
}
