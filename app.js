/* =====================================================
   app.js — لعبة المافيا الذكية | Client Logic
   ===================================================== */

// ============================
//  Init & State
// ============================
const socket = io();

const state = {
  myId: null,
  myRole: null,
  myName: null,
  myCardId: null,
  phase: 'lobby',
  players: {},
  adminCode: '',
  adminUnlocked: false,
  nightTarget: null,
  doctorTarget: null,
  detectiveTarget: null,
  jokerTarget1: null,
  jokerTarget2: null,
  investigationResults: {},
  headerTapCount: 0,
  headerTapTimer: null,
  timerInterval: null,
  timerDuration: 0,
  timerRemaining: 0,
  hasVoted: false,
  avengerUsed: false
};

// ============================
//  Screens
// ============================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}

// ============================
//  NFC Card Detection
// ============================
const urlParams = new URLSearchParams(window.location.search);
const cardParam = urlParams.get('card');
if (cardParam) {
  state.myCardId = cardParam;
  // Remove card from URL
  window.history.replaceState({}, document.title, '/play');
}

// ============================
//  Anti-Cheat: Disable DevTools
// ============================
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I') || (e.ctrlKey && e.key === 'u') || (e.ctrlKey && e.key === 'U')) {
    e.preventDefault();
  }
});

// ============================
//  Admin: Header Tap Sequence
// ============================
document.getElementById('headerTitle').addEventListener('click', () => {
  state.headerTapCount++;
  clearTimeout(state.headerTapTimer);
  state.headerTapTimer = setTimeout(() => { state.headerTapCount = 0; }, 1500);
  if (state.headerTapCount >= 5) {
    state.headerTapCount = 0;
    openAdmin();
  }
});

function openAdmin() {
  document.getElementById('adminOverlay').classList.add('open');
  document.getElementById('adminCodeInput').value = '';
  document.getElementById('adminCodeInput').focus();
  document.getElementById('adminActions').classList.add('hidden');
  state.adminUnlocked = false;
}

function closeAdmin() {
  document.getElementById('adminOverlay').classList.remove('open');
}

document.getElementById('adminCodeInput').addEventListener('input', function() {
  const val = this.value;
  if (val.length === 6) {
    if (val === '901332') {
      state.adminUnlocked = true;
      document.getElementById('adminActions').classList.remove('hidden');
      document.getElementById('adminActions').style.display = 'flex';
      buildAdminKickList();
    } else {
      this.style.border = '1px solid var(--red)';
      setTimeout(() => { this.style.border = ''; }, 1000);
    }
  }
});

function buildAdminKickList() {
  const list = document.getElementById('adminKickList');
  list.innerHTML = '';
  for (const [id, p] of Object.entries(state.players)) {
    if (!p.ready) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = `🚫 طرد: ${p.name}`;
      btn.onclick = () => { socket.emit('admin_kick', { code: '901332', playerId: id }); closeAdmin(); };
      list.appendChild(btn);
    }
  }
}

function adminAction(action) {
  if (!state.adminUnlocked) return;
  if (action === 'start') {
    socket.emit('admin_start', { code: '901332' });
    closeAdmin();
  } else if (action === 'reset') {
    socket.emit('admin_reset', { code: '901332' });
    closeAdmin();
  } else if (action === 'vote') {
    socket.emit('admin_open_voting', { code: '901332' });
    closeAdmin();
  }
}

// ============================
//  Join Game
// ============================
function joinGame() {
  const name = document.getElementById('playerNameInput').value.trim();
  if (!name) { alert('أدخل اسمك أولاً'); return; }
  state.myName = name;
  socket.emit('join_game', { name, cardId: state.myCardId || null });
}

// ============================
//  Ready Up
// ============================
function setReady() {
  socket.emit('player_ready');
  document.getElementById('readyBtn').disabled = true;
  document.getElementById('readyBtn').textContent = '✅ جاهز!';
}

// ============================
//  Night: Target Selection Helpers
// ============================
function buildTargetList(containerId, targets, onSelect, selectedId = null) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  targets.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'target-btn' + (t.id === selectedId ? ' selected' : '');
    btn.innerHTML = `<div class="target-avatar">${t.name.charAt(0)}</div><span>${t.name}</span>`;
    btn.onclick = () => onSelect(t.id, t.name);
    container.appendChild(btn);
  });
}

function confirmNightVote() {
  if (!state.nightTarget) return;
  socket.emit('night_vote', { targetId: state.nightTarget });
  document.getElementById('mafiaConfirmBtn').textContent = '✓ تم الإرسال';
  document.getElementById('mafiaConfirmBtn').disabled = true;
}

