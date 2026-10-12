// Networking + UI. No backend: the party creator's browser is the host and holds the
// game state; everyone else connects to it over WebRTC (PeerJS) using the party code.
const PREFIX = 'ultimate-mancala-';
const MAX_PLAYERS = 3;
const COLORS = ['#e4572e', '#2e86de', '#27ae60'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

let peer = null, conn = null, conns = [];
let room = null, me = 0, isHost = false, error = '';

const app = document.getElementById('app');
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const myName = () => (localStorage.name || '').trim().slice(0, 16) || 'Player';

// ---------- host ----------

function createParty() {
  isHost = true;
  me = 0;
  const code = Array.from({ length: 4 }, () => LETTERS[Math.random() * LETTERS.length | 0]).join('');
  peer = new Peer(PREFIX + code);
  peer.on('open', () => {
    room = { code, players: [{ name: myName() }], settings: { mode: 'capture', layout: 'normal' }, game: null };
    conns = [null];
    sync();
  });
  peer.on('connection', c => {
    c.on('open', () => {
      if (room.game || room.players.length >= MAX_PLAYERS) {
        c.send({ error: room.game ? 'That game has already started' : 'That party is full' });
        return;
      }
      conns.push(c);
      room.players.push({ name: 'Player' });
      sync();
    });
    c.on('data', d => {
      const seat = conns.indexOf(c);
      if (seat < 0 || !d) return;
      if (typeof d.name === 'string') room.players[seat].name = d.name.trim().slice(0, 16) || 'Player';
      if ('move' in d) move(seat, d.move);
      sync();
    });
    c.on('close', () => drop(c));
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { peer.destroy(); createParty(); } // code taken, roll again
    else if (!room) fail('Could not create party (' + e.type + ')');
  });
}

function drop(c) {
  const seat = conns.indexOf(c);
  if (seat < 0) return;
  const g = room.game;
  if (g) {
    conns[seat] = null;
    room.players[seat].gone = true;
    g.out.push(seat);
    if (!g.over && g.turn === seat) nextTurn(g);
  } else {
    conns.splice(seat, 1);
    room.players.splice(seat, 1);
  }
  sync();
}

function move(seat, slot) {
  const g = room.game;
  if (g && g.turn === seat) play(g, slot);
}

function sync() {
  conns.forEach((c, i) => c && c.send({ room, you: i }));
  render();
  botTick();
}

// Bots are seats with no connection; the host plays their turns after a short pause.
let botTimer = null;
function botTick() {
  const isBotTurn = () => room && room.game && !room.game.over && room.players[room.game.turn].bot;
  if (botTimer || !isBotTurn()) return;
  botTimer = setTimeout(() => {
    botTimer = null;
    if (!isBotTurn()) return;
    move(room.game.turn, botMove(room.game));
    sync();
  }, animTime(room.game) + 700); // let the previous move finish animating first
}

function addBot() {
  if (room.players.length >= MAX_PLAYERS) return;
  conns.push(null);
  room.players.push({ name: 'Bot ' + (room.players.filter(p => p.bot).length + 1), bot: true });
  sync();
}

function removeBot() {
  const i = room.players.findLastIndex(p => p.bot);
  if (i < 0) return;
  conns.splice(i, 1);
  room.players.splice(i, 1);
  sync();
}

function backToLobby() {
  for (let i = room.players.length - 1; i > 0; i--)
    if (room.players[i].gone) { room.players.splice(i, 1); conns.splice(i, 1); }
  room.game = null;
  sync();
}

// ---------- guest ----------

function joinParty(code) {
  isHost = false;
  peer = new Peer();
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => conn.send({ name: myName() }));
    conn.on('data', d => {
      if (d.error) return fail(d.error);
      room = d.room;
      me = d.you;
      render();
    });
    conn.on('close', () => fail('Disconnected from the party'));
  });
  peer.on('error', e => fail(e.type === 'peer-unavailable' ? 'No party with that code' : 'Connection error (' + e.type + ')'));
}

function fail(msg) {
  if (!peer) return;
  peer.destroy();
  peer = conn = room = null;
  error = msg;
  render();
}

// ---------- views ----------

function render() {
  if (!room || !room.game) {
    view = null;
    app.replaceChildren(...(room ? lobby() : home()));
    return;
  }
  const g = room.game;
  if (!view || view.id !== g.id || g.moveNo < view.queued || g.moveNo > view.queued + 1) {
    buildView(g);
  } else if (g.moveNo === view.queued + 1) {
    const v = view, snap = structuredClone(g);
    v.queued = g.moveNo;
    v.chain = v.chain.then(() => animate(v, snap));
  } else if (view.shown.moveNo === g.moveNo) {
    view.shown = structuredClone(g);
  }
  refresh();
}

