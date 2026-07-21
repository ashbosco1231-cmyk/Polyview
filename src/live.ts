// Live push hub. The frontend opens one WebSocket, subscribes to the token it's
// currently viewing, and receives that token's trades and book updates the
// instant the recorder sees them. Clients only get the token they asked for, so
// a busy recorder (thousands of prints across 80 markets) never floods a viewer
// looking at one chart.

import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { LiveEvent } from "./recorder.js";

interface Client {
  socket: WebSocket;
  tokenId: string | null;
}

export class LiveHub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();

  constructor(server: Server, path = "/live") {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on("connection", (socket) => this.onConnect(socket));
  }

  private onConnect(socket: WebSocket): void {
    const client: Client = { socket, tokenId: null };
    this.clients.add(client);

    socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // { type: "subscribe", tokenId: "..." }
      if (msg?.type === "subscribe" && typeof msg.tokenId === "string") {
        client.tokenId = msg.tokenId;
        socket.send(JSON.stringify({ type: "subscribed", tokenId: msg.tokenId }));
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
      if (client.tokenId === tokenId && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}