function confirmDoctorSave() {
  if (!state.doctorTarget) return;
  socket.emit('doctor_save', { targetId: state.doctorTarget });
  document.getElementById('doctorConfirmBtn').textContent = '✓ تم الإرسال';
  document.getElementById('doctorConfirmBtn').disabled = true;
}

function confirmInvestigation() {
  if (!state.detectiveTarget) return;
  socket.emit('detective_investigate', { targetId: state.detectiveTarget });
  document.getElementById('detectiveConfirmBtn').textContent = '⏳ جارٍ التحقيق...';
  document.getElementById('detectiveConfirmBtn').disabled = true;
}

function confirmJokerSwap() {
  if (!state.jokerTarget1 || !state.jokerTarget2) return;
  socket.emit('joker_swap', { target1: state.jokerTarget1, target2: state.jokerTarget2 });
  document.getElementById('jokerConfirmBtn').textContent = '✓ تم التبديل';
  document.getElementById('jokerConfirmBtn').disabled = true;
}

function resetJokerSelection() {
  state.jokerTarget1 = null;
  state.jokerTarget2 = null;
  document.getElementById('jokerConfirmBtn').disabled = true;
}

// ============================
//  Day Voting
// ============================
function castVote(targetId) {
  if (state.hasVoted) return;
  socket.emit('day_vote', { targetId });
  state.hasVoted = true;
  document.querySelectorAll('#voteTargetList .target-btn').forEach(b => {
    b.disabled = true;
    b.style.opacity = '0.5';
  });
}

// ============================
//  Timer
// ============================
function startTimerUI(duration) {
  clearInterval(state.timerInterval);
  state.timerDuration = duration;
  state.timerRemaining = duration;

  const textEl = document.getElementById('timerText');
  const ringEl = document.getElementById('timerRing');
  const circumference = 314;

  function tick() {
    if (state.timerRemaining < 0) { clearInterval(state.timerInterval); return; }
    if (textEl) textEl.textContent = state.timerRemaining;
    if (ringEl) {
      const progress = state.timerRemaining / state.timerDuration;
      ringEl.style.strokeDashoffset = circumference * (1 - progress);
      if (state.timerRemaining <= 10) ringEl.style.stroke = '#ffd700';
      else ringEl.style.stroke = 'var(--red)';
    }
    state.timerRemaining--;
  }
  tick();
  state.timerInterval = setInterval(tick, 1000);
}

// ============================
//  Role Info Map
// ============================
const roleInfo = {
  mafia:     { icon: '🕵️‍♂️', name: 'المافيا',         cls: 'role-mafia',     desc: 'أنت من المافيا. استيقظ ليلاً مع فريقك وصوّت سراً على ضحيتك. ابقَ مخفياً وخدع المجلس نهاراً.' },
  doctor:    { icon: '🩺',   name: 'الطبيب',           cls: 'role-doctor',    desc: 'أنت الطبيب. اختر كل ليلة من ستحمي من الاغتيال. لا يمكنك حماية نفسك مرتين متتاليتين.' },
  detective: { icon: '🔍',   name: 'المحقق',           cls: 'role-detective', desc: 'أنت المحقق. كشف هوية لاعب واحد كل ليلة. تُحفظ نتائجك على شاشتك طوال اللعبة.' },
  citizen:   { icon: '👥',   name: 'مواطن بريء',       cls: 'role-citizen',   desc: 'أنت مواطن بريء. لا قوة ليلية. قوتك الحقيقية في النقاش والإقناع ليُعدَم الصحيح نهاراً.' },
  joker:     { icon: '🃏',   name: 'الجوكر',           cls: 'role-joker',     desc: 'أنت الجوكر! بدّل أدوار لاعبين في الليل. هدفك الوحيد أن تُعدَم بالتصويت النهاري!' },
  avenger:   { icon: '🔫',   name: 'المقتص',           cls: 'role-avenger',   desc: 'أنت المقتص. لديك رصاصة واحدة فقط! أصبت مافيا؟ ينجو. أخطأت ببريء؟ تموتان معاً.' }
};

function renderRole(role) {
  const info = roleInfo[role] || roleInfo.citizen;
  document.getElementById('roleIcon').textContent = info.icon;
  const nameEl = document.getElementById('roleName');
  nameEl.textContent = info.name;
  nameEl.className = 'role-name ' + info.cls;
  document.getElementById('roleDesc').textContent = info.desc;
}

