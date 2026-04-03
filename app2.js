const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const fs = require("fs");
const dayjs = require("dayjs");
const express = require("express");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const FILE = "./tasks.json";

let sock;

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
    console.log("🌅 Resetting new day");

    data.date = today;
    data.tasks.forEach((t) => (t.done = false));

    data.lastMissDate = null;
    data.lastReminderDate = null;

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

// ===== SEND MESSAGE SAFE =====
async function sendMessageSafe(number, text) {
  try {
    await sock.sendMessage(number + "@s.whatsapp.net", { text });
    console.log("📤 Sent to", number);
  } catch (err) {
    console.log("❌ Failed send:", err.message);
  }
}

// ===== REMINDER =====
function checkReminderLogic() {
  let data = load();
  resetIfNewDay(data);

  const today = dayjs().format("YYYY-MM-DD");

  if (data.lastReminderDate === today) {
    return { result: "SKIP" };
  }

  const pending = data.tasks.filter((t) => !t.done);

  if (pending.length === 0) {
    data.lastReminderDate = today;
    save(data);
    return { result: "SAFE" };
  }

  const nextStreak = (data.streak || 0) + 1;
  const fine = data.penalty * nextStreak;

  const list = pending.map((t) => `• ${t.name}`).join("\n");

  const message = `⚠️ Reminder!

${list}

🔥 Kalau gagal streak jadi: ${nextStreak}
💸 Denda: Rp${fine}

⏰ Deadline: 23:59`;

  data.lastReminderDate = today;
  save(data);

  return { result: "REMIND", message };
}

// ===== MISS =====
function checkMissLogic() {
  let data = load();
  resetIfNewDay(data);

  const today = dayjs().format("YYYY-MM-DD");

  if (data.lastMissDate === today) {
    return { result: "SKIP" };
  }

  const pending = data.tasks.filter((t) => !t.done);

  if (pending.length === 0) {
    data.streak = 0;
    data.failStreak = 0;
    data.lastMissDate = today;
    save(data);

    return {
      result: "SAFE",
      message: "🔥 GOOD JOB! Semua task selesai hari ini ✅",
    };
  }

  data.streak = (data.streak || 0) + 1;
  data.failStreak = (data.failStreak || 0) + 1;
  data.lastMissDate = today;

  const fine = data.penalty * data.streak;
  const roast = getEscalationMessage(data.failStreak);
  const list = pending.map((t) => `• ${t.name}`).join("\n");

  const message = `💀 MISS!

${roast}

Task gagal:
${list}

🔥 Streak gagal: ${data.streak}
💸 Denda: Rp${fine}`;

  save(data);

  return { result: "MISS", message, fine, list };
}

// ===== RECOVERY SYSTEM =====
async function recoveryCheck() {
  console.log("🧠 Running recovery check...");

  const now = dayjs();
  const hour = now.hour();

  const data = load();

  // Reminder recovery
  if (hour >= 20) {
    const r = checkReminderLogic();
    if (r.result === "REMIND") {
      await sendMessageSafe(data.owner, "⚠️ (Recovery)\n\n" + r.message);
    }
  }

  // Miss recovery
  if (hour >= 23) {
    const r = checkMissLogic();
    if (r.result === "MISS") {
      await sendMessageSafe(data.owner, "💀 (Recovery)\n\n" + r.message);
    }
  }
}

// ===== WHATSAPP =====
async function startWA() {
  console.log("🔄 Starting WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("🔥 Connected!");

      // 🔥 Recovery after connect
      setTimeout(recoveryCheck, 5000);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("🔁 Reconnecting...");
        setTimeout(startWA, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text;

    if (!text) return;

    await handleCommand(text.toLowerCase(), sender);
  });
}

// ===== COMMAND =====
async function handleCommand(text, sender) {
  const data = load();

  if (text === "cek") {
    const r = checkReminderLogic();
    await sendMessageSafe(data.owner, r.message || "✅ Aman");
  }

  else if (text === "miss") {
    const r = checkMissLogic();
    await sendMessageSafe(data.owner, r.message);
  }

  else if (text === "status") {
    const list = data.tasks
      .map((t) => `${t.done ? "✅" : "❌"} ${t.name}`)
      .join("\n");

    await sendMessageSafe(data.owner, "📊 STATUS:\n\n" + list);
  }

  else if (text.startsWith("add ")) {
    const name = text.replace("add ", "");

    data.tasks.push({
      id: Date.now(),
      name,
      done: false,
    });

    save(data);
    await sendMessageSafe(data.owner, `✅ Task "${name}" ditambahkan`);
  }

  else if (text.startsWith("done ")) {
    const name = text.replace("done ", "");

    const task = data.tasks.find((t) => t.name === name);

    if (!task) {
      await sendMessageSafe(data.owner, "❌ Task tidak ditemukan");
      return;
    }

    task.done = true;
    save(data);

    await sendMessageSafe(data.owner, `🔥 Task "${name}" selesai`);
  }
}

// ===== CRON =====

// Reminder 20:00
cron.schedule(
  "0 20 * * *",
  async () => {
    console.log("⏰ Reminder cron");

    const data = load();
    const r = checkReminderLogic();

    if (r.result === "REMIND") {
      await sendMessageSafe(data.owner, r.message);
    }
  },
  { timezone: "Asia/Jakarta" }
);

// Miss 23:59
cron.schedule(
  "59 23 * * *",
  async () => {
    console.log("💀 Miss cron");

    const data = load();
    const r = checkMissLogic();

    await sendMessageSafe(data.owner, r.message);

    if (r.result === "MISS") {
      for (const num of data.shameContacts || []) {
        await sendMessageSafe(
          num,
          `🚨 ALERT MALAM 🚨

Pasangan kamu, ${data.name}, gagal hari ini.

${r.list}

🔥 Streak: ${data.streak}
💸 Denda: Rp${r.fine}`
        );
      }
    }
  },
  { timezone: "Asia/Jakarta" }
);

// ===== START =====
app.listen(3000, () => {
  console.log("🚀 Server running");
});

startWA();
