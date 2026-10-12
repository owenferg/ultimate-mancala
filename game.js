// Pure game rules. The board is one flat ring: each player owns 6 pits followed by their store.
const PITS = 6, ROW = PITS + 1;

// `random` scatters each side's stones unevenly (at least one per pit). Every player
// gets the same layout, so it stays fair.
function newGame(n, stones, mode, random) {
  const layout = Array(PITS).fill(stones);
  if (random) {
    layout.fill(1);
    for (let k = 0; k < PITS * (stones - 1); k++) layout[Math.random() * PITS | 0]++;
  }
  const board = [];
  for (let p = 0; p < n; p++) board.push(...layout, 0);
  // steps = stone movements of the latest move, as [from, to, count], for the UI to replay
  return { id: Math.random(), n, mode, board, turn: 0, out: [], over: false, last: -1, moveNo: 0, steps: [] };
}

const score = (g, p) => g.board[p * ROW + PITS];

function nextTurn(g) {
  for (let k = 0; k < g.n; k++) {
    g.turn = (g.turn + 1) % g.n;
    if (!g.out.includes(g.turn)) return;
  }
}

// Medium bot: looks one move ahead and takes whatever banks the most stones,
// preferring moves that earn another turn. Ties are broken at random.
function botMove(g) {
  const me = g.turn;
  let best = [], bestValue = -Infinity;
  for (let s = 0; s < PITS; s++) {
    const c = structuredClone(g);
    if (!play(c, s)) continue;
    const value = score(c, me) - score(g, me) + (!c.over && c.turn === me ? 1 : 0);
    if (value > bestValue) { best = [s]; bestValue = value; }
    else if (value === bestValue) best.push(s);
  }
  return best[Math.random() * best.length | 0];
}

// Current player plays pit `slot` (0-5). Returns false if the move is illegal.
function play(g, slot) {
  const me = g.turn, len = g.n * ROW, b = g.board, store = me * ROW + PITS;
  const start = me * ROW + slot;
  if (g.over || !Number.isInteger(slot) || slot < 0 || slot >= PITS || !b[start]) return false;

  const steps = [];
  let i = start;
  for (;;) {
    const from = i;
    let hand = b[i];
    b[i] = 0;
    while (hand) {
      i = (i + 1) % len;
      if (i % ROW === PITS && i !== store) continue; // skip other players' stores
      b[i]++;
      hand--;
      steps.push([from, i, 1]);
    }
    // avalanche: landing on a non-empty pit picks it up and keeps going
    if (g.mode === 'avalanche' && i !== store && b[i] > 1) continue;
    break;
  }

  // capture: last stone in my own empty pit takes the mirrored pit of every opponent
  if (g.mode === 'capture' && i !== store && Math.floor(i / ROW) === me && b[i] === 1) {
    const mirror = PITS - 1 - (i % ROW);
    const targets = [];
    for (let p = 0; p < g.n; p++) if (p !== me && b[p * ROW + mirror]) targets.push(p * ROW + mirror);
    if (targets.length) {
      for (const t of [...targets, i]) { steps.push([t, store, b[t]]); b[store] += b[t]; b[t] = 0; }
    }
  }

  g.last = start;
  g.steps = steps;
  g.moveNo++;

  // game ends when any side is empty; everyone banks what is left on their own side
  const empty = p => b.slice(p * ROW, p * ROW + PITS).every(x => !x);
  if ([...Array(g.n).keys()].some(empty)) {
    for (let p = 0; p < g.n; p++)
      for (let s = 0; s < PITS; s++) {
        const t = p * ROW + s;
        if (b[t]) steps.push([t, p * ROW + PITS, b[t]]);
        b[p * ROW + PITS] += b[t];
        b[t] = 0;
      }
    g.over = true;
    return true;
  }

  if (i !== store) nextTurn(g); // ending in your own store = go again
  return true;
}
