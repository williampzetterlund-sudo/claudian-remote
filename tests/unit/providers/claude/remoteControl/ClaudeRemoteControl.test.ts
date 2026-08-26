import type { Query } from '@anthropic-ai/claude-agent-sdk';

import {
  buildRemoteControlName,
  enableRemoteControlOnQuery,
  getRemoteControlState,
  isRemoteControlEnabled,
  REMOTE_CONTROL_NAME_MAX_LENGTH,
} from '@/providers/claude/remoteControl/ClaudeRemoteControl';

function createQuery(
  request: jest.Mock,
): Query {
  return { request } as unknown as Query;
}

describe('ClaudeRemoteControl', () => {
  describe('isRemoteControlEnabled', () => {
    it('is opt-in', () => {
      expect(isRemoteControlEnabled({ remoteControlEnabled: false })).toBe(false);
      expect(isRemoteControlEnabled({ remoteControlEnabled: true })).toBe(true);
    });
  });

  describe('getRemoteControlState', () => {
    it('returns null for missing or malformed state', () => {
      expect(getRemoteControlState(undefined)).toBeNull();
      expect(getRemoteControlState({})).toBeNull();
      expect(getRemoteControlState({ remoteControl: 'nope' })).toBeNull();
      expect(getRemoteControlState({ remoteControl: { sessionUrl: 'x' } })).toBeNull();
    });

    it('parses a persisted state and defaults optional fields', () => {
      expect(getRemoteControlState({
        remoteControl: { bridgeSessionId: 'cse_1', sessionUrl: 'https://claude.ai/code/session_1' },
      })).toEqual({
        bridgeSessionId: 'cse_1',
        sessionUrl: 'https://claude.ai/code/session_1',
        name: 'Ignis',
        updatedAt: 0,
      });
    });
  });

  describe('buildRemoteControlName', () => {
    it('falls back to the prefix without a prompt', () => {
      expect(buildRemoteControlName(undefined)).toBe('Ignis');
      expect(buildRemoteControlName('   ')).toBe('Ignis');
    });

    it('derives a bounded, markup-free excerpt from the opening prompt', () => {
      const name = buildRemoteControlName(
        '<linked_content path="x" /> **Hur** gör jag `det här`? ' + 'x'.repeat(200),
      );
      expect(name.startsWith('Ignis · Hur gör jag det här?')).toBe(true);
      expect(name.length).toBeLessThanOrEqual(REMOTE_CONTROL_NAME_MAX_LENGTH);
      expect(name.endsWith('…')).toBe(true);
    });
  });

  describe('enableRemoteControlOnQuery', () => {
    it('mints a new session with keep_session_on_exit and the derived name', async () => {
      const request = jest.fn().mockResolvedValue({
        response: { session_url: 'https://claude.ai/code/session_A', bridge_session_id: 'cse_A' },
      });
      const state = await enableRemoteControlOnQuery(createQuery(request), {
        previous: null,
        prompt: 'Skriv en dikt',
        now: () => 42,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith({
        subtype: 'remote_control',
        enabled: true,
        name: 'Ignis · Skriv en dikt',
        keep_session_on_exit: true,
      });
      expect(state).toEqual({
        bridgeSessionId: 'cse_A',
        sessionUrl: 'https://claude.ai/code/session_A',
        name: 'Ignis · Skriv en dikt',
        updatedAt: 42,
      });
    });

    it('reattaches the previous bridge session and keeps its name', async () => {
      const request = jest.fn().mockResolvedValue({
        response: { session_url: 'https://claude.ai/code/session_A', bridge_session_id: 'cse_A' },
      });
      const state = await enableRemoteControlOnQuery(createQuery(request), {
        previous: {
          bridgeSessionId: 'cse_A',
          sessionUrl: 'https://claude.ai/code/session_A',
          name: 'Ignis · Gammal',
          updatedAt: 1,
        },
        prompt: 'Nytt meddelande',
        now: () => 2,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toMatchObject({
        reattach_session_id: 'cse_A',
        name: 'Ignis · Gammal',
      });
      expect(state?.bridgeSessionId).toBe('cse_A');
    });

    it('falls back to a fresh session when reattach is refused', async () => {
      const request = jest.fn()
        .mockRejectedValueOnce(new Error('unknown bridge session'))
        .mockResolvedValueOnce({
          response: { session_url: 'https://claude.ai/code/session_B', bridge_session_id: 'cse_B' },
        });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const state = await enableRemoteControlOnQuery(createQuery(request), {
          previous: {
            bridgeSessionId: 'cse_A',
            sessionUrl: 'https://claude.ai/code/session_A',
            name: 'Ignis · Gammal',
            updatedAt: 1,
          },
          now: () => 3,
        });
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1][0]).not.toHaveProperty('reattach_session_id');
        expect(state).toEqual({
          bridgeSessionId: 'cse_B',
          sessionUrl: 'https://claude.ai/code/session_B',
          name: 'Ignis · Gammal',
          updatedAt: 3,
        });
      } finally {
        warn.mockRestore();
      }
    });

    it('returns null when the CLI answers without the needed fields', async () => {
      const request = jest.fn().mockResolvedValue({ response: {} });
      await expect(enableRemoteControlOnQuery(createQuery(request), {
        previous: null,
      })).resolves.toBeNull();
    });
  });
});
