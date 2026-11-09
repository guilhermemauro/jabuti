// The UI side of the WebSocket boundary: validates every server message and
// reconnects when the server restarts.
import { ServerMessage, type ClientMessage } from "@jabuti/protocol";

export interface Connection {
  send(message: ClientMessage): void;
  close(): void;
}

export function connect(handlers: {
  onMessage(message: ServerMessage): void;
  onStatus(connected: boolean): void;
  onInvalid(detail: string): void;
}): Connection {
  let socket: WebSocket | undefined;
  let closed = false;
  let retry = 0;

  const open = () => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      retry = 0;
      handlers.onStatus(true);
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      const parsed = ServerMessage.safeParse(JSON.parse(event.data));
      if (parsed.success) handlers.onMessage(parsed.data);
      else handlers.onInvalid(parsed.error.message);
    };
    ws.onclose = () => {
      handlers.onStatus(false);
      if (!closed) setTimeout(open, Math.min(5_000, 250 * 2 ** retry++));
    };
  };
  open();

  return {
    send(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close() {
      closed = true;
      socket?.close();
    },
  };
}
