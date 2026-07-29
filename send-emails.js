import admin from "firebase-admin";
import nodemailer from "nodemailer";

/* ---------- 1. Env Variables & Fallbacks ---------- */
const env = process.env;

const FIREBASE_SERVICE_ACCOUNT = env.FIREBASE_SERVICE_ACCOUNT;
const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
const SMTP_USER = env.SMTP_USER;
const SMTP_PASS = env.SMTP_PASS;

if (!FIREBASE_SERVICE_ACCOUNT || !DEEPSEEK_API_KEY || !SMTP_USER || !SMTP_PASS) {
  console.error("❌ Missing required Secret environment variables!");
  process.exit(1);
}

const USER_NAME = env.USER_NAME || "Friend";
const RECIPIENT_EMAIL = env.RECIPIENT_EMAIL || "1336487767@qq.com";
const SMTP_HOST = env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(env.SMTP_PORT || 465);
const SMTP_SECURE = (env.SMTP_SECURE || "true") === "true";
const TARGET_UID = env.TARGET_UID || "";

/* ---------- 2. Init Firebase Admin ---------- */
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();

/* ---------- 3. Date Helpers ---------- */
function getFormattedDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const today = getFormattedDate(0);
const weekAgo = getFormattedDate(-6);

// Returns 0=Monday, 1=Tuesday, ..., 6=Sunday
function getWeekdayIndex() {
  const d = new Date().getDay(); // 0=Sunday, 6=Saturday
  return d === 0 ? 6 : d - 1;
}

/* ---------- 4. Fetch Tasks Data ---------- */
async function fetchData() {
  let uid = TARGET_UID;

  const todaySnap = await db.collection("tasks").where("date", "==", today).get();
  if (!uid && !todaySnap.empty) {
    uid = todaySnap.docs[0].data().userId;
  }

  const weekSnap = await db
    .collection("tasks")
    .where("date", ">=", weekAgo)
    .where("date", "<=", today)
    .get();

  let allTasks = weekSnap.docs.map((d) => d.data());
  if (uid) allTasks = allTasks.filter((t) => t.userId === uid);

  const todayTasks = allTasks.filter((t) => t.date === today);

  let streak = { current: 0, longest: 0 };
  if (uid) {
    const streakDoc = await db.collection("streaks").doc(uid).get();
    if (streakDoc.exists) streak = streakDoc.data();
  }

  return { todayTasks, streak, uid };
}

/* ---------- 更新连胜 ---------- */
async function updateStreak(uid, doneCount) {
  if (!uid) return null;

  const streakRef = db.collection("streaks").doc(uid);

  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(streakRef);
    let data = doc.exists ? doc.data() : { current: 0, longest: 0 };

    if (doneCount > 0) {
      data.current += 1;
      if (data.current > data.longest) {
        data.longest = data.current;
      }
    } else {
      data.current = 0;
    }

    transaction.set(streakRef, data);
    return data; // 返回更新后的连胜数据
  });
}