function getRoleBadge(role) {
  const info = roleInfo[role] || roleInfo.citizen;
  return `<span class="player-badge badge-${role}">${info.icon} ${info.name}</span>`;
}

// ============================
//  Update Lobby
// ============================
function updateLobby(players) {
  const list = document.getElementById('lobbyPlayerList');
  list.innerHTML = '';
  let count = 0;
  for (const [id, p] of Object.entries(players)) {
    count++;
    const div = document.createElement('div');
    div.className = 'player-item' + (p.ready ? ' ready' : '');
    div.innerHTML = `
      <span class="player-name">${p.name} ${id === state.myId ? '<span class="chip">أنت</span>' : ''}</span>
      <span class="player-status">${p.ready ? '✅ جاهز' : '⏳ انتظار'}</span>
    `;
    list.appendChild(div);
  }
  document.getElementById('playerCountChip').textContent = count + ' لاعبين';
}

// ============================
//  Update Day Player List
// ============================
function updateDayList(players) {
  const list = document.getElementById('dayPlayerList');
  list.innerHTML = '';
  for (const [id, p] of Object.entries(players)) {
    const div = document.createElement('div');
    div.className = 'player-item' + (!p.alive ? ' dead' : '');
    div.innerHTML = `
      <span class="player-name">${p.name} ${id === state.myId ? '<small class="text-dim">(أنت)</small>' : ''}</span>
      <span class="player-status">${p.alive ? '🟢 حي' : '💀 ميت'}</span>
    `;
    list.appendChild(div);
  }
}

// ============================
//  Socket Events
// ============================
socket.on('connect', () => { console.log('✅ متصل بالسيرفر'); });

socket.on('joined', ({ playerId }) => {
  state.myId = playerId;
  showScreen('lobby');
});

socket.on('card_taken', () => {
  document.getElementById('cheatAlert').classList.add('show');
});

socket.on('game_state', ({ phase, players, nightCount }) => {
  state.phase = phase;
  state.players = players;

  if (phase === 'lobby') {
    updateLobby(players);
  }
  if (phase === 'day' || phase === 'vote' || phase === 'tiebreak') {
    updateDayList(players);
  }
});

socket.on('private_info', ({ role, mafiaTeam, investigatorResults }) => {
  state.myRole = role;
  renderRole(role);

  // Show mafia team
  if (role === 'mafia' && mafiaTeam && mafiaTeam.length > 0) {
    const card = document.getElementById('mafiaTeamCard');
    card.classList.remove('hidden');
    const list = document.getElementById('mafiaTeamList');
    list.innerHTML = mafiaTeam.map(n => `<div class="player-item"><span class="player-name">🕵️ ${n}</span></div>`).join('');
  }

  if (role === 'detective' && investigatorResults) {
    state.investigationResults = investigatorResults;
  }

  showScreen('role');
});

socket.on('game_started', () => {
  // Role screen already shown via private_info
});

socket.on('night_timer', ({ duration }) => {
  startTimerUI(duration);
});

socket.on('night_distraction', ({ buttons }) => {
  showScreen('night');
  document.getElementById('nightTitle').textContent = '🌙 ليلة الظلام';
  document.getElementById('nightSubtitle').textContent = 'أغلق عينيك وابقَ نشطاً...';
  document.getElementById('distractionSection').classList.remove('hidden');
  document.getElementById('mafiaSection').classList.add('hidden');
  document.getElementById('doctorSection').classList.add('hidden');
  document.getElementById('detectiveSection').classList.add('hidden');
  document.getElementById('jokerSection').classList.add('hidden');

  const grid = document.getElementById('distractionGrid');
  grid.innerHTML = '';
  buttons.forEach(label => {
    const btn = document.createElement('button');
    btn.className = 'btn-distract';
    const parts = label.split(' ');
    btn.innerHTML = `<span style="font-size:28px">${parts[0]}</span><span>${parts.slice(1).join(' ')}</span>`;
    let pressCount = 0;
    btn.addEventListener('touchstart', () => { btn.style.opacity = '0.7'; pressCount++; });
    btn.addEventListener('touchend', () => { btn.style.opacity = '1'; });
    grid.appendChild(btn);
  });
});

