/** Pure Workspace-to-Session tree projection for the terminal sidebar. */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One visible row in the collapsible terminal sidebar. */
export type SidebarRow =
  | {
    readonly kind: 'workspace'
    readonly key: `workspace:${string}`
    readonly workspaceId: WorkspaceId
    readonly title: string
    readonly path: string
    readonly expanded: boolean
  }
  | {
    readonly kind: 'session'
    readonly key: `session:${string}`
    readonly workspaceId: WorkspaceId
    readonly sessionId: SessionId
    readonly title: string
    readonly running: boolean
  }

/**
 * Derive the visible tree without inventing membership or exposing archived and
 * ungrouped Sessions.
 * @param workspaces - Host-ordered Workspace rows.
 * @param archivedSessionIds - Sessions hidden from ordinary grouping surfaces.
 * @param sessions - current Session catalog.
 * @param expandedWorkspaceIds - process-local disclosure state.
 * @returns visible Workspace headers and children in Host order.
 */
export function sidebarRows(
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  sessions: SessionListState,
  expandedWorkspaceIds: ReadonlySet<WorkspaceId>,
): SidebarRow[] {
  const archived = new Set(archivedSessionIds)
  const rows: SidebarRow[] = []
  for (const workspace of workspaces) {
    const expanded = expandedWorkspaceIds.has(workspace.workspaceId)
    rows.push({
      kind: 'workspace',
      key: `workspace:${workspace.workspaceId}`,
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      expanded,
    })
    if (!expanded) continue
    for (const sessionId of workspace.sessionIds) {
      if (archived.has(sessionId)) continue
      const session = sessions.byId[sessionId]
      if (session === undefined) continue
      rows.push({
        kind: 'session',
        key: `session:${sessionId}`,
        workspaceId: workspace.workspaceId,
        sessionId,
        title: session.displayTitle,
        running: session.running,
      })
    }
  }
  return rows
}

/**
 * Find the Workspace currently accounting for a Session.
 * @param workspaces - Host-ordered Workspace rows.
 * @param sessionId - Session identity to locate.
 * @returns the accounting Workspace, or undefined for an ungrouped Session.
 */
export function workspaceForSession(
  workspaces: readonly WorkspaceView[],
  sessionId: SessionId,
): WorkspaceView | undefined {
  return workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
}