/* ---------- 5. AI Note Generation (with fallback) ---------- */
async function generateAiNote({ doneTasks, todoTasks, streak }) {
  const prompt = `You are a warm, empathetic, and highly supportive personal study companion for ${USER_NAME}.
Write a deeply encouraging daily email message in English.

Data for Today (${today}):
- User Name: ${USER_NAME}
- Completed Tasks: ${doneTasks.length}
- Pending Tasks: ${todoTasks.length}
- Pending Task Titles: ${todoTasks.map((t) => t.title).join(", ") || "None"}
- Current Streak: ${streak.current || 0} day(s)

Writing Instructions:
1. Start with a warm greeting: "Hi ${USER_NAME}!"
2. Celebrate their hard work today (${doneTasks.length} completed). If they have remaining tasks (${todoTasks.length} left), motivate them gently without causing stress.
3. IMPORTANT: Include a thoughtful, caring reminder to take care of themselves, rest well, and recharge.
4. Tone: Inspiring, friendly, caring, and uplifting.
5. Keep it around 120-150 words. Plain text only.`;

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.75,
    }),
  });

  if (!resp.ok) {
    throw new Error(`DeepSeek API error ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  return (
    json.choices?.[0]?.message?.content?.trim() ||
    getFallbackNote({ doneTasks, todoTasks, streak })
  );
}

/* ---------- 6. Fallback Notes (English only) ---------- */
function getFallbackNote({ doneTasks, todoTasks, streak }) {
  const variants = [
    `Hi ${USER_NAME}! You've done an incredible job today with ${doneTasks.length} tasks completed. ${
      todoTasks.length > 0
        ? `You still have ${todoTasks.length} tasks left, but remember – progress is progress! Take it step by step.`
        : "You've finished everything – that's amazing!"
    } Don't forget to take a well-deserved break, hydrate, and get some rest. You're doing great, keep it up! 🌟`,
    `Hey ${USER_NAME}, great work today! Completing ${doneTasks.length} tasks is no small feat. ${
      todoTasks.length > 0
        ? `You have ${todoTasks.length} more to go – you've got this, just pace yourself.`
        : "You've crushed all your tasks! Time to relax and recharge."
    } Remember to take care of your health and sleep well. See you tomorrow! 💪`,
    `Hello ${USER_NAME}! Today you finished ${doneTasks.length} tasks – fantastic! ${
      todoTasks.length > 0
        ? `With ${todoTasks.length} remaining, you're almost there. Keep going, but also listen to your body.`
        : "All done – what a productive day! Now it's time to unwind."
    } Stay positive, stay healthy, and don't forget to enjoy the little moments. You're awesome! 🌈`,
  ];
  const idx = new Date().getDate() % variants.length;
  return variants[idx];
}

/* ---------- 7. Helper functions for task lists (English only) ---------- */
function buildTodoList(tasks) {
  if (tasks.length === 0) return `<li style="color:#10B981;">🎉 All done!</li>`;
  return tasks
    .map(
      (t) =>
        `<li style="margin-bottom:6px;color:#D97706;">⏳ ${t.title}${
          t.tag
            ? ` <span style="font-size:11px;color:#6B7280;background:#F3F4F6;padding:2px 6px;border-radius:4px;">${t.tag}</span>`
            : ""
        }</li>`
    )
    .join("");
}

function buildDoneList(tasks) {
  if (tasks.length === 0) return `<li style="color:#9CA3AF;">No completed tasks yet.</li>`;
  return tasks
    .map(
      (t) =>
        `<li style="margin-bottom:4px;color:#059669;text-decoration:line-through;">✅ ${t.title}</li>`
    )
    .join("");
}

/* ---------- 8. Seven unique card templates (English only, Monday–Sunday) ---------- */

// Monday: Fresh blue & white
function templateMonday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#EFF6FF;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:24px;padding:24px;box-shadow:0 8px 20px rgba(0,0,0,0.04);">
      <div style="border-bottom:3px solid #3B82F6;padding-bottom:12px;margin-bottom:20px;">
        <div style="font-size:22px;font-weight:700;color:#1E3A8A;">📅 Monday · New Week Launch</div>
        <div style="font-size:13px;color:#6B7280;">${today} · 🔥 ${streak.current || 0}-day streak</div>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:18px;">
        <div style="flex:1;background:#ECFDF5;border-radius:12px;padding:12px;text-align:center;border:1px solid #A7F3D0;">
          <div style="font-size:26px;font-weight:800;color:#059669;">${doneTasks.length}</div>
          <div style="font-size:12px;color:#047857;">Completed</div>
        </div>
        <div style="flex:1;background:#FFFBEB;border-radius:12px;padding:12px;text-align:center;border:1px solid #FDE68A;">
          <div style="font-size:26px;font-weight:800;color:#D97706;">${todoTasks.length}</div>
          <div style="font-size:12px;color:#B45309;">Pending</div>
        </div>
      </div>
      <div style="background:#F8FAFC;border-radius:12px;padding:14px;margin-bottom:18px;border-left:4px solid #3B82F6;font-size:14px;line-height:1.6;color:#1E293B;">${aiContent}</div>
      <div><h4 style="margin:0 0 6px;font-size:14px;color:#1F2937;">📌 Pending</h4><ul style="margin:0 0 12px;padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:0 0 6px;font-size:14px;color:#1F2937;">✅ Completed</h4><ul style="margin:0;padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
    </div>
  </div>`;
}

