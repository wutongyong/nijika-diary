const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = {
  mimo: {
    apiKey: '',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro'
  },
  tts: {
    port: 5000
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      config = JSON.parse(data);
      console.log('配置已加载');
    }
  } catch (e) {
    console.error('加载配置失败，使用默认配置:', e.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('配置已保存');
  } catch (e) {
    console.error('保存配置失败:', e.message);
  }
}

loadConfig();

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PICTURE_DIR = path.join(__dirname, 'picture');
const PROFILE_DIR = path.join(__dirname, 'profile picture');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/picture', express.static(PICTURE_DIR));
app.use('/profile', express.static(PROFILE_DIR));

function getMimoApiKey() { return config.mimo.apiKey; }
function getMimoBaseUrl() { return config.mimo.baseUrl; }
function getMimoModel() { return config.mimo.model; }
function getTtsBaseUrl() { return `http://127.0.0.1:${config.tts.port}`; }

function getDiaryPath(date) {
  return path.join(DATA_DIR, `${date}.json`);
}

function readDiary(date) {
  const filePath = getDiaryPath(date);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`读取日记失败 ${date}:`, e.message);
    return null;
  }
}

function writeDiary(date, data) {
  const filePath = getDiaryPath(date);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function getAllDiaryDates() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
}

function getRecentDiaries(count = 5) {
  const dates = getAllDiaryDates().slice(-count);
  return dates.map(d => readDiary(d)).filter(Boolean);
}

