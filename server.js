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
        high_score INT DEFAULT 0,
        career_score INT DEFAULT 0,
        games_played INT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar VARCHAR(10) DEFAULT '🚀';

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
  masterQuestions = JSON.parse(fs.readFileSync(questionsFilePath, 'utf8'));
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
    return res.json(successPayload);
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
      currentGameCategory: 'all',
      previousRankings: {}
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
   ADMIN API: QUESTIONS, CSV PARSER, GEMINI AI, PRESETS & PLAYERS
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
    if (q.category && q.question && Array.isArray(q.options) && q.options.length === 4 && q.answer !== undefined) {
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

// AI-Powered Question Generator using Gemini API
app.post('/api/questions/generate', async (req, res) => {
  const { password, category, difficulty, count } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });

  const num = Math.min(Math.max(parseInt(count, 10) || 3, 1), 10);
  const targetCategory = (category || 'Bible Trivia').trim();
  const targetDifficulty = (difficulty || 'Easy').trim();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, message: 'GEMINI_API_KEY environment variable is not configured on the server.' });
  }

  const prompt = `Generate exactly ${num} trivia questions about "${targetCategory}" with a difficulty level of "${targetDifficulty}".
You must return the result strictly as a JSON array of objects, with no markdown code blocks, no backticks, and no extra text.
Each object must have these exact keys:
- "question": string (the trivia prompt)
- "options": array of 4 strings (potential answers)
- "answer": integer (index 0 to 3 pointing to the correct option)

Example format:
[
  {
    "question": "What is the capital of France?",
    "options": ["London", "Berlin", "Paris", "Madrid"],
    "answer": 2
  }
]`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, responseMimeType: "application/json" }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to communicate with Gemini API.');
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Empty response received from Gemini.');

    const cleanedJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedQuestions = JSON.parse(cleanedJson);

    if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
      throw new Error('Gemini did not return a valid question array.');
    }

    const formattedQuestions = parsedQuestions.map(q => ({
      category: `${targetCategory}: ${targetDifficulty}`,
      question: String(q.question).trim(),
      options: Array.isArray(q.options) ? q.options.map(opt => String(opt).trim()) : ['A', 'B', 'C', 'D'],
      answer: Math.min(Math.max(parseInt(q.answer, 10) || 0, 0), 3)
    }));

    return res.json({ success: true, questions: formattedQuestions });
  } catch (err) {
    console.error('Gemini Generation Error:', err);
    return res.status(500).json({ success: false, message: `AI Generation Error: ${err.message}` });
  }
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
    const result = await pool.query('SELECT username, avatar, high_score, career_score, games_played, updated_at FROM players ORDER BY career_score DESC;');
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
        await pool.query('UPDATE players SET high_score = 0, career_score = 0, games_played = 0, updated_at = NOW() WHERE username = $1;', [cleanUser]);
        await pool.query('UPDATE room_scores SET high_score = 0, career_score = 0, games_played = 0 WHERE username = $1;', [cleanUser]);
        await pool.query('UPDATE category_scores SET high_score = 0, career_score = 0, games_played = 0 WHERE username = $1;', [cleanUser]);
      } else if (memoryPlayers[cleanUser]) {
        memoryPlayers[cleanUser].high_score = 0;
        memoryPlayers[cleanUser].career_score = 0;
        memoryPlayers[cleanUser].games_played = 0;
        Object.keys(memoryRoomScores).forEach(k => {
          if (k.startsWith(`${cleanUser}:`)) {
            memoryRoomScores[k].high_score = 0;
            memoryRoomScores[k].career_score = 0;
            memoryRoomScores[k].games_played = 0;
          }
        });
      }
      return res.json({ success: true, message: `Scores reset for ${cleanUser}.` });
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
        await pool.query('UPDATE players SET high_score = 0, career_score = 0, games_played = 0, updated_at = NOW();');
        await pool.query('UPDATE room_scores SET high_score = 0, career_score = 0, games_played = 0;');
        await pool.query('UPDATE category_scores SET high_score = 0, career_score = 0, games_played = 0;');
      }
      Object.keys(memoryPlayers).forEach(u => {
        memoryPlayers[u].high_score = 0;
        memoryPlayers[u].career_score = 0;
        memoryPlayers[u].games_played = 0;
      });
      Object.keys(memoryRoomScores).forEach(k => {
        memoryRoomScores[k].high_score = 0;
        memoryRoomScores[k].career_score = 0;
        memoryRoomScores[k].games_played = 0;
      });
      return res.json({ success: true, message: 'All player scores reset to 0.' });
    } else if (action === 'wipe_all_players') {
      if (pool) {
        await pool.query('TRUNCATE TABLE category_scores;');
        await pool.query('TRUNCATE TABLE room_scores;');
        await pool.query('TRUNCATE TABLE players;');
      }
      Object.keys(memoryPlayers).forEach(k => delete memoryPlayers[k]);
      Object.keys(memoryRoomScores).forEach(k => delete memoryRoomScores[k]);

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
    if (roomScope === 'ALL') {
      const list = Object.values(memoryPlayers);
      const highScores = [...list].sort((a, b) => b.high_score - a.high_score).slice(0, 100).map(p => ({ username: p.username, avatar: p.avatar, score: p.high_score, games_played: p.games_played }));
      const careerScores = [...list].sort((a, b) => b.career_score - a.career_score).slice(0, 100).map(p => ({ username: p.username, avatar: p.avatar, score: p.career_score, games_played: p.games_played }));
      return res.json({ highScores, careerScores });
    } else {
      const list = Object.values(memoryRoomScores).filter(r => r.room_code === roomScope);
      const highScores = [...list].sort((a, b) => b.high_score - a.high_score).slice(0, 100).map(r => ({ username: r.username, avatar: (memoryPlayers[r.username] || {}).avatar || '🚀', score: r.high_score, games_played: r.games_played }));
      const careerScores = [...list].sort((a, b) => b.career_score - a.career_score).slice(0, 100).map(r => ({ username: r.username, avatar: (memoryPlayers[r.username] || {}).avatar || '🚀', score: r.career_score, games_played: r.games_played }));
      return res.json({ highScores, careerScores });
    }
  }

  try {
    if (roomScope === 'ALL') {
      if (category === 'all') {
        const highScores = (await pool.query('SELECT username, avatar, high_score AS score, games_played FROM players ORDER BY high_score DESC LIMIT 100;')).rows;
        const careerScores = (await pool.query('SELECT username, avatar, career_score AS score, games_played FROM players ORDER BY career_score DESC LIMIT 100;')).rows;
        return res.json({ highScores, careerScores });
      } else {
        const highScores = (await pool.query('SELECT p.username, p.avatar, c.high_score AS score, c.games_played FROM category_scores c JOIN players p ON c.username = p.username WHERE c.category = $1 ORDER BY c.high_score DESC LIMIT 100;', [category])).rows;
        const careerScores = (await pool.query('SELECT p.username, p.avatar, c.career_score AS score, c.games_played FROM category_scores c JOIN players p ON c.username = p.username WHERE c.category = $1 ORDER BY c.career_score DESC LIMIT 100;', [category])).rows;
        return res.json({ highScores, careerScores });
      }
    } else {
      const highScores = (await pool.query(`
        SELECT r.username, p.avatar, r.high_score AS score, r.games_played 
        FROM room_scores r 
        LEFT JOIN players p ON r.username = p.username 
        WHERE r.room_code = $1 
        ORDER BY r.high_score DESC LIMIT 100;
      `, [roomScope])).rows;

      const careerScores = (await pool.query(`
        SELECT r.username, p.avatar, r.career_score AS score, r.games_played 
        FROM room_scores r 
        LEFT JOIN players p ON r.username = p.username 
        WHERE r.room_code = $1 
        ORDER BY r.career_score DESC LIMIT 100;
      `, [roomScope])).rows;

      return res.json({ highScores, careerScores });
    }
  } catch (err) {
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
    const chosenAvatar = (avatar || '🚀').trim();
    const targetRoomCode = (roomCode || 'ROOM1').trim().toUpperCase();

    if (!cleanUser || !cleanPin || cleanUser.length < 2 || cleanPin.length < 4) {
      return socket.emit('player:auth_error', 'Username (2+ chars) and 4-digit PIN required.');
    }

    const room = getOrCreateRoom(targetRoomCode);
    if (!room) return socket.emit('player:auth_error', `Room ${targetRoomCode} unavailable.`);
    if (isPlayerCurrentlyOnline(cleanUser)) return socket.emit('player:auth_error', `"${cleanUser}" is already playing right now.`);

    try {
      let playerProfile = { username: cleanUser, pin: cleanPin, avatar: chosenAvatar, high_score: 0, career_score: 0, games_played: 0 };

      if (pool) {
        const existing = await pool.query('SELECT * FROM players WHERE username = $1;', [cleanUser]);
        if (existing.rows.length > 0) {
          if (existing.rows[0].pin !== cleanPin) {
            return socket.emit('player:auth_error', `Username "${cleanUser}" taken. Pick another name or correct PIN.`);
          }
          await pool.query('UPDATE players SET avatar = $1 WHERE username = $2;', [chosenAvatar, cleanUser]);
          playerProfile = { ...existing.rows[0], avatar: chosenAvatar };
        } else {
          await pool.query(
            'INSERT INTO players (username, pin, avatar, high_score, career_score, games_played) VALUES ($1, $2, $3, 0, 0, 0);',
            [cleanUser, cleanPin, chosenAvatar]
          );
        }
      } else {
        if (memoryPlayers[cleanUser]) {
          if (memoryPlayers[cleanUser].pin !== cleanPin) {
            return socket.emit('player:auth_error', `Username "${cleanUser}" taken. Pick another name or correct PIN.`);
          }
          memoryPlayers[cleanUser].avatar = chosenAvatar;
          playerProfile = memoryPlayers[cleanUser];
        } else {
          memoryPlayers[cleanUser] = playerProfile;
        }
      }

      socket.join(room.code);

      room.activeSockets[socket.id] = {
        username: cleanUser,
        avatar: chosenAvatar,
        score: 0,
        currentAnswer: null,
        answerTimeLeft: 0,
        reactionSeconds: null,
        roundPointsEarned: 0,
        streak: 0
      };

      socket.emit('player:authenticated', {
        username: cleanUser,
        avatar: chosenAvatar,
        roomCode: room.code,
        roomName: room.name,
        highScore: playerProfile.high_score,
        careerScore: playerProfile.career_score,
        gamesPlayed: playerProfile.games_played
      });

      io.to(room.code).emit('game:player_list', getLobbyPlayers(room));
    } catch (err) {
      console.error('Login error detail:', err);
      socket.emit('player:auth_error', 'Server error logging in.');
    }
  });

  socket.on('player:submit_answer', (answerIndex) => {
    const room = getSocketRoom(socket);
    if (!room) return;

    if (room.roundActive && room.activeSockets[socket.id] && room.activeSockets[socket.id].currentAnswer === null) {
      const now = Date.now();
      const elapsedSeconds = Math.max(0.1, (now - room.questionStartTime) / 1000);

      room.activeSockets[socket.id].currentAnswer = answerIndex;
      room.activeSockets[socket.id].answerTimeLeft = room.timeLeft;
      room.activeSockets[socket.id].reactionSeconds = parseFloat(elapsedSeconds.toFixed(2));
      socket.emit('player:answer_received', answerIndex);

      io.to(room.code).emit('game:submission_update', {
        username: room.activeSockets[socket.id].username,
        avatar: room.activeSockets[socket.id].avatar,
        socketId: socket.id,
        submittedCount: Object.values(room.activeSockets).filter(p => p.currentAnswer !== null).length,
        totalCount: Object.keys(room.activeSockets).length
      });

      const totalPlayers = Object.keys(room.activeSockets).length;
      const answeredPlayers = Object.values(room.activeSockets).filter(p => p.currentAnswer !== null).length;

      if (totalPlayers > 0 && answeredPlayers >= totalPlayers) {
        clearInterval(room.questionTimer);
        endRound(room);
      }
    }
  });

  socket.on('host:kick_player', (targetUsername) => {
    const room = getSocketRoom(socket) || getOrCreateRoom('ROOM1');
    if (room) disconnectPlayerByUsername(room, targetUsername, 'You were removed by the host.');
  });

  socket.on('host:start_game', (config) => {
    const roomCode = (config.roomCode || 'ROOM1').trim().toUpperCase();
    const room = getOrCreateRoom(roomCode);
    if (!room) return;

    clearInterval(room.questionTimer);
    clearTimeout(room.intermissionTimer);

    room.previousRankings = {};

    Object.keys(room.activeSockets).forEach((id) => {
      room.activeSockets[id].score = 0;
      room.activeSockets[id].currentAnswer = null;
      room.activeSockets[id].answerTimeLeft = 0;
      room.activeSockets[id].reactionSeconds = null;
      room.activeSockets[id].roundPointsEarned = 0;
      room.activeSockets[id].streak = 0;
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
        else if (room.currentGameCategory === 'logos') matchCat = cat.includes('logo');
        else if (room.currentGameCategory === 'music') matchCat = cat.includes('music') || cat.includes('pop culture');
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

      const shuffled = shuffle(eligible);
      room.activeQuestions = shuffled.slice(0, Math.min(requestedCount, shuffled.length));
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
  room.timeLeft = QUESTION_DURATION;
  room.questionStartTime = Date.now();

  const connectedList = Object.values(room.activeSockets).map(p => ({
    name: p.username,
    avatar: p.avatar,
    answered: false
  }));

  io.to(room.code).emit('game:new_question', {
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

  clearInterval(room.questionTimer);
  room.questionTimer = setInterval(() => {
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

  const distribution = [0, 0, 0, 0];
  let unansweredCount = 0;

  let fastestPlayer = null;
  let slowestPlayer = null;

  Object.keys(room.activeSockets).forEach((id) => {
    const p = room.activeSockets[id];

    if (p.currentAnswer === correctIdx) {
      p.streak = (p.streak || 0) + 1;
      const multiplier = getStreakMultiplier(p.streak);
      const baseSpeedBonus = Math.round((Math.max(1, p.answerTimeLeft) / QUESTION_DURATION) * 500);
      const rawPoints = 500 + baseSpeedBonus;
      const earned = Math.round(rawPoints * multiplier);

      p.roundPointsEarned = earned;
      p.score += earned;

      if (p.reactionSeconds !== null) {
        if (!fastestPlayer || p.reactionSeconds < fastestPlayer.time) {
          fastestPlayer = { name: p.username, avatar: p.avatar, time: p.reactionSeconds };
        }
      }
    } else {
      p.streak = 0;
      p.roundPointsEarned = 0;
    }

    if (p.reactionSeconds !== null) {
      if (!slowestPlayer || p.reactionSeconds > slowestPlayer.time) {
        slowestPlayer = { name: p.username, avatar: p.avatar, time: p.reactionSeconds };
      }
    }

    if (p.currentAnswer !== null && p.currentAnswer >= 0 && p.currentAnswer <= 3) {
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

async function finishGameAndSaveStats(room) {
  const standings = getCurrentGameStandings(room);

  for (const p of Object.values(room.activeSockets)) {
    if (p.username) {
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
      }
    }
  }

  io.to(room.code).emit('game:over', {
    roomCode: room.code,
    roomName: room.name,
    category: room.currentGameCategory,
    leaderboard: standings
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
      score: room.activeSockets[id].score,
      streak: room.activeSockets[id].streak || 0
    }))
    .sort((a, b) => b.score - a.score);
}

function getLobbyPlayers(room) {
  return Object.values(room.activeSockets).map((p) => ({
    name: p.username,
    avatar: p.avatar || '🚀'
  }));
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
