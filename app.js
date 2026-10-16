// networking and ui
// the party creator's browser is the host and holds the game state
// everyone else reaches it over a WebSocket to worker.js, which relays messages for the party code
const MAX_PLAYERS = 10;
// one per seat, all mid-toned so they show on a light or a dark page and none passes for a pebble
const COLORS = ['#e4572e', '#2e86de', '#27ae60', '#9b59b6', '#e6a700', '#e84393', '#12b5cb', '#96633c', '#8fbf26', '#5b5fd6'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const GRACE = 10000; // how long a guest can be gone before it counts as leaving, so a refresh is not one
const LEAVE = 4000; // the close code that tells the relay this player left on purpose, matching worker.js

let ws = null, conns = [];
let room = null, me = 0, isHost = false, error = '';

const app = document.getElementById('app');
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const myName = () => (localStorage.name || '').trim().slice(0, 16) || 'Player';
// who this tab is to the relay, kept per tab so a refresh keeps its seat and a second tab is a second player
const myId = () => sessionStorage.id ||= crypto.randomUUID();

// the host's last used settings become the defaults for their next party
// anything missing or unrecognised falls back to the first choice
const SETTING_CHOICES = { mode: ['capture', 'avalanche'], layout: ['normal', 'random', 'crazy'] };
function savedSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.settings) || {}; } catch {}
  return Object.fromEntries(Object.entries(SETTING_CHOICES).map(([key, choices]) =>
    [key, choices.includes(saved[key]) ? saved[key] : choices[0]]));
}

// a plain socket back to this site, which the browser has no reason to ask permission for
// the pings keep an idle party from being closed as a dead connection
// the address becomes the party's, so a refresh comes back to it
function connect(code, query, onmessage, onclose) {
  history.replaceState(null, '', '/party/' + code);
  const s = ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws/' + code + query);
  const ping = setInterval(() => s.readyState === 1 && s.send('ping'), 30000);
  s.onmessage = e => e.data === 'pong' || onmessage(JSON.parse(e.data));
  s.onclose = e => { clearInterval(ping); if (ws === s) onclose(e); };
}
const send = d => ws.send(JSON.stringify(d));
// a page being refreshed or closed must not treat its socket closing as the party failing
addEventListener('pagehide', () => ws = null);

// host: owns the room and game state, and sends it to every guest after each change
// conns holds the id of the guest in each seat
// a guest whose socket closes keeps their seat for a moment, in case they are only refreshing
const leaving = {};
const away = id => leaving[id] = setTimeout(drop, GRACE, id);

