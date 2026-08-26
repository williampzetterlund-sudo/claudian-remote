import type { Query } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudianSettings } from '../../../core/types/settings';

/**
 * Persisted (in the conversation's opaque Claude provider state) under the
 * `remoteControl` key. `bridgeSessionId` is what the CLI needs to reattach
 * the same claude.ai session after a process restart; `sessionUrl` is what
 * the user opens on the phone.
 */
export interface ClaudeRemoteControlState {
  readonly bridgeSessionId: string;
  readonly sessionUrl: string;
  readonly name: string;
  readonly updatedAt: number;
}

interface RemoteControlResponse {
  readonly session_url?: unknown;
  readonly bridge_session_id?: unknown;
  readonly connect_url?: unknown;
  readonly environment_id?: unknown;
  readonly bridge_epoch?: unknown;
}

/**
 * The CLI's control loop accepts `{subtype:"remote_control"}` in headless
 * stream-json mode (the same channel the SDK uses for set_model etc.).
 * The SDK wraps it as `enableRemoteControl(enabled, name[, opts])`, but the
 * bundled SDK version only forwards two arguments, so we send the request
 * ourselves to get `reattach_session_id` / `keep_session_on_exit` through.
 */
interface RemoteControlCapableQuery {
  request?(
    payload: Record<string, unknown>,
    options?: unknown,
  ): Promise<unknown>;
  enableRemoteControl?(enabled: boolean, name?: string): Promise<unknown>;
}

export const REMOTE_CONTROL_NAME_MAX_LENGTH = 48;
export const REMOTE_CONTROL_NAME_PREFIX = 'Ignis';

export function isRemoteControlEnabled(
  settings: Pick<ClaudianSettings, 'remoteControlEnabled'>,
): boolean {
  return settings.remoteControlEnabled === true;
}

export function getRemoteControlState(
  providerState: Readonly<Record<string, unknown>> | undefined,
): ClaudeRemoteControlState | null {
  const raw = providerState?.remoteControl;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.bridgeSessionId !== 'string'
    || typeof record.sessionUrl !== 'string'
    || !record.bridgeSessionId
    || !record.sessionUrl
  ) {
    return null;
  }
  return {
    bridgeSessionId: record.bridgeSessionId,
    sessionUrl: record.sessionUrl,
    name: typeof record.name === 'string' ? record.name : REMOTE_CONTROL_NAME_PREFIX,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  };
}

/** Session name shown in claude.ai/code — derived from the opening prompt. */
export function buildRemoteControlName(prompt: string | undefined): string {
  const collapsed = (prompt ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_#>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return REMOTE_CONTROL_NAME_PREFIX;
  const budget = REMOTE_CONTROL_NAME_MAX_LENGTH - REMOTE_CONTROL_NAME_PREFIX.length - 3;
  const excerpt = collapsed.length > budget
    ? `${collapsed.slice(0, budget - 1).trimEnd()}…`
    : collapsed;
  return `${REMOTE_CONTROL_NAME_PREFIX} · ${excerpt}`;
}

function unwrapResponse(result: unknown): RemoteControlResponse | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  const inner = record.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown>
    : record;
  return inner as RemoteControlResponse;
}

async function sendRemoteControlRequest(
  query: Query,
  payload: {
    name: string;
    reattachSessionId?: string;
  },
): Promise<RemoteControlResponse | null> {
  const capable = query as unknown as RemoteControlCapableQuery;
  if (typeof capable.request === 'function') {
    const result = await capable.request({
      subtype: 'remote_control',
      enabled: true,
      name: payload.name,
      ...(payload.reattachSessionId
        ? { reattach_session_id: payload.reattachSessionId }
        : {}),
      keep_session_on_exit: true,
    });
    return unwrapResponse(result);
  }
  if (typeof capable.enableRemoteControl === 'function') {
    return unwrapResponse(await capable.enableRemoteControl(true, payload.name));
  }
  throw new Error('Claude SDK query does not support Remote Control requests.');
}

export interface EnableRemoteControlOptions {
  readonly previous: ClaudeRemoteControlState | null;
  readonly prompt?: string;
  readonly now?: () => number;
}

/**
 * Enables Remote Control on a live query. Tries to reattach the
 * conversation's previous claude.ai session first; if the CLI refuses
 * (expired / unknown bridge session) a fresh session is minted instead.
 * Returns null when the CLI answered without the fields we need.
 */
export async function enableRemoteControlOnQuery(
  query: Query,
  options: EnableRemoteControlOptions,
): Promise<ClaudeRemoteControlState | null> {
  const name = options.previous?.name ?? buildRemoteControlName(options.prompt);
  let response: RemoteControlResponse | null = null;
  if (options.previous) {
    try {
      response = await sendRemoteControlRequest(query, {
        name,
        reattachSessionId: options.previous.bridgeSessionId,
      });
    } catch (error) {
      console.warn(
        '[Claudian] Remote Control reattach failed, minting a new session:',
        error,
      );
      response = null;
    }
  }
  if (!response || typeof response.session_url !== 'string') {
    response = await sendRemoteControlRequest(query, { name });
  }
  if (
    !response
    || typeof response.session_url !== 'string'
    || typeof response.bridge_session_id !== 'string'
    || !response.session_url
    || !response.bridge_session_id
  ) {
    return null;
  }
  return {
    bridgeSessionId: response.bridge_session_id,
    sessionUrl: response.session_url,
    name,
    updatedAt: (options.now ?? Date.now)(),
  };
}
