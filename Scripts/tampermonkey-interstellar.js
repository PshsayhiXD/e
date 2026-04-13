// ==UserScript==
// @name         Drednot Team PRO v4
// @namespace    https://drednot.io/
// @version      4.0
// @description  Realtime group pings, minimap, team manager for Drednot
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @match        *https://drednot.io/*
// ==/UserScript==
const currentVer = "4.0";

(function() {
    'use strict';

    // ─── GM_addStyle polyfill (runs fine in both Tampermonkey and Interstellar mod contexts) ───
    if (typeof GM_addStyle === 'undefined') {
        window.GM_addStyle = function(css) {
            const style = document.createElement('style');
            style.type = 'text/css';
            style.textContent = css;
            (document.head || document.documentElement).appendChild(style);
        };
    }

    // ─── GM_notification polyfill ──────────────────────────────────────────────
    if (typeof GM_notification === 'undefined') {
        window.GM_notification = function({ title, text, timeout }) {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                const n = new Notification(title || 'Drednot PRO', { body: text });
                if (timeout) setTimeout(() => n.close(), timeout);
            } else if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        const n = new Notification(title || 'Drednot PRO', { body: text });
                        if (timeout) setTimeout(() => n.close(), timeout);
                    } else {
                        _showToast(`${title}: ${text}`, timeout || 1700);
                    }
                });
            } else {
                _showToast(`${title}: ${text}`, timeout || 1700);
            }
        };
    }

    // ─── GM_xmlhttpRequest polyfill ────────────────────────────────────────────
    if (typeof GM_xmlhttpRequest === 'undefined') {
        window.GM_xmlhttpRequest = function({ method, url, headers, data, onload, onerror }) {
            const xhr = new XMLHttpRequest();
            xhr.open(method || 'GET', url, true);
            if (headers) {
                Object.entries(headers).forEach(([k, v]) => {
                    try { xhr.setRequestHeader(k, v); } catch(e) {}
                });
            }
            xhr.onload  = () => { if (onload)  onload({ status: xhr.status, responseText: xhr.responseText }); };
            xhr.onerror = (e) => { if (onerror) onerror(e); };
            xhr.send(data || null);
        };
    }

    // ─── Toast helper (fallback for GM_notification polyfill) ──────────────────
    function _showToast(msg, duration) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = [
            'position:fixed', 'bottom:30px', 'left:50%', 'transform:translateX(-50%)',
            'background:rgba(20,20,40,0.95)', 'color:#eee', 'padding:8px 18px',
            'border-radius:8px', 'border:1px solid #3182ce', 'font-family:Arial,sans-serif',
            'font-size:13px', 'z-index:2147483647', 'pointer-events:none',
            'box-shadow:0 4px 16px rgba(0,0,0,0.6)', 'transition:opacity 0.4s'
        ].join('!important;') + '!important';
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.setProperty('opacity', '0', 'important');
            setTimeout(() => toast.remove(), 400);
        }, duration || 1700);
    }

    const BACKEND_URL = 'wss://insurmountably-unsnuffed-urijah.ngrok-free.dev';
    const WORLD = {w:1600,h:1600};
    const MINIMAP = {x0:800,y0:525,x1:950,y1:675};
    const MINIMAP_CANVAS_ID = 'drednot-pro-minimap-canvas';
    // ─── CHANGE 1: The Pits zone constants ────────────────────────────────────
    const PITS_MINIMAP = {x0:1450, y0:630, x1:1570, y1:675};
    const PITS_MINIMAP_CANVAS_ID = 'drednot-pro-pits-minimap-canvas';
    // ─────────────────────────────────────────────────────────────────────────
    const PING_FADE_MS = 6000;
    const COOLDOWNS = {punch:2000,dmg:5000,lowhp:15000};
    const ADMIN_EMOJI = '🛡️';
    const SUPPORT_COLOR = '#00ff00';
    const DMG_COLOR = '#ffa500';
    const ENEMY_COLOR = '#ff3333';
    const WARNING_COLOR = '#d81614';
    const LS_WEBHOOKS_KEY     = 'drednot_pro_webhooks_v1';
    const LS_SAVED_GROUPS_KEY = 'drednot_pro_saved_groups_v1';
    const LS_MINIMAP_POS_KEY  = 'drednot_pro_minimap_pos_v1';
    const LS_KEYBINDS_KEY     = 'drednot_pro_keybinds_v1';
    const LS_NAME_KEY         = 'drednot_pro_name_v1';
    const LS_BAN_LISTS_KEY    = 'drednot_pro_ban_lists_v1';

    const state = {
        ws: null,
        me: {
            id: null, name: '', group: null,
            isAdmin: false, isLeader: false, isStealth: false,
            status: 'Ready', ship: ''
        },
        players: {}, pings: [], livePositions: {}, cooldown: {punch:0, dmg:0, lowhp:0},
        fade: PING_FADE_MS, autoHide: false, combatMode: false, zoom: 1,
        uiClosed: false, uiHidden: true,
        uiCreated: false,
        webhooks: [], currentWebhook: null, currentZone: null,
        savedGroups: [],
        savedGroupsMenuOpen: false,
        pendingSavedGroupsUpdate: null,
        banLists: {},
        minimapLocked: true,
        minimapVisible: false,
        minimapDrag: { active: false, ox: 0, oy: 0 },
        keybinds: { punch: '', dmg: '', enemy: '' },
        dbg: { posSent:0, posReceived:0, posStored:0, posDropped:0, lastRaw:null },
        // ── End-to-end encryption state ───────────────────────────────────
        // password   : raw password string (kept in memory only, never sent to server)
        // encKey     : CryptoKey (AES-GCM 256-bit) derived via PBKDF2 for position encryption
        // authToken  : base64 string derived via a SEPARATE PBKDF2 path from the same password;
        //              sent to the server on join so it can validate membership without knowing
        //              the password or the enc key.  Knowing authToken does NOT help decrypt data.
        // pendingPassword : holds the password between createGroup() and the 'joined' response
        //                   when the group code isn't known yet at create time.
        crypto: {
            password: null,
            encKey: null,
            authToken: null,
            pendingPassword: null,
        },
    };

    console.log("Connecting to:", BACKEND_URL);

    function log(...args) { console.log('[DrednotPRO]', ...args); }
    function notify(text) { GM_notification({title:'Drednot PRO', text, timeout:1700}); }
    function now() { return Date.now(); }

    // ─── Name persistence ─────────────────────────────────────────────────────
    function saveName(name) { try { localStorage.setItem(LS_NAME_KEY, name); } catch(e){} }
    function loadName()     { try { return localStorage.getItem(LS_NAME_KEY) || ''; } catch(e) { return ''; } }

    // ─── Ban list persistence ─────────────────────────────────────────────────
    function saveBanLists() { try { localStorage.setItem(LS_BAN_LISTS_KEY, JSON.stringify(state.banLists)); } catch(e){} }
    function loadBanLists() {
        try {
            const raw = localStorage.getItem(LS_BAN_LISTS_KEY);
            if (raw) {
                const p = JSON.parse(raw);
                if (p && typeof p === 'object') state.banLists = p;
            }
        } catch(e) {}
    }
    function getBanList(groupCode) { return state.banLists[groupCode] || []; }
    function banPlayer(groupCode, name) {
        if (!state.banLists[groupCode]) state.banLists[groupCode] = [];
        if (!state.banLists[groupCode].find(b => b.name === name)) {
            state.banLists[groupCode].push({ name });
            saveBanLists();
        }
    }
    function unbanPlayer(groupCode, name) {
        if (!state.banLists[groupCode]) return;
        state.banLists[groupCode] = state.banLists[groupCode].filter(b => b.name !== name);
        saveBanLists();
    }
    function isBanned(groupCode, name) { return !!getBanList(groupCode).find(b => b.name === name); }

    // Auto-kick any banned player that shows up in a group_update
    function enforceGroupBans(groupCode, players) {
        if (!state.me.isLeader || !groupCode) return;
        Object.entries(players).forEach(([pid, p]) => {
            if (pid === state.me.id) return;
            if (isBanned(groupCode, p.name)) {
                wsSend({ type: 'kick', target: pid });
                log('Auto-kicked banned player:', p.name);
            }
        });
    }

    // ─── Webhook persistence ──────────────────────────────────────────────────
    function saveWebhooks() { try { localStorage.setItem(LS_WEBHOOKS_KEY, JSON.stringify(state.webhooks)); } catch(e){} }
    function loadWebhooks() {
        try {
            const raw = localStorage.getItem(LS_WEBHOOKS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) state.webhooks = parsed;
            }
        } catch(e) {}
    }

    // ─── Minimap position persistence ─────────────────────────────────────────
    function saveMinimapPos() {
        try { localStorage.setItem(LS_MINIMAP_POS_KEY, JSON.stringify({ x0: MINIMAP.x0, y0: MINIMAP.y0 })); } catch(e) {}
    }
    function loadMinimapPos() {
        try {
            const raw = localStorage.getItem(LS_MINIMAP_POS_KEY);
            if (raw) {
                const p = JSON.parse(raw);
                if (typeof p.x0 === 'number' && typeof p.y0 === 'number') {
                    const w = MINIMAP.x1 - MINIMAP.x0;
                    const h = MINIMAP.y1 - MINIMAP.y0;
                    MINIMAP.x0 = p.x0; MINIMAP.y0 = p.y0;
                    MINIMAP.x1 = p.x0 + w; MINIMAP.y1 = p.y0 + h;
                    log('Loaded minimap position from storage:', MINIMAP);
                }
            }
        } catch(e) {}
    }

    // ─── Keybind persistence ──────────────────────────────────────────────────
    function saveKeybinds() { try { localStorage.setItem(LS_KEYBINDS_KEY, JSON.stringify(state.keybinds)); } catch(e) {} }
    function loadKeybinds() {
        try {
            const raw = localStorage.getItem(LS_KEYBINDS_KEY);
            if (raw) {
                const p = JSON.parse(raw);
                if (p && typeof p === 'object') {
                    state.keybinds = Object.assign({ punch: '', dmg: '', enemy: '' }, p);
                }
            }
        } catch(e) {}
    }

    // ─── Saved groups persistence ─────────────────────────────────────────────
    function saveSavedGroups() { try { localStorage.setItem(LS_SAVED_GROUPS_KEY, JSON.stringify(state.savedGroups)); } catch(e) {} }
    function loadSavedGroups() {
        try {
            const raw = localStorage.getItem(LS_SAVED_GROUPS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) state.savedGroups = parsed;
            }
        } catch(e) {}
    }

    function saveCurrentGroup() {
        if (!state.me.group) return;
        const code = state.me.group;
        if (state.savedGroups.find(g => g.code === code)) { notify('Group already saved!'); return; }
        state.savedGroups.push({ code });
        saveSavedGroups();
        wsSend({ type: 'pin_group', code });
        notify('📌 Group ' + code + ' saved!');
        setGroupUI();
    }

    function removeSavedGroup(code) {
        state.savedGroups = state.savedGroups.filter(g => g.code !== code);
        saveSavedGroups();
        wsSend({ type: 'unpin_group', code });
        setGroupUI();
    }

    function showSavedGroupsMenu() {
        const codes = state.savedGroups.map(g => g.code);
        renderSavedGroupsMenu(null);
        wsSend({ type: 'get_saved_groups_info', codes });
    }

    // ─── E2E Crypto ───────────────────────────────────────────────────────────
    const _subtle = (() => {
        try { return (unsafeWindow || window).crypto.subtle; } catch(e) { return window.crypto.subtle; }
    })();
    const _cryptoObj = (() => {
        try { return (unsafeWindow || window).crypto; } catch(e) { return window.crypto; }
    })();

    async function cryptoDeriveKeys(password, groupCode) {
        const enc = new TextEncoder();
        const keyMaterial = await _subtle.importKey(
            'raw',
            enc.encode(password),
            { name: 'PBKDF2' },
            false,
            ['deriveKey', 'deriveBits']
        );
        const authSalt = enc.encode('drednot-pro-auth:' + groupCode);
        const encSalt  = enc.encode('drednot-pro-enc:'  + groupCode);

        const authBits = await _subtle.deriveBits(
            { name: 'PBKDF2', salt: authSalt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            256
        );
        const authToken = btoa(String.fromCharCode(...new Uint8Array(authBits)));

        const encKey = await _subtle.deriveKey(
            { name: 'PBKDF2', salt: encSalt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );

        return { authToken, encKey };
    }

    async function cryptoEncryptPos(encKey, plainData) {
        const enc = new TextEncoder();
        const iv = _cryptoObj.getRandomValues(new Uint8Array(12));
        const ciphertext = await _subtle.encrypt(
            { name: 'AES-GCM', iv },
            encKey,
            enc.encode(JSON.stringify(plainData))
        );
        const combined = new Uint8Array(12 + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), 12);
        return btoa(String.fromCharCode(...combined));
    }

    async function cryptoDecryptPos(encKey, b64) {
        try {
            const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const iv         = combined.slice(0, 12);
            const ciphertext = combined.slice(12);
            const plainBuf   = await _subtle.decrypt(
                { name: 'AES-GCM', iv },
                encKey,
                ciphertext
            );
            return JSON.parse(new TextDecoder().decode(plainBuf));
        } catch (e) {
            log('Decryption failed:', e);
            return null;
        }
    }

    function cryptoClear() {
        state.crypto.password      = null;
        state.crypto.encKey        = null;
        state.crypto.authToken     = null;
        state.crypto.pendingPassword = null;
        updatePasswordStatus();
    }

    function updatePasswordStatus() {
        const el = document.getElementById('password-status');
        if (!el) return;
        if (state.crypto.encKey) {
            el.textContent = '🔒 End-to-end encrypted';
            el.style.color   = '#4ade80';
            el.style.display = 'block';
        } else {
            el.textContent = '';
            el.style.display = 'none';
        }
    }

    // ─── Saved Groups Modal ───────────────────────────────────────────────────
    function renderSavedGroupsMenu(serverGroups) {
        let menu = document.getElementById('saved-groups-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'saved-groups-menu';
            document.body.appendChild(menu);
        }
        menu.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'sg-title';
        title.innerHTML = '📌 Saved Groups';
        menu.appendChild(title);

        if (state.savedGroups.length === 0) {
            const empty = document.createElement('p');
            empty.style.cssText = 'color:#888;font-size:12px;margin:8px 0;text-align:center;';
            empty.textContent = 'No saved groups yet. Join a group and click "Save Group"!';
            menu.appendChild(empty);
        } else if (!serverGroups) {
            const loading = document.createElement('p');
            loading.style.cssText = 'color:#aaa;font-size:12px;margin:8px 0;text-align:center;';
            loading.textContent = '⏳ Loading group info...';
            menu.appendChild(loading);
        } else {
            const infoMap = {};
            serverGroups.forEach(g => { infoMap[g.code] = g; });

            state.savedGroups.forEach(saved => {
                const info = infoMap[saved.code] || { exists: false, onlineCount: 0, hasPassword: false };
                const row = document.createElement('div');
                row.className = 'sg-row';
                const left = document.createElement('div');
                left.style.cssText = 'flex:1;min-width:0;';
                const codeSpan = document.createElement('div');
                codeSpan.style.cssText = 'font-weight:bold;font-size:13px;color:#e2e8f0;letter-spacing:1px;';
                codeSpan.textContent = saved.code + (info.hasPassword ? '  🔒' : '');
                const statusSpan = document.createElement('div');
                statusSpan.style.cssText = 'font-size:11px;margin-top:2px;';
                if (!info.exists) {
                    statusSpan.style.color = '#f87171';
                    statusSpan.textContent = '⚫ Offline / disbanded';
                } else if (info.onlineCount === 0) {
                    statusSpan.style.color = '#94a3b8';
                    statusSpan.textContent = '👥 0 players online (kept alive by saves)';
                } else {
                    statusSpan.style.color = '#4ade80';
                    statusSpan.textContent = `👥 ${info.onlineCount} player${info.onlineCount !== 1 ? 's' : ''} online`;
                }
                left.appendChild(codeSpan);
                left.appendChild(statusSpan);

                const btns = document.createElement('div');
                btns.style.cssText = 'display:flex;gap:5px;align-items:center;flex-shrink:0;';
                const nameEl = document.getElementById('name-input');
                const playerName = () => (nameEl && nameEl.value.trim()) || state.me.name || 'Player';

                async function resolvePasswordForGroup(code, hasPassword, actionLabel) {
                    if (!hasPassword) return { authToken: null, encKey: null };
                    const pw = prompt(
                        `Group ${code} is password-protected.\n` +
                        `Enter the password to ${actionLabel}:`
                    );
                    if (pw === null || pw.trim() === '') {
                        notify('Cancelled — password required for this group.');
                        return null;
                    }
                    try {
                        const keys = await cryptoDeriveKeys(pw.trim(), code);
                        return { authToken: keys.authToken, encKey: keys.encKey, password: pw.trim() };
                    } catch (e) {
                        log('Key derivation error:', e);
                        notify('Crypto error — could not derive key.');
                        return null;
                    }
                }

                let actionBtn;
                if (!info.exists) {
                    actionBtn = document.createElement('button');
                    actionBtn.className = 'sg-btn-recreate';
                    actionBtn.textContent = '🔄 Recreate';
                    actionBtn.title = 'Recreate this group with the same code so others can rejoin';
                    actionBtn.onclick = async () => {
                        const name = playerName();
                        state.me.name = name; saveName(name);
                        let authToken = null;
                        if (info.hasPassword) {
                            const result = await resolvePasswordForGroup(saved.code, true, 'recreate');
                            if (!result) return;
                            state.crypto.pendingPassword = result.password;
                        }
                        wsSend({ type: 'recreate', name, code: saved.code, authToken });
                        const m = document.getElementById('saved-groups-menu');
                        if (m) m.remove();
                        state.savedGroupsMenuOpen = false;
                    };
                } else {
                    actionBtn = document.createElement('button');
                    actionBtn.className = 'sg-btn-join';
                    actionBtn.textContent = '▶ Join';
                    actionBtn.onclick = async () => {
                        const name = playerName();
                        state.me.name = name; saveName(name);
                        const result = await resolvePasswordForGroup(saved.code, info.hasPassword, 'join');
                        if (result === null) return;
                        if (result.encKey) {
                            state.crypto.encKey    = result.encKey;
                            state.crypto.authToken = result.authToken;
                            state.crypto.password  = result.password;
                        } else {
                            cryptoClear();
                        }
                        wsSend({ type: 'join', name, code: saved.code, authToken: result.authToken });
                        const m = document.getElementById('saved-groups-menu');
                        if (m) m.remove();
                        state.savedGroupsMenuOpen = false;
                    };
                }

                const delBtn = document.createElement('button');
                delBtn.className = 'sg-btn-del';
                delBtn.textContent = '🗑';
                delBtn.title = 'Remove from saved groups';
                delBtn.onclick = () => {
                    if (confirm(`Remove group ${saved.code} from your saved groups?\n\nIf nobody else has it saved, the group may be deleted.`)) {
                        removeSavedGroup(saved.code);
                        row.remove();
                        if (state.savedGroups.length === 0) renderSavedGroupsMenu(serverGroups);
                    }
                };

                btns.appendChild(actionBtn);
                btns.appendChild(delBtn);
                row.appendChild(left);
                row.appendChild(btns);
                menu.appendChild(row);
            });
        }

        const footer = document.createElement('div');
        footer.style.cssText = 'margin-top:10px;display:flex;justify-content:flex-end;';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'sg-btn-close';
        closeBtn.textContent = '✕ Close';
        closeBtn.onclick = () => { menu.remove(); state.savedGroupsMenuOpen = false; };
        footer.appendChild(closeBtn);
        menu.appendChild(footer);
        state.savedGroupsMenuOpen = true;
        state.pendingSavedGroupsUpdate = (data) => renderSavedGroupsMenu(data);
    }

    // ─── Member Management Modal ──────────────────────────────────────────────
    function showManageMembersMenu() {
        let menu = document.getElementById('manage-members-menu');
        if (menu) { menu.remove(); return; }
        menu = document.createElement('div');
        menu.id = 'manage-members-menu';
        document.body.appendChild(menu);

        function render() {
            menu.innerHTML = '';
            const groupCode = state.me.group;
            const banList = getBanList(groupCode);

            const title = document.createElement('div');
            title.className = 'mm-title';
            title.textContent = '👥 Manage Members';
            menu.appendChild(title);

            const activePlayers = Object.entries(state.players).filter(([pid]) => pid !== state.me.id);

            const activeLabel = document.createElement('div');
            activeLabel.className = 'mm-section-label';
            activeLabel.textContent = '🟢 Active Members';
            menu.appendChild(activeLabel);

            if (activePlayers.length === 0) {
                const empty = document.createElement('p');
                empty.style.cssText = 'color:#94a3b8;font-size:12px;margin:4px 0 8px;';
                empty.textContent = 'No other members in the group.';
                menu.appendChild(empty);
            } else {
                activePlayers.forEach(([pid, p]) => {
                    const row = document.createElement('div');
                    row.className = 'mm-row';

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'mm-name';
                    nameSpan.textContent = p.name + (p.isAdmin ? ' 🛡️' : '');

                    const btns = document.createElement('div');
                    btns.className = 'mm-btns';

                    const kickBtn = document.createElement('button');
                    kickBtn.className = 'mm-btn mm-btn-kick';
                    kickBtn.textContent = '⚡ Kick';
                    kickBtn.onclick = () => {
                        if (confirm(`Kick ${p.name} from the group?`)) {
                            wsSend({ type: 'kick', target: pid });
                            setTimeout(() => render(), 400);
                        }
                    };

                    const banBtn = document.createElement('button');
                    banBtn.className = 'mm-btn mm-btn-ban';
                    banBtn.textContent = '🚫 Ban';
                    banBtn.onclick = () => {
                        if (confirm(`Ban ${p.name}?\nThey will be kicked and blocked from rejoining this group.`)) {
                            banPlayer(groupCode, p.name);
                            wsSend({ type: 'kick', target: pid });
                            setTimeout(() => render(), 400);
                        }
                    };

                    btns.appendChild(kickBtn);
                    btns.appendChild(banBtn);
                    row.appendChild(nameSpan);
                    row.appendChild(btns);
                    menu.appendChild(row);
                });
            }

            if (banList.length > 0) {
                const banLabel = document.createElement('div');
                banLabel.className = 'mm-section-label';
                banLabel.style.cssText += 'color:#f87171 !important;margin-top:8px;';
                banLabel.textContent = '🚫 Banned Players';
                menu.appendChild(banLabel);

                banList.forEach(banned => {
                    const row = document.createElement('div');
                    row.className = 'mm-row';

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'mm-name';
                    nameSpan.style.color = '#f87171';
                    nameSpan.textContent = banned.name;

                    const unbanBtn = document.createElement('button');
                    unbanBtn.className = 'mm-btn mm-btn-unban';
                    unbanBtn.textContent = '✅ Unban';
                    unbanBtn.onclick = () => { unbanPlayer(groupCode, banned.name); render(); };

                    row.appendChild(nameSpan);
                    row.appendChild(unbanBtn);
                    menu.appendChild(row);
                });
            }

            const footer = document.createElement('div');
            footer.style.cssText = 'margin-top:12px;display:flex;justify-content:flex-end;';
            const closeBtn = document.createElement('button');
            closeBtn.className = 'mm-btn mm-btn-close';
            closeBtn.textContent = '✕ Close';
            closeBtn.onclick = () => menu.remove();
            footer.appendChild(closeBtn);
            menu.appendChild(footer);
        }

        render();
    }

    // ─── Keybinds Modal ───────────────────────────────────────────────────────
    function showKeybindsMenu() {
        let menu = document.getElementById('keybinds-menu');
        if (menu) { menu.remove(); return; }
        menu = document.createElement('div');
        menu.id = 'keybinds-menu';
        document.body.appendChild(menu);

        const title = document.createElement('div');
        title.className = 'kb-title';
        title.textContent = '⌨ Ping Keybinds';
        menu.appendChild(title);

        const hint = document.createElement('p');
        hint.style.cssText = 'color:#94a3b8;font-size:11px;margin:0 0 10px;';
        hint.textContent = 'Click a button then press any key to bind it. ESC to cancel.';
        menu.appendChild(hint);

        const PING_DEFS = [
            { key: 'punch', label: '🟢 Punch Support', borderColor: '#00cc00' },
            { key: 'dmg',   label: '🟠 Dmg Support',   borderColor: '#ff8c00' },
            { key: 'enemy', label: '🔴 Enemy',           borderColor: '#ff3333' },
        ];

        let listeningFor = null;

        PING_DEFS.forEach(({ key, label, borderColor }) => {
            const row = document.createElement('div');
            row.className = 'kb-row';

            const lbl = document.createElement('span');
            lbl.className = 'kb-label';
            lbl.textContent = label;

            const bindBtn = document.createElement('button');
            bindBtn.className = 'kb-bind-btn';
            bindBtn.id = `kb-btn-${key}`;
            bindBtn.style.borderColor = borderColor;
            bindBtn.textContent = state.keybinds[key] ? `[ ${state.keybinds[key].toUpperCase()} ]` : '[ None ]';

            bindBtn.onclick = () => {
                if (listeningFor === key) {
                    listeningFor = null;
                    const label = state.keybinds[key] ? `[ ${state.keybinds[key].toUpperCase()} ]` : '[ None ]';
                    bindBtn.textContent = label;
                    bindBtn.classList.remove('kb-listening');
                    return;
                }
                if (listeningFor) {
                    const prev = document.getElementById(`kb-btn-${listeningFor}`);
                    if (prev) {
                        const label = state.keybinds[listeningFor] ? `[ ${state.keybinds[listeningFor].toUpperCase()} ]` : '[ None ]';
                        prev.textContent = label;
                        prev.classList.remove('kb-listening');
                    }
                }
                listeningFor = key;
                bindBtn.textContent = '… press a key';
                bindBtn.classList.add('kb-listening');
            };

            const clearBtn = document.createElement('button');
            clearBtn.className = 'kb-clear-btn';
            clearBtn.textContent = '✕';
            clearBtn.title = 'Clear this keybind';
            clearBtn.onclick = () => {
                state.keybinds[key] = '';
                saveKeybinds();
                bindBtn.textContent = '[ None ]';
                if (listeningFor === key) {
                    listeningFor = null;
                    bindBtn.classList.remove('kb-listening');
                }
                updatePingButtonLabels();
            };

            row.appendChild(lbl);
            row.appendChild(bindBtn);
            row.appendChild(clearBtn);
            menu.appendChild(row);
        });

        const keyHandler = (e) => {
            if (!listeningFor) return;
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') {
                const btn = document.getElementById(`kb-btn-${listeningFor}`);
                if (btn) {
                    const label = state.keybinds[listeningFor]
                        ? `[ ${state.keybinds[listeningFor].toUpperCase()} ]`
                        : '[ None ]';
                    btn.textContent = label;
                    btn.classList.remove('kb-listening');
                }
                listeningFor = null;
                return;
            }
            state.keybinds[listeningFor] = e.key;
            saveKeybinds();
            const btn = document.getElementById(`kb-btn-${listeningFor}`);
            if (btn) {
                const keyLabel = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                btn.textContent = `[ ${keyLabel} ]`;
                btn.classList.remove('kb-listening');
            }
            listeningFor = null;
            updatePingButtonLabels();
        };
        document.addEventListener('keydown', keyHandler);

        const footer = document.createElement('div');
        footer.style.cssText = 'margin-top:12px;display:flex;justify-content:flex-end;';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'kb-close-btn';
        closeBtn.textContent = '✕ Close';
        closeBtn.onclick = () => { document.removeEventListener('keydown', keyHandler); menu.remove(); };
        footer.appendChild(closeBtn);
        menu.appendChild(footer);
    }

    function updatePingButtonLabels() {
        const defs = [
            { id: 'btn-punch', base: 'Punch Support', key: 'punch' },
            { id: 'btn-dmg',   base: 'Dmg Support',   key: 'dmg'   },
            { id: 'btn-enemy', base: 'Enemy',           key: 'enemy' },
        ];
        defs.forEach(({ id, base, key }) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            const kb = state.keybinds[key];
            btn.textContent = kb ? `${base} [${kb.length === 1 ? kb.toUpperCase() : kb}]` : base;
        });
    }

    // ─── Styles ───────────────────────────────────────────────────────────────
    function addStyles() {
        GM_addStyle(`
        #drednot-pro-panel{
            position:fixed !important;left:20px !important;top:20px !important;
            width:340px !important;height:560px !important;
            background:rgba(1,1,12,0.92) !important;color:#eee !important;
            z-index:2147483647 !important;border:2px solid #3182ce !important;
            border-radius:10px !important;resize:both !important;overflow:auto !important;
            padding:6px !important;backdrop-filter:blur(4px) !important;
            font-family:Arial,sans-serif !important;user-select:none !important;
            pointer-events:auto !important;
            transition: width 0.15s ease, height 0.15s ease !important;
        }
        #drednot-pro-panel button{
            margin:2px !important;z-index:2147483647 !important;
            pointer-events:auto !important;position:relative !important;cursor:pointer !important;
        }
        #drednot-pro-panel input {
            z-index:2147483647 !important;pointer-events:auto !important;position:relative !important;
        }
        #team-list button {
            pointer-events:auto !important;position:relative !important;
            z-index:2147483647 !important;cursor:pointer !important;
            background:#555 !important;color:#fff !important;
            border:1px solid #888 !important;border-radius:3px !important;padding:2px 6px !important;
        }
        #drednot-minimap-canvas{
            position:fixed !important;
            left:${MINIMAP.x0}px !important;top:${MINIMAP.y0}px !important;
            z-index:2147483646 !important;pointer-events:none !important;
            border:1px solid rgba(255,255,255,0.5) !important;
            background:rgba(0,0,0,0.20) !important;
        }
        #drednot-pro-panel *, #drednot-pro-panel button, #drednot-pro-panel input {
            z-index:2147483647 !important;
        }
        body > #drednot-pro-panel {transform: none !important;}
        #drednot-show-tab{
            position:fixed !important;left:0 !important;top:20px !important;
            z-index:2147483648 !important;background:#3182ce !important;color:#fff !important;
            border:none !important;border-radius:0 6px 6px 0 !important;
            padding:6px 10px !important;cursor:pointer !important;font-size:12px !important;
            font-family:Arial,sans-serif !important;pointer-events:auto !important;display:none !important;
        }
        #drednot-dbg-box{
            font-size:10px !important;color:#aef !important;
            background:rgba(0,0,0,0.4) !important;border-radius:4px !important;
            padding:3px 5px !important;margin-top:4px !important;
            white-space:pre-wrap !important;word-break:break-all !important;
        }
        #webhook-menu {
            position:fixed !important;left:50% !important;top:50% !important;
            transform:translate(-50%,-50%) !important;background:#1a1a2e !important;
            color:#eee !important;padding:16px !important;z-index:2147483648 !important;
            border:2px solid #3182ce !important;border-radius:10px !important;
            min-width:280px !important;max-width:360px !important;
            font-family:Arial,sans-serif !important;pointer-events:auto !important;
            box-shadow: 0 8px 32px rgba(0,0,0,0.7) !important;
        }
        #webhook-menu input {
            width:calc(100% - 10px) !important;margin-bottom:8px !important;padding:5px !important;
            background:#2a2a3e !important;border:1px solid #555 !important;
            color:#fff !important;border-radius:4px !important;font-size:12px !important;
        }
        #webhook-menu button {
            display:block !important;width:100% !important;margin:3px 0 !important;
            padding:7px 10px !important;border:none !important;border-radius:5px !important;
            color:#fff !important;cursor:pointer !important;font-size:12px !important;text-align:left !important;
        }
        #webhook-menu .wh-title { font-weight:bold;font-size:14px;margin-bottom:10px;border-bottom:1px solid #3182ce;padding-bottom:6px; }
        #webhook-menu .wh-active-badge { float:right;background:#38a169;color:#fff;font-size:9px;padding:1px 5px;border-radius:8px; }
        .hp-bar-wrap{ background:#333 !important;border-radius:3px !important;height:6px !important;margin-top:3px !important;width:100% !important;overflow:hidden !important; }
        .hp-bar-fill{ height:6px !important;border-radius:3px !important;transition:width 0.4s ease !important; }

        /* ── Password input ───────────────────────────────── */
        #password-input {
            width:calc(100% - 10px) !important;margin-top:4px !important;
            background:rgba(30,10,40,0.95) !important;
            border:1px solid #6b46c1 !important;border-radius:4px !important;
            color:#e9d5ff !important;padding:4px 5px !important;font-size:12px !important;
        }
        #password-input::placeholder { color:#9f7aea !important;opacity:0.7 !important; }
        #password-status {
            font-size:10px !important;margin-top:2px !important;margin-bottom:2px !important;
            padding:2px 5px !important;border-radius:3px !important;display:none !important;
            font-weight:bold !important;letter-spacing:0.3px !important;
        }

        /* ── Saved Groups Modal ─────────────────────────────── */
        #saved-groups-menu {
            position:fixed !important;left:50% !important;top:50% !important;
            transform:translate(-50%,-50%) !important;background:#0f0f1e !important;
            color:#e2e8f0 !important;padding:16px !important;z-index:2147483649 !important;
            border:2px solid #6b46c1 !important;border-radius:12px !important;
            min-width:320px !important;max-width:420px !important;
            max-height:75vh !important;overflow-y:auto !important;
            font-family:Arial,sans-serif !important;pointer-events:auto !important;
            box-shadow: 0 12px 40px rgba(0,0,0,0.8) !important;
        }
        #saved-groups-menu .sg-title { font-weight:bold !important;font-size:15px !important;margin-bottom:12px !important;padding-bottom:8px !important;border-bottom:1px solid #6b46c1 !important;color:#c4b5fd !important;letter-spacing:0.5px !important; }
        #saved-groups-menu .sg-row { display:flex !important;align-items:center !important;gap:8px !important;padding:8px 0 !important;border-bottom:1px solid rgba(255,255,255,0.08) !important; }
        #saved-groups-menu .sg-row:last-of-type { border-bottom:none !important; }
        #saved-groups-menu .sg-btn-join { background:#38a169 !important;color:#fff !important;border:none !important;border-radius:6px !important;padding:5px 10px !important;font-size:12px !important;font-weight:bold !important;cursor:pointer !important;white-space:nowrap !important; }
        #saved-groups-menu .sg-btn-join:hover:not(:disabled) { background:#2f855a !important; }
        #saved-groups-menu .sg-btn-del { background:#7f1d1d !important;color:#fca5a5 !important;border:1px solid #ef4444 !important;border-radius:6px !important;padding:5px 8px !important;font-size:12px !important;cursor:pointer !important; }
        #saved-groups-menu .sg-btn-del:hover { background:#991b1b !important; }
        #saved-groups-menu .sg-btn-recreate { background:#b45309 !important;color:#fef3c7 !important;border:1px solid #f59e0b !important;border-radius:6px !important;padding:5px 10px !important;font-size:12px !important;font-weight:bold !important;cursor:pointer !important;white-space:nowrap !important; }
        #saved-groups-menu .sg-btn-recreate:hover { background:#92400e !important; }
        #saved-groups-menu .sg-btn-close { background:#374151 !important;color:#d1d5db !important;border:1px solid #6b7280 !important;border-radius:6px !important;padding:6px 14px !important;font-size:12px !important;cursor:pointer !important; }
        #saved-groups-menu .sg-btn-close:hover { background:#4b5563 !important; }

        /* ── Manage Members Modal ──────────────────────────── */
        #manage-members-menu {
            position:fixed !important;left:50% !important;top:50% !important;
            transform:translate(-50%,-50%) !important;background:#0f0f1e !important;
            color:#e2e8f0 !important;padding:16px !important;z-index:2147483649 !important;
            border:2px solid #e53e3e !important;border-radius:12px !important;
            min-width:320px !important;max-width:440px !important;
            max-height:75vh !important;overflow-y:auto !important;
            font-family:Arial,sans-serif !important;pointer-events:auto !important;
            box-shadow:0 12px 40px rgba(0,0,0,0.9) !important;
        }
        #manage-members-menu .mm-title {
            font-weight:bold !important;font-size:15px !important;
            margin-bottom:10px !important;padding-bottom:8px !important;
            border-bottom:1px solid #e53e3e !important;color:#fc8181 !important;letter-spacing:0.5px !important;
        }
        #manage-members-menu .mm-section-label {
            font-size:11px !important;font-weight:bold !important;
            color:#94a3b8 !important;letter-spacing:0.8px !important;
            text-transform:uppercase !important;margin:6px 0 4px !important;
        }
        #manage-members-menu .mm-row {
            display:flex !important;align-items:center !important;
            justify-content:space-between !important;gap:8px !important;
            padding:7px 0 !important;border-bottom:1px solid rgba(255,255,255,0.07) !important;
        }
        #manage-members-menu .mm-row:last-of-type { border-bottom:none !important; }
        #manage-members-menu .mm-name {
            flex:1 !important;font-size:13px !important;
            color:#e2e8f0 !important;font-weight:500 !important;word-break:break-all !important;
        }
        #manage-members-menu .mm-btns { display:flex !important;gap:5px !important;flex-shrink:0 !important; }
        #manage-members-menu .mm-btn {
            border:none !important;border-radius:6px !important;
            padding:5px 10px !important;font-size:12px !important;font-weight:bold !important;
            cursor:pointer !important;pointer-events:auto !important;
            white-space:nowrap !important;transition:filter 0.1s !important;
        }
        #manage-members-menu .mm-btn:hover { filter:brightness(1.15) !important; }
        #manage-members-menu .mm-btn-kick { background:#b45309 !important;color:#fef3c7 !important;border:1px solid #f59e0b !important; }
        #manage-members-menu .mm-btn-ban  { background:#7f1d1d !important;color:#fca5a5 !important;border:1px solid #ef4444 !important; }
        #manage-members-menu .mm-btn-unban{ background:#065f46 !important;color:#6ee7b7 !important;border:1px solid #34d399 !important; }
        #manage-members-menu .mm-btn-close{ background:#374151 !important;color:#d1d5db !important;border:1px solid #6b7280 !important; }

        /* ── Keybinds Modal ──────────────────────────────────── */
        #keybinds-menu {
            position:fixed !important;left:50% !important;top:50% !important;
            transform:translate(-50%,-50%) !important;background:#0f0f1e !important;
            color:#e2e8f0 !important;padding:16px !important;z-index:2147483649 !important;
            border:2px solid #2d6a9f !important;border-radius:12px !important;
            min-width:300px !important;max-width:380px !important;
            font-family:Arial,sans-serif !important;pointer-events:auto !important;
            box-shadow: 0 12px 40px rgba(0,0,0,0.85) !important;
        }
        #keybinds-menu .kb-title { font-weight:bold !important;font-size:15px !important;margin-bottom:6px !important;padding-bottom:8px !important;border-bottom:1px solid #2d6a9f !important;color:#7dd3fc !important;letter-spacing:0.5px !important; }
        #keybinds-menu .kb-row { display:flex !important;align-items:center !important;gap:8px !important;padding:7px 0 !important;border-bottom:1px solid rgba(255,255,255,0.07) !important; }
        #keybinds-menu .kb-label { flex:1 !important;font-size:13px !important;color:#cbd5e1 !important; }
        #keybinds-menu .kb-bind-btn { background:#1e293b !important;color:#e2e8f0 !important;border:2px solid #334155 !important;border-radius:6px !important;padding:4px 10px !important;font-size:12px !important;font-weight:bold !important;cursor:pointer !important;min-width:90px !important;text-align:center !important;letter-spacing:0.5px !important;transition: background 0.1s !important; }
        #keybinds-menu .kb-bind-btn:hover { background:#2d3f55 !important; }
        #keybinds-menu .kb-bind-btn.kb-listening { background:#1a3a5c !important;border-color:#38bdf8 !important;color:#38bdf8 !important;animation: kb-pulse 0.8s ease-in-out infinite !important; }
        @keyframes kb-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(56,189,248,0.4); } 50% { box-shadow: 0 0 0 5px rgba(56,189,248,0); } }
        #keybinds-menu .kb-clear-btn { background:#374151 !important;color:#9ca3af !important;border:1px solid #4b5563 !important;border-radius:5px !important;padding:4px 7px !important;font-size:11px !important;cursor:pointer !important; }
        #keybinds-menu .kb-clear-btn:hover { background:#4b5563 !important;color:#f3f4f6 !important; }
        #keybinds-menu .kb-close-btn { background:#374151 !important;color:#d1d5db !important;border:1px solid #6b7280 !important;border-radius:6px !important;padding:6px 14px !important;font-size:12px !important;cursor:pointer !important; }
        #keybinds-menu .kb-close-btn:hover { background:#4b5563 !important; }

        /* ── Minimap drag overlay label ──────────────────────── */
        #drednot-minimap-drag-hint {
            position:fixed !important;z-index:2147483645 !important;pointer-events:none !important;
            color:#f59e0b !important;font-family:Arial,sans-serif !important;
            font-size:11px !important;font-weight:bold !important;text-align:center !important;
            text-shadow:0 1px 3px rgba(0,0,0,0.9) !important;display:none;
        }

        /* ── CHANGE 4: The Pits minimap canvas ───────────────── */
        #drednot-pro-pits-minimap-canvas {
            position:fixed !important;
            left:${PITS_MINIMAP.x0}px !important;top:${PITS_MINIMAP.y0}px !important;
            z-index:2147483646 !important;pointer-events:none !important;
            border:1px solid rgba(192,132,252,0.65) !important;
            background:rgba(0,0,0,0.22) !important;
        }
        `);
    }

    // ─── IDs to hide in combat mode ───────────────────────────────────────────
    const COMBAT_HIDE_IDS = [
        'my-id-row', 'name-input', 'code-input', 'password-input', 'password-status',
        'btn-row-create-join', 'btn-row-leave',
        'btn-row-saved-groups',
        'admin-box', 'leader-box', 'btn-setstatus', 'status-input',
        'team-count-row', 'team-list',
        'cd-row', 'zoom-row', 'drednot-dbg-box',
        'btn-setwebhook', 'btn-minimap-move', 'btn-row-keybinds'
    ];

    // ─── Grid helpers ─────────────────────────────────────────────────────────
    function getGridCell(x, y) {
        const colIdx = Math.min(4, Math.max(0, Math.floor(x / WORLD.w * 5)));
        const rowIdx = Math.min(4, Math.max(0, Math.floor((1 - y / WORLD.h) * 5)));
        const col = colIdx + 1;
        const row = ['A','B','C','D','E'][rowIdx];
        return row + '' + col;
    }

    function toLocalXY(pos, width, height) {
        const xRel = Math.max(0, Math.min(1, pos.x / WORLD.w));
        const yRel = 1 - Math.max(0, Math.min(1, pos.y / WORLD.h));
        return { x: xRel * width, y: yRel * height };
    }

    // ─── HP bar helpers ───────────────────────────────────────────────────────
    function getShipHp() {
        const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
        const api = root.StellarAPI || window.StellarAPI;
        if (!api || !api.currentShip) return null;
        const hp = api.currentShip.health;
        const maxHp = api.currentShip.max_health;
        if (typeof hp !== 'number' || typeof maxHp !== 'number' || maxHp <= 0) return null;
        return { hp, maxHp };
    }

    function hpColor(pct) {
        if (pct > 0.6) return '#22c55e';
        if (pct > 0.3) return '#eab308';
        return '#ef4444';
    }

    function buildHpBar(hp, maxHp) {
        const pct = Math.max(0, Math.min(1, hp / maxHp));
        const color = hpColor(pct);
        return `<div class="hp-bar-wrap"><div class="hp-bar-fill" style="width:${(pct*100).toFixed(1)}%;background:${color};"></div></div>`
             + `<small style="color:${color};font-size:9px;">${Math.round(hp)} / ${Math.round(maxHp)}</small>`;
    }

    // ─── Shared minimap renderer ──────────────────────────────────────────────
    function renderMinimapToCtx(ctx, width, height, drawGrid) {
        const t = now();

        if (drawGrid) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 0.8;
            for (let i = 1; i < 5; i++) {
                ctx.beginPath(); ctx.moveTo(i * width / 5, 0); ctx.lineTo(i * width / 5, height); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0, i * height / 5); ctx.lineTo(width, i * height / 5); ctx.stroke();
            }
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.font = `bold ${Math.max(8, Math.floor(width / 28))}px Arial`;
            ctx.textAlign = 'center';
            ['1','2','3','4','5'].forEach((c, i) => { ctx.fillText(c, (i + 0.5) * width / 5, 11); });
            ctx.textAlign = 'left';
            ['A','B','C','D','E'].forEach((r, i) => { ctx.fillText(r, 3, (i + 0.5) * height / 5 + 4); });
            ctx.restore();
        }

        if (!state.me.isStealth) {
            const myPos = getPlayerPos();
            if (myPos) {
                const mp = toLocalXY(myPos, width, height);
                ctx.save();
                ctx.fillStyle = 'rgba(200,200,255,0.85)';
                ctx.strokeStyle = 'rgba(255,255,255,0.95)';
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(mp.x, mp.y, 6, 0, 2 * Math.PI);
                ctx.fill(); ctx.stroke();
                ctx.restore();
            }
        }

        const staleMs = 3500;
        Object.entries(state.livePositions).forEach(([pid, p]) => {
            if (t - p.ts > staleMs) return;
            if (typeof p.x !== 'number' || typeof p.y !== 'number') return;
            const mp = toLocalXY(p, width, height);
            ctx.save();
            // ─── CHANGE 3: Added The Pits zone colour ─────────────────────
            let color = '#00ff00';
            if (p.zone === 'Raven')           color = '#3b82f6';
            else if (p.zone === 'Falcon')     color = '#ff8c00';
            else if (p.zone === 'Freeport')   color = '#00ff00';
            else if (p.zone === 'The Pits')   color = '#873e23';
            // ──────────────────────────────────────────────────────────────
            ctx.fillStyle = color;
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(mp.x, mp.y, 6, 0, 2 * Math.PI);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.font = `bold ${Math.max(7, Math.floor(width / 35))}px Arial`;
            ctx.textAlign = 'center';
            ctx.fillText(p.name, mp.x, mp.y - 9);
            ctx.restore();
        });

        state.pings.forEach(p => {
            const age = t - p.ts;
            if (age > state.fade) return;
            const alpha = 1 - age / state.fade;
            const mp = toLocalXY(p, width, height);
            const r = parseInt(p.color.slice(1,3),16);
            const g = parseInt(p.color.slice(3,5),16);
            const b = parseInt(p.color.slice(5,7),16);
            ctx.beginPath();
            ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
            ctx.arc(mp.x, mp.y, 6 + 4 * Math.sin(age / 120), 0, 2 * Math.PI);
            ctx.fill();
            ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
            ctx.lineWidth = 1;
            ctx.stroke();
        });
    }

    // ─── Discord webhook ──────────────────────────────────────────────────────
    async function sendEnemyPingWebhook(pos) {
        const webhook = state.currentWebhook;
        if (!webhook || !webhook.url) return;
        const zone = state.currentZone || 'Unknown Zone';
        const cell = getGridCell(pos.x, pos.y);

        let link = "can't send link";
        try {
            const sendBtn = document.getElementById("chat-send");
            const chatInput = document.getElementById("chat-input");
            if (chatInput && sendBtn) {
                sendBtn.click();
                chatInput.value = "/invite";
                sendBtn.click();
                await new Promise(res => setTimeout(res, 150));
                if (navigator.clipboard && navigator.clipboard.readText) {
                    const clipboardText = await navigator.clipboard.readText();
                    if (clipboardText.startsWith("https://drednot.io/invite/")) {
                        link = clipboardText;
                    }
                }
            }
        } catch (e) {
            console.warn("Error getting invite link:", e);
        }

        let content = `**${zone} ${cell} enemy** ${link}`;
        if (state.me.group) content += `\nGroup code: \`${state.me.group}\``;
        content += '\n@here';

        const mmW = 400, mmH = 400;
        const offscreen = document.createElement('canvas');
        offscreen.width = mmW; offscreen.height = mmH;
        const ctx = offscreen.getContext('2d');
        ctx.fillStyle = 'rgba(0, 0, 20, 0.97)';
        ctx.fillRect(0, 0, mmW, mmH);
        renderMinimapToCtx(ctx, mmW, mmH, true);
        ctx.strokeStyle = 'rgba(49,130,206,0.8)';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, mmW - 2, mmH - 2);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.font = '10px Arial';
        ctx.textAlign = 'right';
        ctx.fillText('Drednot PRO', mmW - 4, mmH - 4);

        offscreen.toBlob(blob => {
            if (!blob) {
                GM_xmlhttpRequest({ method:'POST', url:webhook.url, headers:{'Content-Type':'application/json'}, data:JSON.stringify({content, username:'Drednot PRO'}), onerror: e=>log('Webhook text-only error',e) });
                return;
            }
            const formData = new FormData();
            formData.append('payload_json', JSON.stringify({content, username:'Drednot PRO'}));
            formData.append('file', blob, 'minimap.png');
            GM_xmlhttpRequest({ method:'POST', url:webhook.url, data:formData, onload: r=>log('Webhook sent, status:',r.status), onerror: e=>log('Webhook error',e) });
        }, 'image/png');
    }

    // ─── Webhook menu ─────────────────────────────────────────────────────────
    function showWebhookMenu() {
        let menu = document.getElementById('webhook-menu');
        if (menu) menu.remove();
        menu = document.createElement('div');
        menu.id = 'webhook-menu';
        document.body.appendChild(menu);

        function btn(label, bg, handler) {
            const b = document.createElement('button');
            b.style.background = bg; b.innerHTML = label; b.onclick = handler; return b;
        }

        function renderMain() {
            menu.innerHTML = `<div class="wh-title">🔗 Select Webhook</div>`;
            const list = state.webhooks || [];
            if (list.length === 0) {
                const none = document.createElement('p');
                none.style.cssText = 'color:#888;font-size:11px;margin:0 0 8px;';
                none.textContent = 'No saved webhooks yet.';
                menu.appendChild(none);
            } else {
                list.forEach((wh, idx) => {
                    const isActive = state.currentWebhook && state.currentWebhook.url === wh.url;
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:4px;align-items:center;margin:3px 0;';
                    const selBtn = btn(wh.name + (isActive ? ' <span class="wh-active-badge">ACTIVE</span>' : ''), isActive ? '#2d6a4f' : '#2a2a4e', () => selectWebhook(wh));
                    selBtn.style.flex = '1';
                    const delBtn = btn('🗑', '#7f1d1d', () => {
                        state.webhooks.splice(idx, 1);
                        if (state.currentWebhook && state.currentWebhook.url === wh.url) state.currentWebhook = null;
                        saveWebhooks(); renderMain();
                    });
                    delBtn.style.cssText = 'flex:0;padding:4px 8px;font-size:11px;';
                    row.appendChild(selBtn); row.appendChild(delBtn); menu.appendChild(row);
                });
            }
            const noActive = !state.currentWebhook;
            menu.appendChild(btn('No Webhook' + (noActive ? ' <span class="wh-active-badge">ACTIVE</span>' : ''), noActive ? '#555' : '#333', () => selectWebhook(null)));
            menu.appendChild(btn('＋ Add New Webhook', '#3182ce', renderAdd));
            menu.appendChild(btn('Cancel', '#e53e3e', () => menu.remove()));
        }

        function selectWebhook(wh) {
            state.currentWebhook = wh;
            if (state.me.group && state.me.isAdmin) wsSend({ type: 'set_group_webhook', webhook: wh });
            menu.remove();
            notify(wh ? 'Webhook set: ' + wh.name : 'No webhook selected');
            setGroupUI();
        }

        function renderAdd() {
            menu.innerHTML = `<div class="wh-title">＋ Add New Webhook</div>`;
            const nameInput = document.createElement('input'); nameInput.placeholder = 'Webhook name (e.g. "Main Server")'; menu.appendChild(nameInput);
            const urlInput = document.createElement('input'); urlInput.placeholder = 'Discord Webhook URL'; menu.appendChild(urlInput);
            menu.appendChild(btn('Save & Select', '#38a169', () => {
                const name = nameInput.value.trim(); const url = urlInput.value.trim();
                if (!name || !url) { notify('Name and URL are required'); return; }
                if (!url.startsWith('https://discord.com/api/webhooks/') && !url.startsWith('https://discordapp.com/api/webhooks/')) { notify('Looks like an invalid Discord webhook URL'); return; }
                const wh = { name, url }; state.webhooks.push(wh); saveWebhooks(); selectWebhook(wh);
            }));
            menu.appendChild(btn('← Back', '#555', renderMain));
        }

        renderMain();
    }

    // ─── Floating "Show" tab ──────────────────────────────────────────────────
    function createShowTab() {
        if (document.getElementById('drednot-show-tab')) return;
        const tab = document.createElement('button');
        tab.id = 'drednot-show-tab';
        tab.innerText = '▶ PRO';
        tab.onclick = showPanel;
        document.body.appendChild(tab);
    }

    // ─── Enforce loop ─────────────────────────────────────────────────────────
    function startEnforceLoop() {
        setInterval(() => {
            const panel  = document.getElementById('drednot-pro-panel');
            const canvas = document.getElementById(MINIMAP_CANVAS_ID);
            const tab    = document.getElementById('drednot-show-tab');

            if (panel && !state.uiClosed) {
                panel.style.setProperty('z-index', '2147483647', 'important');
                panel.style.setProperty('position', 'fixed', 'important');
                panel.style.setProperty('pointer-events', 'auto', 'important');
                if (!state.uiHidden) {
                    panel.style.setProperty('visibility', 'visible', 'important');
                    panel.style.setProperty('display', 'block', 'important');
                }
            }
            if (canvas) {
                canvas.style.setProperty('z-index', '2147483646', 'important');
                if (state.minimapVisible) {
                    canvas.style.setProperty('visibility', 'visible', 'important');
                    canvas.style.setProperty('display', 'block', 'important');
                } else {
                    canvas.style.setProperty('display', 'none', 'important');
                }
                if (state.minimapLocked) {
                    canvas.style.setProperty('pointer-events', 'none', 'important');
                } else {
                    canvas.style.setProperty('pointer-events', 'auto', 'important');
                }
            }
            // ─── CHANGE 7: Enforce Pits canvas visibility ─────────────────
            const pitsCanvas = document.getElementById(PITS_MINIMAP_CANVAS_ID);
            if (pitsCanvas) {
                pitsCanvas.style.setProperty('z-index', '2147483646', 'important');
                pitsCanvas.style.setProperty('pointer-events', 'none', 'important');
                if (state.minimapVisible && state.currentZone === 'The Pits') {
                    pitsCanvas.style.setProperty('display', 'block', 'important');
                    pitsCanvas.style.setProperty('visibility', 'visible', 'important');
                } else {
                    pitsCanvas.style.setProperty('display', 'none', 'important');
                }
            }
            // ──────────────────────────────────────────────────────────────
            if (!tab && state.uiHidden && !state.uiClosed) {
                createShowTab();
                document.getElementById('drednot-show-tab').style.setProperty('display','block','important');
            } else if (tab && state.uiHidden && !state.uiClosed) {
                tab.style.setProperty('display', 'block', 'important');
            }
        }, 150);
    }

    // ─── ensureUI ─────────────────────────────────────────────────────────────
    function ensureUI() {
        if (state.uiClosed) { getOrCreateMinimapCanvas(); return; }
        if (!document.getElementById('drednot-pro-panel')) {
            createUI();
            setGroupUI();
            updatePlayerList();
            updatePingButtonLabels();
            if (state.uiHidden) {
                const panel = document.getElementById('drednot-pro-panel');
                if (panel) panel.style.setProperty('display', 'none', 'important');
            }
        }
        if (state.uiHidden) createShowTab();
        getOrCreateMinimapCanvas();
    }

    function startMutationObserver() {
        const observer = new MutationObserver(() => ensureUI());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ─── Minimap canvas ───────────────────────────────────────────────────────
    function getOrCreateMinimapCanvas() {
        let c = document.getElementById(MINIMAP_CANVAS_ID);
        if (!c) {
            c = document.createElement('canvas');
            c.id = MINIMAP_CANVAS_ID;
            c.width  = MINIMAP.x1 - MINIMAP.x0;
            c.height = MINIMAP.y1 - MINIMAP.y0;
            c.style.cssText = `position:fixed;left:${MINIMAP.x0}px;top:${MINIMAP.y0}px;z-index:2147483646;pointer-events:none;border:1px solid rgba(255,255,255,0.5);background:rgba(0,0,0,0.20);display:none;`;
            document.body.appendChild(c);
            attachMinimapDragListeners(c);
            log('Minimap canvas created (hidden by default)');
        } else if (c.parentNode !== document.body) {
            document.body.appendChild(c);
        }
        c.style.setProperty('z-index', '2147483646', 'important');
        if (state.minimapVisible) {
            c.style.setProperty('display', 'block', 'important');
            c.style.setProperty('visibility', 'visible', 'important');
        } else {
            c.style.setProperty('display', 'none', 'important');
        }
        if (state.minimapLocked) {
            c.style.setProperty('pointer-events', 'none', 'important');
        } else {
            c.style.setProperty('pointer-events', 'auto', 'important');
        }
        return c;
    }

    function toggleMinimapVisibility() {
        state.minimapVisible = !state.minimapVisible;
        const canvas = getOrCreateMinimapCanvas();
        const btn = document.getElementById('btn-minimap-toggle');
        if (state.minimapVisible) {
            canvas.style.setProperty('display', 'block', 'important');
            canvas.style.setProperty('visibility', 'visible', 'important');
            if (btn) { btn.textContent = '🗺 Hide Minimap'; btn.style.background = '#4a5568'; }
        } else {
            canvas.style.setProperty('display', 'none', 'important');
            if (btn) { btn.textContent = '🗺 Show Minimap'; btn.style.background = '#2d6a9f'; }
        }
    }

    // ─── Minimap drag ─────────────────────────────────────────────────────────
    function attachMinimapDragListeners(canvas) {
        canvas.addEventListener('mousedown', (e) => {
            if (state.minimapLocked) return;
            state.minimapDrag.active = true;
            const rect = canvas.getBoundingClientRect();
            state.minimapDrag.ox = e.clientX - rect.left;
            state.minimapDrag.oy = e.clientY - rect.top;
            e.preventDefault(); e.stopPropagation();
        });
        document.addEventListener('mousemove', (e) => {
            if (!state.minimapDrag.active) return;
            const newLeft = e.clientX - state.minimapDrag.ox;
            const newTop  = e.clientY - state.minimapDrag.oy;
            canvas.style.setProperty('left', newLeft + 'px', 'important');
            canvas.style.setProperty('top',  newTop  + 'px', 'important');
            const hint = document.getElementById('drednot-minimap-drag-hint');
            if (hint) { hint.style.left = newLeft + 'px'; hint.style.top = (newTop - 18) + 'px'; }
        });
        document.addEventListener('mouseup', () => { state.minimapDrag.active = false; });
    }

    function toggleMinimapLock() {
        const canvas = getOrCreateMinimapCanvas();
        const btn    = document.getElementById('btn-minimap-move');
        if (state.minimapLocked) {
            const wasHidden = !state.minimapVisible;
            if (wasHidden) toggleMinimapVisibility();
            state.minimapLocked = false;
            canvas.style.setProperty('pointer-events', 'auto', 'important');
            canvas.style.setProperty('cursor', 'move', 'important');
            canvas.style.setProperty('border', '2px dashed #f59e0b', 'important');
            canvas.style.setProperty('opacity', '0.75', 'important');
            let hint = document.getElementById('drednot-minimap-drag-hint');
            if (!hint) { hint = document.createElement('div'); hint.id = 'drednot-minimap-drag-hint'; document.body.appendChild(hint); }
            const rect = canvas.getBoundingClientRect();
            hint.textContent = '✥ Drag to reposition — click 🔒 Lock to confirm';
            hint.style.display = 'block'; hint.style.left = rect.left + 'px'; hint.style.top = (rect.top - 18) + 'px'; hint.style.width = canvas.width + 'px';
            if (btn) { btn.textContent = '🔒 Lock Minimap'; btn.style.background = '#b45309'; }
            notify('Minimap unlocked — drag it, then click Lock Minimap');
        } else {
            state.minimapLocked = true;
            state.minimapDrag.active = false;
            const rawLeft = canvas.style.left || `${MINIMAP.x0}px`;
            const rawTop  = canvas.style.top  || `${MINIMAP.y0}px`;
            const newLeft = parseInt(rawLeft, 10);
            const newTop  = parseInt(rawTop,  10);
            const w = MINIMAP.x1 - MINIMAP.x0; const h = MINIMAP.y1 - MINIMAP.y0;
            MINIMAP.x0 = newLeft; MINIMAP.y0 = newTop; MINIMAP.x1 = newLeft + w; MINIMAP.y1 = newTop + h;
            saveMinimapPos();
            canvas.style.setProperty('pointer-events', 'none', 'important');
            canvas.style.setProperty('cursor', 'default', 'important');
            canvas.style.setProperty('border', '1px solid rgba(255,255,255,0.5)', 'important');
            canvas.style.setProperty('opacity', '1', 'important');
            const hint = document.getElementById('drednot-minimap-drag-hint');
            if (hint) hint.remove();
            if (btn) { btn.textContent = '✥ Move Minimap'; btn.style.background = '#2d6a4f'; }
            notify(`Minimap locked at (${newLeft}, ${newTop})`);
        }
    }

    // ─── CHANGE 5: The Pits canvas + renderer ────────────────────────────────
    function getOrCreatePitsCanvas() {
        let c = document.getElementById(PITS_MINIMAP_CANVAS_ID);
        if (!c) {
            c = document.createElement('canvas');
            c.id = PITS_MINIMAP_CANVAS_ID;
            c.width  = PITS_MINIMAP.x1 - PITS_MINIMAP.x0; // 120
            c.height = PITS_MINIMAP.y1 - PITS_MINIMAP.y0; // 45
            c.style.cssText = [
                'position:fixed',
                `left:${PITS_MINIMAP.x0}px`,
                `top:${PITS_MINIMAP.y0}px`,
                'z-index:2147483646',
                'pointer-events:none',
                'border:1px solid rgba(192,132,252,0.65)',
                'background:rgba(0,0,0,0.22)',
                'display:none'
            ].join('!important;') + '!important';
            document.body.appendChild(c);
            log('Pits minimap canvas created');
        } else if (c.parentNode !== document.body) {
            document.body.appendChild(c);
        }
        return c;
    }

    function renderPitsMinimap() {
        const inPits = state.currentZone === 'The Pits';
        const c = inPits ? getOrCreatePitsCanvas() : document.getElementById(PITS_MINIMAP_CANVAS_ID);
        if (!c) return;

        if (!state.minimapVisible || !inPits) {
            c.style.setProperty('display', 'none', 'important');
            return;
        }

        c.style.setProperty('display', 'block', 'important');
        c.style.setProperty('visibility', 'visible', 'important');
        c.style.setProperty('z-index', '2147483646', 'important');

        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);

        // Proportional grid lines (3 cols, 2 rows for 970×410 aspect)
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 0.6;
        for (let i = 1; i < 3; i++) {
            ctx.beginPath(); ctx.moveTo(i * c.width / 3, 0); ctx.lineTo(i * c.width / 3, c.height); ctx.stroke();
        }
        ctx.beginPath(); ctx.moveTo(0, c.height / 2); ctx.lineTo(c.width, c.height / 2); ctx.stroke();
        ctx.restore();

        // Zone label
        ctx.save();
        ctx.fillStyle = 'rgba(192,132,252,0.6)';
        ctx.font = 'bold 7px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('THE PITS', 3, 8);
        ctx.restore();

        // Shared renderer — uses current WORLD.w/h which is 970×410 in this zone
        renderMinimapToCtx(ctx, c.width, c.height, false);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ─── Coordinate helper ────────────────────────────────────────────────────
    function toMapXY(pos) {
        const xRel = Math.max(0, Math.min(1, pos.x / WORLD.w));
        const yRel = 1 - Math.max(0, Math.min(1, pos.y / WORLD.h));
        const width = MINIMAP.x1 - MINIMAP.x0; const height = MINIMAP.y1 - MINIMAP.y0;
        return { x: MINIMAP.x0 + xRel * width, y: MINIMAP.y0 + yRel * height, localX: xRel * width, localY: yRel * height, xRel, yRel };
    }

    // ─── UI creation ──────────────────────────────────────────────────────────
    function createUI() {
        const p = document.createElement('div');
        p.id = 'drednot-pro-panel';
        p.innerHTML = `
        <div id='drednot-pro-header' style='display:flex;justify-content:space-between;align-items:center;cursor:move;padding-bottom:4px;border-bottom:1px solid #3182ce;margin-bottom:4px;'>
            <b style='pointer-events:none;'>Drednot PRO v3.9</b>
            <div>
                <button id='drednot-hide'  title='Minimise' style='padding:2px 9px;font-size:15px;'>—</button>
                <button id='drednot-close' title='Close'    style='padding:2px 8px;font-size:13px;'>✕</button>
            </div>
        </div>
        <button id='btn-setwebhook' style='width:100%;margin-bottom:4px;background:#6b46c1;display:none;'>🔗 Set Webhook</button>
        <div id='my-id-row'>ID:<span id='my-id'>-</span> Group:<span id='my-group'>None</span></div>
        <input id='name-input' placeholder='Name' style='width:calc(100% - 10px);margin-top:4px;' />
        <input id='code-input' placeholder='Group code' style='width:calc(100% - 10px);margin-top:4px;' />
        <input id='password-input' type='password' placeholder='Group password (optional — encrypts positions)' />
        <div id='password-status'></div>
        <div id='btn-row-create-join'>
            <button id='btn-create' style='width:48%;background:#17a2b8;'>Create Group</button>
            <button id='btn-join'   style='width:48%;background:#38a169;'>Join Group</button>
        </div>
        <div id='btn-row-leave'><button id='btn-leave' style='width:100%;background:#e53e3e;display:none;'>Leave Group</button></div>
        <div id='btn-row-saved-groups' style='margin-top:2px;'>
            <button id='btn-saved-groups' style='width:100%;background:#553c9a;'>📌 Saved Groups</button>
        </div>
        <div id='admin-box' style='display:none;border:1px solid #718096;padding:4px;border-radius:5px;margin:4px 0;'>
            <button id='btn-disband'     style='width:48%;'>Disband</button>
            <button id='btn-change-code' style='width:48%;'>Change Code</button>
        </div>
        <div id='leader-box' style='display:none;margin:2px 0;'>
            <button id='btn-manage-members' style='width:100%;background:#7b2d8b;border:1px solid #a855f7;color:#e9d5ff;'>👥 Manage Members</button>
        </div>
        <div id='ping-row'>
            <button id='btn-punch'  style='background:#00cc00;'>Punch Support</button>
            <button id='btn-dmg'    style='background:#ff8c00;'>Dmg Support</button>
            <button id='btn-enemy'  style='background:#ff3333;'>Enemy</button>
        </div>
        <div id='btn-row-keybinds' style='margin-top:2px;'>
            <button id='btn-keybinds' style='width:100%;background:#1e3a5f;'>⌨ Set Keybinds</button>
        </div>
        <button id='btn-setstatus' style='width:100%;margin-top:4px;'>Set Ship Status</button>
        <input id='status-input' placeholder='Ship status message...' style='width:calc(100% - 10px);margin-top:2px;' />
        <div id='team-count-row' style='margin-top:4px;font-size:12px;'>Team (<span id='team-count'>0</span>):</div>
        <div id='team-list' style='max-height:180px;overflow:auto;background:rgba(0,0,0,0.2);padding:4px;border-radius:4px;position:relative;z-index:2147483647;pointer-events:auto;'></div>
        <div id='cd-row'>Cooldowns: <span id='cd-info'></span></div>
        <button id='btn-autohide' style='width:100%;margin-top:2px;'>Combat Mode: OFF</button>
        <label id='zoom-row'>Zoom<input id='zoom-slider' type='range' min='0.5' max='2' step='0.1' value='1' /></label>
        <div style='display:flex;gap:4px;margin-top:4px;'>
            <button id='btn-minimap-toggle' style='flex:1;background:#2d6a9f;'>🗺 Show Minimap</button>
            <button id='btn-minimap-move'   style='flex:1;background:#2d6a4f;'>✥ Move Minimap</button>
        </div>
        <div id='drednot-dbg-box'>Debug loading...</div>
        `;

        document.body.appendChild(p);
        state.uiCreated = true;

        document.getElementById('drednot-close').onclick      = closePanel;
        document.getElementById('drednot-hide').onclick       = hidePanel;
        document.getElementById('btn-create').onclick         = createGroup;
        document.getElementById('btn-join').onclick           = joinGroup;
        document.getElementById('btn-leave').onclick          = leaveGroup;
        document.getElementById('btn-disband').onclick        = disbandGroup;
        document.getElementById('btn-change-code').onclick    = changeCode;
        document.getElementById('btn-manage-members').onclick = showManageMembersMenu;
        document.getElementById('btn-punch').onclick          = punchSupport;
        document.getElementById('btn-dmg').onclick            = dmgSupport;
        document.getElementById('btn-enemy').onclick          = enemyPing;
        document.getElementById('btn-setstatus').onclick      = () => setStatus(document.getElementById('status-input').value);
        document.getElementById('btn-autohide').onclick       = () => { state.combatMode = !state.combatMode; updateCombatMode(); };
        document.getElementById('zoom-slider').oninput        = (e) => { state.zoom = parseFloat(e.target.value); };
        document.getElementById('btn-setwebhook').onclick     = showWebhookMenu;
        document.getElementById('btn-minimap-move').onclick   = toggleMinimapLock;
        document.getElementById('btn-minimap-toggle').onclick = toggleMinimapVisibility;
        document.getElementById('btn-keybinds').onclick       = showKeybindsMenu;
        document.getElementById('btn-saved-groups').onclick   = () => {
            if (state.me.group) { saveCurrentGroup(); }
            else { showSavedGroupsMenu(); }
        };

        const nameInput = document.getElementById('name-input');
        if (nameInput) {
            nameInput.addEventListener('input', () => { saveName(nameInput.value.trim()); });
        }

        makePanelDraggable(p);
    }

    // ─── Debug overlay ────────────────────────────────────────────────────────
    let dbgTick = 0;
    function updateDebugBox() {
        dbgTick++;
        if (dbgTick % 30 !== 0) return;
        const box = document.getElementById('drednot-dbg-box');
        if (!box) return;
        const myPos = getPlayerPos();
        const livePosEntries = Object.entries(state.livePositions);
        const wsState = ['CONNECTING','OPEN','CLOSING','CLOSED'][state.ws ? state.ws.readyState : 3];
        const canvas  = document.getElementById(MINIMAP_CANVAS_ID);
        const whName  = state.currentWebhook ? state.currentWebhook.name : 'none';
        const kbStr   = `P:${state.keybinds.punch||'-'} D:${state.keybinds.dmg||'-'} E:${state.keybinds.enemy||'-'}`;
        const encStr  = state.crypto.encKey ? '🔒 ON' : '🔓 OFF';
        const lines = [
            `WS: ${wsState} | Group: ${state.me.group || 'none'} | MyID: ${state.me.id || '?'}`,
            `MyPos: ${myPos ? `(${myPos.x.toFixed(0)}, ${myPos.y.toFixed(0)})` : 'NOT FOUND'} | Zone: ${state.currentZone || '?'}`,
            `Stealth: ${state.me.isStealth} | Leader: ${state.me.isLeader} | E2E Enc: ${encStr}`,
            `Webhook: ${whName} | Saved groups: ${state.savedGroups.length}`,
            `Minimap: (${MINIMAP.x0}, ${MINIMAP.y0}) ${state.minimapLocked ? '🔒' : '🔓 MOVING'} ${state.minimapVisible ? '👁' : '🚫'}`,
            `Keybinds: ${kbStr}`,
            `posSent: ${state.dbg.posSent} | posRcvd: ${state.dbg.posReceived}`,
            `posStored: ${state.dbg.posStored} | posDropped: ${state.dbg.posDropped}`,
            `livePositions (${livePosEntries.length}):`,
            ...livePosEntries.map(([pid, p]) => {
                const age = ((now() - p.ts) / 1000).toFixed(1);
                return `  ${p.name} pid=${pid.slice(0,8)} age=${age}s (${p.x?.toFixed(0)},${p.y?.toFixed(0)})`;
            }),
            `Canvas: ${canvas ? `${canvas.width}x${canvas.height} parent=${canvas.parentNode?.tagName}` : 'MISSING'}`,
            state.dbg.lastRaw ? `lastRaw: ${JSON.stringify(state.dbg.lastRaw).slice(0,120)}` : 'lastRaw: none'
        ];
        box.textContent = lines.join('\n');
    }

    // ─── Drag ─────────────────────────────────────────────────────────────────
    function makePanelDraggable(panel) {
        const header = panel.querySelector('#drednot-pro-header');
        if (!header) { log('drag: header not found'); return; }
        let dragging = false, ox = 0, oy = 0;
        header.addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            ox = e.clientX - rect.left; oy = e.clientY - rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.setProperty('left', (e.clientX - ox) + 'px', 'important');
            panel.style.setProperty('top',  (e.clientY - oy) + 'px', 'important');
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    // ─── Close / Hide / Show ──────────────────────────────────────────────────
    function closePanel() {
        state.uiClosed = true; state.uiHidden = false;
        const panel = document.getElementById('drednot-pro-panel');
        if (panel) panel.remove();
        const tab = document.getElementById('drednot-show-tab');
        if (tab) tab.style.setProperty('display', 'none', 'important');
    }

    function hidePanel() {
        state.uiHidden = true;
        const panel = document.getElementById('drednot-pro-panel');
        if (panel) panel.style.setProperty('display', 'none', 'important');
        createShowTab();
        const tab = document.getElementById('drednot-show-tab');
        if (tab) tab.style.setProperty('display', 'block', 'important');
    }

    function showPanel() {
        state.uiHidden = false;
        const tab = document.getElementById('drednot-show-tab');
        if (tab) tab.style.setProperty('display', 'none', 'important');
        let panel = document.getElementById('drednot-pro-panel');
        if (panel) {
            panel.style.setProperty('display', 'block', 'important');
        } else if (!state.uiClosed) {
            createUI(); setGroupUI(); updatePlayerList(); updatePingButtonLabels();
        }
    }

    // ─── Combat mode ─────────────────────────────────────────────────────────
    function updateCombatMode() {
        const panel = document.getElementById('drednot-pro-panel');
        const btn   = document.getElementById('btn-autohide');
        if (!panel || !btn) return;
        if (state.combatMode) {
            btn.innerText = 'Combat Mode: ON';
            COMBAT_HIDE_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.style.setProperty('display', 'none', 'important'); });
            ['name-input','code-input','password-input','status-input'].forEach(id => { const el = document.getElementById(id); if (el) el.style.setProperty('display', 'none', 'important'); });
            panel.style.setProperty('width',  '200px', 'important');
            panel.style.setProperty('height', 'auto',  'important');
            panel.style.setProperty('resize', 'none',  'important');
            panel.style.setProperty('overflow', 'visible', 'important');
        } else {
            btn.innerText = 'Combat Mode: OFF';
            COMBAT_HIDE_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.style.removeProperty('display'); });
            ['name-input','code-input','password-input','status-input'].forEach(id => { const el = document.getElementById(id); if (el) el.style.removeProperty('display'); });
            panel.style.setProperty('width',  '340px', 'important');
            panel.style.setProperty('height', '560px', 'important');
            panel.style.setProperty('resize', 'both',  'important');
            panel.style.setProperty('overflow', 'auto', 'important');
            setGroupUI();
        }
    }

    // ─── Group UI helpers ─────────────────────────────────────────────────────
    function setGroupUI() {
        const inGroup = !!state.me.group;
        const el = id => document.getElementById(id);
        if (!el('btn-create')) return;

        if (!state.combatMode) {
            el('btn-create').style.display = inGroup ? 'none' : 'inline-block';
            el('btn-join').style.display   = inGroup ? 'none' : 'inline-block';
            el('btn-leave').style.display  = inGroup ? 'block' : 'none';
            el('admin-box').style.display  = (state.me.isAdmin && inGroup) ? 'block' : 'none';

            const leaderBox = el('leader-box');
            if (leaderBox) leaderBox.style.display = (state.me.isLeader && inGroup) ? 'block' : 'none';

            const pwInput = el('password-input');
            if (pwInput) pwInput.style.display = inGroup ? 'none' : '';
            updatePasswordStatus();

            const sgBtn = el('btn-saved-groups');
            if (sgBtn) {
                if (inGroup) {
                    const alreadySaved = !!state.savedGroups.find(g => g.code === state.me.group);
                    if (alreadySaved) {
                        sgBtn.textContent = '✅ Group Saved'; sgBtn.style.background = '#276749';
                        sgBtn.disabled = true; sgBtn.title = 'This group is already in your saved list';
                    } else {
                        sgBtn.textContent = '📌 Save Current Group'; sgBtn.style.background = '#553c9a';
                        sgBtn.disabled = false; sgBtn.title = 'Save this group so it stays alive even when empty';
                    }
                } else {
                    const count = state.savedGroups.length;
                    sgBtn.textContent = count > 0 ? `📌 Saved Groups (${count})` : '📌 Saved Groups';
                    sgBtn.style.background = '#553c9a'; sgBtn.disabled = false;
                    sgBtn.title = 'View and join your saved groups';
                }
            }

            const wbtn = el('btn-setwebhook');
            if (wbtn) {
                const showWebhookBtn = !inGroup || (inGroup && state.me.isAdmin);
                wbtn.style.display = showWebhookBtn ? 'block' : 'none';
                wbtn.textContent = state.currentWebhook ? `🔗 Webhook: ${state.currentWebhook.name}` : '🔗 Set Webhook';
            }
        }
    }

    // ─── Player list ──────────────────────────────────────────────────────────
    function updatePlayerList() {
        const el = id => document.getElementById(id);
        if (!el('my-id')) return;
        el('my-id').innerText    = state.me.id    || '-';
        el('my-group').innerText = state.me.group || 'None';
        const list = el('team-list');
        list.innerHTML = '';

        if (!state.me.isStealth) {
            const myHpData = getShipHp();
            const myDiv = document.createElement('div');
            myDiv.style.cssText = 'border-bottom:1px solid #555;padding:3px 0;position:relative;z-index:2147483647;';
            let myHtml = `<b style="color:#a0cfff;">${state.me.name || 'Me'}</b> <small style="color:#aaa;">(you)</small>`;
            if (state.me.status && state.me.status.trim()) {
                myHtml += `<div style="margin-top:1px;"><small style="color:#7dd3fc;font-size:10px;">📋 ${state.me.status}</small></div>`;
            }
            if (myHpData) {
                myHtml += buildHpBar(myHpData.hp, myHpData.maxHp);
            }
            myDiv.innerHTML = myHtml;
            list.appendChild(myDiv);
        }

        const players = Object.entries(state.players);
        players.forEach(([pid, p]) => {
            if (pid === state.me.id) return;

            const div = document.createElement('div');
            div.style.cssText = 'border-bottom:1px solid #444;padding:3px 0;position:relative;z-index:2147483647;pointer-events:auto;display:flex;flex-direction:column;gap:1px;';

            const topRow = document.createElement('div');
            topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

            const nameSpan = document.createElement('span');
            nameSpan.innerHTML = `<b>${p.name}</b> ${p.isAdmin ? ADMIN_EMOJI : ''}`;
            topRow.appendChild(nameSpan);

            if (state.me.isAdmin && pid !== state.me.id) {
                const kickBtn = document.createElement('button');
                kickBtn.textContent = 'Kick';
                kickBtn.style.cssText = 'background:#7f1d1d !important;color:#fca5a5 !important;border:1px solid #ef4444 !important;border-radius:3px !important;padding:1px 6px !important;font-size:10px !important;cursor:pointer !important;margin-left:4px !important;';
                kickBtn.onclick = (e) => { e.stopPropagation(); if (confirm(`Kick ${p.name} from the group?`)) { wsSend({ type: 'kick', target: pid }); } };
                topRow.appendChild(kickBtn);
            }

            div.appendChild(topRow);

            if (p.status) {
                const sub = document.createElement('small');
                sub.style.cssText = 'color:#7dd3fc;font-size:10px;';
                sub.textContent = '📋 ' + p.status;
                div.appendChild(sub);
            }

            const liveData = state.livePositions[pid];
            if (liveData && typeof liveData.hp === 'number' && typeof liveData.maxHp === 'number' && liveData.maxHp > 0) {
                const hpWrap = document.createElement('div');
                hpWrap.innerHTML = buildHpBar(liveData.hp, liveData.maxHp);
                div.appendChild(hpWrap);
            }

            list.appendChild(div);
        });

        el('team-count').innerText = Object.keys(state.players).length;
        el('cd-info').innerText = `P:${Math.max(0,state.cooldown.punch-now())} D:${Math.max(0,state.cooldown.dmg-now())}`;
        setGroupUI();
    }

    // ─── Player position ──────────────────────────────────────────────────────
    function getPlayerPos() {
        const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
        if (!root) return state.lastKnownPos || null;
        const interstellar = root.Interstellar || window.Interstellar;
        if (!interstellar) return state.lastKnownPos || null;
        let pos = null;
        if (interstellar.patcher && typeof interstellar.patcher.getPlayerPosition === 'function') {
            pos = interstellar.patcher.getPlayerPosition();
        } else if (interstellar.player && interstellar.player.position) {
            pos = interstellar.player.position;
        } else if (interstellar.player && interstellar.player.transform && interstellar.player.transform.position) {
            pos = interstellar.player.transform.position;
        }
        if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
            state.lastKnownPos = {x: pos.x, y: pos.y};
            return state.lastKnownPos;
        }
        return state.lastKnownPos || null;
    }

    function updateWorldSize() {
        const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
        const api = root.StellarAPI || window.StellarAPI;
        if (!api || !api.Game || typeof api.Game.getCurrentZone !== 'function') return;
        const zone = api.Game.getCurrentZone();
        if (!zone) return;
        state.currentZone = zone;
        // ─── CHANGE 2: Added The Pits world dimensions ────────────────────
        if (zone === 'Raven')           { WORLD.w = 1600; WORLD.h = 1600; }
        else if (zone === 'Falcon')     { WORLD.w = 3600; WORLD.h = 3600; }
        else if (zone === 'Freeport')   { WORLD.w = 1200; WORLD.h = 1200; }
        else if (zone === 'The Pits')   { WORLD.w = 970;  WORLD.h = 410;  }
        // ─────────────────────────────────────────────────────────────────
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────
    function wsSend(data) { if (state.ws && state.ws.readyState === WebSocket.OPEN) { state.ws.send(JSON.stringify(data)); } }

    function connectWS() {
        state.ws = new WebSocket(BACKEND_URL);
        state.ws.onopen = () => {
            log('WS opened to', BACKEND_URL);
            const ni = document.getElementById('name-input');
            const name = (ni && ni.value.trim()) || state.me.name || 'Player' + Math.floor(Math.random() * 1000);
            state.me.name = name;
            wsSend({type: 'hello', name});
        };
        state.ws.onclose = (e) => { log('WS closed', e.code, e.reason); setTimeout(connectWS, 1500); };
        state.ws.onerror = e => { log('WS error', e); };
        state.ws.onmessage = e => {
            log('[WS RAW]', e.data);
            let m;
            try { m = JSON.parse(e.data); } catch (err) { log('INVALID WS JSON', e.data); return; }

            if (m.type === 'pos_update') {
                state.dbg.posReceived++;
                if (m.id === state.me.id) return;

                if (m.enc) {
                    if (state.crypto.encKey) {
                        cryptoDecryptPos(state.crypto.encKey, m.enc).then(plain => {
                            if (!plain) { state.dbg.posDropped++; return; }
                            state.livePositions[m.id] = {
                                name: m.name || m.id,
                                x: plain.x, y: plain.y,
                                zone: plain.zone || null,
                                hp:    typeof plain.hp    === 'number' ? plain.hp    : null,
                                maxHp: typeof plain.maxHp === 'number' ? plain.maxHp : null,
                                ts: now()
                            };
                            state.dbg.posStored++;
                        });
                    } else {
                        state.dbg.posDropped++;
                    }
                } else {
                    state.livePositions[m.id] = {
                        name: m.name || m.id, x: m.x, y: m.y, zone: m.zone || null,
                        hp:    typeof m.hp    === 'number' ? m.hp    : null,
                        maxHp: typeof m.maxHp === 'number' ? m.maxHp : null,
                        ts: now()
                    };
                    state.dbg.posStored++;
                }
            }

            if (m.type === 'welcome') {
                state.me.id      = m.id;
                state.me.name    = m.name;
                state.me.group   = m.group;
                state.me.isAdmin = m.isAdmin;
                state.me.isStealth = m.isStealth || false;
                const ni = document.getElementById('name-input');
                if (ni) ni.value = state.me.name;
                setGroupUI(); updatePlayerList();

                if (state.savedGroups.length > 0) {
                    wsSend({ type: 'pin_groups', codes: state.savedGroups.map(g => g.code) });
                    log('Re-pinned', state.savedGroups.length, 'saved groups with server');
                }
            }

            if (m.type === 'joined') {
                state.me.group   = m.code;
                state.me.isAdmin = m.isAdmin;
                setGroupUI();
                updatePlayerList();

                if (state.crypto.pendingPassword) {
                    const pw   = state.crypto.pendingPassword;
                    const code = m.code;
                    state.crypto.pendingPassword = null;
                    cryptoDeriveKeys(pw, code).then(keys => {
                        state.crypto.encKey    = keys.encKey;
                        state.crypto.authToken = keys.authToken;
                        state.crypto.password  = pw;
                        wsSend({ type: 'set_group_auth', authToken: keys.authToken });
                        updatePasswordStatus();
                        log('🔒 E2E encryption active for group', code);
                        notify('🔒 Group is now end-to-end encrypted');
                    }).catch(e => log('Key derivation failed on create:', e));
                }

                if (m.recreated) { notify('🔄 Group ' + m.code + ' recreated! Others can now rejoin.'); }
                else             { notify('Joined ' + m.code); }
            }

            if (m.type === 'left') {
                state.me.group    = null;
                state.me.isAdmin  = false;
                state.me.isLeader = false;
                state.players = {};
                state.livePositions = {};
                cryptoClear();
                setGroupUI();
                updatePlayerList();
            }

            if (m.type === 'disbanded') {
                state.me.group    = null;
                state.me.isAdmin  = false;
                state.me.isLeader = false;
                state.players = {};
                state.livePositions = {};
                cryptoClear();
                setGroupUI();
                updatePlayerList();
                notify('Group disbanded');
            }

            if (m.type === 'group_update') {
                state.players = m.players || {};
                state.me.isAdmin   = !!(state.players[state.me.id] && state.players[state.me.id].isAdmin);
                state.me.isLeader  = m.leader === state.me.id;
                enforceGroupBans(state.me.group, state.players);
                updatePlayerList();
            }

            if (m.type === 'group_auth_status') {
                if (!m.protected) {
                    if (!state.me.isLeader) {
                        cryptoClear();
                        notify('🔓 Group password protection was removed');
                    }
                }
                setGroupUI();
            }

            if (m.type === 'auth_set') {
                log('Server confirmed auth token for group', m.code, '| protected:', m.protected);
            }

            if (m.type === 'saved_groups_info') {
                if (state.pendingSavedGroupsUpdate) {
                    state.pendingSavedGroupsUpdate(m.groups);
                    state.pendingSavedGroupsUpdate = null;
                }
            }

            if (m.type === 'pin_ack') { log('Server confirmed pin for group', m.code); }

            if (m.type === 'webhook_update') {
                if (m.webhook) {
                    const exists = state.webhooks.find(w => w.url === m.webhook.url);
                    if (!exists) { state.webhooks.push(m.webhook); saveWebhooks(); }
                    state.currentWebhook = m.webhook;
                    notify('Group webhook set: ' + m.webhook.name);
                } else {
                    state.currentWebhook = null;
                    notify('Group webhook cleared');
                }
                setGroupUI();
            }

            if (m.type === 'ping') {
                log('[ping recv]', JSON.stringify(m));
                state.dbg.lastRaw = {
                    tag: m.tag, pid: m.pid, by: m.by,
                    id: m.id, x: m.x, y: m.y
                };

                if (m.tag === 'pos') {
                    state.dbg.posReceived++;
                    let playerKey = m.pid;
                    if (!playerKey && m.id) {
                        const parts = m.id.split('-');
                        if (parts.length >= 2) playerKey = parts[1];
                    }
                    if (!playerKey && m.by) { playerKey = 'name:' + m.by; }
                    if (!playerKey) {
                        state.dbg.posDropped++;
                    } else if (playerKey === state.me.id) {
                        // own echo — ignore
                    } else {
                        state.livePositions[playerKey] = {
                            name: m.by || playerKey,
                            x: m.x, y: m.y,
                            hp: null, maxHp: null,
                            ts: now()
                        };
                        state.dbg.posStored++;
                    }
                } else {
                    addPing(m);
                }
            }

            if (m.type === 'error') { log('server error', m.message); }
        };
    }

    // ─── Group actions ────────────────────────────────────────────────────────
    async function createGroup() {
        const name = document.getElementById('name-input').value.trim();
        if (!name) { alert('Name required'); return; }
        state.me.name = name; saveName(name);

        const pwEl = document.getElementById('password-input');
        const password = pwEl ? pwEl.value.trim() : '';
        if (password) {
            state.crypto.pendingPassword = password;
            log('Password set — will derive keys after receiving group code');
        } else {
            state.crypto.pendingPassword = null;
            cryptoClear();
        }

        wsSend({type: 'create', name});
    }

    async function joinGroup() {
        const name = document.getElementById('name-input').value.trim();
        const code = document.getElementById('code-input').value.trim().toUpperCase();
        if (!name || !code) { alert('Name + code required'); return; }
        state.me.name = name; saveName(name);

        const pwEl = document.getElementById('password-input');
        const password = pwEl ? pwEl.value.trim() : '';

        let authToken = null;
        if (password) {
            try {
                const keys = await cryptoDeriveKeys(password, code);
                authToken = keys.authToken;
                state.crypto.encKey    = keys.encKey;
                state.crypto.authToken = keys.authToken;
                state.crypto.password  = password;
                log('🔒 Keys derived for join — auth token ready');
            } catch (e) {
                log('Key derivation failed:', e);
                alert('Crypto error — could not derive keys from password. Check console.');
                return;
            }
        } else {
            cryptoClear();
        }

        wsSend({type: 'join', name, code, authToken});
    }

    function leaveGroup()   { wsSend({type: 'leave'}); }
    function disbandGroup() { if (!confirm('Disband the group for everyone?')) return; wsSend({type: 'disband'}); }

    function changeCode() {
        const code = prompt('New group code (6 char):');
        if (!code) return;
        const newCode = code.trim().toUpperCase();
        wsSend({type: 'change_code', code: newCode});

        if (state.crypto.password) {
            const pw = state.crypto.password;
            cryptoDeriveKeys(pw, newCode).then(keys => {
                state.crypto.encKey    = keys.encKey;
                state.crypto.authToken = keys.authToken;
                wsSend({ type: 'set_group_auth', authToken: keys.authToken });
                log('🔒 Re-derived keys for new code', newCode);
                notify('🔒 Encryption keys updated for new code');
            }).catch(e => log('Re-derive failed after code change:', e));
        }
    }

    function setStatus(text) {
        state.me.status = text ? text.trim() : 'Ready';
        wsSend({type: 'status', status: state.me.status, ship: ''});
        updatePlayerList();
    }

    // ─── Pings ────────────────────────────────────────────────────────────────
    function ping(type) {
        const pos = getPlayerPos(); if (!pos) { notify('Position not available'); return; }
        if (now() < state.cooldown[type]) { notify('cooldown'); return; }
        const color = type === 'punch' ? SUPPORT_COLOR : type === 'dmg' ? DMG_COLOR : ENEMY_COLOR;
        const payload = {type: 'ping', tag: type, x: pos.x, y: pos.y, color, by: state.me.name, id: `${state.me.id}-${now()}`};
        wsSend(payload); addPing(payload);
        state.cooldown[type] = now() + COOLDOWNS[type];
        updatePlayerList();
        const sound = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-fast-game-notification-946.wav');
        sound.volume = 0.5; sound.play().catch(() => {});
    }

    function punchSupport() { ping('punch'); }
    function dmgSupport()   { ping('dmg'); }
    function enemyPing() {
        const pos = getPlayerPos();
        if (!pos) { notify('Position not available'); return; }
        if (now() < state.cooldown['enemy']) { notify('cooldown'); return; }
        const color = ENEMY_COLOR;
        const payload = {type: 'ping', tag: 'enemy', x: pos.x, y: pos.y, color, by: state.me.name, id: `${state.me.id}-${now()}`};
        wsSend(payload); addPing(payload);
        state.cooldown['enemy'] = now() + COOLDOWNS['dmg'];
        updatePlayerList();
        const sound = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-fast-game-notification-946.wav');
        sound.volume = 0.5; sound.play().catch(() => {});
        sendEnemyPingWebhook(pos);
    }

    function addPing(p) { state.pings.push(Object.assign({ts: now(), alpha: 1}, p)); }

    // ─── Global keybind handler ───────────────────────────────────────────────
    function setupGlobalKeybinds() {
        document.addEventListener('keydown', (e) => {
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (document.getElementById('keybinds-menu')) return;
            const key = e.key;
            if (state.keybinds.punch && key === state.keybinds.punch) { e.preventDefault(); punchSupport(); }
            else if (state.keybinds.dmg && key === state.keybinds.dmg) { e.preventDefault(); dmgSupport(); }
            else if (state.keybinds.enemy && key === state.keybinds.enemy) { e.preventDefault(); enemyPing(); }
        });
    }

    // ─── Live position broadcast ──────────────────────────────────────────────
    async function sendLivePosition() {
        if (!state.me.group || !state.me.id) return;
        if (state.me.isStealth) return;
        const pos = getPlayerPos();
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
        const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
        const api = root.StellarAPI || window.StellarAPI;
        let ship = null; let zone = null;
        if (api && api.currentShip) {
            ship = { health: api.currentShip.health, max_health: api.currentShip.max_health, hex: api.currentShip.hex, name: api.currentShip.name, warp_time: api.currentShip.warp_time, max_warp_time: api.currentShip.max_warp_time };
        }
        if (api && api.Game && typeof api.Game.getCurrentZone === 'function') { zone = api.Game.getCurrentZone(); }
        if (!state.me.group) return;
        if (!state.ws || state.ws.readyState !== 1) return;

        if (state.crypto.encKey) {
            try {
                const plainData = {
                    x: pos.x, y: pos.y, zone,
                    hp:    ship ? ship.health     : null,
                    maxHp: ship ? ship.max_health : null,
                    ship,
                };
                const enc = await cryptoEncryptPos(state.crypto.encKey, plainData);
                state.ws.send(JSON.stringify({ type: 'pos_update', enc }));
            } catch (e) {
                log('Encryption error in sendLivePosition:', e);
            }
        } else {
            state.ws.send(JSON.stringify({
                type: 'pos_update', x: pos.x, y: pos.y, zone,
                hp:    ship ? ship.health     : null,
                maxHp: ship ? ship.max_health : null,
                ship
            }));
        }
        state.dbg.posSent++;
    }

    // ─── Minimap render (live overlay) ────────────────────────────────────────
    function renderMinimap() {
        if (!state.minimapVisible || !state.minimapLocked) return;
        const c = getOrCreateMinimapCanvas();
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
        renderMinimapToCtx(ctx, c.width, c.height, false);

        const t = now();
        const center = {x: c.width / 2, y: c.height / 2};
        state.pings.filter(p => p.tag === 'enemy').forEach(p => {
            const age = t - p.ts;
            if (age > state.fade) return;
            const mp = toMapXY(p);
            let dx = mp.localX - center.x; let dy = mp.localY - center.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 20) return;
            dx /= dist; dy /= dist;
            const ax = center.x + dx * (c.width / 2 - 10);
            const ay = center.y + dy * (c.height / 2 - 10);
            ctx.save(); ctx.translate(ax, ay); ctx.rotate(Math.atan2(dy, dx));
            ctx.fillStyle = 'rgba(255,50,50,0.9)';
            ctx.beginPath(); ctx.moveTo(0,-8); ctx.lineTo(12,0); ctx.lineTo(0,8); ctx.closePath(); ctx.fill();
            ctx.restore();
        });

        const staleMs = 3500;
        Object.keys(state.livePositions).forEach(pid => {
            if (now() - state.livePositions[pid].ts > staleMs) delete state.livePositions[pid];
        });

        // ─── CHANGE 6: Render Pits minimap alongside main minimap ─────────
        renderPitsMinimap();
        // ──────────────────────────────────────────────────────────────────
    }

    // ─── Low HP check ─────────────────────────────────────────────────────────
    function lowHpCheck() {
        const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
        const api = root.StellarAPI || window.StellarAPI;
        if (!api || !api.currentShip) return;
        const ship = api.currentShip;
        const hp = ship.health, maxHp = ship.max_health;
        if (typeof hp !== 'number') return;
        if (hp < 2000 && now() > state.cooldown.lowhp) {
            state.cooldown.lowhp = now() + COOLDOWNS.lowhp;
            const pos = getPlayerPos(); if (!pos) return;
            const xy = toMapXY(pos);
            const c = document.createElement('div');
            c.textContent = '✚';
            c.style.cssText = `position:fixed;left:${xy.x-10}px;top:${xy.y-10}px;font-size:26px;color:${WARNING_COLOR};z-index:99999999;`;
            document.body.appendChild(c); setTimeout(() => c.remove(), 2500);
            notify(`LOW HP! (${hp}/${maxHp})`);
            wsSend({type:'ping', tag:'lowhp', x:pos.x, y:pos.y, color:WARNING_COLOR, by:state.me.name, id:`lhp-${now()}`});
        }
    }

    // ─── Canvas hook ──────────────────────────────────────────────────────────
    (function hookCanvas() {
        const original = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function(...args) {
            const res = original.apply(this, args);
            try { if (this.canvas === document.getElementById(MINIMAP_CANVAS_ID)) renderMinimap(); } catch(e) {}
            return res;
        };
    })();

    // ─── Main loop ────────────────────────────────────────────────────────────
    function mainLoop() {
        updateWorldSize();
        ensureUI();
        renderMinimap();
        lowHpCheck();
        updatePlayerList();
        updateDebugBox();
        requestAnimationFrame(mainLoop);
    }

    function checkCombat() { state.inCombat = !!(window.Interstellar && window.Interstellar.player && window.Interstellar.player.inCombat); }

    // ─── Wait for Interstellar ────────────────────────────────────────────────
    function waitForInterstellar(callback) {
        const maxAttempts = 100;
        let attempts = 0;
        const interval = setInterval(() => {
            const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
            const interstellar = root.Interstellar || window.Interstellar;
            if (interstellar && (interstellar.player || interstellar.patcher)) {
                log('Interstellar detected ✅'); clearInterval(interval); setTimeout(callback, 1000);
            } else {
                attempts++;
                if (attempts % 10 === 0) log('Waiting for Interstellar...');
                if (attempts > maxAttempts) { log('Interstellar not found, starting anyway...'); clearInterval(interval); callback(); }
            }
        }, 100);
    }

    function startScript() {
        log('Starting AFTER Interstellar');
        loadWebhooks();
        loadSavedGroups();
        loadBanLists();
        loadMinimapPos();
        loadKeybinds();

        addStyles();
        createUI();
        updatePingButtonLabels();

        const savedName = loadName();
        if (savedName) {
            const nameInput = document.getElementById('name-input');
            if (nameInput) nameInput.value = savedName;
            state.me.name = savedName;
        }

        const panel = document.getElementById('drednot-pro-panel');
        if (panel) panel.style.setProperty('display', 'none', 'important');
        createShowTab();
        const tab = document.getElementById('drednot-show-tab');
        if (tab) tab.style.setProperty('display', 'block', 'important');

        const canvas = getOrCreateMinimapCanvas();
        canvas.style.setProperty('left', MINIMAP.x0 + 'px', 'important');
        canvas.style.setProperty('top',  MINIMAP.y0 + 'px', 'important');

        setupGlobalKeybinds();

        connectWS();
        setInterval(checkCombat, 800);
        setInterval(sendLivePosition, 1000);
        setInterval(() => { if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({type: 'ping_keepalive'})); }, 15000);
        startEnforceLoop();
        startMutationObserver();
        mainLoop();
        
        fetch("https://raw.githubusercontent.com/PshsayhiXD/e/main/VERSION")
          .then(r => r.text())
          .then(v => {
            if(v.trim() !== currentVer) notify("New update available! :", v);
          });
    }

    waitForInterstellar(startScript);
})();

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const InterstellarScriptingMod = __importDefault(require("@interstellar/InterstellarScriptingMod"));
class MinimapVisualizer extends InterstellarScriptingMod.default {

    preload() {
        // call your start function here
    }

    load() {

    }
}exports.default = MinimapVisualizer;
