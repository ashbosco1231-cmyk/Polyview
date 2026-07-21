// Live push hub. The frontend opens one WebSocket, subscribes to the token it's
// currently viewing, and receives that token's trades and book updates the
// instant the recorder sees them. Clients only get the token they asked for, so
// a busy recorder (thousands of prints across 80 markets) never floods a viewer
// looking at one chart.

import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { LiveEvent } from "./source.js";

interface Client {
  socket: WebSocket;
  tokenIds: Set<string>;
}

export class LiveHub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();

  constructor(server: Server, path = "/live") {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on("connection", (socket) => this.onConnect(socket));
  }

  private onConnect(socket: WebSocket): void {
    const client: Client = { socket, tokenIds: new Set() };
    this.clients.add(client);

    socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // { type: "subscribe", tokenId: "..." } or { type: "subscribe", tokenIds: [...] }
      // A subscribe replaces the client's set, so switching markets is one message.
      if (msg?.type === "subscribe") {
        const ids: string[] = Array.isArray(msg.tokenIds)
          ? msg.tokenIds.filter((t: unknown) => typeof t === "string")
          : typeof msg.tokenId === "string"
            ? [msg.tokenId]
            : [];
        client.tokenIds = new Set(ids);
        socket.send(JSON.stringify({ type: "subscribed", tokenIds: [...client.tokenIds] }));
      }
    });

    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
  }

  /** Fan an event out to every client subscribed to that event's token. */
  broadcast(ev: LiveEvent): void {
    const tokenId = ev.kind === "trade" ? ev.trade.tokenId : ev.book.tokenId;
    const payload = JSON.stringify(ev);
    for (const client of this.clients) {
      if (client.tokenIds.has(tokenId) && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}
