const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

// Initialize Firebase Admin for Firestore cloud storage
try {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
} catch (e) {
    admin.initializeApp();
}

const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 10 * 1024 * 1024
});

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {

    socket.on('check_auth', async ({ uid }) => {
        socket.uid = uid;
        try {
            const userDoc = await db.collection('users').doc(uid).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                socket.join(userData.username);
                
                const groupsSnapshot = await db.collection('groups').where('members', 'array-contains', userData.username).get();
                const userGroups = [];
                groupsSnapshot.forEach(doc => userGroups.push(doc.data()));

                socket.emit('auth_result', { exists: true, user: userData, groups: userGroups });
            } else {
                socket.emit('auth_result', { exists: false });
            }
        } catch (e) {
            console.error("Auth check error:", e);
            socket.emit('auth_result', { exists: false });
        }
    });

    socket.on('register_new_user', async ({ uid, username, dob, bio, pfp }) => {
        try {
            const usernameRef = db.collection('usernames').doc(username);
            const usernameDoc = await usernameRef.get();
            if (usernameDoc.exists && usernameDoc.data().uid !== uid) {
                socket.emit('registration_error', { message: 'Username is already in use! Please choose a different one.' });
                return;
            }

            const cleanPfp = pfp || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=202c33&color=e9edef`;
            const joinDate = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

            const userData = {
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

            await db.collection('users').doc(uid).set(userData);
            await usernameRef.set({ uid });

            socket.uid = uid;
            socket.join(username);

            socket.emit('auth_result', { exists: true, user: userData, groups: [] });
        } catch (e) {
            console.error("Registration error:", e);
        }
    });

    socket.on('update_profile', async ({ newUsername, newBio, newPfp }) => {
        try {
            const userRef = db.collection('users').doc(socket.uid);
            const userDoc = await userRef.get();
            if (!userDoc.exists) return;
            let userData = userDoc.data();

            if (newUsername && newUsername !== userData.username) {
                const newUsernameRef = db.collection('usernames').doc(newUsername);
                const existing = await newUsernameRef.get();
                if (existing.exists && existing.data().uid !== socket.uid) {
                    socket.emit('profile_update_error', { message: 'Username is already taken!' });
                    return;
                }

                const now = Date.now();
                const cooldown = 14 * 24 * 60 * 60 * 1000;
                if (userData.lastUsernameChange && (now - userData.lastUsernameChange < cooldown)) {
                    const daysLeft = Math.ceil((cooldown - (now - userData.lastUsernameChange)) / (1000 * 60 * 60 * 24));
                    socket.emit('profile_update_error', { message: `You can change your username again in ${daysLeft} days.` });
                    return;
                }

                socket.leave(userData.username);
                await db.collection('usernames').doc(userData.username).delete();
                
                userData.username = newUsername;
                await newUsernameRef.set({ uid: socket.uid });
                socket.join(newUsername);
                userData.lastUsernameChange = now;
            }

            if (newBio !== undefined) userData.bio = newBio;
            if (newPfp) userData.pfp = newPfp;

            await userRef.set(userData);
            socket.emit('profile_updated_success', { user: userData });
        } catch (e) {
            console.error("Profile update error:", e);
        }
    });

    socket.on('search_user', async ({ query }) => {
        if (!query) {
            socket.emit('search_results', []);
            return;
        }
        try {
            const userDoc = await db.collection('users').doc(socket.uid).get();
            const currentUser = userDoc.exists ? userDoc.data() : null;
            const blockedList = currentUser?.blocked || [];

            const snapshot = await db.collection('users').get();
            const results = [];
            snapshot.forEach(doc => {
                const u = doc.data();
                if (u.username.toLowerCase().includes(query.toLowerCase()) && u.username !== currentUser?.username && !blockedList.includes(u.username)) {
                    results.push({ username: u.username, bio: u.bio, pfp: u.pfp });
                }
            });
            socket.emit('search_results', results);
        } catch (e) {
            console.error("Search error:", e);
        }
    });

    socket.on('send_friend_request', async ({ targetUsername }) => {
        try {
            const senderDoc = await db.collection('users').doc(socket.uid).get();
            const targetUsernameRef = db.collection('usernames').doc(targetUsername);
            const targetDoc = await targetUsernameRef.get();
            if (!senderDoc.exists || !targetDoc.exists) return;

            const sender = senderDoc.data();
            const targetUid = targetDoc.data().uid;
            const targetRef = db.collection('users').doc(targetUid);
            const targetUser = (await targetRef.get()).data();

            if (!targetUser.requests.includes(sender.username) && !targetUser.friends.includes(sender.username)) {
                targetUser.requests.push(sender.username);
                await targetRef.update({ requests: targetUser.requests });
                io.to(targetUsername).emit('update_requests', { requests: targetUser.requests });
            }
        } catch (e) {
            console.error("Friend request error:", e);
        }
    });

    socket.on('handle_request', async ({ requester, action }) => {
        try {
            const userRef = db.collection('users').doc(socket.uid);
            const user = (await userRef.get()).data();
            const requesterDocRef = db.collection('usernames').doc(requester);
            const reqTarget = await requesterDocRef.get();
            if (!reqTarget.exists) return;
            const reqUid = reqTarget.data().uid;
            const reqUserRef = db.collection('users').doc(reqUid);
            const requesterUser = (await reqUserRef.get()).data();

            user.requests = user.requests.filter(r => r !== requester);

            if (action === 'accept') {
                if (!user.friends.includes(requester)) user.friends.push(requester);
                if (!requesterUser.friends.includes(user.username)) requesterUser.friends.push(user.username);
                await reqUserRef.update({ friends: requesterUser.friends });
                io.to(requester).emit('update_friends', { friends: requesterUser.friends });
            }

            await userRef.update({ requests: user.requests, friends: user.friends });

            socket.emit('update_requests', { requests: user.requests });
            socket.emit('update_friends', { friends: user.friends });
        } catch (e) {
            console.error("Handle request error:", e);
        }
    });

    socket.on('block_user', async ({ targetUsername }) => {
        try {
            const userRef = db.collection('users').doc(socket.uid);
            const user = (await userRef.get()).data();
            if (!user.blocked) user.blocked = [];
            if (!user.blocked.includes(targetUsername)) {
                user.blocked.push(targetUsername);
                user.friends = user.friends.filter(f => f !== targetUsername);
            }
            await userRef.update({ blocked: user.blocked, friends: user.friends });
            socket.emit('update_blocked', { blocked: user.blocked });
            socket.emit('update_friends', { friends: user.friends });
        } catch (e) {
            console.error("Block error:", e);
        }
    });

    socket.on('unblock_user', async ({ targetUsername }) => {
        try {
            const userRef = db.collection('users').doc(socket.uid);
            const user = (await userRef.get()).data();
            if (user.blocked) {
                user.blocked = user.blocked.filter(b => b !== targetUsername);
            }
            await userRef.update({ blocked: user.blocked });
            socket.emit('update_blocked', { blocked: user.blocked });
        } catch (e) {
            console.error("Unblock error:", e);
        }
    });

    socket.on('create_group', async ({ groupName, members }) => {
        try {
            const userDoc = await db.collection('users').doc(socket.uid).get();
            const creator = userDoc.data();
            if (!creator) return;

            const groupId = 'group_' + Date.now();
            const allMembers = [creator.username, ...members];
            const groupObj = { id: groupId, name: groupName, members: allMembers };

            await db.collection('groups').doc(groupId).set(groupObj);

            allMembers.forEach(mName => {
                io.to(mName).emit('new_group_added', groupObj);
            });
        } catch (e) {
            console.error("Group creation error:", e);
        }
    });

    socket.on('chat_message', async ({ recipientOrGroup, message, timestamp, isGroup, isAudio }) => {
        try {
            const userDoc = await db.collection('users').doc(socket.uid).get();
            const sender = userDoc.data();
            if (!sender) return;

            if (recipientOrGroup === 'Yaply' && sender.username !== 'Kyroxify') return;

            const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
            const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
            const chatData = { id: msgId, sender: sender.username, message, pfp: sender.pfp, timestamp, target: recipientOrGroup, isAudio: !!isAudio, pinned: false };

            await db.collection('chats').doc(chatKey).collection('messages').doc(msgId).set(chatData);

            if (isGroup) {
                io.emit('receive_message', chatData);
            } else {
                io.to(recipientOrGroup).emit('receive_message', chatData);
                socket.emit('receive_message', chatData);
            }
        } catch (e) {
            console.error("Chat message error:", e);
        }
    });

    socket.on('edit_message', async ({ recipientOrGroup, msgId, newText, isGroup }) => {
        try {
            const userDoc = await db.collection('users').doc(socket.uid).get();
            const sender = userDoc.data();
            if (!sender) return;

            const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
            const msgRef = db.collection('chats').doc(chatKey).collection('messages').doc(msgId);
            const doc = await msgRef.get();

            if (doc.exists && doc.data().sender === sender.username) {
                const updatedMsg = doc.data();
                updatedMsg.message = newText + ' (edited)';
                await msgRef.update({ message: updatedMsg.message });

                if (isGroup) {
                    io.emit('update_message', updatedMsg);
                } else {
                    io.to(recipientOrGroup).emit('update_message', updatedMsg);
                    socket.emit('update_message', updatedMsg);
                }
            }
        } catch (e) {
            console.error("Edit error:", e);
        }
    });

    socket.on('delete_message', async ({ recipientOrGroup, msgId, isGroup }) => {
        try {
            const userDoc = await db.collection('users').doc(socket.uid).get();
            const sender = userDoc.data();
            if (!sender) return;

            const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
            await db.collection('chats').doc(chatKey).collection('messages').doc(msgId).delete();

            if (isGroup) {
                io.emit('remove_message', { msgId });
            } else {
                io.to(recipientOrGroup).emit('remove_message', { msgId });
                socket.emit('remove_message', { msgId });
            }
        } catch (e) {
            console.error("Delete error:", e);
        }
    });

    socket.on('pin_message', async ({ recipientOrGroup, msgId, isGroup }) => {
        try {
            const userDoc = await db.collection('users').doc(socket.uid).get();
            const sender = userDoc.data();
            if (!sender) return;

            const chatKey = isGroup ? recipientOrGroup : [sender.username, recipientOrGroup].sort().join('_');
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
            console.error("Pin error:", e);
        }
    });

    socket.on('get_chat_history', async ({ chatTarget, isGroup }) => {
        try {
            const userDoc = await db.collection('users').doc(socket.uid).get();
            const sender = userDoc.data();
            if (!sender) return;

            const chatKey = isGroup ? chatTarget : [sender.username, chatTarget].sort().join('_');
            const snapshot = await db.collection('chats').doc(chatKey).collection('messages').get();
            const history = [];
            snapshot.forEach(doc => history.push(doc.data()));
            history.sort((a, b) => a.id.localeCompare(b.id));

            socket.emit('load_chat_history', { target: chatTarget, history });
        } catch (e) {
            console.error("History load error:", e);
            socket.emit('load_chat_history', { target: chatTarget, history: [] });
        }
    });

    socket.on('get_profile', async ({ targetUsername }) => {
        try {
            const targetDoc = await db.collection('usernames').doc(targetUsername).get();
            if (!targetDoc.exists) return;
            const uUid = targetDoc.data().uid;
            const uDoc = await db.collection('users').doc(uUid).get();
            if (!uDoc.exists) return;
            const u = uDoc.data();

            socket.emit('profile_data', { username: u.username, bio: u.bio, pfp: u.pfp, joinDate: u.joinDate });
        } catch (e) {
            console.error("Profile get error:", e);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Yaply server running on port ${PORT}`);
});
