const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory data structures
const users = {};        // uid -> { username, dob, bio, pfp, friends, requests, blocked, lastUsernameChange, joinDate }
const usernames = {};    // username -> uid
const groups = {};       // groupId -> { id, name, members: [] }
const chatHistory = {};  // targetId -> [ { sender, message, pfp, timestamp } ]

io.on('connection', (socket) => {

    socket.on('check_auth', ({ uid }) => {
        socket.uid = uid;
        if (users[uid]) {
            socket.join(users[uid].username);
            const userGroups = Object.values(groups).filter(g => g.members.includes(users[uid].username));
            socket.emit('auth_result', { exists: true, user: users[uid], groups: userGroups });
        } else {
            socket.emit('auth_result', { exists: false });
        }
    });

    socket.on('register_new_user', ({ uid, username, dob, bio, pfp }) => {
        if (usernames[username]) {
            socket.emit('registration_error', { message: 'Username is already in use! Please choose a different one.' });
            return;
        }

        const cleanPfp = pfp || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=202c33&color=e9edef`;
        const joinDate = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

        users[uid] = {
            username,
            dob,
            bio: bio || 'Hey there! I am using Yaply.',
            pfp: cleanPfp,
            friends: [],
            requests: [],
            blocked: [],
            lastUsernameChange: Date.now(),
            joinDate
        };
        usernames[username] = uid;
        socket.uid = uid;
        socket.join(username);

        socket.emit('auth_result', { exists: true, user: users[uid], groups: [] });
    });

    // Profile Management with 14-Day Username Cooldown
    socket.on('update_profile', ({ newUsername, newBio, newPfp }) => {
        let user = users[socket.uid];
        if (!user) return;

        if (newUsername && newUsername !== user.username) {
            if (usernames[newUsername]) {
                socket.emit('profile_update_error', { message: 'Username is already taken!' });
                return;
            }

            const now = Date.now();
            const cooldown = 14 * 24 * 60 * 60 * 1000; // 14 days
            if (user.lastUsernameChange && (now - user.lastUsernameChange < cooldown)) {
                const daysLeft = Math.ceil((cooldown - (now - user.lastUsernameChange)) / (1000 * 60 * 60 * 24));
                socket.emit('profile_update_error', { message: `You can change your username again in ${daysLeft} days.` });
                return;
            }

            delete usernames[user.username];
            user.username = newUsername;
            usernames[newUsername] = socket.uid;
            user.lastUsernameChange = now;
        }

        if (newBio !== undefined) user.bio = newBio;
        if (newPfp) user.pfp = newPfp;

        socket.emit('profile_updated_success', { user });
    });

    socket.on('search_user', ({ query }) => {
        if (!query) {
            socket.emit('search_results', []);
            return;
        }
        const results = Object.values(users)
            .filter(u => u.username.toLowerCase().includes(query.toLowerCase()) && u.username !== users[socket.uid]?.username)
            .map(u => ({ username: u.username, bio: u.bio, pfp: u.pfp }));
        socket.emit('search_results', results);
    });

    socket.on('send_friend_request', ({ targetUsername }) => {
        const sender = users[socket.uid];
        const targetUid = usernames[targetUsername];
        if (!sender || !targetUid) return;
        const targetUser = users[targetUid];

        if (!targetUser.requests.includes(sender.username) && !targetUser.friends.includes(sender.username)) {
            targetUser.requests.push(sender.username);
            io.to(targetUsername).emit('update_requests', { requests: targetUser.requests });
        }
    });

    socket.on('handle_request', ({ requester, action }) => {
        const user = users[socket.uid];
        const requesterUid = usernames[requester];
        if (!user || !requesterUid) return;
        const requesterUser = users[requesterUid];

        user.requests = user.requests.filter(r => r !== requester);

        if (action === 'accept') {
            if (!user.friends.includes(requester)) user.friends.push(requester);
            if (!requesterUser.friends.includes(user.username)) requesterUser.friends.push(user.username);

            io.to(requester).emit('update_friends', { friends: requesterUser.friends });
        }

        socket.emit('update_requests', { requests: user.requests });
        socket.emit('update_friends', { friends: user.friends });
    });

    socket.on('create_group', ({ groupName, members }) => {
        const creator = users[socket.uid];
        if (!creator) return;

        const groupId = 'group_' + Date.now();
        const allMembers = [creator.username, ...members];
        groups[groupId] = { id: groupId, name: groupName, members: allMembers };

        allMembers.forEach(mName => {
            io.to(mName).emit('new_group_added', groups[groupId]);
        });
    });

    socket.on('chat_message', ({ recipientOrGroup, message, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;

        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const chatData = { sender: sender.username, message, pfp: sender.pfp, timestamp, target: recipientOrGroup };

        if (!chatHistory[recipientOrGroup]) chatHistory[recipientOrGroup] = [];
        chatHistory[recipientOrGroup].push(chatData);

        if (isGroup) {
            const grp = groups[recipientOrGroup];
            if (grp) {
                grp.members.forEach(m => io.to(m).emit('receive_message', chatData));
            }
        } else {
            io.to(recipientOrGroup).emit('receive_message', chatData);
            socket.emit('receive_message', chatData);
        }
    });

    socket.on('get_chat_history', ({ chatTarget }) => {
        const history = chatHistory[chatTarget] || [];
        socket.emit('load_chat_history', { target: chatTarget, history });
    });

    socket.on('get_profile', ({ targetUsername }) => {
        const targetUid = usernames[targetUsername];
        if (!targetUid) return;
        const u = users[targetUid];
        socket.emit('profile_data', { username: u.username, bio: u.bio, pfp: u.pfp, joinDate: u.joinDate });
    });

    // WebRTC Signaling
    socket.on('call_user', ({ target, signalData, type, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        io.to(target).emit('incoming_call', { from: sender.username, signalData, type, groupName: isGroup ? groups[target]?.name : null });
    });

    socket.on('accept_call', ({ to, signalData }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        io.to(to).emit('call_accepted', { signalData, from: sender.username });
    });

    socket.on('reject_call', ({ to }) => {
        io.to(to).emit('call_rejected');
    });

    socket.on('end_call', ({ to }) => {
        io.to(to).emit('call_ended');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Yaply server running on port ${PORT}`);
});
