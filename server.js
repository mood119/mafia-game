const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

// ============================
//  NFC Card Routes
// ============================
const cardRegistry = {}; // cardId -> { locked: bool, playerId: string|null }
for (let i = 1; i <= 10; i++) {
  cardRegistry[`card${i}`] = { locked: false, playerId: null };
}

app.get('/scan/:cardId', (req, res) => {
  const { cardId } = req.params;
  if (!cardRegistry[cardId]) return res.status(404).send('بطاقة غير معروفة');
  const card = cardRegistry[cardId];
  if (card.locked) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>body{background:#000;color:#f00;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:20px}
      .flash{animation:flash 0.3s infinite}.icon{font-size:60px}p{font-size:22px;text-align:center}
      @keyframes flash{0%,100%{opacity:1}50%{opacity:0}}</style></head>
      <body class="flash"><div class="icon">🚨</div>
      <p>تنبيه: تم رصد محاولة غش باستخدام البطاقة!</p>
      <p style="font-size:16px;color:#ff6666">هذه البطاقة مستخدمة بالفعل في هذه الجولة</p>
      </body></html>`);
  }
  res.redirect('/play?card=' + cardId);
});

// ============================
//  Game State
// ============================
let gameState = {
  phase: 'lobby',        // lobby | night | day | vote | tiebreak | ended
  players: {},           // socketId -> { name, role, alive, cardId, ready }
  nightTimer: null,
  dayVotes: {},          // socketId -> targetId
  nightVotes: {},        // mafiaId -> targetId
  doctorSaved: null,
  investigatorResults: {},
  lastDoctorSelf: false,
  jesterWon: false,
  nightCount: 0,
  jokerTarget1: null,
  jokerTarget2: null,
  distractionButtons: [
    '☕ صبّ شاي', '🧘 خفّض أنفاسك', '⚡ عبّئ الطاقة',
    '🌙 راقب القمر', '🔇 صمّت الصوت', '🎵 دندن لحناً'
  ],
  pendingCard: null,
  tiebreakCandidates: [],
  timerHandle: null,
  revealedDead: null
};

// ============================
//  Role Distribution Table
// ============================
function assignRoles(count) {
  let roles = [];
  const table = {
    4:  { mafia:1, doctor:1, detective:0, citizen:2 },
    5:  { mafia:1, doctor:1, detective:1, citizen:2 },
    6:  { mafia:2, doctor:1, detective:1, citizen:2 },
    7:  { mafia:2, doctor:1, detective:1, citizen:3 },
    8:  { mafia:2, doctor:1, detective:1, citizen:4 },
    9:  { mafia:2, doctor:1, detective:1, citizen:5 },
    10: { mafia:2, doctor:1, detective:1, citizen:5, extra:1 }
  };
  const dist = table[count] || table[10];
  for (let i = 0; i < dist.mafia; i++) roles.push('mafia');
  if (dist.doctor) roles.push('doctor');
  if (dist.detective) roles.push('detective');
  for (let i = 0; i < dist.citizen; i++) roles.push('citizen');
  if (dist.extra) {
    roles.push(Math.random() < 0.5 ? 'avenger' : 'joker');
  }
  // Shuffle
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

// ============================
//  Helpers
// ============================
function alivePlayers() {
  return Object.entries(gameState.players).filter(([, p]) => p.alive);
}
function aliveCount() { return alivePlayers().length; }
function mafiaAlive() { return alivePlayers().filter(([, p]) => p.role === 'mafia').length; }
function jokerAlive() { return alivePlayers().some(([, p]) => p.role === 'joker'); }
function nonMafiaAlive() { return alivePlayers().filter(([, p]) => p.role !== 'mafia').length; }

function broadcastState() {
  const publicPlayers = {};
  for (const [id, p] of Object.entries(gameState.players)) {
    publicPlayers[id] = { name: p.name, alive: p.alive, ready: p.ready, cardId: p.cardId };
  }
  io.emit('game_state', { phase: gameState.phase, players: publicPlayers, nightCount: gameState.nightCount });
}

function sendPrivateInfo() {
  for (const [sid, player] of Object.entries(gameState.players)) {
    const socket = io.sockets.sockets.get(sid);
    if (!socket) continue;
    let extra = {};
    if (player.role === 'mafia') {
      const teammates = Object.entries(gameState.players)
        .filter(([id, p]) => p.role === 'mafia' && id !== sid)
        .map(([, p]) => p.name);
      extra.mafiaTeam = teammates;
    }
    if (player.role === 'detective') {
      extra.investigatorResults = gameState.investigatorResults[sid] || {};
    }
    socket.emit('private_info', { role: player.role, ...extra });
  }
}

function checkEndCondition() {
  const mCount = mafiaAlive();
  const othCount = nonMafiaAlive();
  if (mCount === 0) return endGame('citizens');
  if (!jokerAlive() && mCount >= othCount) return endGame('mafia');
  return false;
}

function endGame(winner) {
  clearTimeout(gameState.timerHandle);
  gameState.phase = 'ended';
  gameState.winner = winner;
  const reveal = {};
  for (const [id, p] of Object.entries(gameState.players)) {
    reveal[id] = { name: p.name, role: p.role, alive: p.alive };
  }
  io.emit('game_ended', { winner, players: reveal });
  broadcastState();
  return true;
}

// ============================
//  Night Phase
// ============================
function startNight() {
  clearTimeout(gameState.timerHandle);
  gameState.phase = 'night';
  gameState.nightCount++;
  gameState.nightVotes = {};
  gameState.doctorSaved = null;
  gameState.jokerTarget1 = null;
  gameState.jokerTarget2 = null;

  const aliveList = alivePlayers().map(([id, p]) => ({ id, name: p.name, role: p.role }));

  for (const [sid, player] of Object.entries(gameState.players)) {
    if (!player.alive) continue;
    const socket = io.sockets.sockets.get(sid);
    if (!socket) continue;

    if (player.role === 'citizen') {
      socket.emit('night_distraction', {
        buttons: gameState.distractionButtons.sort(() => Math.random() - 0.5).slice(0, 3)
      });
    } else if (player.role === 'mafia') {
      const targets = aliveList.filter(p => p.role !== 'mafia');
      socket.emit('night_action', { role: 'mafia', targets });
    } else if (player.role === 'doctor') {
      const targets = aliveList;
      socket.emit('night_action', { role: 'doctor', targets, canSelfHeal: !gameState.lastDoctorSelf });
    } else if (player.role === 'detective') {
      const targets = aliveList.filter(p => p.id !== sid);
      socket.emit('night_action', { role: 'detective', targets });
    } else if (player.role === 'joker') {
      const targets = aliveList;
      socket.emit('night_action', { role: 'joker', targets });
    } else if (player.role === 'avenger') {
      socket.emit('night_distraction', {
        buttons: gameState.distractionButtons.sort(() => Math.random() - 0.5).slice(0, 3)
      });
    }
  }

  broadcastState();
  io.emit('night_timer', { duration: 35 });

  gameState.timerHandle = setTimeout(() => resolveNight(), 35000);
}

function resolveNight() {
  clearTimeout(gameState.timerHandle);

  // Mafia voting
  const votes = Object.values(gameState.nightVotes);
  let victim = null;
  if (votes.length > 0) {
    const tally = {};
    for (const v of votes) tally[v] = (tally[v] || 0) + 1;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    // If tied, pick randomly among tied
    const maxVotes = top[0][1];
    const tied = top.filter(([, c]) => c === maxVotes).map(([id]) => id);
    victim = tied[Math.floor(Math.random() * tied.length)];
  }

  // Doctor save
  if (victim && gameState.doctorSaved === victim) {
    victim = null; // saved
  }

  // Joker swap
  if (gameState.jokerTarget1 && gameState.jokerTarget2) {
    const p1 = gameState.players[gameState.jokerTarget1];
    const p2 = gameState.players[gameState.jokerTarget2];
    if (p1 && p2) {
      [p1.role, p2.role] = [p2.role, p1.role];
    }
  }

  let killed = null;
  if (victim && gameState.players[victim]) {
    gameState.players[victim].alive = false;
    killed = { id: victim, name: gameState.players[victim].name, role: gameState.players[victim].role };
  }

  io.emit('night_result', {
    killed,
    saved: victim === null && votes.length > 0
  });

  gameState.revealedDead = killed;

  if (!checkEndCondition()) {
    startDay(killed);
  }
}

// ============================
//  Day Phase
// ============================
function startDay(killed) {
  gameState.phase = 'day';
  gameState.dayVotes = {};
  broadcastState();

  const aliveList = alivePlayers().map(([id, p]) => ({ id, name: p.name }));
  io.emit('day_started', { killed, alivePlayers: aliveList });
}

function openVoting() {
  gameState.phase = 'vote';
  const aliveList = alivePlayers().map(([id, p]) => ({ id, name: p.name }));
  io.emit('voting_opened', { candidates: aliveList });
  broadcastState();
  checkVoteProgress();
}

function checkVoteProgress() {
  clearTimeout(gameState.timerHandle);
  const total = alivePlayers().length;
  const voted = Object.keys(gameState.dayVotes).length;
  const remaining = total - voted;

  if (remaining <= 0) {
    resolveVoting();
    return;
  }
  if (remaining === 1) {
    io.emit('vote_timer', { duration: 10, message: 'تبقى لاعب واحد لم يصوت!' });
    gameState.timerHandle = setTimeout(resolveVoting, 10000);
  } else if (remaining === 2) {
    io.emit('vote_timer', { duration: 30, message: 'تبقى لاعبان لم يصوتا' });
    gameState.timerHandle = setTimeout(resolveVoting, 30000);
  }
}

function resolveVoting() {
  clearTimeout(gameState.timerHandle);
  const tally = {};
  for (const [, target] of Object.entries(gameState.dayVotes)) {
    if (target === 'abstain') continue;
    tally[target] = (tally[target] || 0) + 1;
  }

  if (Object.keys(tally).length === 0) {
    io.emit('vote_result', { executed: null, message: 'لم يُنفَّذ أي إعدام اليوم' });
    if (!checkEndCondition()) startNight();
    return;
  }

  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const maxV = sorted[0][1];
  const tied = sorted.filter(([, c]) => c === maxV).map(([id]) => id);

  if (tied.length > 1) {
    // Tiebreak round
    gameState.tiebreakCandidates = tied;
    gameState.phase = 'tiebreak';
    gameState.dayVotes = {};
    io.emit('tiebreak_started', { candidates: tied.map(id => ({ id, name: gameState.players[id]?.name })) });
    broadcastState();
    io.emit('vote_timer', { duration: 40, message: 'جولة التصويت الحاسمة! 40 ثانية' });
    gameState.timerHandle = setTimeout(resolveTiebreak, 40000);
    return;
  }

  const executedId = sorted[0][0];
  executePlayer(executedId);
}

function resolveTiebreak() {
  clearTimeout(gameState.timerHandle);
  const tally = {};
  for (const [, target] of Object.entries(gameState.dayVotes)) {
    if (!gameState.tiebreakCandidates.includes(target)) continue;
    tally[target] = (tally[target] || 0) + 1;
  }
  if (Object.keys(tally).length === 0) {
    io.emit('vote_result', { executed: null, message: 'لم يُنفَّذ أي إعدام بعد التعادل' });
    if (!checkEndCondition()) startNight();
    return;
  }
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  executePlayer(sorted[0][0]);
}

function executePlayer(id) {
  const player = gameState.players[id];
  if (!player) return;
  player.alive = false;

  // Joker wins if executed by day vote
  if (player.role === 'joker') {
    return endGame('joker');
  }

  io.emit('vote_result', { executed: { id, name: player.name, role: player.role } });
  if (!checkEndCondition()) startNight();
}

// ============================
//  Socket.IO Events
// ============================
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Join lobby
  socket.on('join_game', ({ name, cardId }) => {
    if (gameState.phase !== 'lobby') {
      socket.emit('error_msg', { message: 'اللعبة بدأت بالفعل' });
      return;
    }
    if (cardRegistry[cardId] && cardRegistry[cardId].locked) {
      socket.emit('card_taken', { cardId });
      return;
    }
    // Lock card
    if (cardId && cardRegistry[cardId]) {
      cardRegistry[cardId].locked = true;
      cardRegistry[cardId].playerId = socket.id;
    }
    gameState.players[socket.id] = { name, role: null, alive: true, cardId, ready: false };
    socket.emit('joined', { playerId: socket.id });
    broadcastState();
  });

  // Ready up
  socket.on('player_ready', () => {
    if (gameState.players[socket.id]) {
      gameState.players[socket.id].ready = true;
      broadcastState();
    }
  });

  // ---- ADMIN ACTIONS ----
  socket.on('admin_start', ({ code }) => {
    if (code !== '901332') return socket.emit('error_msg', { message: 'رمز خاطئ' });
    const count = Object.keys(gameState.players).length;
    if (count < 4) return socket.emit('error_msg', { message: 'يلزم 4 لاعبين على الأقل' });

    const roles = assignRoles(count);
    const playerIds = Object.keys(gameState.players);
    playerIds.forEach((id, i) => {
      gameState.players[id].role = roles[i];
      gameState.players[id].alive = true;
    });

    sendPrivateInfo();
    io.emit('game_started', { message: 'بدأت اللعبة!' });
    startNight();
  });

  socket.on('admin_kick', ({ code, playerId }) => {
    if (code !== '901332') return;
    const kicked = io.sockets.sockets.get(playerId);
    if (kicked) kicked.emit('kicked');
    const p = gameState.players[playerId];
    if (p?.cardId && cardRegistry[p.cardId]) {
      cardRegistry[p.cardId].locked = false;
      cardRegistry[p.cardId].playerId = null;
    }
    delete gameState.players[playerId];
    broadcastState();
  });

  socket.on('admin_reset', ({ code }) => {
    if (code !== '901332') return;
    clearTimeout(gameState.timerHandle);
    gameState = {
      phase: 'lobby', players: {}, nightTimer: null, dayVotes: {}, nightVotes: {},
      doctorSaved: null, investigatorResults: {}, lastDoctorSelf: false, jesterWon: false,
      nightCount: 0, jokerTarget1: null, jokerTarget2: null,
      distractionButtons: ['☕ صبّ شاي','🧘 خفّض أنفاسك','⚡ عبّئ الطاقة','🌙 راقب القمر','🔇 صمّت الصوت','🎵 دندن لحناً'],
      pendingCard: null, tiebreakCandidates: [], timerHandle: null, revealedDead: null
    };
    for (let i = 1; i <= 10; i++) {
      cardRegistry[`card${i}`] = { locked: false, playerId: null };
    }
    io.emit('game_reset');
    broadcastState();
  });

  socket.on('admin_open_voting', ({ code }) => {
    if (code !== '901332') return;
    openVoting();
  });

  // ---- NIGHT ACTIONS ----
  socket.on('night_vote', ({ targetId }) => {
    const player = gameState.players[socket.id];
    if (!player || player.role !== 'mafia' || gameState.phase !== 'night') return;
    gameState.nightVotes[socket.id] = targetId;
  });

  socket.on('doctor_save', ({ targetId }) => {
    const player = gameState.players[socket.id];
    if (!player || player.role !== 'doctor' || gameState.phase !== 'night') return;
    if (targetId === socket.id && gameState.lastDoctorSelf) return; // blocked
    gameState.lastDoctorSelf = (targetId === socket.id);
    gameState.doctorSaved = targetId;
  });

  socket.on('detective_investigate', ({ targetId }) => {
    const player = gameState.players[socket.id];
    if (!player || player.role !== 'detective' || gameState.phase !== 'night') return;
    const target = gameState.players[targetId];
    if (!target) return;
    if (!gameState.investigatorResults[socket.id]) gameState.investigatorResults[socket.id] = {};
    gameState.investigatorResults[socket.id][targetId] = { name: target.name, role: target.role };
    socket.emit('investigation_result', { targetId, name: target.name, role: target.role });
  });

  socket.on('joker_swap', ({ target1, target2 }) => {
    const player = gameState.players[socket.id];
    if (!player || player.role !== 'joker' || gameState.phase !== 'night') return;
    gameState.jokerTarget1 = target1;
    gameState.jokerTarget2 = target2;
  });

  socket.on('avenger_shoot', ({ targetId }) => {
    const player = gameState.players[socket.id];
    if (!player || player.role !== 'avenger') return;
    const target = gameState.players[targetId];
    if (!target || !target.alive) return;

    if (target.role === 'mafia') {
      target.alive = false;
      io.emit('avenger_result', { shooter: player.name, target: target.name, targetRole: 'mafia', success: true });
    } else {
      player.alive = false;
      target.alive = false;
      io.emit('avenger_result', { shooter: player.name, target: target.name, targetRole: target.role, success: false });
    }
    if (!checkEndCondition()) broadcastState();
  });

  // ---- DAY ACTIONS ----
  socket.on('day_vote', ({ targetId }) => {
    const player = gameState.players[socket.id];
    if (!player || !player.alive) return;
    if (gameState.phase !== 'vote' && gameState.phase !== 'tiebreak') return;
    if (gameState.phase === 'tiebreak' && !gameState.tiebreakCandidates.includes(targetId)) return;
    gameState.dayVotes[socket.id] = targetId;
    io.emit('vote_update', { votes: gameState.dayVotes });
    checkVoteProgress();
  });

  socket.on('open_day_vote', () => {
    if (gameState.phase === 'day') openVoting();
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const p = gameState.players[socket.id];
    if (p?.cardId && cardRegistry[p.cardId]) {
      cardRegistry[p.cardId].locked = false;
    }
    if (gameState.phase === 'lobby') {
      delete gameState.players[socket.id];
      broadcastState();
    }
  });

  // Send current state on connect
  socket.emit('connected');
  broadcastState();
});

// ============================
//  Start
// ============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎭 لعبة المافيا تعمل على المنفذ ${PORT}`));