// Tuesday: Warm orange, bold numbers
function templateTuesday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#FFF7ED;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:20px;border:1px solid #FED7AA;">
      <div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:28px;font-weight:800;color:#9A3412;">🔥 Tuesday · Full Power</div>
        <div style="font-size:13px;color:#78350F;">${today} · ${streak.current || 0}-day streak</div>
      </div>
      <div style="display:flex;justify-content:space-around;margin:16px 0;">
        <div><span style="font-size:32px;font-weight:900;color:#EA580C;">${doneTasks.length}</span><span style="font-size:12px;color:#9A3412;display:block;">Completed</span></div>
        <div><span style="font-size:32px;font-weight:900;color:#D97706;">${todoTasks.length}</span><span style="font-size:12px;color:#9A3412;display:block;">Pending</span></div>
      </div>
      <div style="background:#FFF4E6;border-radius:10px;padding:14px;margin-bottom:16px;font-size:14px;line-height:1.6;color:#431407;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;color:#9A3412;">⏳ Pending</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;color:#9A3412;">✔️ Completed</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
    </div>
  </div>`;
}

// Wednesday: Emerald green with progress bar
function templateWednesday({ aiContent, doneTasks, todoTasks, streak, today }) {
  const total = doneTasks.length + todoTasks.length || 1;
  const pct = Math.round((doneTasks.length / total) * 100);
  return `
  <div style="background:#ECFDF5;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;padding:24px;box-shadow:0 4px 12px rgba(0,0,0,0.04);">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div><span style="font-size:20px;font-weight:700;color:#064E3B;">🌿 Wednesday · Steady Progress</span><div style="font-size:12px;color:#6B7280;">${today}</div></div>
        <span style="background:#D1FAE5;padding:4px 12px;border-radius:30px;font-size:13px;color:#065F46;">${pct}%</span>
      </div>
      <div style="background:#E5E7EB;height:8px;border-radius:10px;margin:12px 0 16px;overflow:hidden;"><div style="background:#10B981;height:100%;width:${pct}%;"></div></div>
      <div style="display:flex;gap:12px;margin-bottom:14px;"><div style="flex:1;text-align:center;background:#F0FDF4;border-radius:10px;padding:8px;"><span style="font-weight:800;color:#047857;">${doneTasks.length}</span><span style="font-size:12px;color:#047857;display:block;">Completed</span></div><div style="flex:1;text-align:center;background:#FEFCE8;border-radius:10px;padding:8px;"><span style="font-weight:800;color:#CA8A04;">${todoTasks.length}</span><span style="font-size:12px;color:#CA8A04;display:block;">Pending</span></div></div>
      <div style="background:#F9FAFB;border-radius:12px;padding:14px;margin-bottom:16px;font-size:14px;line-height:1.6;color:#1F2937;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;font-size:14px;">📋 Pending</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;font-size:13px;color:#6B7280;">✅ Completed</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
      <div style="text-align:center;font-size:12px;color:#9CA3AF;margin-top:12px;">🔥 ${streak.current || 0}-day streak</div>
    </div>
  </div>`;
}

// Thursday: Deep starry purple, elegant
function templateThursday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#F5F3FF;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:28px;padding:20px;border:1px solid #DDD6FE;">
      <div style="background:#4C1D95;color:white;border-radius:20px 20px 0 0;margin:-20px -20px 16px;padding:16px 20px;">
        <div style="font-size:20px;font-weight:700;">🌌 Thursday · Breakthrough</div>
        <div style="font-size:12px;opacity:0.8;">${today} · ${streak.current || 0}-day streak</div>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:14px;"><div style="flex:1;background:#F5F3FF;border-radius:12px;padding:8px;text-align:center;"><span style="font-size:24px;font-weight:800;color:#7C3AED;">${doneTasks.length}</span><div style="font-size:12px;color:#5B21B6;">Completed</div></div><div style="flex:1;background:#FEF3C7;border-radius:12px;padding:8px;text-align:center;"><span style="font-size:24px;font-weight:800;color:#D97706;">${todoTasks.length}</span><div style="font-size:12px;color:#B45309;">Pending</div></div></div>
      <div style="background:#F8FAFC;border-radius:12px;padding:12px;margin-bottom:14px;border-left:4px solid #7C3AED;font-size:14px;line-height:1.6;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;font-size:14px;color:#4C1D95;">📌 Pending</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;font-size:13px;color:#6B7280;">✅ Completed</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
    </div>
  </div>`;
}

