const { onValueCreated } = require("firebase-functions/v2/database");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const DB_REGION_URL = "https://hogarcontrol-65d91-default-rtdb.europe-west1.firebasedatabase.app";

exports.notifyOnNewChatMessage = onValueCreated(
  {
    ref: "/homes/{homeCode}/chats/{employeeId}/{msgId}",
    instance: DB_REGION_URL,
    region: "europe-west1"
  },
  async (event) => {
    const msg = event.data.val();
    if (!msg || !msg.text) return;

    const { homeCode, employeeId } = event.params;
    const db = getDatabase().ref();

    const [tokensSnap, empSnap] = await Promise.all([
      db.child(`homes/${homeCode}/fcmTokens`).get(),
      db.child(`homes/${homeCode}/employees/${employeeId}`).get()
    ]);

    const tokensObj = tokensSnap.val() || {};
    const empData = empSnap.val() || {};
    const empName = empData.name || "Empleada";

    const senderRole = msg.senderRole || "";
    const senderUid = msg.senderUid || "";
    const senderName = msg.senderName || (senderRole === "owner" ? "Propietario" : empName);

    const targetTokens = new Set();

    Object.entries(tokensObj).forEach(([uid, entry]) => {
      if (!entry || !entry.token) return;
      if (senderUid && uid === senderUid) return;

      if (senderRole === "owner") {
        const isOtherOwner = entry.role === "owner";
        const isThisEmployee = entry.role === "employee" && entry.employeeId === employeeId;
        if (isOtherOwner || isThisEmployee) {
          targetTokens.add(entry.token);
        }
      } else if (senderRole === "employee") {
        if (entry.role === "owner") {
          targetTokens.add(entry.token);
        }
      } else {
        const isOwner = entry.role === "owner";
        const isThisEmployee = entry.role === "employee" && entry.employeeId === employeeId;
        if (isOwner || isThisEmployee) {
          targetTokens.add(entry.token);
        }
      }
    });

    const tokens = Array.from(targetTokens);
    if (!tokens.length) return;

    const title =
      senderRole === "owner"
        ? `${senderName} (${homeCode})`
        : `${senderName} · Hogar ${homeCode}`;

    const multicastMessage = {
      tokens,
      notification: {
        title,
        body: String(msg.text).slice(0, 180)
      },
      data: {
        homeCode: String(homeCode),
        employeeId: String(employeeId),
        senderRole: String(senderRole)
      },
      android: {
        priority: "high",
        notification: {
          channelId: "chat_messages",
          sound: "default"
        }
      }
    };

    const res = await getMessaging().sendEachForMulticast(multicastMessage);

    const cleanupPromises = [];
    res.responses.forEach((r, idx) => {
      if (!r.success && r.error) {
        const code = r.error.code;
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          const badToken = tokens[idx];
          Object.entries(tokensObj).forEach(([uid, entry]) => {
            if (entry && entry.token === badToken) {
              cleanupPromises.push(db.child(`homes/${homeCode}/fcmTokens/${uid}`).remove());
            }
          });
        }
      }
    });

    await Promise.all(cleanupPromises);
  }
);
