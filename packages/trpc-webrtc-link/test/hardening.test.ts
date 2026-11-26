import { setTimeout as delay } from 'node:timers/promises';
import { createTRPCClient } from '@trpc/client';
import { initTRPC, type AnyTRPCRouter } from '@trpc/server';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWebRTCHandler,
  createWebRTCLink,
  TRPC_WEBRTC_PROTOCOL,
  type CreateWebRTCHandlerOptions,
  type WebRTCHandler,
} from '../src/index.js';
import { createInMemoryChannelPair, type InMemoryDataChannel } from './in-memory-channel.js';
import { testRouter, type TestState, waitFor } from './test-utils.js';

const t = initTRPC.create();

function frame(value: Record<string, unknown>): string {
  return JSON.stringify({ protocol: TRPC_WEBRTC_PROTOCOL, ...value });
}

function framesOfType(channel: InMemoryDataChannel, type: string): Array<Record<string, unknown>> {
  return channel.sent
    .map((payload) => JSON.parse(payload) as Record<string, unknown>)
    .filter((sent) => sent.type === type);
}

describe('production hardening', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function startServer<TRouter extends AnyTRPCRouter>(
    router: TRouter,
    options: Partial<CreateWebRTCHandlerOptions<TRouter, null>> = {},
  ) {
    const channels = createInMemoryChannelPair();
    const server = createWebRTCHandler({
      router,
      channel: channels.server,
      peer: null,
      ...options,
    });
    cleanups.push(() => {
      server.close();
      channels.client.close();
    });
    return { channels, server };
  }

  it('keeps a slow but draining connection alive under server keep-alive', async () => {
    const state: TestState = {
      counter: 0,
      contextCreations: 0,
      subscriptionCancellations: 0,
      queryCancellations: 0,
      trackedInputs: [],
    };
    const { channels, server } = startServer(testRouter, {
      backpressure: { highWatermark: 0, lowWatermark: 0 },
      keepAlive: { enabled: true, intervalMs: 10, pongTimeoutMs: 40 },
      createContext: () => ({ state, peerName: 'slow' }),
    });
    const link = createWebRTCLink<typeof testRouter>({
      channel: channels.client,
      transformer: superjson,
    });
    cleanups.push(() => link.close());
    const client = createTRPCClient<typeof testRouter>({ links: [link] });
    await Promise.all([link.connect(), server.ready]);

    channels.server.autoDrain = false;
    for (let index = 0; index < 10; index += 1) {
      client.clock.subscribe({ count: 10_000, waitMs: 0 }, { onData() {} });
    }
    // One frame leaves per drain, so the ping waits behind up to ten frames
    // (about 150ms), far longer than the 40ms pong deadline.
    const drainer = setInterval(() => channels.server.drain(), 15);
    cleanups.push(() => clearInterval(drainer));

    await delay(400);
    expect(channels.server.readyState).toBe('open');
  });

  it('still times out a connection whose send queue stops draining', async () => {
    const router = t.router({
      ticks: t.procedure.subscription(async function* ({ signal }) {
        while (!signal?.aborted) {
          yield 1;
          await delay(1);
        }
      }),
    });
    const { channels, server } = startServer(router, {
      backpressure: { highWatermark: 0, lowWatermark: 0 },
      keepAlive: { enabled: true, intervalMs: 10, pongTimeoutMs: 30 },
    });
    const link = createWebRTCLink<typeof router>({ channel: channels.client });
    cleanups.push(() => link.close());
    const client = createTRPCClient<typeof router>({ links: [link] });
    await Promise.all([link.connect(), server.ready]);

    channels.server.autoDrain = false;
    client.ticks.subscribe(undefined, { onData() {}, onError() {} });

    await waitFor(() => channels.server.readyState === 'closed', 1_000);
  });

  it('makes one attempt for a manual reconnect when reconnection is disabled', async () => {
    const router = t.router({ ping: t.procedure.query(() => 'pong') });
    let calls = 0;
    let failing = false;
    const servers: WebRTCHandler[] = [];
    const link = createWebRTCLink<typeof router>({
      channel: () => {
        calls += 1;
        if (failing) {
          throw new Error('signaling is down');
        }
        const channels = createInMemoryChannelPair();
        servers.push(createWebRTCHandler({ router, channel: channels.server, peer: null }));
        return channels.client;
      },
      reconnect: false,
    });
    cleanups.push(() => {
      link.close();
      for (const server of servers) {
        server.close();
      }
    });
    await link.connect();

    failing = true;
    await expect(
      Promise.race([
        link.reconnect(),
        delay(1_000).then(() => {
          throw new Error('reconnect kept retrying');
        }),
      ]),
    ).rejects.toThrow('signaling is down');
    expect(calls).toBe(2);
  });

  it('limits concurrent operations to 100 by default', async () => {
    const router = t.router({
      hang: t.procedure.query(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      ),
    });
    const { channels, server } = startServer(router);
    channels.client.send(frame({ type: 'handshake', role: 'client' }));
    await server.ready;

    for (let index = 0; index <= 100; index += 1) {
      channels.client.send(
        frame({ type: 'request', id: `op-${index}`, procedureType: 'query', path: 'hang' }),
      );
    }

    await waitFor(() => framesOfType(channels.server, 'error').length === 1);
    expect(framesOfType(channels.server, 'error')[0]).toMatchObject({
      id: 'op-100',
      error: { data: { code: 'TOO_MANY_REQUESTS' } },
    });
  });

  it('reports a cancelled subscription that never stops', async () => {
    const onError = vi.fn();
    const router = t.router({
      stuck: t.procedure.subscription(async function* () {
        yield 1;
        await new Promise(() => undefined);
      }),
    });
    const { channels, server } = startServer(router, { onError });
    channels.client.send(frame({ type: 'handshake', role: 'client' }));
    await server.ready;
    channels.client.send(
      frame({ type: 'request', id: 'stuck', procedureType: 'subscription', path: 'stuck' }),
    );
    await waitFor(() => framesOfType(channels.server, 'data').length === 1);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    channels.client.send(frame({ type: 'cancel', id: 'stuck' }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].error.message).toContain('did not stop');
  });

  it('reports undeserializable input as PARSE_ERROR', async () => {
    const onError = vi.fn();
    const strict = initTRPC.create({
      transformer: {
        serialize: (value: unknown) => value,
        deserialize: () => {
          throw new Error('cannot decode');
        },
      },
    });
    const router = strict.router({ echo: strict.procedure.query(() => 'never') });
    const { channels, server } = startServer(router, { onError });
    channels.client.send(frame({ type: 'handshake', role: 'client' }));
    await server.ready;
    channels.client.send(
      frame({ type: 'request', id: 'bad', procedureType: 'query', path: 'echo', input: 1 }),
    );

    await waitFor(() => framesOfType(channels.server, 'error').length === 1);
    expect(onError.mock.calls[0]![0].error.code).toBe('PARSE_ERROR');
  });

  it('rejects non-string connectionParams before sending the handshake', async () => {
    const router = t.router({ ping: t.procedure.query(() => 'pong') });
    const { channels } = startServer(router);
    const link = createWebRTCLink<typeof router>({
      channel: channels.client,
      connectionParams: () => ({ token: 1 }) as unknown as Record<string, string>,
    });
    cleanups.push(() => link.close());

    await expect(link.connect()).rejects.toThrow(TypeError);
    expect(framesOfType(channels.client, 'handshake')).toHaveLength(0);
  });
});
