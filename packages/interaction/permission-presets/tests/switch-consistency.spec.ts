/** A preset switch must keep the preset event in sync with every knob write it drives. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('switch consistency tests do not execute shell commands') },
    run() { throw new Error('switch consistency tests do not execute shell commands') },
    start() { throw new Error('switch consistency tests do not execute shell commands') },
  })
  const fiber = ctx.plugin(PermissionPresetService)
  await fiber
  return { ctx }
}

describe('preset switch event consistency', () => {
  it('re-records the preset identity when knobs are written, including after out-of-band knob writes', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(brandString<SessionId>('switch-consistency'))
    // A foreign writer recorded the identity for one bundle but left the
    // folded knobs on another (the stale/oscillating log shape).
    session.append('permission/preset', { preset: 'danger-full-access' })
    session.append('sandbox/mode', { mode: 'workspace-write' })
    session.append('approval/policy', { policy: 'ask' })

    ctx.permissionPresets.set(session, 'danger-full-access')
    const events = session.snapshotEvents().map(event => event.type)
    expect(events).toContain('permission/preset')
    expect(events[events.length - 3]).toBe('permission/preset')
    expect(events[events.length - 2]).toBe('sandbox/mode')
    expect(events[events.length - 1]).toBe('approval/policy')
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')

    // A re-select of the effective preset writes nothing.
    const before = session.snapshotEvents().length
    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(session.snapshotEvents().length).toBe(before)
  })

  it('appends a preset event whenever a switch changes any knob', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(brandString<SessionId>('switch-fresh'))
    ctx.permissionPresets.set(session, 'danger-full-access')
    const events = session.snapshotEvents().map(event => event.type)
    expect(events.filter(type => type === 'permission/preset')).toHaveLength(1)
    expect(events.filter(type => type === 'sandbox/mode')).toHaveLength(1)
    expect(events.filter(type => type === 'approval/policy')).toHaveLength(1)
  })
})
