/* Vynqo Tic-Tac-Toe. Presence, invitations and matches use Vynqo's existing APIs/socket. */
(() => {
  const state = {match:null, matchPoll:null, invitePoll:null, socketBound:false, busy:false, lastInviteIds:new Set()};
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

  function startInvitePolling() { if (!state.invitePoll) state.invitePoll = setInterval(() => { loadFriends(); loadInvites(); }, 1000); }
  function stopMatchPolling() { if (state.matchPoll) clearInterval(state.matchPoll); state.matchPoll = null; }

  function startMatch(match) {
    stopMatchPolling(); state.match = match;
    $('tttLobby').classList.add('hidden'); $('tttBoardWrap').classList.remove('hidden');
    render(); state.matchPoll = setInterval(refreshMatch, 1000);
  }

  async function refreshMatch() {
    if (!state.match) return;
    try {
      const latest = await api(`/tictactoe/matches/${state.match.id}`);
      if (JSON.stringify(latest.board) !== JSON.stringify(state.match.board) || latest.status !== state.match.status || latest.turn !== state.match.turn) {
        state.match = latest; render();
      }
    } catch (error) { $('tttStatus').textContent = 'Reconnecting…'; }
  }

  function render() {
    const match = state.match; if (!match) return;
    $('tttBoard').replaceChildren();
    match.board.forEach((mark, index) => {
      const cell = document.createElement('button'); cell.type = 'button';
      cell.className = `ttt-cell ${mark === 'X' ? 'is-x' : mark === 'O' ? 'is-o' : ''}`;
      cell.textContent = mark || ''; cell.setAttribute('aria-label', mark ? `Square ${index+1}: ${mark}` : `Square ${index+1}, empty`);
      cell.disabled = !!mark || !match.your_turn || match.status !== 'active';
      cell.onclick = () => play(index); $('tttBoard').append(cell);
    });
    const opponent = match.players[match.you === 'X' ? 'O' : 'X'];
    $('tttOpponent').textContent = opponent ? opponent.name : 'Waiting for opponent';
    $('tttStatus').textContent = match.status === 'active' ? (match.your_turn ? `Your turn (${match.you})` : 'Opponent’s turn') :
      match.status === 'won' ? (match.result === 'win' ? 'You won! 🎉' : 'You lost this match.') : match.status === 'draw' ? 'It’s a draw!' : match.status;
    $('tttResign').classList.toggle('hidden', match.status !== 'active');
    $('tttRematch').classList.toggle('hidden', !['won','draw'].includes(match.status));
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