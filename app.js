const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const fs = require("fs");
const dayjs = require("dayjs");
const express = require("express");

const app = express();
app.use(express.json());

const FILE = "./tasks.json";

// ===== WHATSAPP INIT =====
let sock;

async function startWA() {
  console.log("🔄 Starting WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState("auth");

  sock = makeWASocket({
    auth: state,
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

    data.streak = data.streak || 0;
    data.failStreak = data.failStreak || 0;

    data.lastMissDate = null;

    save(data);
  }
}

// ===== ESCALATION MESSAGE =====
function getEscalationMessage(streak) {
  if (streak === 1) {
    return "Masih aman... tapi jangan santai 😏";
  }
  if (streak === 2) {
    return "Udah mulai keliatan pola malasnya 👀";
  }
  if (streak === 3) {
    return "Lo serius mau berubah gak sih?";
  }
  if (streak >= 4) {
    return "Fix ini bukan lupa... ini pilihan 😈";
  }
  return "";
}

// ===== CHECK MISS + REWARD =====
function checkMissLogic() {
  let data = load();
  resetIfNewDay(data);

  const today = dayjs().format("YYYY-MM-DD");
  const pendingTasks = data.tasks.filter(t => !t.done);

  // ❌ MISS
  if (pendingTasks.length > 0) {

    // 🔥 FIX: sync state kalau beda hari
    if (data.lastMissDate && data.lastMissDate !== data.date) {
      data.lastMissDate = null;
    }

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

    return {
      result: "MISS",
      message
    };
  }

  // ✅ SUCCESS
  data.streak = 0;
  data.failStreak = 0;
  data.lastMissDate = null;

  save(data);

  return {
    result: "SAFE",
    reward: true,
    message: [
      "🔥 GOOD JOB!",
      "",
      "Semua task selesai hari ini ✅",
      "",
      "Mental lu masih aman 😏"
    ].join("\n")
  };
}

// ===== CHECK REMINDER =====
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
      "Lo belum selesaikan task ini:",
      "",
      ...taskList,
      "",
      `🔥 Kalau gagal streak jadi: ${nextStreak}`,
      `💸 Denda: Rp${fine}`,
      "",
      "⏰ Deadline: 23:59"
    ].join("\n");

    return {
      result: "REMIND",
      message
    };
  }

  return {
    result: "SAFE",
    message: "✅ Semua task sudah aman"
  };
}

// ===== API =====

// cek miss
app.get("/check", (req, res) => {
  const result = checkMissLogic();
  res.json(result);
});

// reminder
app.get("/reminder", (req, res) => {
  const result = checkReminderLogic();
  res.json(result);
});

// kirim WA + mode malu
app.post("/send-message", async (req, res) => {
  try {
    const { number, message, isMiss } = req.body;

    const isMissFlag = isMiss === true || isMiss === "true";

    if (!sock) {
      return res.status(500).json({ error: "WhatsApp belum siap" });
    }

    const jid = number + "@s.whatsapp.net";

    console.log("📤 sending message...");
    await sock.sendMessage(jid, { text: message });
    console.log("✅ message sent!");

    const data = load();
    const pendingTasks = data.tasks.filter(t => !t.done);

    // 😈 MODE MALU (ONLY WHEN MISS)
    if (isMissFlag && pendingTasks.length > 0) {
      console.log("isMiss:", isMiss);
      console.log("😈 MODE MALU AKTIF!");

      const taskList = pendingTasks.map(t => `• ${t.name}`);
      const fine = data.penalty * data.streak;

      const shameMessage = [
        `💀 ${data.name} GAGAL HARI INI!`,
        "",
        "Task yang belum selesai:",
        "",
        ...taskList,
        "",
        `💸 Denda hari ini: Rp${fine}`,
        "",
        "Tolong ingetin dia 😈"
      ].join("\n");

      for (const num of data.shameContacts || []) {
        const jid = num + "@s.whatsapp.net";
        await sock.sendMessage(jid, { text: shameMessage });
        console.log("📢 Shame dikirim ke:", num);
      }
    }

    res.json({ success: true });

  } catch (err) {
    console.error("❌ Error kirim WA:", err);
    res.status(500).json({ error: "Gagal kirim WA" });
  }
});

// ===== CLI =====
const cmd = process.argv[2];
const arg = process.argv.slice(3).join(" ");

function addTask(name) {
  let data = load();
  resetIfNewDay(data);

  data.tasks.push({
    id: Date.now(),
    name,
    done: false
  });

  save(data);
  console.log(`✅ Task "${name}" ditambahkan`);
}

function doneTask(name) {
  let data = load();
  resetIfNewDay(data);

  const task = data.tasks.find(t => t.name === name);

  if (!task) {
    console.log("❌ Task tidak ditemukan");
    return;
  }

  task.done = true;
  save(data);

  console.log(`🔥 Task "${name}" selesai`);
}

function status() {
  let data = load();
  resetIfNewDay(data);

  if (data.tasks.length === 0) {
    console.log("Belum ada task");
    return;
  }

  data.tasks.forEach(t => {
    console.log(`${t.done ? "✅" : "❌"} ${t.name}`);
  });
}

// ===== START =====
app.listen(3000, () => {
  console.log("🚀 Habit system API running on http://localhost:3000");
});

startWA();