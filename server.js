const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 10 * 1024 * 1024
});

app.use(express.static(path.join(__dirname, 'public')));

const users = {};        
const usernames = {};    
const groups = {};       
const chatHistory = {};  

io.on('connection', (socket) => {

    socket.on('check_auth', ({ uid }) => {
        socket.uid = uid;
        if (users[uid]) {
            const username = users[uid].username;
            socket.join(username);
            const userGroups = Object.values(groups).filter(g => g.members.includes(username));
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

    socket.on('update_profile', ({ newUsername, newBio, newPfp }) => {
        let user = users[socket.uid];
        if (!user) return;

        if (newUsername && newUsername !== user.username) {
            if (usernames[newUsername]) {
                socket.emit('profile_update_error', { message: 'Username is already taken!' });
                return;
            }

            const now = Date.now();
            const cooldown = 14 * 24 * 60 * 60 * 1000;
            if (user.lastUsernameChange && (now - user.lastUsernameChange < cooldown)) {
                const daysLeft = Math.ceil((cooldown - (now - user.lastUsernameChange)) / (1000 * 60 * 60 * 24));
                socket.emit('profile_update_error', { message: `You can change your username again in ${daysLeft} days.` });
                return;
            }

            socket.leave(user.username);
            delete usernames[user.username];
            user.username = newUsername;
            usernames[newUsername] = socket.uid;
            socket.join(newUsername);
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

    socket.on('chat_message', ({ recipientOrGroup, message, timestamp, isGroup, isAudio }) => {
        const sender = users[socket.uid];
        if (!sender) return;

        const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const chatData = { id: msgId, sender: sender.username, message, pfp: sender.pfp, timestamp, target: recipientOrGroup, isAudio: !!isAudio, pinned: false };

        if (!chatHistory[chatKey]) chatHistory[chatKey] = [];
        chatHistory[chatKey].push(chatData);

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

    socket.on('edit_message', ({ recipientOrGroup, msgId, newText, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
        const history = chatHistory[chatKey] || [];
        const msg = history.find(m => m.id === msgId && m.sender === sender.username);
        if (msg) {
            msg.message = newText + ' (edited)';
            if (isGroup) {
                groups[recipientOrGroup].members.forEach(m => io.to(m).emit('update_message', msg));
            } else {
                io.to(recipientOrGroup).emit('update_message', msg);
                socket.emit('update_message', msg);
            }
        }
    });

    socket.on('delete_message', ({ recipientOrGroup, msgId, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
        if (chatHistory[chatKey]) {
            chatHistory[chatKey] = chatHistory[chatKey].filter(m => m.id !== msgId);
        }
        if (isGroup) {
            groups[recipientOrGroup].members.forEach(m => io.to(m).emit('remove_message', { msgId }));
        } else {
            io.to(recipientOrGroup).emit('remove_message', { msgId });
            socket.emit('remove_message', { msgId });
        }
    });

    socket.on('pin_message', ({ recipientOrGroup, msgId, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
        const history = chatHistory[chatKey] || [];
        const msg = history.find(m => m.id === msgId);
        if (msg) {
            msg.pinned = !msg.pinned;
            if (isGroup) {
                groups[recipientOrGroup].members.forEach(m => io.to(m).emit('update_message', msg));
            } else {
                io.to(recipientOrGroup).emit('update_message', msg);
                socket.emit('update_message', msg);
            }
        }
    });

    socket.on('get_chat_history', ({ chatTarget, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        const chatKey = isGroup ? chatTarget : [sender.username, chatTarget].sort().join('_');
        const history = chatHistory[chatKey] || [];
        socket.emit('load_chat_history', { target: chatTarget, history });
    });

    socket.on('get_profile', ({ targetUsername }) => {
        const targetUid = usernames[targetUsername];
        if (!targetUid) return;
        const u = users[targetUid];
        socket.emit('profile_data', { username: u.username, bio: u.bio, pfp: u.pfp, joinDate: u.joinDate });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Yaply server running on port ${PORT}`);
});
