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

// 返回 0=周一, 1=周二, 2=周三, 3=周四, 4=周五, 5=周六, 6=周日
function getWeekdayIndex() {
  const d = new Date().getDay(); // 0=周日, 6=周六
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

  return { todayTasks, streak };
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
      model: "deepseek-v4-pro", // ✅ 修复模型名称
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

/* ---------- 6. Fallback Notes (3种备用文案，也会轮换) ---------- */
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
  // 用日期作为种子简单轮换
  const idx = new Date().getDate() % variants.length;
  return variants[idx];
}

/* ---------- 7. 七套完全不重复的卡片模板 (周一 ~ 周日) ---------- */

// 辅助：生成待办和已办列表 HTML（不同模板可共用，但每个模板独立写以保证样式差异）
function buildTodoList(tasks) {
  if (tasks.length === 0) return `<li style="color:#10B981;">🎉 全部完成！</li>`;
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
  if (tasks.length === 0) return `<li style="color:#9CA3AF;">暂无已完成任务。</li>`;
  return tasks
    .map(
      (t) =>
        `<li style="margin-bottom:4px;color:#059669;text-decoration:line-through;">✅ ${t.title}</li>`
    )
    .join("");
}

// ----- 周一模板：清新蓝白，圆角大卡片 -----
function templateMonday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#EFF6FF;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:24px;padding:24px;box-shadow:0 8px 20px rgba(0,0,0,0.04);">
      <div style="border-bottom:3px solid #3B82F6;padding-bottom:12px;margin-bottom:20px;">
        <div style="font-size:22px;font-weight:700;color:#1E3A8A;">📅 周一 · 新周启航</div>
        <div style="font-size:13px;color:#6B7280;">${today} · 🔥 ${streak.current || 0}天连续</div>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:18px;">
        <div style="flex:1;background:#ECFDF5;border-radius:12px;padding:12px;text-align:center;border:1px solid #A7F3D0;">
          <div style="font-size:26px;font-weight:800;color:#059669;">${doneTasks.length}</div>
          <div style="font-size:12px;color:#047857;">已完成</div>
        </div>
        <div style="flex:1;background:#FFFBEB;border-radius:12px;padding:12px;text-align:center;border:1px solid #FDE68A;">
          <div style="font-size:26px;font-weight:800;color:#D97706;">${todoTasks.length}</div>
          <div style="font-size:12px;color:#B45309;">待办</div>
        </div>
      </div>
      <div style="background:#F8FAFC;border-radius:12px;padding:14px;margin-bottom:18px;border-left:4px solid #3B82F6;font-size:14px;line-height:1.6;color:#1E293B;">${aiContent}</div>
      <div><h4 style="margin:0 0 6px;font-size:14px;color:#1F2937;">📌 待办</h4><ul style="margin:0 0 12px;padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:0 0 6px;font-size:14px;color:#1F2937;">✅ 已完成</h4><ul style="margin:0;padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
    </div>
  </div>`;
}

// ----- 周二模板：暖橙活力，大数字突出 -----
function templateTuesday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#FFF7ED;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:20px;border:1px solid #FED7AA;">
      <div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:28px;font-weight:800;color:#9A3412;">🔥 周二 · 火力全开</div>
        <div style="font-size:13px;color:#78350F;">${today} · 连续 ${streak.current || 0} 天</div>
      </div>
      <div style="display:flex;justify-content:space-around;margin:16px 0;">
        <div><span style="font-size:32px;font-weight:900;color:#EA580C;">${doneTasks.length}</span><span style="font-size:12px;color:#9A3412;display:block;">完成</span></div>
        <div><span style="font-size:32px;font-weight:900;color:#D97706;">${todoTasks.length}</span><span style="font-size:12px;color:#9A3412;display:block;">待办</span></div>
      </div>
      <div style="background:#FFF4E6;border-radius:10px;padding:14px;margin-bottom:16px;font-size:14px;line-height:1.6;color:#431407;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;color:#9A3412;">⏳ 待办</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;color:#9A3412;">✔️ 已完成</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
    </div>
  </div>`;
}

