const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_USERNAME = 'Kyroxify';
const DB_FILE = path.join(__dirname, 'db.json');

// --- Persistent Storage Helpers ---
let db = {
    userProfiles: {},   
    usernamesToUid: {}, 
    chatHistory: { 'Yaply': [] },
    groups: {} 
};

if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!db.chatHistory) db.chatHistory = { 'Yaply': [] };
        if (!db.usernamesToUid) db.usernamesToUid = {};
        if (!db.userProfiles) db.userProfiles = {};
        if (!db.groups) db.groups = {};
    } catch (err) {
        console.error('Error reading db.json:', err);
    }
}

function saveDB() {
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), (err) => {
        if (err) console.error('Error saving db.json:', err);
    });
}

function getDmRoomKey(user1, user2) {
    return [user1, user2].sort().join('__');
}

let activeSockets = {}; 

io.on('connection', (socket) => {
    
    // Auth & Auto-Reconnect
    socket.on('check_auth', ({ uid }) => {
        if (db.userProfiles[uid]) {
            const user = db.userProfiles[uid];
            activeSockets[socket.id] = user.username;
            socket.username = user.username;
            
            const userGroups = Object.entries(db.groups)
                .filter(([id, g]) => g.members.includes(user.username))
                .map(([id, g]) => ({ id, name: g.name }));

            socket.emit('auth_result', { exists: true, user, groups: userGroups });
            io.emit('online_users', Object.values(activeSockets));
        } else {
            socket.emit('auth_result', { exists: false, uid });
        }
    });

    socket.on('register_new_user', ({ uid, username, dob, bio, pfp }) => {
        const cleanUsername = username.trim();
        const lowerName = cleanUsername.toLowerCase();

        if (db.usernamesToUid[lowerName] && db.usernamesToUid[lowerName] !== uid) {
            return socket.emit('register_error', 'Username taken!');
        }

        const isKyroxify = lowerName === ADMIN_USERNAME.toLowerCase();
        const finalUsername = isKyroxify ? ADMIN_USERNAME : cleanUsername;
        const joinDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const finalPfp = pfp || `https://ui-avatars.com/api/?name=${encodeURIComponent(finalUsername)}&background=00a884&color=111b21`;

        db.userProfiles[uid] = {
            uid, username: finalUsername, dob, bio: bio || "Using Yaply.",
            pfp: finalPfp, friends: [], requests: [], blocked: [], joinDate
        };

        db.usernamesToUid[lowerName] = uid;
        saveDB();

        activeSockets[socket.id] = finalUsername;
        socket.username = finalUsername;

        socket.emit('auth_result', { exists: true, user: db.userProfiles[uid], groups: [] });
        io.emit('online_users', Object.values(activeSockets));
    });

    // Groups Management
    socket.on('create_group', ({ groupName, members }) => {
        const groupId = 'group_' + Date.now();
        const groupMembers = [...members, socket.username];
        db.groups[groupId] = { name: groupName, members: groupMembers };
        saveDB();

        groupMembers.forEach(member => {
            const memberSocket = Object.keys(activeSockets).find(id => activeSockets[id] === member);
            if (memberSocket) {
                io.to(memberSocket).emit('new_group_added', { id: groupId, name: groupName });
            }
        });
    });

    socket.on('search_user', ({ query }) => {
        const q = (query || '').toLowerCase().trim();
        if (!q) return socket.emit('search_results', []);
        const results = Object.values(db.userProfiles)
            .filter(p => p.username.toLowerCase().includes(q) && p.username !== socket.username)
            .map(p => ({ username: p.username, bio: p.bio, pfp: p.pfp }));
        socket.emit('search_results', results);
    });

    // Friends & Blocks
    socket.on('block_user', ({ targetUsername }) => {
        const myUid = db.usernamesToUid[socket.username?.toLowerCase()];
        if (!myUid || !targetUsername) return;
        if (!db.userProfiles[myUid].blocked.includes(targetUsername)) {
            db.userProfiles[myUid].blocked.push(targetUsername);
            db.userProfiles[myUid].friends = db.userProfiles[myUid].friends.filter(f => f !== targetUsername);
            saveDB();
        }
        socket.emit('update_blocked', { blocked: db.userProfiles[myUid].blocked });
        socket.emit('update_friends', { friends: db.userProfiles[myUid].friends });
    });

    socket.on('unblock_user', ({ targetUsername }) => {
        const myUid = db.usernamesToUid[socket.username?.toLowerCase()];
        if (!myUid) return;
        db.userProfiles[myUid].blocked = db.userProfiles[myUid].blocked.filter(b => b !== targetUsername);
        saveDB();
        socket.emit('update_blocked', { blocked: db.userProfiles[myUid].blocked });
    });

    socket.on('send_friend_request', ({ targetUsername }) => {
        const targetUid = db.usernamesToUid[targetUsername?.toLowerCase()];
        if (!targetUid || targetUsername === socket.username) return;
        const targetProfile = db.userProfiles[targetUid];
        if (targetProfile.blocked?.includes(socket.username)) return;

        if (!targetProfile.requests.includes(socket.username) && !targetProfile.friends.includes(socket.username)) {
            targetProfile.requests.push(socket.username);
            saveDB();
            const targetSocket = Object.keys(activeSockets).find(id => activeSockets[id] === targetProfile.username);
            if (targetSocket) io.to(targetSocket).emit('update_requests', { requests: targetProfile.requests });
        }
    });

    socket.on('handle_request', ({ requester, action }) => {
        const myUid = db.usernamesToUid[socket.username?.toLowerCase()];
        const reqUid = db.usernamesToUid[requester?.toLowerCase()];

        if (myUid && reqUid) {
            db.userProfiles[myUid].requests = db.userProfiles[myUid].requests.filter(r => r !== requester);
            if (action === 'accept') {
                if (!db.userProfiles[myUid].friends.includes(requester)) db.userProfiles[myUid].friends.push(requester);
                if (!db.userProfiles[reqUid].friends.includes(socket.username)) db.userProfiles[reqUid].friends.push(socket.username);
                const reqSocket = Object.keys(activeSockets).find(id => activeSockets[id] === requester);
                if (reqSocket) io.to(reqSocket).emit('update_friends', { friends: db.userProfiles[reqUid].friends });
            }
            saveDB();
            socket.emit('update_friends', { friends: db.userProfiles[myUid].friends });
            socket.emit('update_requests', { requests: db.userProfiles[myUid].requests });
        }
    });

    // Messaging
    socket.on('get_chat_history', ({ chatTarget, isGroup }) => {
        const roomKey = isGroup ? (chatTarget === 'Yaply' ? 'Yaply' : chatTarget) : getDmRoomKey(socket.username, chatTarget);
        socket.emit('load_chat_history', { roomKey, target: chatTarget, history: db.chatHistory[roomKey] || [] });
    });

    socket.on('chat_message', ({ recipientOrGroup, message, isGroup }) => {
        const sender = socket.username;
        if (!sender) return;

        if (recipientOrGroup === 'Yaply' && sender !== ADMIN_USERNAME) return;

        if (!isGroup) {
            const recipientUid = db.usernamesToUid[recipientOrGroup?.toLowerCase()];
            if (recipientUid && db.userProfiles[recipientUid]?.blocked?.includes(sender)) return; 
        }

        const senderUid = db.usernamesToUid[sender.toLowerCase()];
        const pfp = db.userProfiles[senderUid]?.pfp || '';
        const chatData = { sender, message, pfp, target: recipientOrGroup, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };

        const roomKey = isGroup ? recipientOrGroup : getDmRoomKey(sender, recipientOrGroup);
        if (!db.chatHistory[roomKey]) db.chatHistory[roomKey] = [];
        db.chatHistory[roomKey].push(chatData);
        saveDB();

        if (isGroup) {
            if (recipientOrGroup === 'Yaply') {
                io.emit('receive_message', chatData);
            } else {
                const group = db.groups[recipientOrGroup];
                if (group) {
                    group.members.forEach(member => {
                        const mSock = Object.keys(activeSockets).find(id => activeSockets[id] === member);
                        if (mSock) io.to(mSock).emit('receive_message', chatData);
                    });
                }
            }
        } else {
            const targetSocketId = Object.keys(activeSockets).find(id => activeSockets[id] === recipientOrGroup);
            if (targetSocketId) io.to(targetSocketId).emit('receive_message', chatData);
            socket.emit('receive_message', chatData);
        }
    });

    // Voice & Video Calls (Now Supports Groups)
    socket.on('call_user', ({ target, signalData, type, isGroup }) => {
        if (isGroup) {
            const group = db.groups[target];
            if (group) {
                group.members.forEach(member => {
                    if (member !== socket.username) {
                        const targetSocketId = Object.keys(activeSockets).find(id => activeSockets[id] === member);
                        if (targetSocketId) io.to(targetSocketId).emit('incoming_call', { from: socket.username, signalData, type, groupName: group.name });
                    }
                });
            }
        } else {
            const targetSocketId = Object.keys(activeSockets).find(id => activeSockets[id] === target);
            if (targetSocketId) {
                io.to(targetSocketId).emit('incoming_call', { from: socket.username, signalData, type });
            } else {
                socket.emit('call_failed', { reason: `${target} is currently offline.` });
            }
        }
    });

    socket.on('accept_call', ({ to, signalData }) => {
        const targetSocketId = Object.keys(activeSockets).find(id => activeSockets[id] === to);
        if (targetSocketId) io.to(targetSocketId).emit('call_accepted', { signalData, from: socket.username });
    });

    socket.on('reject_call', ({ to }) => {
        const targetSocketId = Object.keys(activeSockets).find(id => activeSockets[id] === to);
        if (targetSocketId) io.to(targetSocketId).emit('call_rejected');
    });

    socket.on('end_call', ({ to, isGroup }) => {
        if (isGroup) {
            const group = db.groups[to];
            if (group) {
                group.members.forEach(member => {
                    const mSock = Object.keys(activeSockets).find(id => activeSockets[id] === member);
                    if (mSock) io.to(mSock).emit('call_ended');
                });
            }
        } else {
            const targetSocketId = Object.keys(activeSockets).find(id => activeSockets[id] === to);
            if (targetSocketId) io.to(targetSocketId).emit('call_ended');
        }
    });

    socket.on('get_profile', ({ targetUsername }) => {
        const targetUid = db.usernamesToUid[targetUsername?.toLowerCase()];
        if (targetUid && db.userProfiles[targetUid]) {
            const p = db.userProfiles[targetUid];
            socket.emit('profile_data', { username: p.username, bio: p.bio, pfp: p.pfp, joinDate: p.joinDate });
        }
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            delete activeSockets[socket.id];
            io.emit('online_users', Object.values(activeSockets));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Yaply server running on http://localhost:${PORT}`));