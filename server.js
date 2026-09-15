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
    console.error('Error creating database tables:', err);
  }
}
initDb();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const questionsFilePath = path.join(__dirname, 'questions.json');
let masterQuestions = [];
try {
  masterQuestions = JSON.parse(fs.readFileSync(questionsFilePath, 'utf8'));
} catch (err) {
  console.error('Error loading questions.json:', err);
}

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
let currentGameCategory = 'all';

// Admin API
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
  fs.writeFile(questionsFilePath, JSON.stringify(masterQuestions, null, 2), 'utf8', (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Error saving file.' });
    return res.json({ success: true, totalQuestions: masterQuestions.length });
  });
});

app.post('/api/questions/bulk', (req, res) => {
  const { password, questions } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ success: false, message: 'No questions array provided.' });
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
  fs.writeFile(questionsFilePath, JSON.stringify(masterQuestions, null, 2), 'utf8', (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Error saving file.' });
    return res.json({ success: true, addedCount: validQuestions.length, totalQuestions: masterQuestions.length });
  });
});

app.post('/api/questions/delete', (req, res) => {
  const { password, index } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  const qIndex = parseInt(index, 10);
  if (isNaN(qIndex) || qIndex < 0 || qIndex >= masterQuestions.length) {
    return res.status(400).json({ success: false, message: 'Invalid index.' });
  }

  masterQuestions.splice(qIndex, 1);
  fs.writeFile(questionsFilePath, JSON.stringify(masterQuestions, null, 2), 'utf8', (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Error writing file.' });
    return res.json({ success: true, totalQuestions: masterQuestions.length });
  });
});

