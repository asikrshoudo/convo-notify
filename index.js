const express  = require("express");
const admin    = require("firebase-admin");
const nodemailer = require("nodemailer");

// ── Firebase init ─────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db  = admin.firestore();
const fcm = admin.messaging();
const app = express();
app.use(express.json());

// ── Email transporter (Gmail) ─────────────────────────────────────────────────
// Set GMAIL_USER and GMAIL_APP_PASS in Render environment variables
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASS,
  },
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Convo Notify Server Running ✅"));

// ── Helper: send FCM + save to Firestore ──────────────────────────────────────
async function sendNotification(token, title, body, data = {}) {
  if (data.toUid) {
    await db.collection("notifications").add({
      uid:       data.toUid,
      title,
      body,
      type:      data.type || "general",
      data,
      read:      false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
  if (!token) return;
  try {
    await fcm.send({
      token,
      notification: { title, body },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          priority: "max",
          visibility: "public",
        },
      },
      data: { ...data, click_action: "FLUTTER_NOTIFICATION_CLICK" },
    });
    console.log(`✅ FCM sent to ${token.substring(0, 20)}...`);
  } catch (e) {
    console.log("❌ FCM error:", e.message);
  }
}

// ── API: Send Email OTP for registration ──────────────────────────────────────
app.post("/send-email-otp", async (req, res) => {
  try {
    const { email, code, name } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Missing fields" });

    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin:0;padding:0;background:#0A0A0A;font-family:'Segoe UI',sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="padding:40px 20px;">
            <table width="480" cellpadding="0" cellspacing="0"
              style="background:#111;border-radius:20px;border:1px solid #1a1a1a;overflow:hidden;">
              
              <!-- Header -->
              <tr><td style="background:linear-gradient(135deg,#00C853,#004d20);padding:32px 40px;text-align:center;">
                <h1 style="color:#fff;margin:0;font-size:32px;letter-spacing:3px;font-weight:900;">CONVO</h1>
                <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:13px;">Email Verification</p>
              </td></tr>
              
              <!-- Body -->
              <tr><td style="padding:36px 40px;">
                <p style="color:#ccc;margin:0 0 8px;font-size:15px;">
                  Hi <strong style="color:#fff;">${name || "there"}</strong>,
                </p>
                <p style="color:#888;font-size:14px;line-height:1.6;margin:0 0 28px;">
                  Your Convo verification code is:
                </p>
                
                <!-- Code box -->
                <div style="background:#1a1a1a;border:1px solid #00C853;border-radius:16px;
                  padding:24px;text-align:center;margin-bottom:28px;">
                  <span style="font-size:42px;font-weight:900;letter-spacing:10px;
                    color:#00C853;font-family:monospace;">${code}</span>
                </div>
                
                <p style="color:#666;font-size:12px;line-height:1.6;margin:0;">
                  This code expires in <strong style="color:#aaa;">10 minutes</strong>.<br>
                  Do not share this code with anyone.<br>
                  If you didn't request this, ignore this email.
                </p>
              </td></tr>
              
              <!-- Footer -->
              <tr><td style="background:#0a0a0a;padding:20px 40px;text-align:center;
                border-top:1px solid #1a1a1a;">
                <p style="color:#444;font-size:11px;margin:0;">
                  Powered by TheKami · thekami.tech
                </p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: `"Convo" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `${code} is your Convo verification code`,
      html,
    });

    console.log(`✅ OTP email sent to ${email}`);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ Email OTP error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: DM notification ──────────────────────────────────────────────────────
app.post("/notify/dm", async (req, res) => {
  try {
    const { chatId, messageId, senderId, text } = req.body;
    if (!chatId || !senderId) return res.status(400).json({ error: "Missing fields" });

    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists) return res.status(404).json({ error: "Chat not found" });

    const participants = chatDoc.data().participants || [];
    const receiverId   = participants.find((uid) => uid !== senderId);
    if (!receiverId) return res.status(404).json({ error: "Receiver not found" });

    const [senderDoc, receiverDoc] = await Promise.all([
      db.collection("users").doc(senderId).get(),
      db.collection("users").doc(receiverId).get(),
    ]);

    const senderName     = senderDoc.data()?.name || "Someone";
    const receiverToken  = receiverDoc.data()?.fcmToken;
    const receiverOnline = receiverDoc.data()?.isOnline === true;

    await sendNotification(
      receiverOnline ? null : receiverToken,
      senderName,
      text || "New message",
      { type: "dm", chatId, senderId, senderName, toUid: receiverId }
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Group notification ───────────────────────────────────────────────────
app.post("/notify/group", async (req, res) => {
  try {
    const { groupId, senderId, senderName, text } = req.body;
    if (!groupId || !senderId) return res.status(400).json({ error: "Missing fields" });

    const groupDoc  = await db.collection("groups").doc(groupId).get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupName = groupDoc.data()?.name || "Group";
    const members   = groupDoc.data()?.members || [];
    const receivers = members.filter((uid) => uid !== senderId);

    await Promise.all(receivers.map(async (uid) => {
      const userDoc = await db.collection("users").doc(uid).get();
      const token   = userDoc.data()?.fcmToken;
      const online  = userDoc.data()?.isOnline === true;
      return sendNotification(
        online ? null : token,
        groupName,
        `${senderName}: ${text}`,
        { type: "group", groupId, senderId, senderName, toUid: uid }
      );
    }));

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Friend Request notification ─────────────────────────────────────────
app.post("/notify/friend-request", async (req, res) => {
  try {
    const { fromUid, fromName, toUid } = req.body;
    if (!fromUid || !toUid) return res.status(400).json({ error: "Missing fields" });

    const receiverDoc    = await db.collection("users").doc(toUid).get();
    const receiverToken  = receiverDoc.data()?.fcmToken;
    const receiverOnline = receiverDoc.data()?.isOnline === true;

    await sendNotification(
      receiverOnline ? null : receiverToken,
      "New Friend Request 👋",
      `${fromName} sent you a friend request`,
      { type: "friend_request", fromUid, toUid }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Friend Accepted notification ────────────────────────────────────────
app.post("/notify/friend-accepted", async (req, res) => {
  try {
    const { fromUid, accepterName, accepterUid } = req.body;
    if (!fromUid) return res.status(400).json({ error: "Missing fields" });

    const senderDoc    = await db.collection("users").doc(fromUid).get();
    const senderToken  = senderDoc.data()?.fcmToken;
    const senderOnline = senderDoc.data()?.isOnline === true;

    await sendNotification(
      senderOnline ? null : senderToken,
      "Friend Request Accepted! 🎉",
      `${accepterName} accepted your friend request`,
      { type: "friend_accepted", accepterUid: accepterUid || "", toUid: fromUid }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Follow notification ──────────────────────────────────────────────────
app.post("/notify/follow", async (req, res) => {
  try {
    const { fromUid, fromName, toUid } = req.body;
    if (!fromUid || !toUid) return res.status(400).json({ error: "Missing fields" });

    const receiverDoc    = await db.collection("users").doc(toUid).get();
    const receiverToken  = receiverDoc.data()?.fcmToken;
    const receiverOnline = receiverDoc.data()?.isOnline === true;

    await sendNotification(
      receiverOnline ? null : receiverToken,
      "New Follower ✨",
      `${fromName} started following you`,
      { type: "follow", fromUid, toUid }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Convo Notify running on port ${PORT}`));
