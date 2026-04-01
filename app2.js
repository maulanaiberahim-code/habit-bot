const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const fs = require("fs");
const dayjs = require("dayjs");
const express = require("express");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const FILE = "./tasks.json";

// // 🔐 whitelist (opsional)
// const ALLOWED = ["6285715514097@s.whatsapp.net"];

// ===== WHATSAPP INIT =====
let sock;

async function startWA() {
  console.log("🔄 Starting WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 QR RECEIVED!");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("🔥 WhatsApp Connected!");
    }

    if (connection === "close") {
      console.log("❌ Connection closed");

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("🔁 Reconnecting...");
        setTimeout(() => startWA(), 3000);
      }
    }
  });

  // ===== LISTENER CHAT =====
  sock.ev.on("messages.upsert", async ({ messages }) => {
    console.log("📩 MASUK EVENT messages.upsert");

    const msg = messages[0];

    // console.log("RAW MESSAGE:", JSON.stringify(msg.message, null, 2));

    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;

    // // 🔐 whitelist check
    // if (!ALLOWED.includes(sender)) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return;

    console.log("📩 Message:", text);

    console.log("TEXT FINAL:", text);
    console.log("SENDER FINAL:", sender);

    await handleCommand(text.toLowerCase(), sender);
  });
}

// ===== LOAD & SAVE =====
function load() {
  return JSON.parse(fs.readFileSync(FILE));
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// ===== RESET HARIAN =====
function resetIfNewDay(data) {
  const today = dayjs().format("YYYY-MM-DD");

  if (data.date !== today) {
    data.date = today;
    data.tasks.forEach(t => (t.done = false));
    data.lastMissDate = null;
    save(data);
  }
}

// ===== ESCALATION =====
function getEscalationMessage(streak) {
  if (streak === 1) return "Masih aman... tapi jangan santai 😏";
  if (streak === 2) return "Udah mulai keliatan pola malasnya 👀";
  if (streak === 3) return "Lo serius mau berubah gak sih?";
  if (streak >= 4) return "Fix ini bukan lupa... ini pilihan 😈";
  return "";
}

// ===== CHECK MISS =====
function checkMissLogic() {
  let data = load();
  resetIfNewDay(data);

  const today = dayjs().format("YYYY-MM-DD");
  const pendingTasks = data.tasks.filter(t => !t.done);

  if (pendingTasks.length > 0) {
    if (!data.lastMissDate || data.lastMissDate !== today) {
      data.streak = (data.streak || 0) + 1;
      data.failStreak = (data.failStreak || 0) + 1;
      data.lastMissDate = today;
    }

    const fine = data.penalty * data.streak;
    const roast = getEscalationMessage(data.failStreak);
    const taskList = pendingTasks.map(t => `• ${t.name}`);

    const message = [
      "💀 MISS!",
      "",
      roast,
      "",
      "Task yang gagal:",
      "",
      ...taskList,
      "",
      `🔥 Streak gagal: ${data.streak}`,
      `💸 Denda: Rp${fine}`
    ].join("\n");

    save(data);
    return { result: "MISS", message };
  }

  data.streak = 0;
  data.failStreak = 0;
  data.lastMissDate = null;
  save(data);

  return {
    result: "SAFE",
    message: "🔥 GOOD JOB! Semua task selesai hari ini ✅"
  };
}

// ===== REMINDER =====
function checkReminderLogic() {
  let data = load();
  resetIfNewDay(data);

  const pendingTasks = data.tasks.filter(t => !t.done);

  if (pendingTasks.length > 0) {
    const nextStreak = (data.streak || 0) + 1;
    const fine = data.penalty * nextStreak;

    const taskList = pendingTasks.map(t => `• ${t.name}`);

    const message = [
      "⚠️ Reminder!",
      "",
      ...taskList,
      "",
      `🔥 Kalau gagal streak jadi: ${nextStreak}`,
      `💸 Denda: Rp${fine}`,
      "",
      "⏰ Deadline: 23:59"
    ].join("\n");

    return { result: "REMIND", message };
  }

  return { result: "SAFE" };
}

// ===== COMMAND HANDLER =====
async function handleCommand(text, sender) {
    if (text === "test") {
        console.log("📤 SENDING TEST REPLY...");
        await sock.sendMessage(sender, { text: "BOT HIDUP ✅" });
        console.log("✅ SENT");
        return;
    }
    console.log("🚀 MASUK HANDLE COMMAND:", text);

  const data = load();

  if (text === "cek") {
    const result = checkReminderLogic();
    await sock.sendMessage(sender, {
      text: result.message || "✅ Aman"
    });
  }

  else if (text === "miss") {
    const result = checkMissLogic();
    await sock.sendMessage(sender, { text: result.message });
  }

  else if (text === "status") {
    const list = data.tasks.map(t =>
      `${t.done ? "✅" : "❌"} ${t.name}`
    );

    await sock.sendMessage(sender, {
      text: ["📊 STATUS:", "", ...list].join("\n")
    });
  }

  else if (text.startsWith("add ")) {
    const taskName = text.replace("add ", "");

    data.tasks.push({
      id: Date.now(),
      name: taskName,
      done: false
    });

    save(data);

    await sock.sendMessage(sender, {
      text: `✅ Task "${taskName}" ditambahkan`
    });
  }

  else if (text.startsWith("done ")) {
    const taskName = text.replace("done ", "");

    const task = data.tasks.find(t => t.name === taskName);

    if (!task) {
      await sock.sendMessage(sender, {
        text: "❌ Task tidak ditemukan"
      });
      return;
    }

    task.done = true;
    save(data);

    await sock.sendMessage(sender, {
      text: `🔥 Task "${taskName}" selesai`
    });
  }

  else if (text === "help") {
    await sock.sendMessage(sender, {
      text: `
🤖 COMMAND:

cek → reminder
miss → check gagal
status → lihat task
add [task]
done [task]
      `
    });
  }
}

// ===== CRON =====

// ⏰ reminder 20:00 WIB
cron.schedule("0 20 * * *", async () => {
  console.log("⏰ Reminder triggered");

  const result = checkReminderLogic();
  if (result.result !== "REMIND") return;

  const data = load();

  await sock.sendMessage(
    data.shameContacts[0] + "@s.whatsapp.net",
    { text: result.message }
  );
}, { timezone: "Asia/Jakarta" });

// 💀 miss 23:59 WIB
cron.schedule("59 23 * * *", async () => {
  console.log("💀 Miss triggered");

  const result = checkMissLogic();
  const data = load();

  await sock.sendMessage(
    data.shameContacts[0] + "@s.whatsapp.net",
    { text: result.message }
  );

  if (result.result === "MISS") {
    for (const num of data.shameContacts || []) {
      await sock.sendMessage(
        num + "@s.whatsapp.net",
        { text: "😈 DIA GAGAL HARI INI!" }
      );
    }
  }
}, { timezone: "Asia/Jakarta" });

// ===== START =====
app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});

startWA();