// Friday: Sunny yellow, weekend vibe
function templateFriday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#FFFBEB;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:30px;padding:24px;box-shadow:0 8px 0 #F59E0B;">
      <div style="text-align:center;margin-bottom:12px;"><span style="font-size:28px;font-weight:900;color:#B45309;">⭐ Friday · Final Sprint</span><div style="font-size:13px;color:#78716C;">${today}</div></div>
      <div style="display:flex;justify-content:center;gap:24px;margin:12px 0;"><div style="text-align:center;"><span style="font-size:30px;font-weight:900;color:#16A34A;">${doneTasks.length}</span><div style="font-size:12px;color:#15803D;">Completed</div></div><div style="text-align:center;"><span style="font-size:30px;font-weight:900;color:#EA580C;">${todoTasks.length}</span><div style="font-size:12px;color:#9A3412;">Pending</div></div></div>
      <div style="background:#FEF9C3;border-radius:16px;padding:14px;margin-bottom:14px;font-size:14px;line-height:1.6;color:#713F12;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;color:#92400E;">📋 Pending</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;color:#92400E;">✅ Completed</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
      <div style="text-align:center;margin-top:12px;font-size:12px;color:#A16207;">🔥 ${streak.current || 0}-day streak · Keep up!</div>
    </div>
  </div>`;
}

// Saturday: Soft pastel pink, cozy
function templateSaturday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#FDF2F8;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:40px;padding:24px;border:2px solid #FBCFE8;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span style="font-size:28px;">🌸</span><span style="font-size:22px;font-weight:700;color:#831843;">Saturday · Easy Going</span></div>
      <div style="font-size:13px;color:#9D174D;margin-bottom:14px;">${today} · ${streak.current || 0}-day streak</div>
      <div style="display:flex;gap:8px;margin-bottom:14px;"><div style="flex:1;background:#FCE7F3;border-radius:30px;padding:10px;text-align:center;"><span style="font-weight:800;color:#BE185D;">${doneTasks.length}</span><div style="font-size:12px;color:#9D174D;">Completed</div></div><div style="flex:1;background:#FEF3C7;border-radius:30px;padding:10px;text-align:center;"><span style="font-weight:800;color:#B45309;">${todoTasks.length}</span><div style="font-size:12px;color:#92400E;">Pending</div></div></div>
      <div style="background:#FDF4FF;border-radius:20px;padding:14px;margin-bottom:14px;font-size:14px;line-height:1.6;color:#4C0519;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;color:#9D174D;">📌 Pending</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;color:#9D174D;">✅ Completed</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
    </div>
  </div>`;
}

