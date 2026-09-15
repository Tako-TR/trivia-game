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

// Database setup
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

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
        high_score INT DEFAULT 0,
        career_score INT DEFAULT 0,
        games_played INT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Error creating database tables:', err);
  }
}
initDb();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Questions loader
const questionsFilePath = path.join(__dirname, 'questions.json');
let masterQuestions = [];
try {
  masterQuestions = JSON.parse(fs.readFileSync(questionsFilePath, 'utf8'));
} catch (err) {
  console.error('Error loading questions.json:', err);
}

// API: Fetch all questions for Manager
app.post('/api/questions/list', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  }
  return res.json({ success: true, questions: masterQuestions });
});

// API: Add Question
app.post('/api/questions/add', (req, res) => {
  const { password, category, difficulty, question, options, answer, image } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  }
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
  fs.writeFile(questionsFilePath, JSON.stringify(masterQuestions, null, 2), 'utf8', (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Error saving file.' });
    return res.json({ success: true, totalQuestions: masterQuestions.length });
  });
});

// API: Delete Question by Index
app.post('/api/questions/delete', (req, res) => {
  const { password, index } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  }
  const qIndex = parseInt(index, 10);
  if (isNaN(qIndex) || qIndex < 0 || qIndex >= masterQuestions.length) {
    return res.status(400).json({ success: false, message: 'Invalid question index.' });
  }

  masterQuestions.splice(qIndex, 1);
  fs.writeFile(questionsFilePath, JSON.stringify(masterQuestions, null, 2), 'utf8', (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Error writing questions.json.' });
    return res.json({ success: true, totalQuestions: masterQuestions.length });
  });
});