// ----- 周三模板：翡翠绿，进度条风格 -----
function templateWednesday({ aiContent, doneTasks, todoTasks, streak, today }) {
  const total = doneTasks.length + todoTasks.length || 1;
  const pct = Math.round((doneTasks.length / total) * 100);
  return `
  <div style="background:#ECFDF5;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;padding:24px;box-shadow:0 4px 12px rgba(0,0,0,0.04);">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div><span style="font-size:20px;font-weight:700;color:#064E3B;">🌿 周三 · 持续深耕</span><div style="font-size:12px;color:#6B7280;">${today}</div></div>
        <span style="background:#D1FAE5;padding:4px 12px;border-radius:30px;font-size:13px;color:#065F46;">${pct}%</span>
      </div>
      <div style="background:#E5E7EB;height:8px;border-radius:10px;margin:12px 0 16px;overflow:hidden;"><div style="background:#10B981;height:100%;width:${pct}%;"></div></div>
      <div style="display:flex;gap:12px;margin-bottom:14px;"><div style="flex:1;text-align:center;background:#F0FDF4;border-radius:10px;padding:8px;"><span style="font-weight:800;color:#047857;">${doneTasks.length}</span><span style="font-size:12px;color:#047857;display:block;">完成</span></div><div style="flex:1;text-align:center;background:#FEFCE8;border-radius:10px;padding:8px;"><span style="font-weight:800;color:#CA8A04;">${todoTasks.length}</span><span style="font-size:12px;color:#CA8A04;display:block;">待办</span></div></div>
      <div style="background:#F9FAFB;border-radius:12px;padding:14px;margin-bottom:16px;font-size:14px;line-height:1.6;color:#1F2937;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;font-size:14px;">📋 待办</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;font-size:13px;color:#6B7280;">✅ 已完成</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
      <div style="text-align:center;font-size:12px;color:#9CA3AF;margin-top:12px;">🔥 连续 ${streak.current || 0} 天</div>
    </div>
  </div>`;
}

// ----- 周四模板：深邃星空紫，优雅卡片 -----
function templateThursday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#F5F3FF;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:28px;padding:20px;border:1px solid #DDD6FE;">
      <div style="background:#4C1D95;color:white;border-radius:20px 20px 0 0;margin:-20px -20px 16px;padding:16px 20px;">
        <div style="font-size:20px;font-weight:700;">🌌 周四 · 突破自我</div>
        <div style="font-size:12px;opacity:0.8;">${today} · 连续 ${streak.current || 0} 天</div>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:14px;"><div style="flex:1;background:#F5F3FF;border-radius:12px;padding:8px;text-align:center;"><span style="font-size:24px;font-weight:800;color:#7C3AED;">${doneTasks.length}</span><div style="font-size:12px;color:#5B21B6;">完成</div></div><div style="flex:1;background:#FEF3C7;border-radius:12px;padding:8px;text-align:center;"><span style="font-size:24px;font-weight:800;color:#D97706;">${todoTasks.length}</span><div style="font-size:12px;color:#B45309;">待办</div></div></div>
      <div style="background:#F8FAFC;border-radius:12px;padding:12px;margin-bottom:14px;border-left:4px solid #7C3AED;font-size:14px;line-height:1.6;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;font-size:14px;color:#4C1D95;">📌 待办</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;font-size:13px;color:#6B7280;">✅ 已完成</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
    </div>
  </div>`;
}

// ----- 周五模板：阳光黄，迎接周末气氛 -----
function templateFriday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#FFFBEB;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:30px;padding:24px;box-shadow:0 8px 0 #F59E0B;">
      <div style="text-align:center;margin-bottom:12px;"><span style="font-size:28px;font-weight:900;color:#B45309;">⭐ 周五 · 冲刺收官</span><div style="font-size:13px;color:#78716C;">${today}</div></div>
      <div style="display:flex;justify-content:center;gap:24px;margin:12px 0;"><div style="text-align:center;"><span style="font-size:30px;font-weight:900;color:#16A34A;">${doneTasks.length}</span><div style="font-size:12px;color:#15803D;">完成</div></div><div style="text-align:center;"><span style="font-size:30px;font-weight:900;color:#EA580C;">${todoTasks.length}</span><div style="font-size:12px;color:#9A3412;">待办</div></div></div>
      <div style="background:#FEF9C3;border-radius:16px;padding:14px;margin-bottom:14px;font-size:14px;line-height:1.6;color:#713F12;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;color:#92400E;">📋 待办</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;color:#92400E;">✅ 已完成</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
      <div style="text-align:center;margin-top:12px;font-size:12px;color:#A16207;">🔥 连续 ${streak.current || 0} 天 · 周末加油！</div>
    </div>
  </div>`;
}

