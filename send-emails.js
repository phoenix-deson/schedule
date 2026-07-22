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

// Hidden variables & fallback defaults
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

/* ---------- 3. Date Helper ---------- */
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

/* ---------- 5. AI Warm & Encouraging Note ---------- */
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
3. IMPORTANT: Include a thoughtful, caring reminder to take care of themselves, rest well, and recharge (e.g., "Don't forget to take breaks, get enough sleep, and take good care of yourself!").
4. Tone: Inspiring, friendly, caring, and uplifting.
5. Keep it around 120-150 words. Plain text only (no markdown like # or **).`;

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
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
    `Hi ${USER_NAME}! You're doing an amazing job. Remember to stay hydrated and take a good rest tonight!`
  );
}

/* ---------- 6. Clean HTML Card Template ---------- */
function buildCardHtml(aiContent, { doneTasks, todoTasks, streak }) {
  const todoListHtml =
    todoTasks.length > 0
      ? todoTasks
          .map(
            (t) =>
              `<li style="margin-bottom:8px;color:#D97706;">⏳ ${t.title}${
                t.tag
                  ? ` <span style="font-size:12px;color:#6B7280;background:#F3F4F6;padding:2px 6px;border-radius:4px;">${t.tag}</span>`
                  : ""
              }</li>`
          )
          .join("")
      : `<li style="color:#10B981;">🎉 All tasks completed today! Time to relax!</li>`;

  const doneListHtml =
    doneTasks.length > 0
      ? doneTasks
          .map(
            (t) =>
              `<li style="margin-bottom:6px;color:#059669;text-decoration:line-through;">✅ ${t.title}</li>`
          )
          .join("")
      : `<li style="color:#9CA3AF;">No tasks completed yet today.</li>`;

  return `
  <div style="background-color: #F3F4F6; padding: 30px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
    <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.05);">
      
      <!-- Card Header -->
      <div style="background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); padding: 24px; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 700;">Daily Study Report 📅</h2>
        <div style="margin-top: 6px; font-size: 13px; opacity: 0.9;">${today} · ${streak.current || 0}-day streak</div>
      </div>

      <!-- Core Stats Panel -->
      <div style="padding: 24px 24px 20px 24px;">
        <div style="display: flex; gap: 12px; margin-bottom: 20px;">
          <div style="flex: 1; background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 12px; padding: 14px; text-align: center;">
            <div style="font-size: 24px; font-weight: 800; color: #059669;">${doneTasks.length}</div>
            <div style="font-size: 12px; color: #047857; font-weight: 600; margin-top: 2px;">Completed</div>
          </div>
          <div style="flex: 1; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 12px; padding: 14px; text-align: center;">
            <div style="font-size: 24px; font-weight: 800; color: #D97706;">${todoTasks.length}</div>
            <div style="font-size: 12px; color: #B45309; font-weight: 600; margin-top: 2px;">Pending</div>
          </div>
        </div>

        <!-- AI Warm Encouragement Card -->
        <div style="background: #F9FAFB; border-left: 4px solid #6366F1; border-radius: 4px 8px 8px 4px; padding: 16px; margin-bottom: 24px;">
          <div style="font-size: 14px; line-height: 1.6; color: #374151; white-space: pre-wrap;">${aiContent}</div>
        </div>

        <!-- Pending Tasks List -->
        <div style="margin-bottom: 20px;">
          <h4 style="margin: 0 0 10px 0; font-size: 14px; color: #1F2937; text-transform: uppercase; letter-spacing: 0.5px;">📌 Pending Tasks (${todoTasks.length})</h4>
          <ul style="margin: 0; padding-left: 18px; font-size: 14px;">
            ${todoListHtml}
          </ul>
        </div>

        <!-- Completed Tasks List -->
        <div style="margin-bottom: 10px; border-top: 1px dashed #E5E7EB; padding-top: 16px;">
          <h4 style="margin: 0 0 10px 0; font-size: 13px; color: #6B7280;">✔️ Completed Today (${doneTasks.length})</h4>
          <ul style="margin: 0; padding-left: 18px; font-size: 13px;">
            ${doneListHtml}
          </ul>
        </div>
      </div>

    </div>
  </div>
  `;
}

/* ---------- 7. Send Mail ---------- */
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

/* ---------- 8. Main Entry ---------- */
(async () => {
  try {
    console.log("🚀 Starting daily study email worker...");
    const { todayTasks, streak } = await fetchData();

    const doneTasks = todayTasks.filter((t) => t.status === "done");
    const todoTasks = todayTasks.filter((t) => t.status !== "done");

    const aiContent = await generateAiNote({ doneTasks, todoTasks, streak });
    await sendEmail(aiContent, { doneTasks, todoTasks, streak });
  } catch (err) {
    console.error("❌ Failed to send daily study email:", err);
    process.exit(1);
  }
})();