function connecting() {
  error = '';
  app.replaceChildren(el('p', {}, 'Connecting…'));
}

function home() {
  const name = el('input', { placeholder: 'Your name', maxLength: 16, value: localStorage.name || '' });
  name.oninput = () => localStorage.name = name.value;
  const code = el('input', { placeholder: 'CODE', maxLength: 4, size: 6, value: location.hash.slice(1).toUpperCase() });
  const join = el('form', { className: 'row' }, code, el('button', {}, 'Join party'));
  join.onsubmit = e => {
    e.preventDefault();
    const c = code.value.trim().toUpperCase();
    if (c.length !== 4) return;
    connecting();
    joinParty(c);
  };
  const create = el('button', {}, 'Create party');
  create.onclick = () => { connecting(); createParty(); };
  return [
    el('h1', {}, 'Ultimate Mancala'),
    el('div', { className: 'row' }, name),
    el('div', { className: 'row' }, create),
    join,
    el('p', { className: 'error' }, error),
  ];
}

function playerList(g) {
  return el('ul', { className: 'players' }, ...room.players.map((p, i) => {
    const li = el('li', { className: p.gone ? 'gone' : '' }, el('span', { className: 'dot' }),
      (g && !g.over && g.turn === i ? '▶ ' : '') + p.name + (i === me ? ' (you)' : '') + (g ? ': ' + score(g, i) : i === 0 ? ' (host)' : ''));
    li.style.setProperty('--c', COLORS[i]);
    return li;
  }));
}

function lobby() {
  const link = location.origin + location.pathname + '#' + room.code;
  const copy = el('button', {}, 'Copy link');
  copy.onclick = () => navigator.clipboard.writeText(link).then(() => copy.textContent = 'Copied');

  const select = (key, options) => {
    const s = el('select', { disabled: !isHost }, ...options.map(([value, label]) => el('option', { value }, label)));
    s.value = room.settings[key];
    s.onchange = () => { room.settings[key] = s.value; sync(); };
    return s;
  };

  const start = el('button', { disabled: room.players.length < 2 }, 'Start game');
  start.onclick = () => {
    room.game = newGame(room.players.length, room.settings.mode, room.settings.layout === 'random');
    sync();
  };

  return [
    el('h1', {}, 'Ultimate Mancala'),
    el('div', { className: 'code' }, room.code),
    el('div', { className: 'row' }, el('input', { readOnly: true, value: link, size: 30 }), copy),
    playerList(),
    el('div', { className: 'row' },
      el('label', {}, 'Mode ', select('mode', [['capture', 'Capture'], ['avalanche', 'Avalanche']])),
      el('label', {}, 'Layout ', select('layout', [['normal', 'Normal'], ['random', 'Random']]))),
    isHost ? el('div', { className: 'row' },
      el('button', { disabled: room.players.length >= MAX_PLAYERS, onclick: addBot }, 'Add bot'),
      el('button', { disabled: !room.players.some(p => p.bot), onclick: removeBot }, 'Remove bot'),
      start) : el('p', {}, 'Waiting for the host to start…'),
  ];
}

// ---------- game board ----------

