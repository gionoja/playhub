/* Vynqo Tic-Tac-Toe. Presence, invitations and matches use Vynqo's existing APIs/socket. */
(() => {
  const state = {match:null, matchPoll:null, invitePoll:null, socketBound:false, busy:false, refreshing:false, terminalShownMatchId:null, lastBoardSignature:null};
  const $ = id => document.getElementById(id);
  const token = () => localStorage.getItem(TOKEN_KEY);
  const api = async (path, options={}) => {
    const response = await fetch(API_URL + path, {
      ...options,
      headers: {'Content-Type':'application/json', 'Authorization':'Bearer '+token(), ...(options.headers||{})}
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Tic-Tac-Toe request failed');
    return data;
  };

  window.openTicTacToe = async () => {
    $('ticTacToePanel').classList.remove('hidden');
    $('ticTacToePanel').scrollIntoView({behavior:'smooth', block:'start'});
    await connectGameSocket();
    await Promise.all([loadFriends(), loadInvites()]);
    startInvitePolling();
  };

  window.closeTicTacToe = () => {
    stopMatchPolling();
    if (state.invitePoll) clearInterval(state.invitePoll);
    state.invitePoll = null;
    $('ticTacToePanel').classList.add('hidden');
  };

  async function connectGameSocket() {
    // Reuse the exact authenticated Socket.IO connection already used by Vynqo calling.
    if (typeof connectVynqoCalling === 'function') {
      try { await connectVynqoCalling(); } catch (error) { /* API polling remains as fallback. */ }
    }
    const socket = typeof VYNQO_CALL !== 'undefined' ? VYNQO_CALL.socket : null;
    if (!socket || state.socketBound) return;
    state.socketBound = true;
    socket.on('tictactoe_invite', event => {
      notifyChat(`🎮 ${event.from_name} challenged you to Tic-Tac-Toe. You have 10 seconds to accept.`);
      loadInvites();
    });
    socket.on('tictactoe_invite_accepted', event => {
      notifyChat('Your Tic-Tac-Toe challenge was accepted. The match is ready!');
      loadInvites();
      openAcceptedMatch(event.match_id);
    });
    socket.on('tictactoe_invite_declined', () => {
      notifyChat('Your Tic-Tac-Toe challenge was declined.');
      loadInvites();
    });
    socket.on('tictactoe_invite_expired', () => {
      notifyChat('A Tic-Tac-Toe challenge expired because it was not accepted in time.');
      loadInvites();
    });
    socket.on('tictactoe_match_updated', event => {
      if (state.match && Number(event.match_id) === Number(state.match.id)) refreshMatch();
    });
  }

  function notifyChat(message) {
    // Use Vynqo's global toast/notification surface so game invites feel native to chat.
    if (typeof showToast === 'function') showToast(message);
    else {
      let toast = document.getElementById('tttChatNotice');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'tttChatNotice';
        toast.className = 'ttt-chat-notice';
        toast.setAttribute('role', 'status');
        document.body.append(toast);
      }
      toast.textContent = message;
      toast.classList.add('is-visible');
      clearTimeout(toast._hideTimer);
      toast._hideTimer = setTimeout(() => toast.classList.remove('is-visible'), 5000);
    }
  }

  async function loadFriends() {
    const box = $('tttFriends');
    box.textContent = 'Loading friends…';
    try {
      const friends = await api('/tictactoe/friends');
      box.replaceChildren();
      if (!friends.length) { box.textContent = 'Add friends on Vynqo before challenging them.'; return; }
      const online = friends.filter(friend => friend.online);
      const offline = friends.filter(friend => !friend.online);
      if (online.length) addFriendGroup(box, 'Online now', online);
      if (offline.length) addFriendGroup(box, 'Offline', offline);
    } catch (error) { box.textContent = error.message; }
  }

  function addFriendGroup(box, title, friends) {
    const heading = document.createElement('h4');
    heading.className = 'ttt-friend-group-title';
    heading.textContent = `${title} · ${friends.length}`;
    box.append(heading);
    friends.forEach(friend => {
      const row = document.createElement('div');
      row.className = 'ttt-friend';
      const identity = document.createElement('div');
      identity.className = 'ttt-friend-identity';
      if (friend.avatar_url) {
        const avatar = document.createElement('img');
        avatar.src = friend.avatar_url; avatar.alt = ''; avatar.className = 'ttt-friend-avatar';
        identity.append(avatar);
      }
      const text = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = friend.name;
      const status = document.createElement('small');
      status.className = friend.online ? 'ttt-presence online' : 'ttt-presence offline';
      status.textContent = friend.online ? '● Online' : '○ Offline';
      text.append(name, status); identity.append(text);
      const button = document.createElement('button');
      button.className = friend.online ? 'primary-btn' : 'secondary-btn';
      button.textContent = 'Challenge';
      button.type = 'button';
      button.onclick = async () => {
        button.disabled = true;
        try {
          const result = await api('/tictactoe/invites', {method:'POST', body:JSON.stringify({user_id:friend.id})});
          button.textContent = 'Waiting · 10s';
          notifyChat(`Tic-Tac-Toe challenge sent to ${friend.name}. Waiting 10 seconds for a response.`);
          startInvitePolling();
          let remaining = result.expires_in || 10;
          const timer = setInterval(() => {
            remaining -= 1;
            if (!document.body.contains(button) || remaining <= 0) {
              clearInterval(timer); button.textContent = 'No response'; button.disabled = false;
              loadInvites(); return;
            }
            button.textContent = `Waiting · ${remaining}s`;
          }, 1000);
        } catch (error) { button.disabled = false; notifyChat(error.message); }
      };
      row.append(identity, button); box.append(row);
    });
  }

  async function loadInvites() {
    try {
      const invites = await api('/tictactoe/invites');
      const box = $('tttInvites'); box.replaceChildren();
      invites.forEach(invite => {
        if (invite.direction === 'incoming' && invite.status === 'pending') {
          const row = document.createElement('div'); row.className = 'ttt-invite';
          const label = document.createElement('span');
          label.textContent = `${invite.sender} challenged you · ${invite.remaining_seconds}s left`;
          const accept = document.createElement('button'); accept.className = 'primary-btn'; accept.textContent = 'Accept';
          accept.onclick = async () => {
            accept.disabled = true;
            try { startMatch(await api(`/tictactoe/matches/${invite.id}/accept`, {method:'POST', body:'{}'})); }
            catch (error) { notifyChat(error.message); loadInvites(); }
          };
          const decline = document.createElement('button'); decline.className = 'secondary-btn'; decline.textContent = 'Decline';
          decline.onclick = async () => {
            try { await api(`/tictactoe/matches/${invite.id}/decline`, {method:'POST', body:'{}'}); row.remove(); notifyChat('Tic-Tac-Toe challenge declined.'); }
            catch (error) { notifyChat(error.message); }
          };
          row.append(label, accept, decline); box.append(row);
        } else if (invite.direction === 'outgoing' && invite.status === 'pending') {
          const note = document.createElement('p'); note.className = 'muted ttt-outgoing-note';
          note.textContent = `Challenge sent — waiting for ${invite.sender} (${invite.remaining_seconds}s)`;
          box.append(note);
        } else if (invite.direction === 'outgoing' && invite.status === 'active') {
          openAcceptedMatch(invite.id);
        } else if (invite.status === 'expired' && invite.direction === 'outgoing') {
          const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'Your challenge expired without a response.'; box.append(note);
        }
      });
    } catch (error) { /* Retry on the next poll. */ }
  }

  async function openAcceptedMatch(matchId) {
    if (state.match && state.match.id === matchId) return;
    try { startMatch(await api(`/tictactoe/matches/${matchId}`)); }
    catch (error) { /* The other player's acceptance may still be propagating. */ }
  }

  function startInvitePolling() { if (!state.invitePoll) state.invitePoll = setInterval(() => { if (!$('ticTacToePanel').classList.contains('hidden')) { loadFriends(); loadInvites(); } }, 5000); }
  function stopMatchPolling() { if (state.matchPoll) clearInterval(state.matchPoll); state.matchPoll = null; }

  function startMatch(match) {
    stopMatchPolling(); state.match = match;
    $('tttLobby').classList.add('hidden'); $('tttBoardWrap').classList.remove('hidden');
    state.terminalShownMatchId = null;
    state.lastBoardSignature = null;
    ensureBoardCells();
    render(); state.matchPoll = setInterval(refreshMatch, 3000);
  }

  async function refreshMatch() {
    if (!state.match || state.refreshing) return;
    state.refreshing = true;
    try {
      const latest = await api(`/tictactoe/matches/${state.match.id}`);
      const changed = JSON.stringify(latest.board) !== JSON.stringify(state.match.board) || latest.status !== state.match.status || latest.turn !== state.match.turn;
      if (changed) { state.match = latest; render(); }
    } catch (error) { $('tttStatus').textContent = 'Reconnecting…'; }
    finally { state.refreshing = false; }
  }

  function ensureBoardCells() {
    const board = $('tttBoard');
    if (board.children.length === 9) return;
    board.replaceChildren();
    for (let index = 0; index < 9; index += 1) {
      const cell = document.createElement('button'); cell.type = 'button';
      cell.className = 'ttt-cell';
      cell.addEventListener('click', () => play(index));
      board.append(cell);
    }
  }

  function winningLine(board) {
    const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    return lines.find(line => board[line[0]] && line.every(index => board[index] === board[line[0]])) || null;
  }

  function render() {
    const match = state.match; if (!match) return;
    ensureBoardCells();
    const cells = $('tttBoard').children;
    match.board.forEach((mark, index) => {
      const cell = cells[index];
      if (cell.textContent !== (mark || '')) {
        cell.textContent = mark || '';
        if (mark) { cell.classList.remove('ttt-mark-pop'); void cell.offsetWidth; cell.classList.add('ttt-mark-pop'); }
      }
      cell.classList.toggle('is-x', mark === 'X');
      cell.classList.toggle('is-o', mark === 'O');
      cell.disabled = !!mark || !match.your_turn || match.status !== 'active';
      cell.setAttribute('aria-label', mark ? `Square ${index+1}: ${mark}` : `Square ${index+1}, empty`);
      cell.classList.toggle('ttt-winning-cell', match.status === 'won' && !!winningLine(match.board)?.includes(index));
    });
    const opponent = match.players[match.you === 'X' ? 'O' : 'X'];
    $('tttOpponent').textContent = opponent ? opponent.name : 'Waiting for opponent';
    $('tttStatus').textContent = match.status === 'active' ? (match.your_turn ? `Your turn (${match.you})` : 'Opponent’s turn') :
      match.status === 'won' ? (match.result === 'win' ? 'You won! 🎉' : 'You lost this match.') : match.status === 'draw' ? 'It’s a draw!' : match.status;
    $('tttResign').classList.toggle('hidden', match.status !== 'active');
    $('tttRematch').classList.toggle('hidden', !['won','draw'].includes(match.status));
    if (['won','draw'].includes(match.status)) showResultAnimation(match);
  }

  function showResultAnimation(match) {
    if (state.terminalShownMatchId === match.id) return;
    state.terminalShownMatchId = match.id;
    const wrap = $('tttBoardWrap');
    let panel = $('tttResultAnimation');
    if (!panel) { panel = document.createElement('div'); panel.id = 'tttResultAnimation'; panel.className = 'ttt-result-animation'; wrap.append(panel); }
    const won = match.status === 'won' && match.result === 'win';
    const lost = match.status === 'won' && match.result === 'loss';
    panel.className = `ttt-result-animation ${won ? 'is-win' : lost ? 'is-loss' : 'is-draw'}`;
    panel.innerHTML = `<div class="ttt-result-symbol" aria-hidden="true">${won ? '🏆' : lost ? '💔' : '🤝'}</div><strong>${won ? 'You won!' : lost ? 'You lost' : 'It’s a draw!'}</strong><p>${won ? 'Brilliant move. You got three in a row!' : lost ? 'Good game. You can challenge them to a rematch.' : 'A close match! Nobody takes this round.'}</p><button type="button" class="primary-btn">Continue</button>`;
    panel.querySelector('button').addEventListener('click', () => panel.classList.add('is-dismissed'));
  }

  async function play(cell) {
    if (state.busy || !state.match) return; state.busy = true;
    try { state.match = await api(`/tictactoe/matches/${state.match.id}/move`, {method:'POST', body:JSON.stringify({cell})}); render(); }
    catch (error) { notifyChat(error.message); await refreshMatch(); }
    finally { state.busy = false; }
  }

  window.tttResign = async () => {
    if (!state.match || !confirm('Resign this match?')) return;
    try { state.match = await api(`/tictactoe/matches/${state.match.id}/resign`, {method:'POST', body:'{}'}); render(); }
    catch (error) { notifyChat(error.message); }
  };

  window.tttRematch = () => {
    stopMatchPolling(); state.match = null;
    $('tttBoardWrap').classList.add('hidden'); $('tttLobby').classList.remove('hidden');
    loadFriends(); loadInvites();
  };
})();