// saved is the party this tab was hosting before a refresh, if it is coming back to one
function createParty(saved) {
  isHost = true;
  me = 0;
  const code = saved ? saved.room.code : Array.from({ length: 4 }, () => LETTERS[Math.random() * LETTERS.length | 0]).join('');
  connect(code, '?host=' + myId(), d => {
    if (d.ready) {
      ({ room, conns } = saved || { room: { code, players: [{ name: myName() }], settings: savedSettings(), game: null }, conns: [null] });
      conns.forEach(id => id && away(id)); // the relay says next which guests are still here
      return sync();
    }
    if (d.error) return fail(d.error);
    if (d.closed) return d.left ? drop(d.from) : away(d.from);
    if (d.open) {
      clearTimeout(leaving[d.from]);
      if (conns.includes(d.from)) return sync(); // back from a refresh, so the seat is still theirs
      if (room.game || room.players.length >= MAX_PLAYERS)
        return send({ to: d.from, data: { error: room.game ? 'That game has already started' : 'That party is full' } });
      conns.push(d.from);
      room.players.push({ name: 'Player' });
    } else {
      const seat = conns.indexOf(d.from);
      if (seat < 0 || !d.data) return;
      if (typeof d.data.name === 'string') room.players[seat].name = d.data.name.trim().slice(0, 16) || 'Player';
      if ('move' in d.data) move(seat, d.data.move);
    }
    sync();
  }, e => {
    if (e.code === 4009) createParty(); // code already in use, so roll another
    else fail(room ? 'Disconnected from the party' : 'Could not create party');
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
  sessionStorage.party = JSON.stringify({ room, conns }); // survives the host refreshing
  conns.forEach((id, i) => id && send({ to: id, data: { room, you: i } }));
  render();
  botTick();
}

// bots are seats with no connection, so the host plays their turns
let botTimer = null;
function botTick() {
  const isBotTurn = () => room && room.game && !room.game.over && room.players[room.game.turn].bot;
  if (botTimer || !isBotTurn()) return;
  botTimer = setTimeout(() => {
    botTimer = null;
    if (!isBotTurn()) return;
    move(room.game.turn, botMove(room.game));
    sync();
  }, animTime(room.game) + 700); // wait out the previous move's animation before the bot plays
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

// guest: sends its name and moves to the host, and draws whatever state comes back

function joinParty(code) {
  isHost = false;
  connect(code, '?id=' + myId(), d => {
    if (d.error) return fail(d.error);
    if (!room) send({ name: myName() }); // sent once the host answers, as it may be mid-refresh when the socket opens
    room = d.room;
    me = d.you;
    render();
  }, e => fail(e.reason || 'Disconnected from the party')); // the relay says why when it turns a guest away
}

// renaming myself in the lobby: nameDraft is what is in the name box, or null when it is closed
let nameDraft = null;
function rename() {
  if (nameDraft === null) return;
  localStorage.name = nameDraft;
  nameDraft = null;
  room.players[me].name = myName();
  if (isHost) return sync();
  send({ name: myName() });
  render();
}

function fail(msg, code) {
  if (!ws) return;
  ws.close(code);
  ws = room = nameDraft = null;
  Object.values(leaving).forEach(clearTimeout);
  document.querySelector('dialog')?.close(); // a question about a party that is gone has no answer
  delete sessionStorage.party;
  history.replaceState(null, '', '/');
  error = msg;
  render();
}

// a guest leaving gives up their seat, and the host leaving ends the party for everyone
const leave = () => fail('', LEAVE);

// a popup rather than confirm(), which would stop the host's game while it waits for an answer
function areYouSure(question, yes, onyes) {
  const d = el('dialog', {}, el('p', {}, question), el('form', { method: 'dialog', className: 'row' },
    el('button', { value: 'no' }, 'Cancel'), el('button', { value: 'yes' }, yes)));
  d.onclose = () => { d.remove(); if (d.returnValue === 'yes') onyes(); };
  document.body.append(d);
  d.showModal();
}

// views: home, lobby, and the shared player list

function render() {
  if (!room || !room.game) {
    view = null;
    // the lobby is redrawn whenever anyone joins or leaves, so carry the name box's focus and caret across
    const old = app.querySelector('.rename'), caret = old && old.selectionStart;
    if (old) old.onblur = null; // removing the box blurs it, and that is not the player finishing
    app.replaceChildren(...(room ? lobby() : home()));
    const box = app.querySelector('.rename');
    if (box) {
      box.focus();
      if (old) box.setSelectionRange(caret, caret); else box.select();
    }
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
  const code = el('input', { placeholder: 'CODE', maxLength: 4, size: 6 });
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
    const suffix = (i === me ? ' (you)' : '') + (g ? ': ' + score(g, i) : i === 0 ? ' (host)' : '');
    const li = el('li', { className: p.gone ? 'gone' : '' }, el('span', { className: 'dot' }));
    if (g || i !== me) {
      li.append((g && !g.over && g.turn === i ? '▶ ' : '') + p.name + suffix);
    } else if (nameDraft === null) {
      const edit = el('button', { className: 'edit', title: 'Edit name', innerHTML: PENCIL_ICON });
      edit.onclick = () => { nameDraft = p.name; render(); };
      li.append(p.name + suffix, edit);
    } else {
      const box = el('input', { className: 'rename', maxLength: 16, size: 12, value: nameDraft });
      box.oninput = () => nameDraft = box.value;
      box.onkeydown = e => {
        if (e.key === 'Enter') rename();
        if (e.key === 'Escape') { nameDraft = null; render(); }
      };
      box.onblur = rename;
      li.append(box, suffix);
    }
    li.style.setProperty('--c', COLORS[i]);
    return li;
  }));
}

function lobby() {
  const link = location.origin + '/party/' + room.code;
  const copy = el('button', {}, 'Copy link');
  copy.onclick = () => navigator.clipboard.writeText(link).then(() => copy.textContent = 'Copied');

  const select = (key, options) => {
    const s = el('select', { disabled: !isHost }, ...options.map(([value, label]) => el('option', { value }, label)));
    s.value = room.settings[key];
    s.onchange = () => {
      room.settings[key] = s.value;
      localStorage.settings = JSON.stringify(room.settings);
      sync();
    };
    return s;
  };

  const start = el('button', { disabled: room.players.length < 2 }, 'Start game');
  start.onclick = () => {
    room.game = newGame(room.players.length, room.settings.mode, room.settings.layout);
    sync();
  };

  return [
    el('h1', {}, 'Ultimate Mancala'),
    el('div', { className: 'code' }, room.code),
    el('div', { className: 'row' }, el('input', { readOnly: true, value: link, size: 30 }), copy),
    playerList(),
    el('div', { className: 'row' },
      el('label', {}, 'Mode ', select('mode', [['capture', 'Capture'], ['avalanche', 'Avalanche']])),
      el('label', {}, 'Layout ', select('layout', [['normal', 'Normal'], ['random', 'Random'], ['crazy', 'Random (Crazy)']]))),
    isHost ? el('div', { className: 'row' },
      el('button', { disabled: room.players.length >= MAX_PLAYERS, onclick: addBot }, 'Add bot'),
      el('button', { disabled: !room.players.some(p => p.bot), onclick: removeBot }, 'Remove bot'),
      start) : el('p', {}, 'Waiting for the host to start…'),
    el('div', { className: 'row' }, isHost
      ? el('button', { onclick: () => areYouSure('Disband the party for everyone?', 'Disband', leave) }, 'Disband party')
      : el('button', { onclick: () => areYouSure('Leave the party?', 'Leave', leave) }, 'Leave party')),
  ];
}

// game board
// built once per game and kept so stones can animate between pits
// view.shown is the state on screen, which lags room.game while moves replay
let view = null;
const STONE_COLORS = ['#d8d3c8', '#bdb7ab', '#a3a8ab', '#c7bba8']; // muted pebble tones
const stepDelay = n => Math.max(90, Math.min(300, 6000 / n));
const PLAYER_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0z"/></svg>';
const PENCIL_ICON = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>';
const AVALANCHE_PAUSE = 400;
const animTime = g => g.steps.reduce((t, step) => t + (step.length === 1 ? AVALANCHE_PAUSE : stepDelay(g.steps.length)), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the board for 4 or more players: its height, and [x, y, rot, size] for each row counted round from mine
// my row runs along the bottom and is the biggest, as its pits are the ones that get tapped
// the m others are equal chords of an arch over it, as big as will fit a board 30em wide and h tall
// each row is drawn outward from its chord, so no two can overlap however sharply the arch turns
const MINE = 1.15, ROW_LEN = PITS * 3.4 + 4; // a row's length in its own em
function arch(m, h) {
  const top = h - .9 - 3.2 * MINE, foot = top - .8; // top edge of my row, and where the arch stands just above it
  const bulge = u => Math.sign(u) * Math.abs(u) ** .65; // squarer than an ellipse, which leaves more edge to share out
  let z = .5, lift = 0, pts;
  // the arch is inset by the rows' depth, which depends on the size being solved for, so it takes a few goes to settle
  for (let pass = 0; pass < 12; pass++) {
    const a = 14.2 - 3.2 * z, b = foot - .8 - 3.2 * z + lift;
    const at = t => [15 + a * bulge(Math.cos(t)), foot - b * bulge(Math.sin(t))];
    // step round from the right foot in chords of length c, stopping at the left foot
    const walk = c => {
      const out = [at(0)];
      let t = 0;
      for (let k = 0; k < m; k++) {
        let lo = t, hi = Math.PI;
        for (let j = 0; j < 30; j++) {
          const mid = (lo + hi) / 2, q = at(mid);
          if (Math.hypot(q[0] - out[k][0], q[1] - out[k][1]) < c) lo = mid; else hi = mid;
        }
        out.push(at(t = hi));
      }
      return t < Math.PI && out;
    };
    // the longest chord that does not reach the left foot early is the one that lands on it
    let lo = 0, hi = 60;
    for (let j = 0; j < 40; j++) {
      const mid = (lo + hi) / 2, out = walk(mid);
      if (out) { lo = mid; pts = out; } else hi = mid;
    }
    z = lo / (ROW_LEN + .8);
    // a few long chords cut well under the crown of the arch, so it is stretched until the top row reaches the top of the board
    lift += Math.min(...pts.map(q => q[1])) - .8 - 3.2 * z;
  }
  // with few players the rows run out before the height does, and what is left over is cut off the top
  const cut = Math.min(...pts.map(q => q[1])) - .8 - 3.2 * z;
  return { h: h - cut, rows: [[15, top - cut, 0, MINE], ...pts.slice(1).map(([x, y], k) => {
    const [x0, y0] = pts[k];
    return [(x0 + x) / 2, (y0 + y) / 2 - cut, Math.atan2(y - y0, x - x0) * 180 / Math.PI, z];
  })] };
}

function buildView(g) {
  const header = el('div', { className: 'hud' }), footer = el('div');
  const layer = el('div', { className: 'stones' });
  const board = el('div', { className: 'board n' + g.n + (g.n > 3 ? ' arch' : '') }, layer);
  const pits = [], tags = [], sizes = [];
  header.append(playerList(g), el('h2', {}, '…')); // stands in for what refresh() puts there, so the board knows its room
  app.replaceChildren(header, board, footer);
  let rows, h;
  if (g.n > 3) {
    // the arch is made as tall as the screen has room for with the board at full width, as a taller one fits bigger rows
    // it is only worked out here, so a screen that changes afterwards scales the board rather than reshaping it
    const rest = board.offsetTop + 88; // what is above the board, and the rules link under it
    h = Math.max(24, Math.min(26 + 3 * g.n, (innerHeight - rest) / Math.min(22, app.clientWidth / 30)));
    ({ h, rows } = arch(g.n - 1, h));
    board.style.setProperty('--h', h);
    board.style.setProperty('--rest', rest + 'px');
  }
  const em = parseFloat(getComputedStyle(board).fontSize);
  for (let p = 0; p < g.n; p++) {
    const side = el('div', { className: 'side' });
    // with 3 players my side is at the bottom
    // with 2 the board stands upright, my side on the left running down to my store
    // with 4 or more it is at the bottom too, and arch() says where the rest go
    const k = (p - me + g.n) % g.n, [x, y, rot, size] = rows ? rows[k] : [0, 0, (g.n === 2 ? 90 : 0) - k * 360 / g.n, 1];
    side.style.setProperty('--rot', rot + 'deg');
    side.style.setProperty('--c', COLORS[p]);
    sizes.push(size);
    // pits too small to show both their stones and a badge on the rim show the count alone, in the middle
    side.classList.toggle('tiny', size * 3.2 * em < 22);
    if (rows) Object.assign(side.style, { left: x / 30 * 100 + '%', top: y / h * 100 + '%', fontSize: size + 'em' });
    const tag = el('div', { className: 'tag' }, el('span', { innerHTML: PLAYER_ICON }), el('span', { className: 'name' }, room.players[p].name));
    // an upright tag is wider than it is tall, so it sits further in from a row the more that row leans
    const lean = rot * Math.PI / 180;
    if (rows) tag.style.top = -.3 - 2.3 * Math.abs(Math.sin(lean)) - 1.3 * Math.abs(Math.cos(lean)) + 'em';
    tags.push(tag);
    side.append(tag);
    for (let s = 0; s < PITS; s++) {
      const pit = el('button', { className: 'pit' }, el('span', { className: 'count' }));
      pit.onclick = () => {
        pits.forEach(x => x.disabled = true);
        if (isHost) { move(me, s); sync(); } else send({ move: s });
      };
      pits.push(pit);
    }
    pits.push(el('div', { className: 'store' }, el('span', { className: 'count' })));
    side.append(...pits.slice(-ROW));
    board.append(side);
  }

  // pit centres are in em relative to the board, so stones stay put when the board scales
  const origin = board.getBoundingClientRect();
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

  view = { id: g.id, queued: g.moveNo, shown: structuredClone(g), chain: Promise.resolve(), header, footer, board, pits, tags, sizes, centres, stones };
  pits.forEach((_, i) => place(view, i));
}

// put a stone at distance r and angle a from the centre of pit i, shrunk or grown with that pit's row
// its outline is thickened to cancel the scaling, or it would vanish from the small rows
function put(v, i, stone, r, a) {
  const [cx, cy] = v.centres[i], z = v.sizes[i / ROW | 0];
  stone.style.transform = `translate(${cx + z * r * Math.cos(a)}em, ${cy + z * r * Math.sin(a)}em) scale(${z})`;
  stone.style.borderWidth = 1 / z + 'px';
}

// lay out a pit's stones in a spiral around its centre and update its count badge
function place(v, i) {
  const pile = v.stones[i];
  const spread = Math.min(.6, 1.05 / Math.sqrt(Math.max(pile.length - 1, 1)));
  pile.forEach((stone, k) => put(v, i, stone, spread * Math.sqrt(k), k * 2.4 + i));
  v.pits[i].firstChild.textContent = pile.length;
}

// replay one move stone by stone, then show the resulting state
async function animate(v, g) {
  if (view !== v) return;
  const dt = stepDelay(g.steps.length);
  v.board.style.setProperty('--t', dt * .85 + 'ms');
  // quick pulse on the pit that was played
  const played = v.pits[g.last];
  played.classList.remove('tap');
  void played.offsetWidth; // forces a reflow so the pulse restarts when the same pit is played twice
  played.classList.add('tap');
  let hand = []; // stones being carried around the board together
  for (const [from, to, count] of g.steps) {
    if (to === undefined) { // avalanche rests on the pile before picking it up
      await sleep(AVALANCHE_PAUSE);
      if (view !== v) return;
      continue;
    }
    if (count) {
      v.stones[to].push(...v.stones[from].splice(-count));
    } else {
      if (!hand.length) hand = v.stones[from].splice(0);
      v.stones[to].push(hand.pop()); // drop one here and carry the rest on
      hand.forEach((stone, k) => put(v, to, stone, .2 * Math.sqrt(k), k * 2.4));
    }
    place(v, from);
    place(v, to);
    await sleep(dt);
    if (view !== v) return;
  }
  if (v.stones.some((pile, i) => pile.length !== g.board[i])) buildView(room.game); // stones and state disagree, so redraw from the real board
  else v.shown = g.moveNo === v.queued ? structuredClone(room.game) : g;
  refresh();
}

// everything that is not a stone: scores, whose turn, which pits are clickable
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
  v.footer.replaceChildren(!isHost ? el('button', { onclick: () => areYouSure('Leave the game?', 'Leave', leave) }, 'Leave game')
    : g.over ? el('button', { onclick: backToLobby }, 'Back to lobby')
    : el('button', { onclick: () => areYouSure('Stop the game for everyone?', 'Stop', backToLobby) }, 'Stop game'));
}

// a party's address joins it straight away, or takes its host back to it after a refresh
// links used to carry the code after a # instead
const linked = (location.pathname.match(/^\/party\/(\w{4})$/) || location.hash.match(/^#(\w{4})$/))?.[1].toUpperCase();
let saved;
try { saved = JSON.parse(sessionStorage.party); } catch {}
if (linked) {
  connecting();
  if (saved?.room.code === linked) createParty(saved); else joinParty(linked);
} else render();
