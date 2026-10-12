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
    room = { code, players: [{ name: myName() }], settings: { mode: 'capture', stones: 4, layout: 'normal' }, game: null };
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
  }, 800);
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
  app.replaceChildren(...(!room ? home() : room.game ? game() : lobby()));
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
    s.onchange = () => { room.settings[key] = isNaN(s.value) ? s.value : +s.value; sync(); };
    return s;
  };

  const start = el('button', { disabled: room.players.length < 2 }, 'Start game');
  start.onclick = () => {
    room.game = newGame(room.players.length, room.settings.stones, room.settings.mode, room.settings.layout === 'random');
    sync();
  };

  return [
    el('h1', {}, 'Ultimate Mancala'),
    el('div', { className: 'code' }, room.code),
    el('div', { className: 'row' }, el('input', { readOnly: true, value: link, size: 30 }), copy),
    playerList(),
    el('div', { className: 'row' },
      el('label', {}, 'Mode ', select('mode', [['capture', 'Capture'], ['avalanche', 'Avalanche']])),
      el('label', {}, 'Stones per pit ', select('stones', [3, 4, 5, 6].map(n => [n, n]))),
      el('label', {}, 'Layout ', select('layout', [['normal', 'Normal'], ['random', 'Random']]))),
    isHost ? el('div', { className: 'row' },
      el('button', { disabled: room.players.length >= MAX_PLAYERS, onclick: addBot }, 'Add bot'),
      el('button', { disabled: !room.players.some(p => p.bot), onclick: removeBot }, 'Remove bot'),
      start) : el('p', {}, 'Waiting for the host to start…'),
  ];
}

function game() {
  const g = room.game;
  let status;
  if (g.over) {
    const best = Math.max(...room.players.map((_, i) => score(g, i)));
    const winners = room.players.filter((_, i) => score(g, i) === best).map(p => p.name);
    status = winners.length > 1 ? 'Tie: ' + winners.join(' & ') : winners[0] + ' wins!';
  } else {
    status = g.turn === me ? 'Your turn' : room.players[g.turn].name + "'s turn";
  }

  const board = el('div', { className: 'board n' + g.n });
  for (let p = 0; p < g.n; p++) {
    const side = el('div', { className: 'side' });
    side.style.setProperty('--rot', -((p - me + g.n) % g.n) * 360 / g.n + 'deg'); // my side at the bottom
    side.style.setProperty('--c', COLORS[p]);
    for (let s = 0; s < PITS; s++) {
      const i = p * ROW + s;
      const pit = el('button', {
        className: 'pit' + (g.last === i ? ' last' : ''),
        disabled: g.over || p !== me || g.turn !== me || !g.board[i],
      }, el('span', {}, g.board[i]));
      pit.onclick = () => {
        if (isHost) { move(me, s); sync(); } else conn.send({ move: s });
      };
      side.append(pit);
    }
    side.append(el('div', { className: 'store' }, el('span', {}, score(g, p))));
    board.append(side);
  }

  const again = el('button', {}, 'Back to lobby');
  again.onclick = backToLobby;

  return [
    playerList(g),
    el('h2', {}, status),
    board,
    g.over && isHost ? again : '',
  ];
}

render();
