import * as React from "react";

export type LiveSocketStatus = "waiting" | "connected" | "reconnecting";

function buildWebSocketUrl(path: string): string {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function useLiveSocket<T>(args: {
  path: string;
  enabled?: boolean;
  reconnectKey?: string | number;
  onMessage: (message: T) => void;
  onReconnect?: () => void;
}): { status: LiveSocketStatus } {
  const enabled = args.enabled ?? true;
  const reconnectKey = args.reconnectKey;
  const onMessage = React.useEffectEvent(args.onMessage);
  const onReconnect = React.useEffectEvent(() => {
    args.onReconnect?.();
  });
  const [status, setStatus] = React.useState<LiveSocketStatus>("waiting");

  React.useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let connectTimer: number | null = null;
    let retryCount = 0;
    let hasConnectedOnce = false;

    const scheduleConnect = (delayMs: number) => {
      if (disposed) return;
      if (connectTimer !== null) {
        window.clearTimeout(connectTimer);
      }
      connectTimer = window.setTimeout(() => {
        connectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (disposed) return;
      const nextSocket = new WebSocket(buildWebSocketUrl(args.path));
      socket = nextSocket;

      nextSocket.onopen = () => {
        retryCount = 0;
        if (hasConnectedOnce) {
          onReconnect();
        }
        hasConnectedOnce = true;
        setStatus("connected");
      };

      nextSocket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          onMessage(JSON.parse(event.data) as T);
        } catch {}
      };

      nextSocket.onclose = () => {
        if (disposed) return;
        if (hasConnectedOnce) {
          setStatus("reconnecting");
        }
        const delayMs = Math.min(30_000, 1000 * 2 ** retryCount);
        retryCount += 1;
        scheduleConnect(delayMs);
      };

      nextSocket.onerror = () => {
        try {
          nextSocket.close();
        } catch {}
      };
    };

    setStatus("waiting");

    // Defer initial connect by one tick so React StrictMode's dev-only effect
    // teardown doesn't close a connecting WebSocket and spam the console.
    scheduleConnect(0);

    return () => {
      disposed = true;
      if (connectTimer !== null) {
        window.clearTimeout(connectTimer);
      }
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
    };
  }, [args.path, enabled, reconnectKey]);

  return { status };
}
