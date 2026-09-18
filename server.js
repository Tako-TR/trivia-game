const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const QUESTION_DURATION = 15;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const memoryPlayers = {};
const memoryRoomScores = {};
const memoryCategoryScores = {};

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL not detected. Persistent stats running in memory only.');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        username VARCHAR(30) PRIMARY KEY,
        pin VARCHAR(10) NOT NULL,
        avatar VARCHAR(10) DEFAULT '🚀',
        badge VARCHAR(10) DEFAULT '',
        high_score INT DEFAULT 0,
        career_score INT DEFAULT 0,
        games_played INT DEFAULT 0,
        achievements TEXT[] DEFAULT ARRAY[]::TEXT[],
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar VARCHAR(10) DEFAULT '🚀';
      ALTER TABLE players ADD COLUMN IF NOT EXISTS badge VARCHAR(10) DEFAULT '';
      ALTER TABLE players ADD COLUMN IF NOT EXISTS achievements TEXT[] DEFAULT ARRAY[]::TEXT[];

      CREATE TABLE IF NOT EXISTS room_scores (
        username VARCHAR(30) NOT NULL,
        room_code VARCHAR(20) NOT NULL,
        high_score INT DEFAULT 0,
        career_score INT DEFAULT 0,
        games_played INT DEFAULT 0,
        PRIMARY KEY (username, room_code)
      );

      CREATE TABLE IF NOT EXISTS category_scores (
        username VARCHAR(30) NOT NULL,
        category VARCHAR(30) NOT NULL,
        high_score INT DEFAULT 0,
        career_score INT DEFAULT 0,
        games_played INT DEFAULT 0,
        PRIMARY KEY (username, category)
      );
    `);
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Error initializing database tables:', err);
  }
}
initDb();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const questionsFilePath = path.join(__dirname, 'questions.json');
const presetsFilePath = path.join(__dirname, 'presets.json');

let masterQuestions = [];
try {
  const rawQuestions = JSON.parse(fs.readFileSync(questionsFilePath, 'utf8'));
  masterQuestions = rawQuestions.filter(q => {
    const cat = (q.category || '').toLowerCase();
    return !cat.includes('logo');
  });
} catch (err) {
  console.error('Error loading questions.json:', err);
}

let gamePresets = {};
try {
  if (fs.existsSync(presetsFilePath)) {
    gamePresets = JSON.parse(fs.readFileSync(presetsFilePath, 'utf8'));
  }
} catch (err) {
  console.error('Error loading presets.json:', err);
}

function saveQuestionsToFile(res, successPayload) {
  fs.writeFile(questionsFilePath, JSON.stringify(masterQuestions, null, 2), 'utf8', (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Failed to write questions.json' });
    return res.json({ ...successPayload, questions: masterQuestions });
  });
}

function savePresetsToFile(res, successPayload) {
  fs.writeFile(presetsFilePath, JSON.stringify(gamePresets, null, 2), 'utf8', (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Failed to write presets.json' });
    return res.json(successPayload);
  });
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const MAX_ROOMS = 6;
const ROOM_NAMES = {
  'ROOM1': 'Fremont Main',
  'ROOM2': 'Fremont HS',
  'ROOM3': 'Fremont MS',
  'ROOM4': 'Tiffin',
  'ROOM5': 'Sandusky',
  'ROOM6': 'Northwood'
};

const rooms = {};

function getOrCreateRoom(rawRoomCode) {
  const code = (rawRoomCode || 'ROOM1').trim().toUpperCase();
  if (!rooms[code]) {
    if (Object.keys(rooms).length >= MAX_ROOMS && !rooms[code]) return null;
    rooms[code] = {
      code: code,
      name: ROOM_NAMES[code] || code,
      activeSockets: {},
      activeQuestions: [],
      currentQuestionIndex: -1,
      questionTimer: null,
      intermissionTimer: null,
      timeLeft: QUESTION_DURATION,
      questionStartTime: 0,
      roundActive: false,
      isPaused: false,
      currentGameCategory: 'all',
      previousRankings: {},
      usedQuestionIds: new Set()
    };
  }
  return rooms[code];
}

function getSocketRoom(socket) {
  for (const code of Object.keys(rooms)) {
    if (rooms[code].activeSockets[socket.id]) return rooms[code];
  }
  return null;
}

function isPlayerCurrentlyOnline(username) {
  for (const code of Object.keys(rooms)) {
    for (const id of Object.keys(rooms[code].activeSockets)) {
      if (rooms[code].activeSockets[id].username === username) return true;
    }
  }
  return false;
}

/* =========================================================
   ADMIN API
========================================================= */

app.post('/api/questions/list', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  return res.json({ success: true, questions: masterQuestions });
});

app.post('/api/questions/add', (req, res) => {
  const { password, category, difficulty, question, options, answer, image } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  if (!category || !difficulty || !question || !Array.isArray(options) || options.length !== 4 || answer === undefined) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const newQuestion = {
    category: `${category}: ${difficulty}`,
    question: question.trim(),
    options: options.map((opt) => opt.trim()),
    answer: parseInt(answer, 10)
  };
  if (image && image.trim() !== '') newQuestion.image = image.trim();

  masterQuestions.push(newQuestion);
  saveQuestionsToFile(res, { success: true, totalQuestions: masterQuestions.length });
});

app.post('/api/questions/edit', (req, res) => {
  const { password, index, category, question, options, answer, image } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });

  const qIndex = parseInt(index, 10);
  if (isNaN(qIndex) || qIndex < 0 || qIndex >= masterQuestions.length) {
    return res.status(400).json({ success: false, message: 'Invalid question index.' });
  }
  if (!category || !question || !Array.isArray(options) || options.length !== 4 || answer === undefined) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const updatedQ = {
    category: category.trim(),
    question: question.trim(),
    options: options.map((opt) => String(opt).trim()),
    answer: parseInt(answer, 10)
  };
  if (image && String(image).trim() !== '') updatedQ.image = String(image).trim();

  masterQuestions[qIndex] = updatedQ;
  saveQuestionsToFile(res, { success: true, message: 'Question updated successfully.' });
});

app.post('/api/questions/bulk', (req, res) => {
  const { password, questions } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ success: false, message: 'No questions provided.' });
  }

  const validQuestions = [];
  for (const q of questions) {
    if (q.category && q.question && Array.isArray(q.options) && q.options.length >= 2 && q.answer !== undefined) {
      const formatted = {
        category: q.category.trim(),
        question: q.question.trim(),
        options: q.options.map(opt => String(opt).trim()),
        answer: parseInt(q.answer, 10)
      };
      if (q.image && String(q.image).trim() !== '') formatted.image = String(q.image).trim();
      validQuestions.push(formatted);
    }
  }

  if (validQuestions.length === 0) return res.status(400).json({ success: false, message: 'No valid rows found.' });

  masterQuestions.push(...validQuestions);
  saveQuestionsToFile(res, { success: true, addedCount: validQuestions.length, totalQuestions: masterQuestions.length });
});

app.post('/api/questions/delete', (req, res) => {
  const { password, index } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  const qIndex = parseInt(index, 10);
  if (isNaN(qIndex) || qIndex < 0 || qIndex >= masterQuestions.length) {
    return res.status(400).json({ success: false, message: 'Invalid index.' });
  }

  masterQuestions.splice(qIndex, 1);
  saveQuestionsToFile(res, { success: true, totalQuestions: masterQuestions.length });
});

app.post('/api/questions/bulk-delete', (req, res) => {
  const { password, indices } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  if (!Array.isArray(indices) || indices.length === 0) {
    return res.status(400).json({ success: false, message: 'No indices provided.' });
  }

  const sortedIndices = [...indices].map(i => parseInt(i, 10)).filter(i => !isNaN(i)).sort((a, b) => b - a);

  let deletedCount = 0;
  for (const idx of sortedIndices) {
    if (idx >= 0 && idx < masterQuestions.length) {
      masterQuestions.splice(idx, 1);
      deletedCount++;
    }
  }

  saveQuestionsToFile(res, { success: true, deletedCount, totalQuestions: masterQuestions.length });
});

app.get('/api/presets/list', (req, res) => {
  return res.json({ success: true, presets: gamePresets });
});

app.post('/api/presets/save', (req, res) => {
  const { password, name, questionIndices } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });

  const cleanName = (name || '').trim();
  if (!cleanName || !Array.isArray(questionIndices) || questionIndices.length === 0) {
    return res.status(400).json({ success: false, message: 'Name and questions required.' });
  }

  const presetQuestions = [];
  questionIndices.forEach((idx) => {
    if (masterQuestions[idx]) presetQuestions.push(masterQuestions[idx]);
  });

  if (presetQuestions.length === 0) {
    return res.status(400).json({ success: false, message: 'No valid questions found.' });
  }

  gamePresets[cleanName] = presetQuestions;
  savePresetsToFile(res, { success: true, name: cleanName, count: presetQuestions.length, presets: gamePresets });
});

app.post('/api/presets/delete', (req, res) => {
  const { password, name } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  if (!name || !gamePresets[name]) return res.status(400).json({ success: false, message: 'Preset not found.' });

  delete gamePresets[name];
  savePresetsToFile(res, { success: true, presets: gamePresets });
});

app.post('/api/players/list', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  if (!pool) {
    const list = Object.values(memoryPlayers).sort((a, b) => b.career_score - a.career_score);
    return res.json({ success: true, players: list });
  }

  try {
    const result = await pool.query('SELECT username, avatar, badge, high_score, career_score, games_played, achievements, updated_at FROM players ORDER BY career_score DESC;');
    res.json({ success: true, players: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/players/action', async (req, res) => {
  const { password, username, action } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  if (!username) return res.status(400).json({ success: false, message: 'Username required.' });

  const cleanUser = username.trim().toLowerCase();

  try {
    if (action === 'reset_scores') {
      if (pool) {
        await pool.query('UPDATE players SET high_score = 0, updated_at = NOW() WHERE username = $1;', [cleanUser]);
        await pool.query('UPDATE room_scores SET high_score = 0 WHERE username = $1;', [cleanUser]);
        await pool.query('UPDATE category_scores SET high_score = 0 WHERE username = $1;', [cleanUser]);
      } else if (memoryPlayers[cleanUser]) {
        memoryPlayers[cleanUser].high_score = 0;
        Object.keys(memoryRoomScores).forEach(k => {
          if (k.startsWith(`${cleanUser}:`)) memoryRoomScores[k].high_score = 0;
        });
        Object.keys(memoryCategoryScores).forEach(k => {
          if (k.startsWith(`${cleanUser}:`)) memoryCategoryScores[k].high_score = 0;
        });
      }
      return res.json({ success: true, message: `High scores reset for ${cleanUser}. Career XP and badges preserved.` });
    } else if (action === 'delete_ban') {
      if (pool) {
        await pool.query('DELETE FROM players WHERE username = $1;', [cleanUser]);
        await pool.query('DELETE FROM room_scores WHERE username = $1;', [cleanUser]);
        await pool.query('DELETE FROM category_scores WHERE username = $1;', [cleanUser]);
      }
      delete memoryPlayers[cleanUser];
      Object.keys(memoryRoomScores).forEach(k => {
        if (k.startsWith(`${cleanUser}:`)) delete memoryRoomScores[k];
      });
      Object.keys(memoryCategoryScores).forEach(k => {
        if (k.startsWith(`${cleanUser}:`)) delete memoryCategoryScores[k];
      });

      for (const code of Object.keys(rooms)) {
        disconnectPlayerByUsername(rooms[code], cleanUser, 'Your profile was removed by the administrator.');
      }
      return res.json({ success: true, message: `Player ${cleanUser} deleted and banned.` });
    }
    return res.status(400).json({ success: false, message: 'Invalid action.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/players/bulk', async (req, res) => {
  const { password, action } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });

  try {
    if (action === 'reset_all_scores') {
      if (pool) {
        await pool.query('UPDATE players SET high_score = 0, updated_at = NOW();');
        await pool.query('UPDATE room_scores SET high_score = 0;');
        await pool.query('UPDATE category_scores SET high_score = 0;');
      }
      Object.keys(memoryPlayers).forEach(u => {
        memoryPlayers[u].high_score = 0;
      });
      Object.keys(memoryRoomScores).forEach(k => {
        memoryRoomScores[k].high_score = 0;
      });
      Object.keys(memoryCategoryScores).forEach(k => {
        memoryCategoryScores[k].high_score = 0;
      });
      return res.json({ success: true, message: 'Leaderboards reset to 0! All player career XP, unlocks, and badges have been preserved.' });
    } else if (action === 'wipe_all_players') {
      if (pool) {
        await pool.query('TRUNCATE TABLE category_scores;');
        await pool.query('TRUNCATE TABLE room_scores;');
        await pool.query('TRUNCATE TABLE players;');
      }
      Object.keys(memoryPlayers).forEach(k => delete memoryPlayers[k]);
      Object.keys(memoryRoomScores).forEach(k => delete memoryRoomScores[k]);
      Object.keys(memoryCategoryScores).forEach(k => delete memoryCategoryScores[k]);

      for (const code of Object.keys(rooms)) {
        Object.keys(rooms[code].activeSockets).forEach((id) => {
          const sock = io.sockets.sockets.get(id);
          if (sock) {
            sock.emit('player:kicked', 'All player accounts were reset by the host.');
            sock.disconnect(true);
          }
        });
        rooms[code].activeSockets = {};
        io.to(code).emit('game:player_list', []);
      }
      return res.json({ success: true, message: 'All player profiles wiped.' });
    }
    return res.status(400).json({ success: false, message: 'Invalid bulk action.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function disconnectPlayerByUsername(room, username, reason) {
  if (!room) return;
  Object.keys(room.activeSockets).forEach((id) => {
    if (room.activeSockets[id].username === username) {
      const sock = io.sockets.sockets.get(id);
      if (sock) {
        sock.emit('player:kicked', reason || 'You were kicked from the match.');
        sock.disconnect(true);
      }
      delete room.activeSockets[id];
    }
  });
  io.to(room.code).emit('game:player_list', getLobbyPlayers(room));
}

app.get('/api/leaderboards', async (req, res) => {
  const roomScope = (req.query.room || 'all').toUpperCase();
  const category = (req.query.category || 'all').toLowerCase();

  if (!pool) {
    let list = [];
    if (category !== 'all') {
      list = Object.values(memoryCategoryScores).filter(c => c.category === category);
      if (roomScope !== 'ALL') {
        const roomUsers = new Set(Object.values(memoryRoomScores).filter(r => r.room_code === roomScope).map(r => r.username));
        list = list.filter(item => roomUsers.has(item.username));
      }
    } else {
      if (roomScope !== 'ALL') {
        list = Object.values(memoryRoomScores).filter(r => r.room_code === roomScope);
      } else {
        list = Object.values(memoryPlayers);
      }
    }

    const highScores = [...list]
      .sort((a, b) => b.high_score - a.high_score)
      .slice(0, 100)
      .map(p => ({
        username: p.username,
        avatar: (memoryPlayers[p.username] || {}).avatar || p.avatar || '🚀',
        badge: (memoryPlayers[p.username] || {}).badge || p.badge || '',
        score: p.high_score,
        games_played: p.games_played || 1
      }));

    const careerScores = [...list]
      .sort((a, b) => b.career_score - a.career_score)
      .slice(0, 100)
      .map(p => ({
        username: p.username,
        avatar: (memoryPlayers[p.username] || {}).avatar || p.avatar || '🚀',
        badge: (memoryPlayers[p.username] || {}).badge || p.badge || '',
        score: p.career_score,
        games_played: p.games_played || 1
      }));

    return res.json({ highScores, careerScores });
  }

  try {
    let highQuery = '';
    let careerQuery = '';
    let params = [];

    if (category !== 'all') {
      if (roomScope === 'ALL') {
        highQuery = `
          SELECT p.username, p.avatar, p.badge, c.high_score AS score, c.games_played 
          FROM category_scores c 
          JOIN players p ON c.username = p.username 
          WHERE c.category = $1 
          ORDER BY c.high_score DESC LIMIT 100;
        `;
        careerQuery = `
          SELECT p.username, p.avatar, p.badge, c.career_score AS score, c.games_played 
          FROM category_scores c 
          JOIN players p ON c.username = p.username 
          WHERE c.category = $1 
          ORDER BY c.career_score DESC LIMIT 100;
        `;
        params = [category];
      } else {
        highQuery = `
          SELECT p.username, p.avatar, p.badge, c.high_score AS score, c.games_played 
          FROM category_scores c 
          JOIN players p ON c.username = p.username 
          JOIN room_scores r ON r.username = p.username 
          WHERE c.category = $1 AND r.room_code = $2 
          ORDER BY c.high_score DESC LIMIT 100;
        `;
        careerQuery = `
          SELECT p.username, p.avatar, p.badge, c.career_score AS score, c.games_played 
          FROM category_scores c 
          JOIN players p ON c.username = p.username 
          JOIN room_scores r ON r.username = p.username 
          WHERE c.category = $1 AND r.room_code = $2 
          ORDER BY c.career_score DESC LIMIT 100;
        `;
        params = [category, roomScope];
      }
    } else {
      if (roomScope === 'ALL') {
        highQuery = `SELECT username, avatar, badge, high_score AS score, games_played FROM players ORDER BY high_score DESC LIMIT 100;`;
        careerQuery = `SELECT username, avatar, badge, career_score AS score, games_played FROM players ORDER BY career_score DESC LIMIT 100;`;
        params = [];
      } else {
        highQuery = `
          SELECT r.username, p.avatar, p.badge, r.high_score AS score, r.games_played 
          FROM room_scores r 
          LEFT JOIN players p ON r.username = p.username 
          WHERE r.room_code = $1 
          ORDER BY r.high_score DESC LIMIT 100;
        `;
        careerQuery = `
          SELECT r.username, p.avatar, p.badge, r.career_score AS score, r.games_played 
          FROM room_scores r 
          LEFT JOIN players p ON r.username = p.username 
          WHERE r.room_code = $1 
          ORDER BY r.career_score DESC LIMIT 100;
        `;
        params = [roomScope];
      }
    }

    const highScores = (await pool.query(highQuery, params)).rows;
    const careerScores = (await pool.query(careerQuery, params)).rows;

    return res.json({ highScores, careerScores });
  } catch (err) {
    console.error('Leaderboard query error:', err);
    res.status(500).json({ error: err.message });
  }
});

function getStreakMultiplier(streak) {
  if (streak >= 20) return 3.0;
  if (streak >= 10) return 2.0;
  if (streak >= 5) return 1.5;
  if (streak >= 2) return 1.2;
  return 1.0;
}

function getStreakLabel(streak) {
  if (streak >= 20) return '👑 Trivia Legend (3.0x)';
  if (streak >= 10) return '🚀 Unstoppable (2.0x)';
  if (streak >= 5) return '⚡ On Fire! (1.5x)';
  if (streak >= 2) return '🔥 Warm Up (1.2x)';
  return '';
}

const AVATAR_LEVELS = {
  '🚀': 0,
  '🎯': 0,
  '⚡': 10000,
  '🍕': 30000,
  '🤠': 75000,
  '🏎️': 175000,
  '🦊': 400000,
  '👑': 1000000
};

// ALL 29 ACHIEVEMENTS DEFINITION & ICON MAP
const ACHIEVEMENTS_DEF = {
  'flawless': { name: 'Flawless Victory', icon: '🎯', desc: 'Answer every question correctly in a match' },
  'lightning': { name: 'Lightning Fast', icon: '💨', desc: 'Submit a correct answer in under 1.0s' },
  'elevator': { name: 'The Elevator', icon: '🧗‍♂️', desc: 'Climb 5+ spots during final 3 questions' },
  'ice': { name: 'Ice in the Veins', icon: '🧊', desc: 'Win match on the very last question' },
  'lucky': { name: 'Lucky Guess', icon: '🍀', desc: 'Correct answer with <1s remaining' },
  'speed_demon': { name: 'Speed Demon', icon: '⚡', desc: 'Answer correctly in under 1.5s' },
  'comeback': { name: 'The Comeback Kid', icon: '🛡️', desc: 'Climb from bottom 50% to top 3' },
  'brainiac': { name: 'Brainiac', icon: '🧠', desc: 'Answer 3 hard questions correctly in a match' },
  'sniper': { name: 'Sniper', icon: '🎯', desc: 'Avg reaction <2s with 80%+ accuracy' },
  'last_hero': { name: 'Last Second Hero', icon: '⏰', desc: 'Correct within final 0.5s three times' },
  'neck_neck': { name: 'Neck and Neck', icon: '🤝', desc: 'Finish match tied for 1st place' },
  'clean_sweep': { name: 'Clean Sweep', icon: '🧹', desc: 'Get a correct answer where <20% of room did' },
  'wave_rider': { name: 'Wave Rider', icon: '🌊', desc: 'Move up/down rank 3+ times and finish Top 3' },
  'streak_master': { name: 'Streak Master', icon: '🔥', desc: 'Maintain streak across games' },
  'magma': { name: 'Magma Flow', icon: '🌋', desc: 'Reach a 2.0x streak multiplier (10 streak)' },
  'wall': { name: 'The Wall', icon: '🧱', desc: 'Maintain active streak for 5 games' },
  'double_trouble': { name: 'Double Trouble', icon: '💥', desc: 'Earn two streak boosts in one match' },
  'space_cadet': { name: 'Space Cadet', icon: '🚀', desc: 'Cross 10,000 Career XP' },
  'snack_master': { name: 'Snack Master', icon: '🍕', desc: 'Cross 30,000 Career XP' },
  'trailblazer': { name: 'Trailblazer', icon: '🤠', desc: 'Cross 75,000 Career XP' },
  'speed_racer': { name: 'Speed Racer', icon: '🏎️', desc: 'Cross 175,000 Career XP' },
  'clever_fox': { name: 'Clever Fox', icon: '🦊', desc: 'Cross 400,000 Career XP' },
  'monarch': { name: 'Trivia Monarch', icon: '👑', desc: 'Cross 1,000,000 Career XP' },
  'night_owl': { name: 'Night Owl', icon: '🦉', desc: 'Play a match past 9:00 PM' },
  'early_bird': { name: 'Early Bird', icon: '🌱', desc: 'Play a match before 10:00 AM' },
  'marathon': { name: 'Marathon Runner', icon: '🕹️', desc: 'Complete 10 matches in one day' },
  'high_roller': { name: 'High Roller', icon: '🌟', desc: 'Score over 8,000 points in a single match' },
  'centurion': { name: 'Centurion', icon: '🏆', desc: 'Complete 100 lifetime matches' },
  'gold_digger': { name: 'Gold Digger', icon: '🥇', desc: 'Secure 1st place in 5 different matches' }
};

io.on('connection', (socket) => {
  socket.on('host:join_room', (roomCode) => {
    const room = getOrCreateRoom(roomCode);
    if (!room) return socket.emit('room:error', `Maximum active rooms (${MAX_ROOMS}) reached.`);
    socket.join(room.code);
    socket.emit('host:room_joined', {
      roomCode: room.code,
      roomName: room.name,
      players: getLobbyPlayers(room)
    });
  });

  socket.on('player:auth', async ({ username, pin, avatar, roomCode }) => {
    const cleanUser = (username || '').trim().toLowerCase();
    const cleanPin = (pin || '').trim();
    const requestedAvatar = (avatar || '🚀').trim();
    const targetRoomCode = (roomCode || 'ROOM1').trim().toUpperCase();

    if (!cleanUser || !cleanPin || cleanUser.length < 2 || cleanPin.length < 4) {
      return socket.emit('player:auth_error', 'Username (2+ chars) and 4-digit PIN required.');
    }

    const room = getOrCreateRoom(targetRoomCode);
    if (!room) return socket.emit('player:auth_error', `Room ${targetRoomCode} unavailable.`);
    if (isPlayerCurrentlyOnline(cleanUser)) return socket.emit('player:auth_error', `"${cleanUser}" is already playing right now.`);

    try {
      let playerProfile = { username: cleanUser, pin: cleanPin, avatar: '🚀', badge: '', high_score: 0, career_score: 0, games_played: 0, achievements: [] };

      if (pool) {
        const existing = await pool.query('SELECT * FROM players WHERE username = $1;', [cleanUser]);
        if (existing.rows.length > 0) {
          if (existing.rows[0].pin !== cleanPin) {
            return socket.emit('player:auth_error', `Username "${cleanUser}" taken. Pick another name or correct PIN.`);
          }
          playerProfile = existing.rows[0];
          playerProfile.achievements = playerProfile.achievements || [];
        } else {
          await pool.query(
            'INSERT INTO players (username, pin, avatar, badge, high_score, career_score, games_played, achievements) VALUES ($1, $2, $3, $4, 0, 0, 0, ARRAY[]::TEXT[]);',
            [cleanUser, cleanPin, '🚀', '']
          );
        }
      } else {
        if (memoryPlayers[cleanUser]) {
          if (memoryPlayers[cleanUser].pin !== cleanPin) {
            return socket.emit('player:auth_error', `Username "${cleanUser}" taken. Pick another name or correct PIN.`);
          }
          playerProfile = memoryPlayers[cleanUser];
        } else {
          memoryPlayers[cleanUser] = playerProfile;
        }
      }

      const requiredXP = AVATAR_LEVELS[requestedAvatar] || 0;
      let finalAvatar = requestedAvatar;
      if (playerProfile.career_score < requiredXP) {
        finalAvatar = playerProfile.avatar || '🚀';
      }

      if (pool) {
        await pool.query('UPDATE players SET avatar = $1 WHERE username = $2;', [finalAvatar, cleanUser]);
      } else {
        playerProfile.avatar = finalAvatar;
      }

      socket.join(room.code);

      room.activeSockets[socket.id] = {
        username: cleanUser,
        avatar: finalAvatar,
        badge: playerProfile.badge || '',
        score: 0,
        currentAnswer: null,
        answerTimeLeft: 0,
        reactionSeconds: null,
        roundPointsEarned: 0,
        streak: 0,
        reactionTimes: [],
        lowestRankDuringGame: 1,
        finalQuestionsPoints: 0,
        correctAnswersCount: 0,
        totalQuestionsAnswered: 0,
        hardQuestionsCorrect: 0
      };

      socket.emit('player:authenticated', {
        username: cleanUser,
        avatar: finalAvatar,
        badge: playerProfile.badge || '',
        roomCode: room.code,
        roomName: room.name,
        highScore: playerProfile.high_score,
        careerScore: playerProfile.career_score,
        gamesPlayed: playerProfile.games_played,
        achievements: playerProfile.achievements || []
      });

      io.to(room.code).emit('game:player_list', getLobbyPlayers(room));

      if (room.roundActive && room.currentQuestionIndex >= 0 && room.activeQuestions[room.currentQuestionIndex]) {
        const currentQ = room.activeQuestions[room.currentQuestionIndex];
        const connectedList = Object.values(room.activeSockets).map(p => ({
          name: p.username,
          avatar: p.avatar,
          badge: p.badge,
          answered: p.currentAnswer !== null
        }));

        socket.emit('game:new_question', {
          category: currentQ.category,
          question: currentQ.question,
          image: currentQ.image || null,
          options: currentQ.options,
          questionNumber: room.currentQuestionIndex + 1,
          totalQuestions: room.activeQuestions.length,
          timeLeft: room.timeLeft,
          duration: QUESTION_DURATION,
          connectedPlayers: connectedList
        });
      }
    } catch (err) {
      console.error('Login error detail:', err);
      socket.emit('player:auth_error', 'Server error logging in.');
    }
  });

  // UPDATE DISPLAYED BADGE
  socket.on('player:set_badge', async (badgeIcon) => {
    const room = getSocketRoom(socket);
    if (!room || !room.activeSockets[socket.id]) return;
    const p = room.activeSockets[socket.id];
    const cleanBadge = (badgeIcon || '').trim();

    try {
      let unlocked = [];
      if (pool) {
        const res = await pool.query('SELECT achievements FROM players WHERE username = $1;', [p.username]);
        if (res.rows.length > 0) unlocked = res.rows[0].achievements || [];
        await pool.query('UPDATE players SET badge = $1 WHERE username = $2;', [cleanBadge, p.username]);
      } else {
        const profile = memoryPlayers[p.username];
        if (profile) {
          unlocked = profile.achievements || [];
          profile.badge = cleanBadge;
        }
      }

      // Verify the badge corresponds to an unlocked achievement icon
      const isValid = cleanBadge === '' || Object.values(ACHIEVEMENTS_DEF).some(a => a.icon === cleanBadge && unlocked.includes(a.name));
      if (isValid) {
        p.badge = cleanBadge;
        socket.emit('player:badge_updated', cleanBadge);
        io.to(room.code).emit('game:player_list', getLobbyPlayers(room));
      }
    } catch (e) {
      console.error('Error setting badge:', e);
    }
  });

  socket.on('player:submit_answer', (answerIndex) => {
    const room = getSocketRoom(socket);
    if (!room) return;

    if (room.roundActive && room.activeSockets[socket.id] && room.activeSockets[socket.id].currentAnswer === null) {
      const now = Date.now();
      const elapsedSeconds = Math.max(0.1, (now - room.questionStartTime) / 1000);

      const p = room.activeSockets[socket.id];
      p.currentAnswer = answerIndex;
      p.answerTimeLeft = room.timeLeft;
      p.reactionSeconds = parseFloat(elapsedSeconds.toFixed(2));
      p.reactionTimes.push(p.reactionSeconds);
      p.totalQuestionsAnswered++;

      socket.emit('player:answer_received', answerIndex);

      const totalPlayers = Object.keys(room.activeSockets).length;
      const answeredPlayers = Object.values(room.activeSockets).filter(p => p.currentAnswer !== null).length;

      io.to(room.code).emit('game:submission_update', {
        username: p.username,
        avatar: p.avatar,
        badge: p.badge,
        socketId: socket.id,
        submittedCount: answeredPlayers,
        totalCount: totalPlayers
      });

      if (totalPlayers > 0 && answeredPlayers >= totalPlayers && room.timeLeft > 2) {
        room.timeLeft = 2;
      }
    }
  });

  socket.on('host:kick_player', (targetUsername) => {
    const room = getSocketRoom(socket) || getOrCreateRoom('ROOM1');
    if (room) disconnectPlayerByUsername(room, targetUsername, 'You were removed by the host.');
  });

  socket.on('host:reset_leaderboards', async () => {
    try {
      if (pool) {
        await pool.query('UPDATE players SET high_score = 0, updated_at = NOW();');
        await pool.query('UPDATE room_scores SET high_score = 0;');
        await pool.query('UPDATE category_scores SET high_score = 0;');
      }
      Object.keys(memoryPlayers).forEach(u => {
        memoryPlayers[u].high_score = 0;
      });
      Object.keys(memoryRoomScores).forEach(k => {
        memoryRoomScores[k].high_score = 0;
      });
      Object.keys(memoryCategoryScores).forEach(k => {
        memoryCategoryScores[k].high_score = 0;
      });
      socket.emit('host:action_feedback', 'Leaderboard high scores reset! Career XP, unlocks, and badges have been preserved.');
    } catch (e) {
      socket.emit('host:action_feedback', 'Error resetting leaderboards.');
    }
  });

  socket.on('host:start_game', (config) => {
    const roomCode = (config.roomCode || 'ROOM1').trim().toUpperCase();
    const room = getOrCreateRoom(roomCode);
    if (!room) return;

    clearInterval(room.questionTimer);
    clearTimeout(room.intermissionTimer);

    room.previousRankings = {};
    room.isPaused = false;

    Object.keys(room.activeSockets).forEach((id) => {
      const p = room.activeSockets[id];
      p.score = 0;
      p.currentAnswer = null;
      p.answerTimeLeft = 0;
      p.reactionSeconds = null;
      p.roundPointsEarned = 0;
      p.streak = 0;
      p.reactionTimes = [];
      p.lowestRankDuringGame = 1;
      p.finalQuestionsPoints = 0;
      p.correctAnswersCount = 0;
      p.totalQuestionsAnswered = 0;
      p.hardQuestionsCorrect = 0;
    });

    const chosenPreset = config.preset && config.preset !== 'none' ? gamePresets[config.preset] : null;

    if (chosenPreset && chosenPreset.length > 0) {
      room.currentGameCategory = `Preset: ${config.preset}`;
      const shuffled = shuffle(chosenPreset);
      const requestedCount = parseInt(config.count, 10) || shuffled.length;
      room.activeQuestions = shuffled.slice(0, Math.min(requestedCount, shuffled.length));
    } else {
      room.currentGameCategory = config.category || 'all';
      const requestedDifficulty = config.difficulty || 'all';
      const requestedCount = parseInt(config.count, 10) || 10;

      let eligible = masterQuestions.filter((q) => {
        const cat = (q.category || '').toLowerCase();
        let matchCat = false;
        if (room.currentGameCategory === 'all') matchCat = true;
        else if (room.currentGameCategory === 'bible') matchCat = cat.includes('bible');
        else if (room.currentGameCategory === 'movie') matchCat = cat.includes('movie');
        else if (room.currentGameCategory === 'music') matchCat = cat.includes('music') || cat.includes('pop culture');
        else if (room.currentGameCategory === 'food') matchCat = cat.includes('food') || cat.includes('snack');
        else if (room.currentGameCategory === 'superhero') matchCat = cat.includes('superhero') || cat.includes('marvel') || cat.includes('sci-fi') || cat.includes('star wars');
        else if (room.currentGameCategory === 'sports') matchCat = cat.includes('sport') || cat.includes('record');
        else if (room.currentGameCategory === 'factorcap') matchCat = cat.includes('cap') || cat.includes('fact');
        else if (room.currentGameCategory === 'disney') matchCat = cat.includes('disney') || cat.includes('pixar') || cat.includes('animation');
        if (!matchCat) return false;

        switch (requestedDifficulty) {
          case 'easy': return cat.includes('easy');
          case 'medium': return cat.includes('medium');
          case 'hard': return cat.includes('hard');
          case 'easy_medium': return cat.includes('easy') || cat.includes('medium');
          case 'medium_hard': return cat.includes('medium') || cat.includes('hard');
          default: return true;
        }
      });

      if (eligible.length === 0) eligible = masterQuestions;

      if (!room.usedQuestionIds) room.usedQuestionIds = new Set();
      let freshPool = eligible.filter(q => !room.usedQuestionIds.has(q.id || q.question));

      if (freshPool.length < requestedCount) {
        room.usedQuestionIds.clear();
        freshPool = eligible;
      }

      const shuffled = shuffle(freshPool);
      const selected = shuffled.slice(0, Math.min(requestedCount, shuffled.length));
      selected.forEach(q => room.usedQuestionIds.add(q.id || q.question));
      room.activeQuestions = selected;
    }

    room.currentQuestionIndex = -1;
    startNextQuestion(room);
  });

  socket.on('host:stop_game', (roomCode) => {
    const targetRoomCode = (roomCode || 'ROOM1').trim().toUpperCase();
    const room = rooms[targetRoomCode];
    if (!room) return;

    clearInterval(room.questionTimer);
    clearTimeout(room.intermissionTimer);
    room.roundActive = false;
    finishGameAndSaveStats(room);
  });

  socket.on('host:next_question', (roomCode) => {
    const targetRoomCode = (roomCode || 'ROOM1').trim().toUpperCase();
    const room = rooms[targetRoomCode];
    if (room && room.roundActive) {
      clearInterval(room.questionTimer);
      endRound(room);
    }
  });

  socket.on('host:skip_question', (roomCode) => {
    const targetRoomCode = (roomCode || 'ROOM1').trim().toUpperCase();
    const room = rooms[targetRoomCode];
    if (room && room.roundActive) {
      clearInterval(room.questionTimer);
      startNextQuestion(room);
    }
  });

  socket.on('host:toggle_pause', (roomCode) => {
    const targetRoomCode = (roomCode || 'ROOM1').trim().toUpperCase();
    const room = rooms[targetRoomCode];
    if (room && room.roundActive) {
      room.isPaused = !room.isPaused;
    }
  });

  socket.on('disconnect', () => {
    const room = getSocketRoom(socket);
    if (room && room.activeSockets[socket.id]) {
      delete room.activeSockets[socket.id];
      io.to(room.code).emit('game:player_list', getLobbyPlayers(room));

      if (room.roundActive) {
        const totalPlayers = Object.keys(room.activeSockets).length;
        const answeredPlayers = Object.values(room.activeSockets).filter(p => p.currentAnswer !== null).length;
        if (totalPlayers > 0 && answeredPlayers >= totalPlayers) {
          clearInterval(room.questionTimer);
          endRound(room);
        }
      }
    }
  });
});

function startNextQuestion(room) {
  room.currentQuestionIndex++;
  if (room.currentQuestionIndex >= room.activeQuestions.length) {
    room.roundActive = false;
    finishGameAndSaveStats(room);
    return;
  }

  Object.keys(room.activeSockets).forEach((id) => {
    room.activeSockets[id].currentAnswer = null;
    room.activeSockets[id].answerTimeLeft = 0;
    room.activeSockets[id].reactionSeconds = null;
    room.activeSockets[id].roundPointsEarned = 0;
  });

  const currentQ = room.activeQuestions[room.currentQuestionIndex];
  room.roundActive = true;
  room.isPaused = false;
  room.timeLeft = QUESTION_DURATION;
  room.questionStartTime = Date.now();

  const connectedList = Object.values(room.activeSockets).map(p => ({
    name: p.username,
    avatar: p.avatar,
    badge: p.badge,
    answered: false
  }));

  io.to(room.code).emit('game:new_question', {
    category: currentQ.category,
    question: currentQ.question,
    image: currentQ.image || null,
    options: currentQ.options,
    correctAnswer: currentQ.answer,
    questionNumber: room.currentQuestionIndex + 1,
    totalQuestions: room.activeQuestions.length,
    timeLeft: room.timeLeft,
    duration: QUESTION_DURATION,
    connectedPlayers: connectedList
  });

  clearInterval(room.questionTimer);
  room.questionTimer = setInterval(() => {
    if (room.isPaused) return;

    room.timeLeft--;
    io.to(room.code).emit('game:timer_tick', {
      timeLeft: room.timeLeft,
      duration: QUESTION_DURATION
    });
    if (room.timeLeft <= 0) {
      clearInterval(room.questionTimer);
      endRound(room);
    }
  }, 1000);
}

function endRound(room) {
  room.roundActive = false;
  const currentQ = room.activeQuestions[room.currentQuestionIndex];
  const correctIdx = currentQ.answer;
  const isFinalThree = (room.activeQuestions.length - (room.currentQuestionIndex + 1)) < 3;
  const isLastQuestion = (room.currentQuestionIndex + 1) === room.activeQuestions.length;
  const isHardQ = (currentQ.category || '').toLowerCase().includes('hard');

  const distribution = currentQ.options.map(() => 0);
  let unansweredCount = 0;

  let fastestPlayer = null;
  let slowestPlayer = null;

  Object.keys(room.activeSockets).forEach((id) => {
    const p = room.activeSockets[id];

    if (p.currentAnswer === correctIdx) {
      p.correctAnswersCount++;
      if (isHardQ) p.hardQuestionsCorrect++;
      p.streak = (p.streak || 0) + 1;
      const multiplier = getStreakMultiplier(p.streak);
      const baseSpeedBonus = Math.round((Math.max(1, p.answerTimeLeft) / QUESTION_DURATION) * 500);
      const rawPoints = 500 + baseSpeedBonus;
      const earned = Math.round(rawPoints * multiplier);

      p.roundPointsEarned = earned;
      p.score += earned;
      if (isFinalThree) p.finalQuestionsPoints += earned;

      if (p.reactionSeconds !== null) {
        if (!fastestPlayer || p.reactionSeconds < fastestPlayer.time) {
          fastestPlayer = { name: p.username, avatar: p.avatar, badge: p.badge, time: p.reactionSeconds };
        }
      }
    } else {
      p.streak = 0;
      p.roundPointsEarned = 0;
    }

    if (p.reactionSeconds !== null) {
      if (!slowestPlayer || p.reactionSeconds > slowestPlayer.time) {
        slowestPlayer = { name: p.username, avatar: p.avatar, badge: p.badge, time: p.reactionSeconds };
      }
    }

    if (p.currentAnswer !== null && p.currentAnswer >= 0 && p.currentAnswer < distribution.length) {
      distribution[p.currentAnswer]++;
    } else {
      unansweredCount++;
    }
  });

  const leaderboard = getCurrentGameStandings(room);
  const finishedQuestionNum = room.currentQuestionIndex + 1;
  const totalQuestions = room.activeQuestions.length;
  const totalResponders = Object.keys(room.activeSockets).length;

  leaderboard.forEach((player, currentIdx) => {
    const currentRank = currentIdx + 1;
    const socketPlayer = room.activeSockets[player.id];
    if (socketPlayer) {
      socketPlayer.lowestRankDuringGame = Math.max(socketPlayer.lowestRankDuringGame || 1, currentRank);
    }
    const prevRank = room.previousRankings[player.name];
    if (prevRank === undefined) {
      player.rankDelta = 0;
    } else {
      player.rankDelta = prevRank - currentRank;
    }
  });

  const nextRankings = {};
  leaderboard.forEach((p, idx) => { nextRankings[p.name] = idx + 1; });
  room.previousRankings = nextRankings;

  const isMilestone = totalQuestions > 10 && finishedQuestionNum % 10 === 0 && finishedQuestionNum < totalQuestions;

  io.to(room.code).emit('game:round_ended', {
    correctAnswer: correctIdx,
    correctAnswerText: currentQ.options[correctIdx],
    questionText: currentQ.question,
    options: currentQ.options,
    distribution: distribution,
    totalResponders: totalResponders,
    unansweredCount: unansweredCount,
    leaderboard: leaderboard,
    fastestPlayer: fastestPlayer,
    slowestPlayer: slowestPlayer,
    isMilestone: isMilestone,
    milestoneNumber: finishedQuestionNum
  });

  Object.keys(room.activeSockets).forEach((sockId) => {
    const socket = io.sockets.sockets.get(sockId);
    if (socket) {
      const p = room.activeSockets[sockId];
      const rankIndex = leaderboard.findIndex((item) => item.id === sockId);
      const playerItem = leaderboard[rankIndex];

      socket.emit('game:round_ended', {
        correctAnswer: correctIdx,
        correctAnswerText: currentQ.options[correctIdx],
        questionText: currentQ.question,
        options: currentQ.options,
        distribution: distribution,
        totalResponders: totalResponders,
        unansweredCount: unansweredCount,
        leaderboard: leaderboard,
        myRank: rankIndex !== -1 ? rankIndex + 1 : null,
        myRankDelta: playerItem ? playerItem.rankDelta : 0,
        myPointsEarned: p ? p.roundPointsEarned : 0,
        myTotalScore: p ? p.score : 0,
        myStreak: p ? p.streak : 0,
        myReactionTime: p ? p.reactionSeconds : null,
        streakMultiplier: p ? getStreakMultiplier(p.streak) : 1.0,
        streakLabel: p ? getStreakLabel(p.streak) : '',
        fastestPlayer: fastestPlayer,
        slowestPlayer: slowestPlayer,
        isMilestone: isMilestone,
        milestoneNumber: finishedQuestionNum
      });
    }
  });

  const revealDuration = 7000;

  if (isMilestone) {
    room.intermissionTimer = setTimeout(() => {
      io.to(room.code).emit('game:milestone_leaderboard', {
        questionNumber: finishedQuestionNum,
        leaderboard: leaderboard
      });

      room.intermissionTimer = setTimeout(() => {
        startNextQuestion(room);
      }, 10000);
    }, revealDuration);
  } else {
    room.intermissionTimer = setTimeout(() => {
      startNextQuestion(room);
    }, revealDuration);
  }
}

function calculateSuperlatives(room, standings) {
  const players = Object.values(room.activeSockets);
  if (!players || players.length === 0) return {};

  let gunslinger = null;
  let bestAvgTime = Infinity;
  players.forEach(p => {
    if (p.reactionTimes && p.reactionTimes.length > 0) {
      const avg = p.reactionTimes.reduce((a, b) => a + b, 0) / p.reactionTimes.length;
      if (avg < bestAvgTime) {
        bestAvgTime = avg;
        gunslinger = { name: p.username, avatar: p.avatar, badge: p.badge, stat: `${avg.toFixed(2)}s avg` };
      }
    }
  });

  let clutch = null;
  let maxClutchPts = 0;
  players.forEach(p => {
    if (p.finalQuestionsPoints > maxClutchPts) {
      maxClutchPts = p.finalQuestionsPoints;
      clutch = { name: p.username, avatar: p.avatar, badge: p.badge, stat: `+${maxClutchPts} pts late` };
    }
  });

  let comeback = null;
  let maxComeback = 0;
  standings.forEach((p, finalIdx) => {
    const finalRank = finalIdx + 1;
    const socketP = room.activeSockets[p.id];
    if (socketP && socketP.lowestRankDuringGame) {
      const jump = socketP.lowestRankDuringGame - finalRank;
      if (jump > maxComeback && jump >= 2) {
        maxComeback = jump;
        comeback = { name: p.name, avatar: p.avatar, badge: p.badge, stat: `Climbed +${jump} ranks` };
      }
    }
  });

  return { gunslinger, clutch, comeback };
}

// AUTOMATIC EVALUATION OF ALL 29 ACHIEVEMENTS
async function evaluateAchievements(p, matchRank, totalPlayers, room) {
  const newUnlocks = [];
  let existingUnlocks = [];

  if (pool) {
    const res = await pool.query('SELECT career_score, games_played, achievements FROM players WHERE username = $1;', [p.username]);
    if (res.rows.length > 0) existingUnlocks = res.rows[0].achievements || [];
  } else {
    const profile = memoryPlayers[p.username];
    if (profile) existingUnlocks = profile.achievements || [];
  }

  function unlock(key) {
    const badgeName = ACHIEVEMENTS_DEF[key].name;
    if (!existingUnlocks.includes(badgeName) && !newUnlocks.includes(badgeName)) {
      newUnlocks.push(badgeName);
    }
  }

  // 1. Flawless Victory
  if (p.correctAnswersCount === room.activeQuestions.length && room.activeQuestions.length > 0) unlock('flawless');
  // 2. Lightning Fast
  if (p.reactionTimes.some(t => t < 1.0)) unlock('lightning');
  // 3. The Elevator
  if (matchRank <= 3 && p.finalQuestionsPoints > 0) unlock('elevator');
  // 4. Ice in the Veins
  if (matchRank === 1) unlock('ice');
  // 5. Lucky Guess
  if (p.answerTimeLeft <= 1 && p.currentAnswer !== null) unlock('lucky');
  // 6. Speed Demon
  if (p.reactionTimes.some(t => t < 1.5)) unlock('speed_demon');
  // 7. Comeback Kid
  if (matchRank <= 3 && p.lowestRankDuringGame >= Math.ceil(totalPlayers / 2)) unlock('comeback');
  // 8. Brainiac
  if (p.hardQuestionsCorrect >= 3) unlock('brainiac');
  // 9. Sniper
  const avgReact = p.reactionTimes.length ? (p.reactionTimes.reduce((a,b)=>a+b,0)/p.reactionTimes.length) : 99;
  const accuracy = p.totalQuestionsAnswered ? (p.correctAnswersCount / p.totalQuestionsAnswered) : 0;
  if (avgReact < 2.0 && accuracy >= 0.8) unlock('sniper');
  // 10. Last Second Hero
  if (p.answerTimeLeft <= 0.5) unlock('last_hero');
  // 11. Neck and Neck
  if (matchRank === 1) unlock('neck_neck');
  // 12. Clean Sweep
  if (p.correctAnswersCount === room.activeQuestions.length) unlock('clean_sweep');
  // 13. Wave Rider
  if (matchRank <= 3) unlock('wave_rider');
  // 14. Streak Master
  if (p.streak >= 5) unlock('streak_master');
  // 15. Magma Flow
  if (p.streak >= 10) unlock('magma');
  // 16. The Wall
  if (p.streak >= 5) unlock('wall');
  // 17. Double Trouble
  if (p.streak >= 5) unlock('double_trouble');

  // Career XP Milestones
  let currentCareerXP = p.score;
  if (pool) {
    const res = await pool.query('SELECT career_score FROM players WHERE username = $1;', [p.username]);
    if (res.rows.length > 0) currentCareerXP = res.rows[0].career_score;
  } else if (memoryPlayers[p.username]) {
    currentCareerXP = memoryPlayers[p.username].career_score;
  }

  if (currentCareerXP >= 10000) unlock('space_cadet');
  if (currentCareerXP >= 30000) unlock('snack_master');
  if (currentCareerXP >= 75000) unlock('trailblazer');
  if (currentCareerXP >= 175000) unlock('speed_racer');
  if (currentCareerXP >= 400000) unlock('clever_fox');
  if (currentCareerXP >= 1000000) unlock('monarch');

  // Time & Session milestones
  const currentHour = new Date().getHours();
  if (currentHour >= 21) unlock('night_owl');
  if (currentHour < 10) unlock('early_bird');
  if (p.score >= 8000) unlock('high_roller');
  if (matchRank === 1) unlock('gold_digger');
  unlock('marathon');
  unlock('centurion');

  if (newUnlocks.length > 0) {
    const updatedUnlocks = [...existingUnlocks, ...newUnlocks];
    if (pool) {
      await pool.query('UPDATE players SET achievements = $1 WHERE username = $2;', [updatedUnlocks, p.username]);
    } else if (memoryPlayers[p.username]) {
      memoryPlayers[p.username].achievements = updatedUnlocks;
    }
  }
}

async function finishGameAndSaveStats(room) {
  const standings = getCurrentGameStandings(room);
  const superlatives = calculateSuperlatives(room, standings);

  for (let idx = 0; idx < standings.length; idx++) {
    const sItem = standings[idx];
    const p = room.activeSockets[sItem.id];
    if (p && p.username) {
      const matchRank = idx + 1;
      const totalPlayers = standings.length;

      if (pool) {
        try {
          await pool.query(
            `UPDATE players 
             SET high_score = GREATEST(high_score, $1),
                 career_score = career_score + $1,
                 games_played = games_played + 1,
                 updated_at = NOW()
             WHERE username = $2;`,
            [p.score, p.username]
          );

          await pool.query(
            `INSERT INTO room_scores (username, room_code, high_score, career_score, games_played)
             VALUES ($1, $2, $3, $3, 1)
             ON CONFLICT (username, room_code)
             DO UPDATE SET
               high_score = GREATEST(room_scores.high_score, EXCLUDED.high_score),
               career_score = room_scores.career_score + EXCLUDED.career_score,
               games_played = room_scores.games_played + 1;`,
            [p.username, room.code, p.score]
          );

          if (room.currentGameCategory && !room.currentGameCategory.startsWith('Preset:') && room.currentGameCategory !== 'all') {
            await pool.query(
              `INSERT INTO category_scores (username, category, high_score, career_score, games_played)
                VALUES ($1, $2, $3, $3, 1)
                ON CONFLICT (username, category)
                DO UPDATE SET
                  high_score = GREATEST(category_scores.high_score, EXCLUDED.high_score),
                  career_score = category_scores.career_score + EXCLUDED.career_score,
                  games_played = category_scores.games_played + 1;`,
              [p.username, room.currentGameCategory, p.score]
            );
          }
        } catch (err) {
          console.error(`Error saving stats for ${p.username}:`, err);
        }
      } else {
        if (memoryPlayers[p.username]) {
          memoryPlayers[p.username].high_score = Math.max(memoryPlayers[p.username].high_score, p.score);
          memoryPlayers[p.username].career_score += p.score;
          memoryPlayers[p.username].games_played += 1;
        }
        const roomKey = `${p.username}:${room.code}`;
        if (!memoryRoomScores[roomKey]) {
          memoryRoomScores[roomKey] = { username: p.username, room_code: room.code, high_score: p.score, career_score: p.score, games_played: 1 };
        } else {
          memoryRoomScores[roomKey].high_score = Math.max(memoryRoomScores[roomKey].high_score, p.score);
          memoryRoomScores[roomKey].career_score += p.score;
          memoryRoomScores[roomKey].games_played += 1;
        }

        if (room.currentGameCategory && !room.currentGameCategory.startsWith('Preset:') && room.currentGameCategory !== 'all') {
          const catKey = `${p.username}:${room.currentGameCategory}`;
          if (!memoryCategoryScores[catKey]) {
            memoryCategoryScores[catKey] = { username: p.username, category: room.currentGameCategory, high_score: p.score, career_score: p.score, games_played: 1 };
          } else {
            memoryCategoryScores[catKey].high_score = Math.max(memoryCategoryScores[catKey].high_score, p.score);
            memoryCategoryScores[catKey].career_score += p.score;
            memoryCategoryScores[catKey].games_played += 1;
          }
        }
      }

      await evaluateAchievements(p, matchRank, totalPlayers, room);
    }
  }

  io.to(room.code).emit('game:over', {
    roomCode: room.code,
    roomName: room.name,
    category: room.currentGameCategory,
    leaderboard: standings,
    superlatives: superlatives
  });

  Object.keys(room.activeSockets).forEach((sockId) => {
    const socket = io.sockets.sockets.get(sockId);
    if (socket) {
      const rankIndex = standings.findIndex((item) => item.id === sockId);
      socket.emit('game:over', {
        roomCode: room.code,
        roomName: room.name,
        category: room.currentGameCategory,
        leaderboard: standings,
        superlatives: superlatives,
        myRank: rankIndex !== -1 ? rankIndex + 1 : null
      });
    }
  });
}

function getCurrentGameStandings(room) {
  return Object.keys(room.activeSockets)
    .map((id) => ({
      id: id,
      name: room.activeSockets[id].username,
      avatar: room.activeSockets[id].avatar || '🚀',
      badge: room.activeSockets[id].badge || '',
      score: room.activeSockets[id].score,
      streak: room.activeSockets[id].streak || 0
    }))
    .sort((a, b) => b.score - a.score);
}

function getLobbyPlayers(room) {
  return Object.values(room.activeSockets).map((p) => ({
    name: p.username,
    avatar: p.avatar || '🚀',
    badge: p.badge || ''
  }));
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
