const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// 1. 从 GitHub Secrets 加载 Firebase 证书
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ 错误：未找到 FIREBASE_SERVICE_ACCOUNT 环境变量！");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// 初始化 Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 2. 配置 Gmail SMTP 发件器
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function run() {
  console.log('🚀 开始连接 Cloud Firestore 读取 tasks 集合...');

  // 3. 读取未完成 (completed == false) 的任务
  const snapshot = await db.collection('tasks')
    .where('completed', '==', false)
    .get();

  // 在内存中过滤出未发过邮件的记录
  const pendingTasks = snapshot.docs.filter(doc => !doc.data().emailSent);

  if (pendingTasks.length === 0) {
    console.log('ℹ️ 没有找到待提醒的未完成任务 (completed == false)。');
    return;
  }

  console.log(`✉️ 找到 ${pendingTasks.length} 条待提醒任务，准备发送测试邮件...`);

  // 4. 遍历处理每个任务
  for (const doc of pendingTasks) {
    const data = doc.data();
    
    const taskTitle = data.title || '未命名任务';
    const taskType = data.type || '普通';
    
    // 🎯 【测试模式】：直接把收件人写死为你的测试 QQ 邮箱
    const recipientEmail = '1336487767@qq.com';

    // 格式化创建时间
    let createdAtStr = '未知时间';
    if (data.createdAt && typeof data.createdAt.toDate === 'function') {
      createdAtStr = data.createdAt.toDate().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    }

    try {
      // 5. 发送提醒邮件
      let info = await transporter.sendMail({
        from: `"任务提醒助手" <${process.env.SMTP_USER}>`,
        to: recipientEmail,
        subject: `⏰ [测试提醒] 任务：${taskTitle}`,
        html: `
          <div style="max-width: 500px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; border: 1px solid #e1e4e8; border-radius: 8px;">
            <h2 style="color: #0366d6; margin-top: 0;">📋 待完成任务提醒（测试发信）</h2>
            <p style="color: #333;">你好！这是一封发送至 <strong>1336487767@qq.com</strong> 的测试提醒：</p>
            <div style="background-color: #f6f8fa; padding: 15px; border-radius: 6px; margin: 15px 0;">
              <p style="margin: 5px 0;"><strong>任务内容：</strong> ${taskTitle}</p>
              <p style="margin: 5px 0;"><strong>任务类型：</strong> <span style="background: #28a745; color: white; padding: 2px 6px; border-radius: 3px; font-size: 12px;">${taskType}</span></p>
              <p style="margin: 5px 0; color: #666; font-size: 13px;"><strong>创建时间：</strong> ${createdAtStr}</p>
            </div>
            <p style="color: #d73a49; font-size: 13px;">💡 此邮件由 GitHub Actions 手动点击触发发送！</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
            <small style="color: #6a737d;">GitHub Actions 手动测试运行</small>
          </div>
        `
      });

      console.log(`✅ 成功发送任务「${taskTitle}」提醒至: ${recipientEmail} | Message ID: ${info.messageId}`);

      // 6. 更新 Firestore 状态，防重复发信
      await doc.ref.update({
        emailSent: true,
        lastEmailSentAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`🔄 已将任务 ${doc.id} 标记为 emailSent: true`);

    } catch (err) {
      console.error(`❌ 发送任务「${taskTitle}」提醒失败:`, err);
    }
  }
}

run().catch(console.error);