// API: Fetch All-Time Leaderboards (Top 100)
app.get('/api/leaderboards', async (req, res) => {
  if (!pool) return res.json({ highScores: [], careerScores: [] });
  try {
    const highScores = (await pool.query(
      'SELECT username, high_score AS score, games_played FROM players ORDER BY high_score DESC LIMIT 100;'
    )).rows;
    const careerScores = (await pool.query(
      'SELECT username, career_score AS score, games_played FROM players ORDER BY career_score DESC LIMIT 100;'
    )).rows;
    res.json({ highScores, careerScores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fisher-Yates array shuffle
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Active Game State
let activeSockets = {};
let activeQuestions = [];
let currentQuestionIndex = -1;
let questionTimer = null;
let intermissionTimer = null;
let timeLeft = QUESTION_DURATION;
let roundActive = false;

io.on('connection', (socket) => {
  socket.on('player:auth', async ({ username, pin }) => {
    const cleanUser = (username || '').trim().toLowerCase();
    const cleanPin = (pin || '').trim();

    if (!cleanUser || !cleanPin || cleanUser.length < 2 || cleanPin.length < 4) {
      return socket.emit('player:auth_error', 'Username (2+ chars) and 4-digit PIN required.');
    }

    try {
      let playerProfile = { username: cleanUser, high_score: 0, career_score: 0, games_played: 0 };

      if (pool) {
        const existing = await pool.query('SELECT * FROM players WHERE username = $1;', [cleanUser]);
        if (existing.rows.length > 0) {
          if (existing.rows[0].pin !== cleanPin) {
            return socket.emit('player:auth_error', 'Incorrect PIN for this username.');
          }
          playerProfile = existing.rows[0];
        } else {
          await pool.query(
            'INSERT INTO players (username, pin, high_score, career_score, games_played) VALUES ($1, $2, 0, 0, 0);',
            [cleanUser, cleanPin]
          );
        }
      }

      activeSockets[socket.id] = {
        username: cleanUser,
        score: 0,
        currentAnswer: null,
        answerTimeLeft: 0,
        roundPointsEarned: 0
      };

      socket.emit('player:authenticated', {
        username: cleanUser,
        highScore: playerProfile.high_score,
        careerScore: playerProfile.career_score,
        gamesPlayed: playerProfile.games_played
      });

      io.emit('game:player_list', getLobbyPlayers());
    } catch (err) {
      socket.emit('player:auth_error', 'Server error logging in.');
    }
  });

  socket.on('player:submit_answer', (answerIndex) => {
    if (roundActive && activeSockets[socket.id] && activeSockets[socket.id].currentAnswer === null) {
      activeSockets[socket.id].currentAnswer = answerIndex;
      activeSockets[socket.id].answerTimeLeft = timeLeft;
      socket.emit('player:answer_received', answerIndex);
    }
  });

  socket.on('host:start_game', (config) => {
    clearInterval(questionTimer);
    clearTimeout(intermissionTimer);

    Object.keys(activeSockets).forEach((id) => {
      activeSockets[id].score = 0;
      activeSockets[id].currentAnswer = null;
      activeSockets[id].answerTimeLeft = 0;
      activeSockets[id].roundPointsEarned = 0;
    });

    const requestedCategory = config.category || 'all';
    const requestedDifficulty = config.difficulty || 'all';
    const requestedCount = parseInt(config.count, 10) || 10;

    let eligible = masterQuestions.filter((q) => {
      const cat = (q.category || '').toLowerCase();
      let matchCat = false;
      if (requestedCategory === 'all') matchCat = true;
      else if (requestedCategory === 'bible') matchCat = cat.includes('bible');
      else if (requestedCategory === 'movie') matchCat = cat.includes('movie');
      else if (requestedCategory === 'logos') matchCat = cat.includes('logo');
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
    activeQuestions = shuffled.slice(0, Math.min(requestedCount, shuffled.length));

    currentQuestionIndex = -1;
    startNextQuestion();
  });

  socket.on('host:stop_game', () => {
    clearInterval(questionTimer);
    clearTimeout(intermissionTimer);
    roundActive = false;
    finishGameAndSaveStats();
  });

  socket.on('disconnect', () => {
    if (activeSockets[socket.id]) {
      delete activeSockets[socket.id];
      io.emit('game:player_list', getLobbyPlayers());
    }
  });
});

function startNextQuestion() {
  currentQuestionIndex++;
  if (currentQuestionIndex >= activeQuestions.length) {
    roundActive = false;
    finishGameAndSaveStats();
    return;
  }

  Object.keys(activeSockets).forEach((id) => {
    activeSockets[id].currentAnswer = null;
    activeSockets[id].answerTimeLeft = 0;
    activeSockets[id].roundPointsEarned = 0;
  });

  const currentQ = activeQuestions[currentQuestionIndex];
  roundActive = true;
  timeLeft = QUESTION_DURATION;

  io.emit('game:new_question', {
    category: currentQ.category,
    question: currentQ.question,
    image: currentQ.image || null,
    options: currentQ.options,
    questionNumber: currentQuestionIndex + 1,
    totalQuestions: activeQuestions.length,
    timeLeft: timeLeft
  });

  clearInterval(questionTimer);
  questionTimer = setInterval(() => {
    timeLeft--;
    io.emit('game:timer_tick', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(questionTimer);
      endRound();
    }
  }, 1000);
}

function endRound() {
  roundActive = false;
  const currentQ = activeQuestions[currentQuestionIndex];
  const correctIdx = currentQ.answer;

  Object.keys(activeSockets).forEach((id) => {
    const p = activeSockets[id];
    if (p.currentAnswer === correctIdx) {
      const bonus = Math.round((Math.max(1, p.answerTimeLeft) / QUESTION_DURATION) * 500);
      const earned = 500 + bonus;
      p.roundPointsEarned = earned;
      p.score += earned;
    } else {
      p.roundPointsEarned = 0;
    }
  });

  const leaderboard = getCurrentGameStandings();

  io.sockets.sockets.forEach((socket) => {
    const p = activeSockets[socket.id];
    const rankIndex = leaderboard.findIndex((item) => item.id === socket.id);
    socket.emit('game:round_ended', {
      correctAnswer: correctIdx,
      correctAnswerText: currentQ.options[correctIdx],
      questionText: currentQ.question,
      leaderboard: leaderboard,
      myRank: rankIndex !== -1 ? rankIndex + 1 : null,
      myPointsEarned: p ? p.roundPointsEarned : 0,
      myTotalScore: p ? p.score : 0
    });
  });

  intermissionTimer = setTimeout(() => {
    startNextQuestion();
  }, 5000);
}

async function finishGameAndSaveStats() {
  const standings = getCurrentGameStandings();

  if (pool) {
    for (const p of Object.values(activeSockets)) {
      if (p.username) {
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
        } catch (err) {
          console.error(`Error saving stats for ${p.username}:`, err);
        }
      }
    }
  }

  io.sockets.sockets.forEach((socket) => {
    const rankIndex = standings.findIndex((item) => item.id === socket.id);
    socket.emit('game:over', {
      leaderboard: standings,
      myRank: rankIndex !== -1 ? rankIndex + 1 : null
    });
  });
}

function getCurrentGameStandings() {
  return Object.keys(activeSockets)
    .map((id) => ({
      id: id,
      name: activeSockets[id].username,
      score: activeSockets[id].score
    }))
    .sort((a, b) => b.score - a.score);
}

function getLobbyPlayers() {
  return Object.values(activeSockets).map((p) => ({ name: p.username }));
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
