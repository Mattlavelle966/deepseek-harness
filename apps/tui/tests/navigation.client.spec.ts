import { describe, expect, it } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sidebarRows, workspaceForSession } from '../src/navigation.ts'

const sid = (value: string): SessionId => value as SessionId
const wid = (value: string): WorkspaceId => value as WorkspaceId

function workspace(id: string, sessions: string[]): WorkspaceView {
  return {
    workspaceId: wid(id),
    title: id.toUpperCase(),
    path: `/work/${id}`,
    sessionIds: sessions.map(sid),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function sessionList(ids: string[]): SessionListState {
  return {
    ids: ids.map(sid),
    byId: Object.fromEntries(ids.map(id => [sid(id), {
      id: sid(id),
      displayTitle: `Session ${id}`,
      running: id === 'running',
      retainedBy: {},
      blank: false,
      updatedAt: 0,
    }])),
    phase: 'ready',
    projectionsBySession: {},
  }
}

describe('terminal Workspace tree', () => {
  it('starts collapsed and preserves authoritative Workspace order', () => {
    const workspaces = [workspace('one', ['a']), workspace('two', ['b'])]
    expect(sidebarRows(workspaces, [], sessionList(['a', 'b']), new Set()).map(row => row.key)).toEqual([
      'workspace:one',
      'workspace:two',
    ])
  })

  it('shows only known, non-archived members of expanded Workspaces', () => {
    const workspaces = [workspace('one', ['running', 'archived', 'missing'])]
    const rows = sidebarRows(
      workspaces,
      [sid('archived')],
      sessionList(['running', 'archived', 'ungrouped']),
      new Set([wid('one')]),
    )
    expect(rows.map(row => row.key)).toEqual(['workspace:one', 'session:running'])
    expect(rows[1]).toMatchObject({ title: 'Session running', running: true })
  })

  it('locates the Workspace that accounts for a Session', () => {
    const workspaces = [workspace('one', ['a']), workspace('two', ['b'])]
    expect(workspaceForSession(workspaces, sid('b'))?.workspaceId).toBe('two')
    expect(workspaceForSession(workspaces, sid('ungrouped'))).toBeUndefined()
  })
})
