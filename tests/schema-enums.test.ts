import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { AgentSchema } from "../src/actions/agent.ts";
import { PaneSchema } from "../src/actions/pane.ts";

// An unconstrained Type.String would silently admit invalid tool parameters.
describe.each([['pane', PaneSchema], ['agent', AgentSchema]] as const)('%s read schema', (_name, schema) => {
  it.each(['visible', 'recent', 'recent-unwrapped', 'detection'])('admits source %s', (source) => {
    expect(Value.Check(schema, { action: 'read', source })).toBe(true);
  });
  it('rejects unknown snapshot sources', () => {
    expect(Value.Check(schema, { action: 'read', source: 'everything' })).toBe(false);
  });
  it.each(['text', 'ansi'])('admits format %s', (format) => {
    expect(Value.Check(schema, { action: 'read', format })).toBe(true);
  });
  it('rejects json as a terminal read format', () => {
    expect(Value.Check(schema, { action: 'read', format: 'json' })).toBe(false);
  });
});
it.each(['left', 'right', 'up', 'down'])('pane schema admits focus direction %s', (direction) => {
  expect(Value.Check(PaneSchema, { action: 'focus-neighbor', direction })).toBe(true);
});
it('pane schema rejects an unknown direction', () => {
  expect(Value.Check(PaneSchema, { action: 'focus-neighbor', direction: 'diagonal' })).toBe(false);
});
it.each(['idle', 'working', 'blocked', 'done', 'unknown'])('agent schema admits wait state %s', (state) => {
  expect(Value.Check(AgentSchema, { action: 'wait', until: [state] })).toBe(true);
});
it('agent schema rejects unknown wait states in arrays', () => {
  expect(Value.Check(AgentSchema, { action: 'wait', until: ['idle', 'finished'] })).toBe(false);
});
