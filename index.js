const express = require("express");
const admin = require("firebase-admin");

// ── Firebase init ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db  = admin.firestore();
const fcm = admin.messaging();
const app = express();
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Convo Notify Server Running ✅"));

// ── Helper: send FCM notification ────────────────────────────────────────────
async function sendNotification(token, title, body, data = {}) {
  if (!token) return;
  try {
    await fcm.send({
      token,
      notification: { title, body },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "convo_messages",
          priority: "max",
          visibility: "public",
        },
      },
      data: { ...data, click_action: "FLUTTER_NOTIFICATION_CLICK" },
    });
    console.log(`✅ Notification sent to ${token.substring(0, 20)}...`);
  } catch (e) {
    console.log("❌ FCM error:", e.message);
  }
}

// ── API: Send DM notification ─────────────────────────────────────────────────
app.post("/notify/dm", async (req, res) => {
  try {
    const { chatId, messageId, senderId, text } = req.body;
    if (!chatId || !senderId) return res.status(400).json({ error: "Missing fields" });

    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists) return res.status(404).json({ error: "Chat not found" });

    const participants = chatDoc.data().participants || [];
    const receiverId = participants.find((uid) => uid !== senderId);
    if (!receiverId) return res.status(404).json({ error: "Receiver not found" });

    const [senderDoc, receiverDoc] = await Promise.all([
      db.collection("users").doc(senderId).get(),
      db.collection("users").doc(receiverId).get(),
    ]);

    const senderName    = senderDoc.data()?.name || "Someone";
    const receiverToken = receiverDoc.data()?.fcmToken;
    const receiverOnline = receiverDoc.data()?.isOnline === true;

    if (receiverOnline) return res.json({ skipped: "User is online" });

    await sendNotification(receiverToken, senderName, text || "New message", {
      type: "dm", chatId, senderId, senderName,
    });

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Send Group notification ──────────────────────────────────────────────
app.post("/notify/group", async (req, res) => {
  try {
    const { groupId, senderId, senderName, text } = req.body;
    if (!groupId || !senderId) return res.status(400).json({ error: "Missing fields" });

    const groupDoc = await db.collection("groups").doc(groupId).get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupName = groupDoc.data()?.name || "Group";
    const members   = groupDoc.data()?.members || [];
    const receivers = members.filter((uid) => uid !== senderId);

    await Promise.all(receivers.map(async (uid) => {
      const userDoc = await db.collection("users").doc(uid).get();
      const token   = userDoc.data()?.fcmToken;
      const online  = userDoc.data()?.isOnline === true;
      if (online || !token) return;
      return sendNotification(token, groupName, `${senderName}: ${text}`, {
        type: "group", groupId, senderId, senderName,
      });
    }));

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Send Friend Request notification ─────────────────────────────────────
app.post("/notify/friend-request", async (req, res) => {
  try {
    const { fromUid, fromName, toUid } = req.body;
    if (!fromUid || !toUid) return res.status(400).json({ error: "Missing fields" });

    const receiverDoc  = await db.collection("users").doc(toUid).get();
    const receiverToken = receiverDoc.data()?.fcmToken;
    const receiverOnline = receiverDoc.data()?.isOnline === true;

    if (receiverOnline) return res.json({ skipped: "User is online" });

    await sendNotification(
      receiverToken,
      "New Friend Request",
      `${fromName} sent you a friend request`,
      { type: "friend_request", fromUid }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Friend Request Accepted notification ─────────────────────────────────
app.post("/notify/friend-accepted", async (req, res) => {
  try {
    const { fromUid, accepterName } = req.body;
    if (!fromUid) return res.status(400).json({ error: "Missing fields" });

    const senderDoc  = await db.collection("users").doc(fromUid).get();
    const senderToken = senderDoc.data()?.fcmToken;
    const senderOnline = senderDoc.data()?.isOnline === true;

    if (senderOnline) return res.json({ skipped: "User is online" });

    await sendNotification(
      senderToken,
      "Friend Request Accepted! 🎉",
      `${accepterName} accepted your friend request`,
      { type: "friend_accepted" }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Convo Notify running on port ${PORT}`));
