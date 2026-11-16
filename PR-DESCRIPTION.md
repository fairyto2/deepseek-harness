## Summary

Switching the permission preset mid-session (via the `/permission danger-full-access` command or the conversation permission dropdown) does not stick. The sandbox mode is flipped back to `workspace-write` and the approval policy back to `ask` at the next `step/start` — typically within 65–800 ms — producing an endless oscillation. In one affected session this cycle repeated 25+ times.

## Environment

- dsh-desktop-runtime 0.2.2-rc.3
- Session preset at creation: `workspace-write` + approval `ask`

## Reproduction

1. Open a session created with the `workspace-write` preset (approval policy `ask`).
2. Trigger a tool call that needs escalation (e.g. write outside the workspace) so an `approval/asked` event with reason `escalate sandbox to danger-full-access` appears.
3. Run `/permission danger-full-access` (or pick "Full access" in the permission dropdown).
4. Observe the next `step/start`: the mode reverts to `workspace-write` and the policy to `ask`.

## Evidence (session log excerpt)

```
3334 command/run       {"name":"permission","args":" danger-full-access","source":{"kind":"user"}}
3335 permission/preset {"preset":"danger-full-access"}
3336 sandbox/mode      {"mode":"danger-full-access"}
3337 approval/policy   {"policy":"never"}
3348 sandbox/mode      {"mode":"workspace-write"}      // 68 ms later, at next step/start
3349 approval/policy   {"policy":"ask"}
```

The full log shows 25+ set/revert pairs, each reverting without a matching `permission/preset` event.

## Analysis

The three knobs (`permission/preset`, `sandbox/mode`, `approval/policy`) are durable session events, and the module docs state a switch "records the selected preset, then writes changed knobs through their canonical setters; execution, prompt narration, and replay keep reading their knob folds" — i.e. the switch is meant to be durable.

However, the observed revert pattern matches **no** published write path in `dsh-permission-presets`:

- `apply()` always appends a `permission/preset` event when the effective preset differs (`if (current !== name) session.append('permission/preset', …)`). The reverts never append one — the log's preset events stay on `danger-full-access` while the knob events flip back.
- `pinInitialPermission()` only writes knobs whose folded state is `null` (missing facts); it never overwrites an existing folded value.

So some writer is re-asserting a stale knob bundle (workspace-write + ask) at step boundaries through the canonical setters, bypassing the preset bookkeeping — likely a stale client/server view racing with the freshly folded state, or a re-creation path folding an incompletely hydrated projection.

## Collateral damage

- Changing the mode **cancels a pending escalation approval** (`approval/decided` with `outcome: "cancelled"`).
- It **aborts an in-flight PTC tool call** with `Error: code run failed (abort): sandbox mode changed`, so the agent retries, triggering the next flip.
- Net effect: the user cannot durably grant full access mid-session and must re-run the command dozens of times.

## Expected behavior

A successful preset switch should persist across steps/turns for the session, like sessions created with the preset already active do (those hold `danger-full-access` + `never` indefinitely).

## Suspected mechanism

An architecture note in this repo (`.agents/notes/archived/feature/2026-07-23-web-permission-and-approval.md`) describes idle switches being "held last-write-wins in a proxy-side pending map and flushed on `agent/pre-step`", and that the permission select "reads once per mount; live refresh from another client's switch is deferred". That matches the observed revert timing (exactly at `step/start`, i.e. the `agent/pre-step` boundary) and suggests a stale or never-cleared pending selection (or a stale mounted selection in a second client view) being re-submitted at every step boundary, overwriting the fresh switch. The missing `permission/preset` event on the reverts further suggests the writer evaluates `current()` against a stale/partially-hydrated projection snapshot, concludes the preset "already matches", and skips the preset event while still writing the knobs.

## Suggested fix directions

1. Clear a pending switch entry atomically when it is flushed at `agent/pre-step` (never re-flush the same entry), and drop pending entries when a newer durable knob fold already satisfies them.
2. Re-read the freshly folded knob state at flush time instead of a mount-time snapshot, and skip writes that would not change the fold (this also avoids the spurious `sandbox/mode` write that currently aborts in-flight PTC calls with `sandbox mode changed`).
3. Keep the `permission/preset` event and the knob writes consistent: whenever any knob is written through the preset service, the preset event must reflect the resulting bundle.

Happy to provide the full session log privately if useful.

## Proposed fix

I could not file an issue or PR on this repository directly, so I opened a fix branch on my fork with a consistency patch (every knob write driven by `apply()` is now accompanied by a preset event, with a regression test pinning the invariant):

- branch: https://github.com/fairyto2/deepseek-harness/tree/fix/permission-preset-knob-event-consistency
- patch: `packages/interaction/permission-presets/src/index.ts` + `tests/switch-consistency.spec.ts`
- full write-up (same content as this post, framed as a PR description): https://github.com/fairyto2/deepseek-harness/blob/fix/permission-preset-knob-event-consistency/PR-DESCRIPTION.md

Happy to move it into an upstream branch or PR once contributions are open, or to provide more log detail if useful.
