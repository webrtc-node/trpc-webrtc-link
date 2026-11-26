import { setTimeout as delay } from 'node:timers/promises';
import { createTRPCClient, TRPCClientError } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createWebRTCHandler,
  createWebRTCLink,
  parseWebRTCFrame,
  TRPC_WEBRTC_PROTOCOL,
  type WebRTCHandler,
} from '../src/index.js';
import { exceedsUTF8ByteLimit } from '../src/protocol.js';
import { RecentIdSet } from '../src/recent-ids.js';
import { createInMemoryChannelPair, type InMemoryDataChannel } from './in-memory-channel.js';
import { createTestHarness, type TestHarness, waitFor } from './test-utils.js';

const t = initTRPC.create();

function frame(value: Record<string, unknown>): string {
  return JSON.stringify({ protocol: TRPC_WEBRTC_PROTOCOL, ...value });
}

function framesOfType(channel: InMemoryDataChannel, type: string): Array<Record<string, unknown>> {
  return channel.sent
    .map((payload) => JSON.parse(payload) as Record<string, unknown>)
    .filter((sent) => sent.type === type);
}

describe('client regressions', () => {
  let harness: TestHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it('rejects an operation whose signal is already aborted', async () => {
    harness = await createTestHarness();
    const controller = new AbortController();
    controller.abort(new Error('aborted before start'));

    const request = harness.client.hello.query({ name: 'late' }, { signal: controller.signal });

    await expect(
      Promise.race([
        request,
        delay(500).then(() => {
          throw new Error('operation never settled');
        }),
      ]),
    ).rejects.toBeInstanceOf(TRPCClientError);
    expect(framesOfType(harness.clientChannel, 'request')).toHaveLength(0);
  });

  it('ignores in-flight frames for an operation it cancelled', async () => {
    const onProtocolError = vi.fn();
    harness = await createTestHarness({ client: { onProtocolError } });

    const subscription = harness.client.clock.subscribe(
      { count: 1_000, waitMs: 20 },
      { onData() {} },
    );
    await waitFor(() => framesOfType(harness!.serverChannel, 'data').length > 0);
    const [request] = framesOfType(harness.clientChannel, 'request');
    subscription.unsubscribe();

    // Frames the server sent before it processed the cancellation.
    harness.serverChannel.send(frame({ type: 'data', id: request!.id, data: { json: 99 } }));
    harness.serverChannel.send(frame({ type: 'complete', id: request!.id }));

    await waitFor(() => harness!.state.subscriptionCancellations === 1);
    await delay(10);
    expect(onProtocolError).not.toHaveBeenCalled();
    await expect(harness.client.hello.query({ name: 'after' })).resolves.toBe(
      'hello after from test-peer',
    );
  });

  it('cancels server operations when the link is disposed without closing the channel', async () => {
    harness = await createTestHarness();

    harness.client.clock.subscribe({ count: 1_000, waitMs: 20 }, { onData() {} });
    await waitFor(() => framesOfType(harness!.serverChannel, 'data').length > 0);

    harness.link.close();

    await waitFor(() => harness!.state.subscriptionCancellations === 1);
    expect(harness.clientChannel.readyState).toBe('open');
    expect(framesOfType(harness.clientChannel, 'cancel')).toHaveLength(1);
  });
});

describe('server regressions', () => {
  let handler: WebRTCHandler | undefined;
  let pair: ReturnType<typeof createInMemoryChannelPair> | undefined;

  afterEach(() => {
    handler?.close();
    handler = undefined;
    pair?.client.close();
    pair = undefined;
  });

  it('returns a subscription iterator when its output cannot be sent', async () => {
    let finalized = false;
    const router = t.router({
      huge: t.procedure.subscription(async function* () {
        try {
          yield 'x'.repeat(4_096);
          await new Promise(() => undefined);
        } finally {
          finalized = true;
        }
      }),
    });
    pair = createInMemoryChannelPair();
    handler = createWebRTCHandler({
      router,
      channel: pair.server,
      peer: null,
      backpressure: { maxMessageBytes: 1_024 },
    });
    const client = createTRPCClient<typeof router>({
      links: [createWebRTCLink<typeof router>({ channel: pair.client })],
    });

    const error = await new Promise<unknown>((resolve) => {
      client.huge.subscribe(undefined, { onError: resolve });
    });

    expect(error).toBeInstanceOf(TRPCClientError);
    await waitFor(() => finalized);
  });

  it('does not convert array input into an object when resuming with lastEventId', async () => {
    const inputs: unknown[] = [];
    const router = t.router({
      list: t.procedure.input(z.array(z.number())).subscription(async function* ({ input }) {
        inputs.push(input);
        yield input.length;
      }),
    });
    pair = createInMemoryChannelPair();
    handler = createWebRTCHandler({ router, channel: pair.server, peer: null });

    pair.client.send(frame({ type: 'handshake', role: 'client' }));
    await handler.ready;
    pair.client.send(
      frame({
        type: 'request',
        id: 'resume',
        procedureType: 'subscription',
        path: 'list',
        input: [1, 2, 3],
        lastEventId: 'event-1',
      }),
    );

    await waitFor(() => framesOfType(pair!.server, 'complete').length === 1);
    expect(inputs).toEqual([[1, 2, 3]]);
  });

  it('treats a cancellation that races with completion as benign', async () => {
    const onProtocolError = vi.fn();
    const router = t.router({ ping: t.procedure.query(() => 'pong') });
    pair = createInMemoryChannelPair();
    handler = createWebRTCHandler({ router, channel: pair.server, peer: null, onProtocolError });

    pair.client.send(frame({ type: 'handshake', role: 'client' }));
    await handler.ready;
    pair.client.send(frame({ type: 'request', id: 'done', procedureType: 'query', path: 'ping' }));
    await waitFor(() => framesOfType(pair!.server, 'complete').length === 1);

    pair.client.send(frame({ type: 'cancel', id: 'done' }));
    await delay(10);
    expect(onProtocolError).not.toHaveBeenCalled();

    pair.client.send(frame({ type: 'cancel', id: 'never-seen' }));
    await waitFor(() => onProtocolError.mock.calls.length === 1);
    expect(pair.server.readyState).toBe('open');
  });
});

describe('protocol regressions', () => {
  it('bounds peer-controlled text echoed in parse errors', () => {
    const protocol = parseWebRTCFrame(JSON.stringify({ protocol: 'x'.repeat(10_000) }));
    const type = parseWebRTCFrame(frame({ type: 'y'.repeat(10_000) }));

    expect(protocol.ok).toBe(false);
    expect(type.ok).toBe(false);
    if (!protocol.ok && !type.ok) {
      expect(protocol.error.message.length).toBeLessThan(200);
      expect(type.error.message.length).toBeLessThan(200);
    }
  });
});

describe('internal helpers', () => {
  it.each([
    ['', 0, false],
    ['abc', 3, false],
    ['abc', 2, true],
    ['é', 1, true],
    ['é', 2, false],
    ['€€', 5, true],
    ['€€', 6, false],
    ['😀', 3, true],
    ['😀', 4, false],
  ])('checks %j against a %i byte limit', (value, limit, expected) => {
    expect(exceedsUTF8ByteLimit(value, limit)).toBe(expected);
  });

  it('evicts the oldest retired id once full', () => {
    const ids = new RecentIdSet(2);
    ids.add('a');
    ids.add('b');
    ids.add('a');
    ids.add('c');

    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(false);
    expect(ids.has('c')).toBe(true);
  });
});
