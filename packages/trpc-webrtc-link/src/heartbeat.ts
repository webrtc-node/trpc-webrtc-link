import { normalizeTimeoutMs } from './channel.js';
import { WebRTCKeepAliveTimeoutError } from './errors.js';

export interface WebRTCKeepAliveOptions {
  /**
   * Enable protocol-level ping/pong health checks.
   * @default false
   */
  enabled: boolean;
  /**
   * Wait this long without inbound activity before sending a ping.
   */
  intervalMs?: number;
  /**
   * Close the connection if the matching pong is not received in time.
   */
  pongTimeoutMs?: number;
}

interface NormalizedWebRTCKeepAliveOptions {
  enabled: boolean;
  intervalMs: number;
  pongTimeoutMs: number;
}

export function normalizeKeepAliveOptions(
  options: WebRTCKeepAliveOptions | undefined,
  defaults: { intervalMs: number; pongTimeoutMs: number },
): NormalizedWebRTCKeepAliveOptions {
  if (!options?.enabled) {
    return {
      enabled: false,
      ...defaults,
    };
  }
  return {
    enabled: true,
    intervalMs: normalizeTimeoutMs(options.intervalMs ?? defaults.intervalMs, 'intervalMs'),
    pongTimeoutMs: normalizeTimeoutMs(
      options.pongTimeoutMs ?? defaults.pongTimeoutMs,
      'pongTimeoutMs',
    ),
  };
}

function createNonce(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Sends a ping after `intervalMs` without inbound activity and fails the
 * connection when the matching pong does not arrive within `pongTimeoutMs`.
 *
 * The pong deadline measures the peer, not the local send queue: while the
 * ping is still waiting behind backpressure, every frame the writer manages to
 * send restarts the deadline, and the deadline restarts once more when the
 * ping itself is sent. A connection that is slow but draining stays open; one
 * whose queue stops draining still times out.
 */
export class HeartbeatController {
  readonly #options: NormalizedWebRTCKeepAliveOptions;
  readonly #sendPing: (nonce: string) => Promise<void>;
  readonly #onFailure: (error: Error) => void;

  #active = false;
  #lastActivity = 0;
  #pendingNonce: string | null = null;
  #pingSent = false;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: {
    keepAlive: NormalizedWebRTCKeepAliveOptions;
    sendPing(nonce: string): Promise<void>;
    onFailure(error: Error): void;
  }) {
    this.#options = options.keepAlive;
    this.#sendPing = options.sendPing;
    this.#onFailure = options.onFailure;
  }

  public start(): void {
    if (!this.#options.enabled || this.#active) {
      return;
    }
    this.#active = true;
    this.#lastActivity = now();
    this.#scheduleIdleCheck(this.#options.intervalMs);
  }

  /**
   * Record any valid inbound non-pong frame as proof that the peer is alive.
   * This runs for every frame, so it only records a timestamp unless a ping
   * is outstanding.
   */
  public activity(): void {
    if (!this.#active) {
      return;
    }
    this.#lastActivity = now();
    if (this.#pendingNonce !== null) {
      this.#pendingNonce = null;
      this.#clearPongTimer();
      if (this.#idleTimer === undefined) {
        this.#scheduleIdleCheck(this.#options.intervalMs);
      }
    }
  }

  /**
   * Record that the local writer sent a frame. While a ping is still queued,
   * this proves the channel is draining, so the pong deadline restarts.
   */
  public outboundProgress(): void {
    if (this.#active && this.#pendingNonce !== null && !this.#pingSent) {
      this.#startPongTimer(this.#pendingNonce);
    }
  }

  public pong(nonce: string): boolean {
    if (!this.#active || nonce !== this.#pendingNonce) {
      return false;
    }
    this.activity();
    return true;
  }

  public stop(): void {
    this.#active = false;
    this.#pendingNonce = null;
    this.#clearPongTimer();
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  #scheduleIdleCheck(delayMs: number): void {
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      this.#onIdleCheck();
    }, delayMs);
  }

  #onIdleCheck(): void {
    if (!this.#active || this.#pendingNonce !== null) {
      return;
    }
    const idleMs = now() - this.#lastActivity;
    if (idleMs < this.#options.intervalMs) {
      this.#scheduleIdleCheck(Math.max(1, Math.ceil(this.#options.intervalMs - idleMs)));
      return;
    }

    const nonce = createNonce();
    this.#pendingNonce = nonce;
    this.#pingSent = false;
    this.#startPongTimer(nonce);
    void this.#sendPing(nonce).then(
      () => {
        if (this.#active && this.#pendingNonce === nonce) {
          this.#pingSent = true;
          this.#startPongTimer(nonce);
        }
      },
      (cause: unknown) => {
        if (!this.#active) {
          return;
        }
        this.stop();
        this.#notifyFailure(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  }

  #startPongTimer(nonce: string): void {
    this.#clearPongTimer();
    this.#pongTimer = setTimeout(() => {
      this.#pongTimer = undefined;
      if (!this.#active || this.#pendingNonce !== nonce) {
        return;
      }
      this.stop();
      this.#notifyFailure(new WebRTCKeepAliveTimeoutError(this.#options.pongTimeoutMs));
    }, this.#options.pongTimeoutMs);
  }

  #clearPongTimer(): void {
    if (this.#pongTimer !== undefined) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
    }
  }

  #notifyFailure(error: Error): void {
    try {
      this.#onFailure(error);
    } catch {
      // User-controlled failure handling must not escape a timer callback.
    }
  }
}
