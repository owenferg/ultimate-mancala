import { DurableObject } from 'cloudflare:workers';

// the static files are served without this, it only sees /ws/ and paths that match no file
// each party gets one Party object, found by its code, which passes messages between the host's browser and the guests
export default {
  fetch(request, env) {
    const code = new URL(request.url).pathname.match(/^\/ws\/([A-Z]{4})$/)?.[1];
    if (!code || request.headers.get('Upgrade') !== 'websocket') return new Response('Not found', { status: 404 });
    return env.PARTY.get(env.PARTY.idFromName(code)).fetch(request);
  },
};

// holds no game state, only the sockets
// each socket is tagged 'host' or a guest id, which is all that has to outlive the object sleeping between messages
export class Party extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // answers the browsers' keepalive pings without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  host() {
    return this.ctx.getWebSockets('host').find(s => s.readyState === WebSocket.OPEN);
  }

  fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    const hosting = new URL(request.url).searchParams.has('host'), host = this.host();
    const refused = hosting ? host && [4009, 'That code is taken'] : !host && [4004, 'No party with that code'];
    if (refused) {
      // a browser cannot read the status of a failed upgrade, so refusals are a close code on an accepted socket
      server.accept();
      server.close(...refused);
    } else {
      const tag = hosting ? 'host' : crypto.randomUUID();
      this.ctx.acceptWebSocket(server, [tag]);
      if (hosting) server.send(JSON.stringify({ ready: true }));
      else host.send(JSON.stringify({ from: tag, open: true }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // the host says which guest each message is for, and is told which guest each one came from
  webSocketMessage(ws, text) {
    const [tag] = this.ctx.getTags(ws), d = JSON.parse(text);
    if (tag === 'host') this.ctx.getWebSockets(d.to)[0]?.send(JSON.stringify(d.data));
    else this.host()?.send(JSON.stringify({ from: tag, data: d }));
  }

  webSocketClose(ws, code, reason, clean) {
    this.webSocketError(ws);
    if (clean) ws.close(); // finishes the close on the browser's side, which otherwise waits for it
  }

  webSocketError(ws) {
    const [tag] = this.ctx.getTags(ws);
    // the game lives in the host's browser, so the party ends with it
    // guests are told as well as closed, as a close alone can take a while to show up on their side
    if (tag === 'host') this.ctx.getWebSockets().forEach(s => {
      if (s === ws || s.readyState !== WebSocket.OPEN) return;
      s.send(JSON.stringify({ error: 'Disconnected from the party' }));
      s.close(1000);
    });
    else this.host()?.send(JSON.stringify({ from: tag, closed: true }));
  }
}