// ----- 周六模板：柔和粉彩，轻松治愈风 -----
function templateSaturday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#FDF2F8;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:40px;padding:24px;border:2px solid #FBCFE8;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span style="font-size:28px;">🌸</span><span style="font-size:22px;font-weight:700;color:#831843;">周六 · 悠然自得</span></div>
      <div style="font-size:13px;color:#9D174D;margin-bottom:14px;">${today} · 连续 ${streak.current || 0} 天</div>
      <div style="display:flex;gap:8px;margin-bottom:14px;"><div style="flex:1;background:#FCE7F3;border-radius:30px;padding:10px;text-align:center;"><span style="font-weight:800;color:#BE185D;">${doneTasks.length}</span><div style="font-size:12px;color:#9D174D;">已完成</div></div><div style="flex:1;background:#FEF3C7;border-radius:30px;padding:10px;text-align:center;"><span style="font-weight:800;color:#B45309;">${todoTasks.length}</span><div style="font-size:12px;color:#92400E;">待办</div></div></div>
      <div style="background:#FDF4FF;border-radius:20px;padding:14px;margin-bottom:14px;font-size:14px;line-height:1.6;color:#4C0519;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;color:#9D174D;">📌 待办</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;color:#9D174D;">✅ 已完成</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
    </div>
  </div>`;
}

// ----- 周日模板：极简灰调，复盘与展望 -----
function templateSunday({ aiContent, doneTasks, todoTasks, streak, today }) {
  return `
  <div style="background:#F3F4F6;padding:30px 10px;font-family:sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;border-top:6px solid #374151;">
      <div style="border-bottom:1px solid #E5E7EB;padding-bottom:10px;margin-bottom:16px;">
        <div style="font-size:22px;font-weight:700;color:#1F2937;">📆 周日 · 圆满收尾</div>
        <div style="font-size:13px;color:#6B7280;">${today} · 连续 ${streak.current || 0} 天</div>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:16px;"><div style="flex:1;background:#F9FAFB;border-radius:8px;padding:8px;text-align:center;border:1px solid #D1D5DB;"><span style="font-weight:800;color:#059669;">${doneTasks.length}</span><div style="font-size:12px;color:#4B5563;">完成</div></div><div style="flex:1;background:#F9FAFB;border-radius:8px;padding:8px;text-align:center;border:1px solid #D1D5DB;"><span style="font-weight:800;color:#D97706;">${todoTasks.length}</span><div style="font-size:12px;color:#4B5563;">待办</div></div></div>
      <div style="background:#F9FAFB;border-radius:8px;padding:14px;margin-bottom:16px;font-size:14px;line-height:1.6;color:#1F2937;border:1px solid #E5E7EB;">${aiContent}</div>
      <div><h4 style="margin:0 0 4px;font-size:14px;color:#374151;">📌 待办</h4><ul style="padding-left:18px;font-size:14px;">${buildTodoList(todoTasks)}</ul></div>
      <div><h4 style="margin:8px 0 4px;font-size:13px;color:#6B7280;">✅ 已完成</h4><ul style="padding-left:18px;font-size:13px;">${buildDoneList(doneTasks)}</ul></div>
      <div style="text-align:center;margin-top:16px;font-size:12px;color:#9CA3AF;">✨ 新的一周即将开始，继续加油！</div>
    </div>
  </div>`;
}

// 按周一~周日顺序存放
const weeklyTemplates = [
  templateMonday,
  templateTuesday,
  templateWednesday,
  templateThursday,
  templateFriday,
  templateSaturday,
  templateSunday,
];

/* ---------- 8. 构建卡片：根据星期几选取 ---------- */
function buildCardHtml(aiContent, { doneTasks, todoTasks, streak }) {
  const idx = getWeekdayIndex(); // 0=周一 ... 6=周日
  const selected = weeklyTemplates[idx];
  const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  console.log(`🎨 今日卡片模板: ${dayNames[idx]}`);
  return selected({ aiContent, doneTasks, todoTasks, streak, today });
}

/* ---------- 9. Send Mail ---------- */
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

/* ---------- 10. Main Entry ---------- */
(async () => {
  try {
    console.log("🚀 Starting daily study email worker...");
    const { todayTasks, streak } = await fetchData();

    const doneTasks = todayTasks.filter((t) => t.status === "done");
    const todoTasks = todayTasks.filter((t) => t.status !== "done");

    let aiContent;
    try {
      aiContent = await generateAiNote({ doneTasks, todoTasks, streak });
      console.log("🤖 AI note generated successfully.");
    } catch (err) {
      console.warn("⚠️ AI generation failed, using fallback note:", err.message);
      aiContent = getFallbackNote({ doneTasks, todoTasks, streak });
    }

    await sendEmail(aiContent, { doneTasks, todoTasks, streak });
  } catch (err) {
    console.error("❌ Failed to send daily study email:", err);
    process.exit(1);
  }
})();