// Sunday: Minimalist gray, reflection
function templateSunday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#F3F4F6;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;border-top:6px solid #374151;">
      <div style="border-bottom:1px solid #E5E7EB;padding-bottom:10px;margin-bottom:16px;">
        <div style="font-size:22px;font-weight:700;color:#1F2937;">📆 Sunday · Wrap Up</div>
        <div style="font-size:13px;color:#6B7280;">${today} · ${streak.current || 0}-day streak</div>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:16px;"><div style="flex:1;background:#F9FAFB;border-radius:8px;padding:8px;text-align:center;border:1px solid #D1D5DB;"><span style="font-weight:800;color:#059669;">${doneTasks.length}</span><div style="font-size:12px;color:#4B5563;">Completed</div></div><div style="flex:1;background:#F9FAFB;border-radius:8px;padding:8px;text-align:center;border:1px solid #D1D5DB;"><span style="font-weight:800;color:#D97706;">${todoTasks.length}</span><div style="font-size:12px;color:#4B5563;">Pending</div></div></div>
      <div style="background:#F9FAFB;border-radius:8px;padding:14px;margin-bottom:16px;font-size:14px;line-height:1.6;color:#1F2937;border:1px solid #E5E7EB;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;font-size:14px;color:#374151;">📌 Pending</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;font-size:13px;color:#6B7280;">✅ Completed</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
      <div style="text-align:center;margin-top:16px;font-size:12px;color:#9CA3AF;">✨ A new week begins – keep going!</div>
    </div>
  </div>`;
}

// Weekly templates in order: Monday to Sunday
const weeklyTemplates = [
  templateMonday,
  templateTuesday,
  templateWednesday,
  templateThursday,
  templateFriday,
  templateSaturday,
  templateSunday,
];

/* ---------- 9. Build card: select based on weekday ---------- */
function buildCardHtml(aiContent, { doneTasks, todoTasks, streak }) {
  const idx = getWeekdayIndex(); // 0=Monday ... 6=Sunday
  const selected = weeklyTemplates[idx];
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  console.log(`🎨 Today's card template: ${dayNames[idx]}`);
  return selected({ aiContent, doneTasks, todoTasks, streak, today });
}

/* ---------- 10. Send Mail ---------- */
async function sendEmail(aiText, { doneTasks, todoTasks, streak }) {
  console.log(`📡 Connecting to SMTP Server: ${SMTP_HOST}:${SMTP_PORT}`);

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const subject =
    todoTasks.length > 0
      ? `📘 Hi ${USER_NAME}, ${doneTasks.length} task(s) done today, ${todoTasks.length} left!`
      : `🎉 Hi ${USER_NAME}, all tasks completed today! Great job!`;

  const htmlBody = buildCardHtml(aiText, { doneTasks, todoTasks, streak });

  await transporter.sendMail({
    from: SMTP_USER,
    to: RECIPIENT_EMAIL,
    subject,
    text: aiText,
    html: htmlBody,
  });

  console.log(`✅ Email card successfully sent to ${RECIPIENT_EMAIL}`);
}

/* ---------- 11. Main Entry ---------- */
(async () => {
  try {
    console.log("🚀 Starting daily study email worker...");
    // 修复：从fetchData中解构出uid
    const { todayTasks, streak, uid } = await fetchData();

    const doneTasks = todayTasks.filter((t) => t.status === "done");
    const todoTasks = todayTasks.filter((t) => t.status !== "done");

    // 先更新连胜记录，获取最新数据
    let updatedStreak = streak;
    if (uid) {
      updatedStreak = await updateStreak(uid, doneTasks.length);
      console.log(`🔥 Streak updated: current=${updatedStreak.current}, longest=${updatedStreak.longest}`);
    } else {
      console.warn("⚠️ No uid found, streak not updated.");
    }

    // 使用最新连胜数据生成AI笔记
    let aiContent;
    try {
      aiContent = await generateAiNote({ doneTasks, todoTasks, streak: updatedStreak });
      console.log("🤖 AI note generated successfully.");
    } catch (err) {
      console.warn("⚠️ AI generation failed, using fallback note:", err.message);
      aiContent = getFallbackNote({ doneTasks, todoTasks, streak: updatedStreak });
    }

    // 发送邮件，携带最新的连胜信息
    await sendEmail(aiContent, { doneTasks, todoTasks, streak: updatedStreak });
  } catch (err) {
    console.error("❌ Failed to send daily study email:", err);
    process.exit(1);
  }
})();