// The board is built once per game and kept, so stones can animate between pits.
// view.shown is the state currently on screen; it lags room.game while moves replay.
let view = null;
const STONE_COLORS = ['#d8d3c8', '#bdb7ab', '#a3a8ab', '#c7bba8']; // muted pebble tones
const stepDelay = n => Math.max(90, Math.min(300, 6000 / n));
const PLAYER_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0z"/></svg>';
const AVALANCHE_PAUSE = 400;
const animTime = g => g.steps.reduce((t, step) => t + (step.length === 1 ? AVALANCHE_PAUSE : stepDelay(g.steps.length)), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildView(g) {
  const header = el('div'), footer = el('div');
  const layer = el('div', { className: 'stones' });
  const board = el('div', { className: 'board n' + g.n }, layer);
  const pits = [], tags = [];
  for (let p = 0; p < g.n; p++) {
    const side = el('div', { className: 'side' });
    // 3 players: my side at the bottom. 2 players: board stands upright, my side on the left
    // running down to my store.
    const rot = (g.n === 2 ? 90 : 0) - ((p - me + g.n) % g.n) * 360 / g.n, rad = rot * Math.PI / 180;
    side.style.setProperty('--rot', rot + 'deg');
    side.style.setProperty('--c', COLORS[p]);
    // name tag just outside the side, upright, growing away from the board
    const tag = el('div', { className: 'tag' }, el('span', { innerHTML: PLAYER_ICON }), el('span', { className: 'name' }, room.players[p].name));
    tag.style.setProperty('--tx', (-Math.sin(rad) - 1) * 50 + '%');
    tag.style.setProperty('--ty', (Math.cos(rad) - 1) * 50 + '%');
    tags.push(tag);
    side.append(tag);
    for (let s = 0; s < PITS; s++) {
      const pit = el('button', { className: 'pit' }, el('span', { className: 'count' }));
      pit.onclick = () => {
        pits.forEach(x => x.disabled = true);
        if (isHost) { move(me, s); sync(); } else conn.send({ move: s });
      };
      pits.push(pit);
    }
    pits.push(el('div', { className: 'store' }, el('span', { className: 'count' })));
    side.append(...pits.slice(-ROW));
    board.append(side);
  }
  app.replaceChildren(header, board, footer);

  // pit centres in em, relative to the board, so stones stay put when the board scales
  const em = parseFloat(getComputedStyle(board).fontSize), origin = board.getBoundingClientRect();
  const centres = pits.map(pit => {
    const r = pit.getBoundingClientRect();
    return [(r.left + r.width / 2 - origin.left) / em, (r.top + r.height / 2 - origin.top) / em];
  });
  const stones = g.board.map(count => Array.from({ length: count }, () => {
    const stone = el('div', { className: 'stone' });
    stone.style.background = STONE_COLORS[Math.random() * STONE_COLORS.length | 0];
    layer.append(stone);
    return stone;
  }));

  view = { id: g.id, queued: g.moveNo, shown: structuredClone(g), chain: Promise.resolve(), header, footer, board, pits, tags, centres, stones };
  pits.forEach((_, i) => place(view, i));
}

// Lay out a pit's stones in a spiral around its centre and update its count label.
function place(v, i) {
  const pile = v.stones[i], [cx, cy] = v.centres[i];
  const spread = Math.min(.45, 1.05 / Math.sqrt(Math.max(pile.length - 1, 1)));
  pile.forEach((stone, k) => {
    const r = spread * Math.sqrt(k), a = k * 2.4 + i;
    stone.style.transform = `translate(${cx + r * Math.cos(a)}em, ${cy + r * Math.sin(a)}em)`;
  });
  v.pits[i].firstChild.textContent = pile.length;
}

// Replay one move stone by stone, then show the resulting state.
async function animate(v, g) {
  if (view !== v) return;
  const dt = stepDelay(g.steps.length);
  v.board.style.setProperty('--t', dt * .85 + 'ms');
  // quick pulse on the pit that was played
  const played = v.pits[g.last];
  played.classList.remove('tap');
  void played.offsetWidth; // restart the animation if it is the same pit again
  played.classList.add('tap');
  let hand = []; // stones being carried around the board together
  for (const [from, to, count] of g.steps) {
    if (to === undefined) { // avalanche: rest on the pile before picking it up
      await sleep(AVALANCHE_PAUSE);
      if (view !== v) return;
      continue;
    }
    if (count) {
      v.stones[to].push(...v.stones[from].splice(-count));
    } else {
      if (!hand.length) hand = v.stones[from].splice(0);
      v.stones[to].push(hand.pop()); // drop one here, carry the rest on
      const [cx, cy] = v.centres[to];
      hand.forEach((stone, k) => {
        const r = .2 * Math.sqrt(k), a = k * 2.4;
        stone.style.transform = `translate(${cx + r * Math.cos(a)}em, ${cy + r * Math.sin(a)}em)`;
      });
    }
    place(v, from);
    place(v, to);
    await sleep(dt);
    if (view !== v) return;
  }
  if (v.stones.some((pile, i) => pile.length !== g.board[i])) buildView(room.game); // out of step: redraw
  else v.shown = g.moveNo === v.queued ? structuredClone(room.game) : g;
  refresh();
}

// Everything that is not a stone: scores, whose turn, which pits are clickable.
function refresh() {
  const v = view, g = v.shown, busy = v.queued !== g.moveNo;
  let status;
  if (g.over) {
    const best = Math.max(...room.players.map((_, i) => score(g, i)));
    const winners = room.players.filter((_, i) => score(g, i) === best).map(p => p.name);
    status = winners.length > 1 ? 'Tie: ' + winners.join(' & ') : winners[0] + ' wins!';
  } else {
    status = g.turn === me ? 'Your turn' : room.players[g.turn].name + "'s turn";
  }
  v.header.replaceChildren(playerList(g), el('h2', {}, status));
  v.pits.forEach((pit, i) => {
    if (i % ROW < PITS) pit.disabled = busy || g.over || g.turn !== me || Math.floor(i / ROW) !== me || !g.board[i];
  });
  v.tags.forEach((tag, p) => {
    tag.className = 'tag' + (!g.over && g.turn === p ? ' turn' : '') + (room.players[p].gone ? ' gone' : '');
  });
  v.footer.replaceChildren(g.over && isHost ? el('button', { onclick: backToLobby }, 'Back to lobby') : '');
}

render();
