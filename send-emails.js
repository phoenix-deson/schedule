import admin from "firebase-admin";
import nodemailer from "nodemailer";

/* ---------- 1. 环境变量与容错处理 ---------- */
const env = process.env;

// 必须配置的 Secrets 检查
const FIREBASE_SERVICE_ACCOUNT = env.FIREBASE_SERVICE_ACCOUNT;
const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
const SMTP_USER = env.SMTP_USER;
const SMTP_PASS = env.SMTP_PASS;

if (!FIREBASE_SERVICE_ACCOUNT || !DEEPSEEK_API_KEY || !SMTP_USER || !SMTP_PASS) {
  console.error("❌ 缺少必要的 Secret 环境变量 (FIREBASE_SERVICE_ACCOUNT, DEEPSEEK_API_KEY, SMTP_USER, SMTP_PASS)");
  process.exit(1);
}

// 使用 || 确保在变量为空字符串 "" 时，能正确回退到默认值
const SMTP_HOST = env.SMTP_HOST || "smtp.gmail.com"; 
const SMTP_PORT = Number(env.SMTP_PORT || 465);
const SMTP_SECURE = (env.SMTP_SECURE || "true") === "true";
const RECIPIENT_EMAIL = env.RECIPIENT_EMAIL || "1336487767@qq.com";
const TARGET_UID = env.TARGET_UID || "";

/* ---------- 2. 初始化 Firebase Admin ---------- */
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();

/* ---------- 3. 日期辅助 ---------- */
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

/* ---------- 4. 获取 Firestore 数据 ---------- */
async function fetchData() {
  let uid = TARGET_UID;

  // 获取今天的任务
  const todaySnap = await db.collection("tasks").where("date", "==", today).get();
  if (!uid && !todaySnap.empty) {
    uid = todaySnap.docs[0].data().userId;
  }

  // 获取最近 7 天任务
  const weekSnap = await db
    .collection("tasks")
    .where("date", ">=", weekAgo)
    .where("date", "<=", today)
    .get();

  let allTasks = weekSnap.docs.map((d) => d.data());
  if (uid) allTasks = allTasks.filter((t) => t.userId === uid);

  const todayTasks = allTasks.filter((t) => t.date === today);

  // 获取连续天数
  let streak = { current: 0, longest: 0 };
  if (uid) {
    const streakDoc = await db.collection("streaks").doc(uid).get();
    if (streakDoc.exists) streak = streakDoc.data();
  }

  return { todayTasks, streak };
}

/* ---------- 5. 调用 DeepSeek 生成文案 ---------- */
async function generateEmailText({ todayTasks, streak }) {
  const doneCount = todayTasks.filter((t) => t.status === "done").length;
  const totalCount = todayTasks.length;

  const taskListText = todayTasks
    .map((t) => `- [${t.status}] ${t.title}`)
    .join("\n") || "(No tasks logged today)";

  const prompt = `You are writing a short daily study-progress email to a student on behalf of "Super Study Calendar".
Data for today (${today}):
${taskListText}
Completion: ${doneCount}/${totalCount} tasks completed.
Current streak: ${streak.current || 0} day(s).

Write a warm, concise English email (under 150 words) with plain text (no markdown like # or **). Include a greeting, progress review, and a small encouragement for tomorrow.`;

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    throw new Error(`DeepSeek API error ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  return { text: text || "Keep up the good work!", doneCount, totalCount };
}

/* ---------- 6. 发送邮件 ---------- */
async function sendEmail(bodyText, { doneCount, totalCount }) {
  console.log(`📡 Connecting to SMTP Server: ${SMTP_HOST}:${SMTP_PORT} (Secure: ${SMTP_SECURE})`);

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const subject = totalCount > 0
    ? `📘 Study Update ${today} — ${doneCount}/${totalCount} done`
    : `📘 Daily Study Nudge — ${today}`;

  await transporter.sendMail({
    from: SMTP_USER,
    to: RECIPIENT_EMAIL,
    subject,
    text: bodyText,
    html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#1C2541;">${bodyText.replace(/\n/g, "<br>")}</div>`,
  });

  console.log(`✅ Email successfully sent to ${RECIPIENT_EMAIL}`);
}

/* ---------- 7. 入口函数 ---------- */
(async () => {
  try {
    console.log("🚀 Starting daily study email worker...");
    const data = await fetchData();
    const { text, doneCount, totalCount } = await generateEmailText(data);
    await sendEmail(text, { doneCount, totalCount });
  } catch (err) {
    console.error("❌ Failed to send daily study email:", err);
    process.exit(1);
  }
})();