app.post('/api/players/list', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  if (!pool) return res.json({ success: true, players: [] });

  try {
    const result = await pool.query('SELECT username, high_score, career_score, games_played, updated_at FROM players ORDER BY career_score DESC;');
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
        await pool.query('UPDATE category_scores SET high_score = 0, career_score = 0, games_played = 0 WHERE username = $1;', [cleanUser]);
      }
      return res.json({ success: true, message: `Scores reset for ${cleanUser}.` });
    } else if (action === 'delete_ban') {
      if (pool) {
        await pool.query('DELETE FROM players WHERE username = $1;', [cleanUser]);
        await pool.query('DELETE FROM category_scores WHERE username = $1;', [cleanUser]);
      }
      disconnectPlayerByUsername(cleanUser, 'Your profile has been removed by the administrator.');
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
        await pool.query('UPDATE category_scores SET high_score = 0, career_score = 0, games_played = 0;');
      }
      return res.json({ success: true, message: 'All player scores reset to 0.' });
    } else if (action === 'wipe_all_players') {
      if (pool) {
        await pool.query('TRUNCATE TABLE category_scores;');
        await pool.query('TRUNCATE TABLE players;');
      }
      Object.keys(activeSockets).forEach((id) => {
        const sock = io.sockets.sockets.get(id);
        if (sock) {
          sock.emit('player:kicked', 'All player accounts were reset by the host.');
          sock.disconnect(true);
        }
      });
      activeSockets = {};
      io.emit('game:player_list', []);
      return res.json({ success: true, message: 'All player profiles wiped.' });
    }
    return res.status(400).json({ success: false, message: 'Invalid bulk action.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function disconnectPlayerByUsername(username, reason) {
  Object.keys(activeSockets).forEach((id) => {
    if (activeSockets[id].username === username) {
      const sock = io.sockets.sockets.get(id);
      if (sock) {
        sock.emit('player:kicked', reason || 'You were kicked from the match.');
        sock.disconnect(true);
      }
      delete activeSockets[id];
    }
  });
  io.emit('game:player_list', getLobbyPlayers());
}

app.get('/api/leaderboards', async (req, res) => {
  if (!pool) return res.json({ highScores: [], careerScores: [] });
  const category = (req.query.category || 'all').toLowerCase();

  try {
    if (category === 'all') {
      const highScores = (await pool.query('SELECT username, high_score AS score, games_played FROM players ORDER BY high_score DESC LIMIT 100;')).rows;
      const careerScores = (await pool.query('SELECT username, career_score AS score, games_played FROM players ORDER BY career_score DESC LIMIT 100;')).rows;
      return res.json({ highScores, careerScores });
    } else {
      const highScores = (await pool.query('SELECT username, high_score AS score, games_played FROM category_scores WHERE category = $1 ORDER BY high_score DESC LIMIT 100;', [category])).rows;
      const careerScores = (await pool.query('SELECT username, career_score AS score, games_played FROM category_scores WHERE category = $1 ORDER BY career_score DESC LIMIT 100;', [category])).rows;
      return res.json({ highScores, careerScores });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io Game Events
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

  socket.on('host:kick_player', (targetUsername) => {
    disconnectPlayerByUsername(targetUsername, 'You have been removed by the host.');
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

    currentGameCategory = config.category || 'all';
    const requestedDifficulty = config.difficulty || 'all';
    const requestedCount = parseInt(config.count, 10) || 10;

    let eligible = masterQuestions.filter((q) => {
      const cat = (q.category || '').toLowerCase();
      let matchCat = false;
      if (currentGameCategory === 'all') matchCat = true;
      else if (currentGameCategory === 'bible') matchCat = cat.includes('bible');
      else if (currentGameCategory === 'movie') matchCat = cat.includes('movie');
      else if (currentGameCategory === 'logos') matchCat = cat.includes('logo');
      else if (currentGameCategory === 'music') matchCat = cat.includes('music') || cat.includes('pop culture');
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

  // Calculate answer distribution counts: [opt0Count, opt1Count, opt2Count, opt3Count]
  const distribution = [0, 0, 0, 0];
  let unansweredCount = 0;

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

    if (p.currentAnswer !== null && p.currentAnswer >= 0 && p.currentAnswer <= 3) {
      distribution[p.currentAnswer]++;
    } else {
      unansweredCount++;
    }
  });

  const leaderboard = getCurrentGameStandings();
  const finishedQuestionNum = currentQuestionIndex + 1;
  const totalQuestions = activeQuestions.length;
  const totalResponders = Object.keys(activeSockets).length;

  const isMilestone = totalQuestions > 10 && finishedQuestionNum % 10 === 0 && finishedQuestionNum < totalQuestions;

  io.sockets.sockets.forEach((socket) => {
    const p = activeSockets[socket.id];
    const rankIndex = leaderboard.findIndex((item) => item.id === socket.id);
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
      myPointsEarned: p ? p.roundPointsEarned : 0,
      myTotalScore: p ? p.score : 0,
      isMilestone: isMilestone,
      milestoneNumber: finishedQuestionNum
    });
  });

  // Give 7 seconds on results screen so the host can view the bar chart
  const revealDuration = 7000;

  if (isMilestone) {
    intermissionTimer = setTimeout(() => {
      io.emit('game:milestone_leaderboard', {
        questionNumber: finishedQuestionNum,
        leaderboard: leaderboard
      });

      intermissionTimer = setTimeout(() => {
        startNextQuestion();
      }, 10000);
    }, revealDuration);
  } else {
    intermissionTimer = setTimeout(() => {
      startNextQuestion();
    }, revealDuration);
  }
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

          if (currentGameCategory && currentGameCategory !== 'all') {
            await pool.query(
              `INSERT INTO category_scores (username, category, high_score, career_score, games_played)
               VALUES ($1, $2, $3, $3, 1)
               ON CONFLICT (username, category)
               DO UPDATE SET
                 high_score = GREATEST(category_scores.high_score, EXCLUDED.high_score),
                 career_score = category_scores.career_score + EXCLUDED.career_score,
                 games_played = category_scores.games_played + 1;`,
              [p.username, currentGameCategory, p.score]
            );
          }
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
