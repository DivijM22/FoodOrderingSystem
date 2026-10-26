import { useEffect, useState } from 'react';
import { buildUrl, currentToken } from '../api/client';
import { ordersApi } from '../api/orders';
import type { Tracking } from '../api/types';

export type TrackingMode = 'connecting' | 'live' | 'polling' | 'ended';

const POLL_MS = 5000;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Authoritative order progress from the Order Service. Uses the SSE stream (GET /orders/:id/tracking/stream, read with
 * fetch so the JWT can travel in the Authorization header) and falls back to polling GET /orders/:id/tracking.
 * Nothing here invents a state: every update is a server snapshot.
 */
export function useTracking(orderId: string | undefined) {
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [mode, setMode] = useState<TrackingMode>('connecting');

  useEffect(() => {
    if (!orderId) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;

    async function stream(): Promise<'ended' | 'failed'> {
      const token = currentToken();
      const res = await fetch(buildUrl(`/orders/${orderId}/tracking/stream`), { headers: token ? { authorization: `Bearer ${token}` } : {}, signal });
      if (res.status !== 200 || !res.body) return 'failed';
      setMode('live');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return 'failed'; // connection dropped without an "end" event
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: end$/m.test(block)) return 'ended';
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (/^event: tracking$/m.test(block) && data) setTracking(JSON.parse(data) as Tracking);
        }
      }
    }

    async function poll(): Promise<boolean> {
      try {
        const { data } = await ordersApi.tracking(orderId!);
        setTracking(data);
        return data.settled;
      } catch {
        return false;
      }
    }

    (async () => {
      let failures = 0;
      while (!signal.aborted) {
        try {
          const result = await stream();
          if (result === 'ended') {
            await poll(); // final snapshot
            setMode('ended');
            return;
          }
        } catch {
          if (signal.aborted) return;
        }
        // Stream unavailable: poll for a while, then try the stream again.
        failures++;
        setMode('polling');
        for (let n = 0; n < Math.min(6, 2 * failures) && !signal.aborted; n++) {
          if (await poll()) return setMode('ended');
          await sleep(POLL_MS, signal);
        }
      }
    })();

    return () => ctrl.abort();
  }, [orderId]);

  return { tracking, mode };
}