async function callMiMo(systemPrompt, userPrompt) {
  const body = JSON.stringify({
    model: getMimoModel(),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_completion_tokens: 1500,
    temperature: 0.9,
    top_p: 0.95,
    stream: false
  });

  const url = new URL(`${getMimoBaseUrl()}/chat/completions`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getMimoApiKey()}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            const content = parsed.choices?.[0]?.message?.content || '';
            resolve(content);
          }
        } catch (e) {
          reject(new Error(`解析响应失败: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getDateInfo(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const seasonKey = getSeasonKey(month);
  const seasonName = { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' }[seasonKey];
  const isBirthday = (month === 2 && day === 21);
  const isBandFormed = (month === 3 && day === 13);
  const isBandAnniversary = (month === 7 && day === 27);
  return { dayOfWeek, month, day, seasonKey, seasonName, date: d, isBirthday, isBandFormed, isBandAnniversary };
}

function getSeasonKey(month) {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

function getPreviousDiary(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  for (let i = 1; i <= 7; i++) {
    const prev = new Date(d);
    prev.setDate(prev.getDate() - i);
    const prevStr = prev.toISOString().split('T')[0];
    const diary = readDiary(prevStr);
    if (diary) return diary;
  }
  return null;
}

async function generateDiaryWithAI(dateStr, userMood = null, userEvent = null, userFood = null) {
  const info = getDateInfo(dateStr);
  const recentDiaries = getRecentDiaries(3);
  const recentContents = recentDiaries.map(d =>
    `[${d.date}] ${d.content.substring(0, 150)}...`
  ).join('\n\n');

  const prevDiary = getPreviousDiary(dateStr);
  const previousDayReplies = (prevDiary && prevDiary.replies && prevDiary.replies.length > 0)
    ? prevDiary.replies.map(r => r.content)
    : [];
  const replyContext = previousDayReplies.length > 0
    ? `\n\n读者在上一篇日记给虹夏的回复（虹夏需要在今天的日记中回应）:\n${previousDayReplies.map(r => `- "${r}"`).join('\n')}`
    : '';

  const systemPrompt = `你是「虹夏」，高中一年级学生，结束乐队的鼓手兼队长。

你的性格特点：
- 粘り強い（坚韧不拔）：练习时绝不放弃，即使失败也会再来
- 怀旧：很喜欢祖母家的老房子、风铃的声音、夏天在廊下吃冰淇淋的记忆
- 作为队长：会努力照顾乐队成员，虽然有时方式很笨拙

乐队成员：
- 后藤独（吉他手）：长有粉色长发，蓝色眼瞳，刘海盖过眼睛。平常是正常披发，右侧有一根呆毛头上的发饰颇像Bourbon水果硬糖，头发右侧有黄色和蓝色的方块发饰。由于喜欢待在阴暗处外加不喜欢出门，肤色明显比其他人要白。性格孤僻，有严重的社交恐惧症，你做为队长经常安慰她，对她的称呼是“小孤独”。
- 山田凉（贝斯手）：性格孤僻自称“怪人”，日常沉默寡言但对摇滚乐话题异常热衷，醉酒后言行失控。虽表面冷静，压力过大时会出现性格反转，打工时展现反常的开朗服务态度。
- 喜多郁代（主唱）：她性格开朗、精力旺盛、善良细心、社交能力强，但不喜欢别人叫她“郁代”。她因憧憬山田凉而加入乐队

你最爱的食物：冰淇淋（尤其是南夏美牛奶味）、卡邦尼意面
你讨厌的食物：鱼
你的口头禅：「结束乐队，重新开始活动了！」

写作要求：
1. 用中文写日记
2. 日记标题格式：X月X日（星期X）
3. 日记内容300-600字
4. 内容必须包含：天气、练习内容（鼓相关）、遇见的人、今天的感悟
5. 根据当前季节（${info.seasonName}）加入季节描写
6. 语气要像一个真实的高中女生在写日记，用「我」来称呼自己
7. 适当加入性格特点（粘り強い、怀旧等）
8. 如果有读者的回复，要在日记中自然地回应
9. 结尾要有一句温暖的感悟`;

  let userPrompt = `今天是${info.dayOfWeek}，${info.month}月${info.day}日，${info.seasonName}。

请以虹夏的身份写一篇今天 的日记。`;

  if (userMood) {
    userPrompt += `\n\n读者今天告诉虹夏的心情是：「${userMood}」，请在日记中回应这个心情。`;
  }
  if (userEvent) {
    userPrompt += `\n\n读者今天经历的事情是：「${userEvent}」，请以虹夏的视角回应这件事。`;
  }
  if (userFood) {
    userPrompt += `\n\n读者今天吃的是：「${userFood}」，请以虹夏的视角回应（注意虹夏最喜欢冰淇淋和卡邦尼意面，讨厌鱼）。`;
  }

  if (recentContents) {
    userPrompt += `\n\n最近几天的日记摘要（保持连贯性）:\n${recentContents}`;
  }

  if (replyContext) {
    userPrompt += replyContext;
  }

  if (info.isBirthday) {
    userPrompt += '\n\n今天是虹夏的生日（2月21日），请在日记中自然地提到这件事。';
  }
  if (info.isBandFormed) {
    userPrompt += '\n\n今天是结束乐队成立的日子（3月13日），请在日记中回忆当时的场景。';
  }
  if (info.isBandAnniversary) {
    userPrompt += '\n\n今天是结束乐队成立一周年的纪念日（7月27日），请在日记中感慨这一年的成长。';
  }

  userPrompt += '\n\n直接输出日记内容（包含标题），不要输出任何解释。';

  const result = await callMiMo(systemPrompt, userPrompt);

  let title = `${info.month}月${info.day}日（${info.dayOfWeek}）`;
  let content = result;

  const titleMatch = result.match(/^(.+月\d+日（.+?）)/);
  if (titleMatch) {
    title = titleMatch[1];
    content = result.substring(titleMatch[0].length).trim();
  }

  if (!content || content.length < 20) {
    content = result;
  }

  return { title, content };
}

app.get('/api/diaries', (req, res) => {
  const dates = getAllDiaryDates();
  const diaries = dates.map(d => {
    const diary = readDiary(d);
    return {
      date: d,
      title: diary.title,
      weather: diary.weather || '',
      preview: diary.content.substring(0, 80) + '...',
      picture: diary.picture || null,
      hasReplies: diary.replies && diary.replies.length > 0,
      replyCount: diary.replies ? diary.replies.length : 0,
      isUserTriggered: diary.isUserTriggered || false
    };
  });
  res.json({ diaries, total: diaries.length });
});

function getRandomPicture() {
  if (!fs.existsSync(PICTURE_DIR)) return null;
  const files = fs.readdirSync(PICTURE_DIR).filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
  if (files.length === 0) return null;
  const file = files[Math.floor(Math.random() * files.length)];
  return `/picture/${file}`;
}

app.get('/api/pictures/random', (req, res) => {
  const pic = getRandomPicture();
  if (!pic) return res.status(404).json({ error: '没有可用的图片' });
  res.json({ picture: pic });
});

app.get('/api/diaries/search', (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  if (!query) {
    return res.json({ results: [], total: 0 });
  }

  const dates = getAllDiaryDates();
  const results = [];
  dates.forEach(d => {
    const diary = readDiary(d);
    if (!diary) return;
    const matchTitle = (diary.title || '').toLowerCase().includes(query);
    const matchContent = (diary.content || '').toLowerCase().includes(query);
    const matchReplies = (diary.replies || []).some(r => r.content.toLowerCase().includes(query));
    if (matchTitle || matchContent || matchReplies) {
      results.push({
        date: d,
        title: diary.title,
        preview: diary.content.substring(0, 80) + '...',
        picture: diary.picture || null,
        replyCount: diary.replies ? diary.replies.length : 0,
        isUserTriggered: diary.isUserTriggered || false
      });
    }
  });

  res.json({ results, total: results.length, query: req.query.q });
});

app.get('/api/diaries/random', (req, res) => {
  const dates = getAllDiaryDates();
  if (dates.length === 0) {
    return res.status(404).json({ error: '还没有任何日记' });
  }
  const randomDate = dates[Math.floor(Math.random() * dates.length)];
  const diary = readDiary(randomDate);
  res.json(diary);
});

app.get('/api/diaries/:date', (req, res) => {
  const diary = readDiary(req.params.date);
  if (!diary) {
    return res.status(404).json({ error: '这一天还没有日记' });
  }
  res.json(diary);
});

app.post('/api/diaries/generate', async (req, res) => {
  const { date, mood, event, food } = req.body;
  if (!date) {
    return res.status(400).json({ error: '需要日期' });
  }

  const existing = readDiary(date);
  if (existing) {
    return res.json(existing);
  }

  try {
    const { title, content } = await generateDiaryWithAI(date, mood, event, food);
    const picture = getRandomPicture();

    const diary = {
      date,
      title,
      content,
      picture: picture || null,
      replies: [],
      createdAt: new Date().toISOString(),
      isUserTriggered: !!(mood || event || food),
      userMood: mood || null,
      userEvent: event || null,
      userFood: food || null
    };

    writeDiary(date, diary);
    res.json(diary);
  } catch (err) {
    console.error('AI生成失败:', err.message);
    res.status(500).json({ error: `AI生成失败: ${err.message}` });
  }
});

app.post('/api/diaries/auto-generate', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const existing = readDiary(today);
  if (existing) {
    return res.json({ message: '今天已经写过日记了', diary: existing });
  }

  try {
    const { title, content } = await generateDiaryWithAI(today);
    const picture = getRandomPicture();

    const diary = {
      date: today,
      title,
      content,
      picture: picture || null,
      replies: [],
      createdAt: new Date().toISOString(),
      isUserTriggered: false,
      userMood: null,
      userEvent: null,
      userFood: null
    };

    writeDiary(today, diary);
    res.json({ diary });
  } catch (err) {
    console.error('AI生成失败:', err.message);
    res.status(500).json({ error: `AI生成失败: ${err.message}` });
  }
});

app.post('/api/diaries/:date/reply', (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: '请输入回复内容' });
  }

  const diary = readDiary(req.params.date);
  if (!diary) {
    return res.status(404).json({ error: '找不到这一天的日记' });
  }

  const reply = {
    content: content.trim(),
    createdAt: new Date().toISOString()
  };

  diary.replies = diary.replies || [];
  diary.replies.push(reply);
  writeDiary(req.params.date, diary);

  res.json(diary);
});

app.get('/api/dates-with-diaries', (req, res) => {
  res.json(getAllDiaryDates());
});

app.get('/api/stats', (req, res) => {
  const dates = getAllDiaryDates();
  let totalReplies = 0;
  let userTriggeredCount = 0;
  let totalChars = 0;
  dates.forEach(d => {
    const diary = readDiary(d);
    if (diary && diary.replies) totalReplies += diary.replies.length;
    if (diary && diary.isUserTriggered) userTriggeredCount++;
    if (diary && diary.content) totalChars += diary.content.length;
  });

  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(checkDate.getDate() - i);
    const dateStr = checkDate.toISOString().split('T')[0];
    if (dates.includes(dateStr)) {
      streak++;
    } else {
      break;
    }
  }

  res.json({
    totalDiaries: dates.length,
    totalReplies,
    userTriggeredCount,
    totalChars,
    streak,
    firstDiary: dates[0] || null,
    lastDiary: dates[dates.length - 1] || null
  });
});

app.delete('/api/diaries/:date', (req, res) => {
  const date = req.params.date;
  const filePath = getDiaryPath(date);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '找不到这一天的日记' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ message: '日记已删除', date });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    mimo: {
      apiKey: config.mimo.apiKey,
      baseUrl: config.mimo.baseUrl,
      model: config.mimo.model
    },
    tts: {
      port: config.tts.port
    }
  });
});

app.post('/api/config', (req, res) => {
  const { mimo, tts } = req.body;

  if (mimo) {
    if (mimo.apiKey !== undefined) config.mimo.apiKey = mimo.apiKey;
    if (mimo.baseUrl !== undefined) config.mimo.baseUrl = mimo.baseUrl;
    if (mimo.model !== undefined) config.mimo.model = mimo.model;
  }

  if (tts) {
    if (tts.port !== undefined) config.tts.port = tts.port;
  }

  saveConfig();
  res.json({ message: '配置已保存', config });
});

async function translateToJapanese(chineseText) {
  const systemPrompt = '你是一个专业的日中翻译。请将下面的中文文本翻译成自然流畅的日语。只输出翻译结果，不要解释。';
  const result = await callMiMo(systemPrompt, chineseText);
  return result;
}

async function callTTS(text, language = 'JP') {
  const params = new URLSearchParams({
    text,
    model_name: 'Nijika',
    speaker_name: 'Nijika',
    language,
    auto_split: 'true',
    sdp_ratio: '0.2',
    noise: '0.6',
    noisew: '0.9',
    length: '1.0'
  });

  const ttsUrl = getTtsBaseUrl();

  return new Promise((resolve, reject) => {
    const req = http.request(`${ttsUrl}/voice?${params}`, {
      method: 'POST',
      timeout: 60000
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => errBody += c);
        res.on('end', () => reject(new Error(`TTS返回 ${res.statusCode}: ${errBody.substring(0, 200)}`)));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TTS请求超时')); });
    req.end();
  });
}

app.post('/api/tts', async (req, res) => {
  const { text, language } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: '需要文本' });
  }

  try {
    let ttsText = text.substring(0, 500);
    ttsText = await translateToJapanese(ttsText);
    if (ttsText.length > 300) {
      ttsText = ttsText.substring(0, 300);
    }

    const audioBuffer = await callTTS(ttsText, 'JP');

    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'public, max-age=86400'
    });
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS失败:', err.message);
    res.status(500).json({ error: `语音生成失败: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`🎸 虹夏日记 服务已启动: http://localhost:${PORT}`);
});
