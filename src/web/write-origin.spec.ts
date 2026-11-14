import { describe, expect, it } from 'vitest';
import { agentName, type AgentStamp, ownAgentName } from './write-origin';

/** The one viewer rule every surface answers (#682). */
describe('agentName', () => {
  const OWNER = 1;
  const GRANTEE = 2;
  const OTHER = 3;
  const granteesAgent: AgentStamp = {
    author: { id: GRANTEE, firstName: 'Dana', tokenName: 'Dana’s laptop' },
  };

  it("shows the token's own author its name", () => {
    expect(
      agentName(granteesAgent, { viewerId: GRANTEE, ownerId: OWNER }),
    ).toBe('Dana’s laptop');
  });

  it('shows the owner whose agent it was, by first name, never the token', () => {
    expect(agentName(granteesAgent, { viewerId: OWNER, ownerId: OWNER })).toBe(
      'Dana’s agent',
    );
  });

  it('shows anyone else "Agent"', () => {
    expect(agentName(granteesAgent, { viewerId: OTHER, ownerId: OWNER })).toBe(
      'Agent',
    );
  });

  it('says "Agent" once the author is gone, or has no first name', () => {
    expect(
      agentName({ author: null }, { viewerId: OWNER, ownerId: OWNER }),
    ).toBe('Agent');
    expect(
      agentName(
        { author: { id: GRANTEE, firstName: null, tokenName: 'x' } },
        { viewerId: OWNER, ownerId: OWNER },
      ),
    ).toBe('Agent');
    expect(ownAgentName({ author: null })).toBe('Agent');
  });
});
