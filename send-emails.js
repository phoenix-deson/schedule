/**
 * send-emails.js
 * Runs on a GitHub Actions schedule (or manually via workflow_dispatch).
 * 1. Reads today's + last 7 days' tasks from Firestore (Admin SDK).
 * 2. Sends that data to DeepSeek to write a short, encouraging English email
 *    that reviews progress and motivates the recipient.
 * 3. Emails it via SMTP (nodemailer).
 *
 * Required GitHub Actions secrets:
 *   FIREBASE_SERVICE_ACCOUNT  - full JSON of a Firebase service account key
 *   DEEPSEEK_API_KEY          - DeepSeek API key (rotate the one pasted in chat!)
 *   SMTP_USER                 - SMTP login / from-address
 *   SMTP_PASS                 - SMTP password / app password
 *
 * Optional secrets or repo variables (all have defaults below):
 *   RECIPIENT_EMAIL  (default: 1336487767@qq.com — the test inbox from the PRD)
 *   SMTP_HOST        (default: smtp.gmail.com)
 *   SMTP_PORT        (default: 465)
 *   SMTP_SECURE      (default: true)
 *   TARGET_UID       (optional — if set, only that user's tasks are used;
 *                     otherwise the script uses whichever uid owns today's tasks,
 *                     which is fine for a single-user deployment)
 */

import admin from "firebase-admin";
import nodemailer from "nodemailer";

/* ---------- env / config ---------- */
const {
  FIREBASE_SERVICE_ACCOUNT,
  DEEPSEEK_API_KEY,
  SMTP_USER,
  SMTP_PASS,
  RECIPIENT_EMAIL = "1336487767@qq.com",
  SMTP_HOST = "smtp.gmail.com",
  SMTP_PORT = "465",
  SMTP_SECURE = "true",
  TARGET_UID = "",
} = process.env;

function requireEnv(name, val) {
  if (!val) {
    console.error(`Missing required secret/env var: ${name}`);
    process.exit(1);
  }
}
requireEnv("FIREBASE_SERVICE_ACCOUNT", FIREBASE_SERVICE_ACCOUNT);
requireEnv("DEEPSEEK_API_KEY", DEEPSEEK_API_KEY);
requireEnv("SMTP_USER", SMTP_USER);
requireEnv("SMTP_PASS", SMTP_PASS);

/* ---------- firebase admin init ---------- */
const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

/* ---------- date helpers ---------- */
function fmtDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
const today = fmtDate(new Date());
const weekAgo = addDays(today, -6);

/* ---------- fetch data ---------- */
async function fetchData() {
  let uid = TARGET_UID;

  // If no explicit uid, infer it from whoever has tasks today (single-user friendly).
  const todaySnap = await db.collection("tasks").where("date", "==", today).get();
  if (!uid) {
    const first = todaySnap.docs[0];
    uid = first ? first.data().userId : null;
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

  // Rough per-day completion for the week, for trend context.
  const byDay = {};
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekAgo, i);
    const dayTasks = allTasks.filter((t) => t.date === d);
    byDay[d] = {
      total: dayTasks.length,
      done: dayTasks.filter((t) => t.status === "done").length,
    };
  }

  return { uid, todayTasks, byDay, streak };
}

/* ---------- DeepSeek ---------- */
async function generateEmail({ todayTasks, byDay, streak }) {
  const doneToday = todayTasks.filter((t) => t.status === "done").length;
  const totalToday = todayTasks.length;
  const pctToday = totalToday ? Math.round((doneToday / totalToday) * 100) : null;

  const weekSummary = Object.entries(byDay)
    .map(([d, v]) => `${d}: ${v.done}/${v.total} completed`)
    .join("\n");

  const taskLines = todayTasks
    .map((t) => `- [${t.status}] ${t.title}${t.tag ? ` (${t.tag})` : ""}`)
    .join("\n") || "(no tasks logged for today)";

  const prompt = `You are writing a short daily study-progress email to a student, on behalf of their "Super Study Calendar" app.

Data for today (${today}):
${taskLines}
Today's completion: ${totalToday ? `${doneToday}/${totalToday} (${pctToday}%)` : "no tasks logged"}
Current streak: ${streak.current || 0} day(s), longest streak: ${streak.longest || 0} day(s)

Completion over the last 7 days:
${weekSummary}

Write the email in English, plain text (no markdown symbols like # or **). Structure:
1. A warm, genuine, specific greeting and one encouraging line (not generic hype — reference something real from the data).
2. A short, honest analysis of today's progress and the weekly trend (2-4 sentences).
3. One concrete, kind suggestion for tomorrow.
4. A brief sign-off from "Your Super Study Calendar".

Keep the whole email under 180 words. Do not invent tasks or numbers that weren't given.`;

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
      max_tokens: 500,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepSeek API error ${resp.status}: ${errText}`);
  }
  const json = await resp.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("DeepSeek returned no content");
  return { text, pctToday, doneToday, totalToday };
}

/* ---------- email send ---------- */
async function sendEmail(bodyText, subjectMeta) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const subject =
    subjectMeta.totalToday > 0
      ? `📘 Study Update ${today} — ${subjectMeta.doneToday}/${subjectMeta.totalToday} done (${subjectMeta.pctToday}%)`
      : `📘 Study Update ${today}`;

  await transporter.sendMail({
    from: SMTP_USER,
    to: RECIPIENT_EMAIL,
    subject,
    text: bodyText,
    html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#1C2541;white-space:pre-wrap;">${bodyText.replace(
      /</g,
      "&lt;"
    )}</div>`,
  });

  console.log(`Email sent to ${RECIPIENT_EMAIL}`);
}

/* ---------- main ---------- */
(async () => {
  try {
    const data = await fetchData();
    if (!data.uid) {
      console.log("No tasks found for any user today — sending a gentle nudge instead of skipping.");
    }
    const { text, pctToday, doneToday, totalToday } = await generateEmail(data);
    await sendEmail(text, { pctToday, doneToday, totalToday });
  } catch (err) {
    console.error("Failed to send daily study email:", err);
    process.exit(1);
  }
})();