socket.on('night_action', ({ role, targets, canSelfHeal }) => {
  showScreen('night');
  document.getElementById('distractionSection').classList.add('hidden');

  if (role === 'mafia') {
    document.getElementById('mafiaSection').classList.remove('hidden');
    state.nightTarget = null;
    buildTargetList('mafiaTargetList', targets, (id) => {
      state.nightTarget = id;
      document.getElementById('mafiaConfirmBtn').disabled = false;
      buildTargetList('mafiaTargetList', targets, arguments.callee, id);
    });
  }

  if (role === 'doctor') {
    document.getElementById('doctorSection').classList.remove('hidden');
    const filteredTargets = canSelfHeal ? targets : targets.filter(t => t.id !== state.myId);
    state.doctorTarget = null;
    buildTargetList('doctorTargetList', filteredTargets, (id) => {
      state.doctorTarget = id;
      document.getElementById('doctorConfirmBtn').disabled = false;
      buildTargetList('doctorTargetList', filteredTargets, arguments.callee, id);
    });
  }

  if (role === 'detective') {
    document.getElementById('detectiveSection').classList.remove('hidden');
    state.detectiveTarget = null;
    buildTargetList('detectiveTargetList', targets, (id) => {
      state.detectiveTarget = id;
      document.getElementById('detectiveConfirmBtn').disabled = false;
      buildTargetList('detectiveTargetList', targets, arguments.callee, id);
    });
    renderInvestigationLog();
  }

  if (role === 'joker') {
    document.getElementById('jokerSection').classList.remove('hidden');
    state.jokerTarget1 = null;
    state.jokerTarget2 = null;
    const jokerSelect = (id) => {
      if (!state.jokerTarget1) {
        state.jokerTarget1 = id;
        // Re-render with first selected
        buildTargetList('jokerTargetList', targets, jokerSelect, id);
      } else if (!state.jokerTarget2 && id !== state.jokerTarget1) {
        state.jokerTarget2 = id;
        document.getElementById('jokerConfirmBtn').disabled = false;
      }
    };
    buildTargetList('jokerTargetList', targets, jokerSelect);
  }
});

socket.on('investigation_result', ({ targetId, name, role }) => {
  if (!state.investigationResults) state.investigationResults = {};
  state.investigationResults[targetId] = { name, role };
  renderInvestigationLog();
  document.getElementById('detectiveConfirmBtn').textContent = '✓ تم الكشف!';
});

function renderInvestigationLog() {
  const log = document.getElementById('investigationLog');
  const results = state.investigationResults || {};
  const entries = Object.entries(results);
  if (entries.length === 0) return;

  document.getElementById('detectivePrevResults').classList.remove('hidden');
  log.innerHTML = entries.map(([, r]) => {
    const info = roleInfo[r.role] || roleInfo.citizen;
    return `<div class="invest-item">
      <span class="font-bold">${r.name}</span>
      <span class="player-badge badge-${r.role}">${info.icon} ${info.name}</span>
    </div>`;
  }).join('');
}

socket.on('night_result', ({ killed, saved }) => {
  clearInterval(state.timerInterval);
  // Will transition to day screen via day_started
});

socket.on('day_started', ({ killed, alivePlayers }) => {
  state.hasVoted = false;
  showScreen('day');

  const announcement = document.getElementById('deathAnnouncement');
  if (killed) {
    announcement.style.display = 'block';
    document.getElementById('deathName').textContent = `💀 ${killed.name} قُتل الليلة`;
    const info = roleInfo[killed.role] || roleInfo.citizen;
    document.getElementById('deathRole').textContent = `كان دوره: ${info.icon} ${info.name}`;
  } else {
    announcement.style.display = 'block';
    document.getElementById('deathName').textContent = '🌙 لم يمت أحد الليلة!';
    document.getElementById('deathRole').textContent = 'الطبيب أنقذ أحدهم...';
  }

  updateDayList(state.players);

  // Show detective results for detective
  if (state.myRole === 'detective') {
    const card = document.getElementById('dayDetectiveCard');
    const log = document.getElementById('dayInvestLog');
    const results = state.investigationResults || {};
    const entries = Object.entries(results);
    if (entries.length > 0) {
      card.classList.remove('hidden');
      log.innerHTML = entries.map(([, r]) => {
        const info = roleInfo[r.role] || roleInfo.citizen;
        return `<div class="invest-item"><span class="font-bold">${r.name}</span><span class="player-badge badge-${r.role}">${info.icon} ${info.name}</span></div>`;
      }).join('');
    }
  }
});

socket.on('voting_opened', ({ candidates }) => {
  state.hasVoted = false;
  showScreen('vote');
  document.getElementById('voteTitle').textContent = '🗳️ وقت التصويت';

  const list = document.getElementById('voteTargetList');
  list.innerHTML = '';
  candidates.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.innerHTML = `<div class="target-avatar">${c.name.charAt(0)}</div><span>${c.name}</span>`;
    btn.onclick = () => castVote(c.id);
    list.appendChild(btn);
  });
  updateVoteProgress(0, candidates.length);
});

