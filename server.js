const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

// Initialize Firebase Admin for Firestore storage
// (Ensure your firebase-adminsdk json key is added to Render environment or project root if needed)
try {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
} catch (e) {
    // Fallback initialization if default credentials aren't set up yet
    admin.initializeApp();
}

const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 10 * 1024 * 1024
});

app.use(express.static(path.join(__dirname, 'public')));

const users = {};        
const usernames = {};    
const groups = {};       

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
        if (usernames[username] && usernames[username] !== uid) {
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
            friends: users[uid]?.friends || [],
            requests: users[uid]?.requests || [],
            blocked: users[uid]?.blocked || [],
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
            if (usernames[newUsername] && usernames[newUsername] !== socket.uid) {
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
        const currentUser = users[socket.uid];
        const blockedList = currentUser?.blocked || [];
        const results = Object.values(users)
            .filter(u => u.username.toLowerCase().includes(query.toLowerCase()) && u.username !== currentUser?.username && !blockedList.includes(u.username))
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

    socket.on('block_user', ({ targetUsername }) => {
        const user = users[socket.uid];
        if (!user) return;
        if (!user.blocked) user.blocked = [];
        if (!user.blocked.includes(targetUsername)) {
            user.blocked.push(targetUsername);
            user.friends = user.friends.filter(f => f !== targetUsername);
        }
        socket.emit('update_blocked', { blocked: user.blocked });
        socket.emit('update_friends', { friends: user.friends });
    });

    socket.on('unblock_user', ({ targetUsername }) => {
        const user = users[socket.uid];
        if (!user) return;
        if (user.blocked) {
            user.blocked = user.blocked.filter(b => b !== targetUsername);
        }
        socket.emit('update_blocked', { blocked: user.blocked });
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

    socket.on('chat_message', async ({ recipientOrGroup, message, timestamp, isGroup, isAudio }) => {
        const sender = users[socket.uid];
        if (!sender) return;

        if (recipientOrGroup === 'Yaply' && sender.username !== 'Kyroxify') {
            return;
        }

        const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const chatData = { id: msgId, sender: sender.username, message, pfp: sender.pfp, timestamp, target: recipientOrGroup, isAudio: !!isAudio, pinned: false };

        try {
            await db.collection('chats').doc(chatKey).collection('messages').doc(msgId).set(chatData);
        } catch (e) {
            console.error("Firestore write error:", e);
        }

        if (isGroup) {
            io.emit('receive_message', chatData);
        } else {
            io.to(recipientOrGroup).emit('receive_message', chatData);
            socket.emit('receive_message', chatData);
        }
    });

    socket.on('edit_message', async ({ recipientOrGroup, msgId, newText, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
        
        try {
            const msgRef = db.collection('chats').doc(chatKey).collection('messages').doc(msgId);
            const doc = await msgRef.get();
            if (doc.exists && doc.data().sender === sender.username) {
                const newMsg = doc.data();
                newMsg.message = newText + ' (edited)';
                await msgRef.update({ message: newMsg.message });
                
                if (isGroup) {
                    io.emit('update_message', newMsg);
                } else {
                    io.to(recipientOrGroup).emit('update_message', newMsg);
                    socket.emit('update_message', newMsg);
                }
            }
        } catch (e) {
            console.error("Firestore edit error:", e);
        }
    });

    socket.on('delete_message', async ({ recipientOrGroup, msgId, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
        
        try {
            await db.collection('chats').doc(chatKey).collection('messages').doc(msgId).delete();
            if (isGroup) {
                io.emit('remove_message', { msgId });
            } else {
                io.to(recipientOrGroup).emit('remove_message', { msgId });
                socket.emit('remove_message', { msgId });
            }
        } catch (e) {
            console.error("Firestore delete error:", e);
        }
    });

    socket.on('pin_message', async ({ recipientOrGroup, msgId, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
        
        try {
            const messagesRef = db.collection('chats').doc(chatKey).collection('messages');
            const snapshot = await messagesRef.get();
            
            let targetMsg = null;
            const batch = db.batch();
            
            snapshot.forEach(doc => {
                const data = doc.data();
                if (doc.id === msgId) {
                    targetMsg = data;
                    targetMsg.pinned = !targetMsg.pinned;
                    batch.update(doc.ref, { pinned: targetMsg.pinned });
                } else if (data.pinned) {
                    batch.update(doc.ref, { pinned: false });
                }
            });
            
            await batch.commit();

            if (targetMsg) {
                if (isGroup) {
                    io.emit('update_message', targetMsg);
                } else {
                    io.to(recipientOrGroup).emit('update_message', targetMsg);
                    socket.emit('update_message', targetMsg);
                }
            }
        } catch (e) {
            console.error("Firestore pin error:", e);
        }
    });

    socket.on('get_chat_history', async ({ chatTarget, isGroup }) => {
        const sender = users[socket.uid];
        if (!sender) return;
        const chatKey = isGroup ? chatTarget : [sender.username, chatTarget].sort().join('_');
        
        try {
            const snapshot = await db.collection('chats').doc(chatKey).collection('messages').get();
            const history = [];
            snapshot.forEach(doc => history.push(doc.data()));
            // Sort by message ID generation time to maintain chronological order
            history.sort((a, b) => a.id.localeCompare(b.id));
            socket.emit('load_chat_history', { target: chatTarget, history });
        } catch (e) {
            console.error("Firestore history error:", e);
            socket.emit('load_chat_history', { target: chatTarget, history: [] });
        }
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
