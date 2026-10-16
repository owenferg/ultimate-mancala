import { DurableObject } from 'cloudflare:workers';

// the static files are served without this, it only sees /ws/ and paths that match no file
// each party gets one Party object, found by its code, which passes messages between the host's browser and the guests
// a party's own address is the same page as the front one, which reads the code out of the address
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (/^\/party\/[a-z]{4}$/i.test(url.pathname)) return env.ASSETS.fetch(new URL('/', url));
    const code = url.pathname.match(/^\/ws\/([A-Z]{4})$/)?.[1];
    // every socket says who it is, a host by its key and a guest by its id, both made up by the browser
    if (!code || !/^\?(host|id)=[\w-]{36}$/.test(url.search) || request.headers.get('Upgrade') !== 'websocket')
      return new Response('Not found', { status: 404 });
    return env.PARTY.get(env.PARTY.idFromName(code)).fetch(request);
  },
};

// how long someone can be gone before it counts as leaving, so a refresh is not one
const GRACE = 10000;
// the close code a browser uses when its player leaves, or its host ends the party
const LEAVE = 4000;

// holds no game state, only the sockets
// each socket is tagged 'host' or a guest id, which is all that has to outlive the object sleeping between messages
// the host's socket is also tagged with its key, which is put in storage only while the host is away
export class Party extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // answers the browsers' keepalive pings without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  open(tag) {
    return this.ctx.getWebSockets(tag).filter(s => s.readyState === WebSocket.OPEN);
  }

  host() {
    return this.open('host')[0];
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    const { host: key, id } = Object.fromEntries(new URL(request.url).searchParams), host = this.host();
    // the party belongs to whoever holds this key, so only they can come back as its host
    const owner = host ? this.ctx.getTags(host)[1] : await this.ctx.storage.get('host');
    const refused = key ? owner && owner !== key && [4009, 'That code is taken'] : !owner && [4004, 'No party with that code'];
    if (refused) {
      // a browser cannot read the status of a failed upgrade, so refusals are a close code on an accepted socket
      server.accept();
      server.close(...refused);
    } else {
      const tag = key ? 'host' : id;
      // a refreshed page can get here before its old socket is seen to close
      this.end(tag, 'Opened in another tab');
      this.ctx.acceptWebSocket(server, key ? [tag, key] : [tag]);
      if (key) {
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        server.send(JSON.stringify({ ready: true }));
        // a host back from a refresh has to be told who is still here
        this.open().map(s => this.ctx.getTags(s)[0]).forEach(from => from === tag || server.send(JSON.stringify({ from, open: true })));
      } else host?.send(JSON.stringify({ from: tag, open: true }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // the host says which guest each message is for, and is told which guest each one came from
  webSocketMessage(ws, text) {
    const [tag] = this.ctx.getTags(ws), d = JSON.parse(text);
    if (tag === 'host') this.ctx.getWebSockets(d.to)[0]?.send(JSON.stringify(d.data));
    else this.host()?.send(JSON.stringify({ from: tag, data: d }));
  }

  async webSocketClose(ws, code, reason, clean) {
    const [tag] = this.ctx.getTags(ws);
    // leaving on purpose is not a refresh, so no one waits to see if they come back
    if (code !== LEAVE) await this.webSocketError(ws);
    else if (tag === 'host') this.end(undefined, 'The host ended the party');
    else this.host()?.send(JSON.stringify({ from: tag, closed: true, left: true }));
    if (clean) ws.close(); // finishes the close on the browser's side, which otherwise waits for it
  }

  async webSocketError(ws) {
    const [tag, key] = this.ctx.getTags(ws);
    if (this.open(tag).some(s => s !== ws)) return; // the same browser has already reconnected
    if (tag !== 'host') return this.host()?.send(JSON.stringify({ from: tag, closed: true }));
    // the host may only be refreshing, so the party is kept for them for a moment
    await this.ctx.storage.put('host', key);
    await this.ctx.storage.setAlarm(Date.now() + GRACE);
  }

  // the game lives in the host's browser, so the party ends when they have not come back
  async alarm() {
    if (this.host()) return;
    await this.ctx.storage.deleteAll();
    this.end(undefined, 'Disconnected from the party');
  }

  // sockets are told as well as closed, as a close alone can take a while to show up on their side
  end(tag, error) {
    this.open(tag).forEach(s => {
      s.send(JSON.stringify({ error }));
      s.close(1000);
    });
  }
}