socket.on('tiebreak_started', ({ candidates }) => {
  state.hasVoted = false;
  showScreen('vote');
  document.getElementById('voteTitle').textContent = '⚡ جولة التعادل الحاسمة!';

  const list = document.getElementById('voteTargetList');
  list.innerHTML = '';
  candidates.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.innerHTML = `<div class="target-avatar" style="background:linear-gradient(135deg,var(--red-dark),#500)">${c.name.charAt(0)}</div><span>${c.name}</span>`;
    btn.onclick = () => castVote(c.id);
    list.appendChild(btn);
  });
});

socket.on('vote_timer', ({ duration, message }) => {
  const banner = document.getElementById('voteTimerBanner');
  banner.classList.remove('hidden');
  banner.textContent = message || '';

  // Update the night timer display for vote
  startTimerUI(duration);
});

socket.on('vote_update', ({ votes }) => {
  const total = Object.keys(state.players).filter(id => state.players[id].alive).length;
  const voted = Object.keys(votes).length;
  updateVoteProgress(voted, total);
  if (votes[state.myId]) {
    state.hasVoted = true;
  }
});

function updateVoteProgress(voted, total) {
  const pct = total > 0 ? (voted / total * 100) : 0;
  const bar = document.getElementById('voteBarFill');
  const label = document.getElementById('voteCountLabel');
  if (bar) bar.style.width = pct + '%';
  if (label) label.textContent = `${voted} من ${total} صوّتوا`;
}

socket.on('vote_result', ({ executed, message }) => {
  if (message) {
    // Show as banner in day screen
  }
  // Will show via day_started or game_ended
});

socket.on('avenger_result', ({ shooter, target, targetRole, success }) => {
  const info = roleInfo[targetRole] || roleInfo.citizen;
  const msg = success
    ? `🎯 ${shooter} أطلق الرصاصة على ${target} وكان مافياً!`
    : `💥 ${shooter} أطلق الرصاصة على ${target} لكنه بريء! ماتا معاً!`;
  alert(msg);
});

socket.on('game_ended', ({ winner, players }) => {
  clearInterval(state.timerInterval);
  showScreen('ended');

  const winData = {
    mafia:    { icon: '🕵️‍♂️', title: 'فازت المافيا!', cls: 'win-mafia',    desc: 'سيطرت المافيا على المجلس وأحكمت قبضتها في الظلام.' },
    citizens: { icon: '🏆',   title: 'فاز المواطنون!', cls: 'win-citizens', desc: 'كشف المواطنون الحق وأنهوا سيطرة المافيا.' },
    joker:    { icon: '🃏',   title: 'فاز الجوكر!',   cls: 'win-joker',    desc: 'خدع الجوكر الجميع وأُعدم بالتصويت! انتصر على الجميع!' }
  };

  const data = winData[winner] || winData.citizens;
  document.getElementById('winIcon').textContent = data.icon;
  const title = document.getElementById('winTitle');
  title.textContent = data.title;
  title.className = 'win-title ' + data.cls;
  document.getElementById('winDesc').textContent = data.desc;

  // Full reveal
  const list = document.getElementById('revealList');
  list.innerHTML = '';
  for (const [, p] of Object.entries(players)) {
    const info = roleInfo[p.role] || roleInfo.citizen;
    const div = document.createElement('div');
    div.className = 'player-item' + (!p.alive ? ' dead' : '');
    div.innerHTML = `
      <span class="player-name">${p.name} ${!p.alive ? '💀' : '🟢'}</span>
      <span class="player-badge badge-${p.role}">${info.icon} ${info.name}</span>
    `;
    list.appendChild(div);
  }
});

socket.on('game_reset', () => {
  state.myId = null;
  state.myRole = null;
  state.nightTarget = null;
  state.doctorTarget = null;
  state.detectiveTarget = null;
  state.jokerTarget1 = null;
  state.jokerTarget2 = null;
  state.investigationResults = {};
  state.hasVoted = false;
  state.players = {};
  clearInterval(state.timerInterval);
  showScreen('join');
});

socket.on('kicked', () => {
  alert('تم طردك من اللعبة من قبل المالك.');
  showScreen('join');
});

socket.on('error_msg', ({ message }) => {
  alert('⚠️ ' + message);
});
