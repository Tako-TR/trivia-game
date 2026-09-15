const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const QUESTION_DURATION = 15; // seconds per question
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Enable parsing JSON bodies for the question creator API
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load questions from questions.json
const questionsFilePath = path.join(__dirname, 'questions.json');
let masterQuestions = [];
try {
  const data = fs.readFileSync(questionsFilePath, 'utf8');
  masterQuestions = JSON.parse(data);
} catch (err) {
  console.error('Error loading questions.json:', err);
}

// API endpoint to add new questions directly from the web interface
app.post('/api/questions/add', (req, res) => {
  const { password, category, difficulty, question, options, answer, image } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Invalid admin passcode.' });
  }

  if (!category || !difficulty || !question || !Array.isArray(options) || options.length !== 4 || answer === undefined) {
    return res.status(400).json({ success: false, message: 'Missing or invalid question fields.' });
  }

  const formattedCategory = `${category}: ${difficulty}`;
  const newQuestion = {
    category: formattedCategory,
    question: question.trim(),
    options: options.map(opt => opt.trim()),
    answer: parseInt(answer, 10)
  };

  if (image && image.trim() !== '') {
    newQuestion.image = image.trim();
  }

  // Update memory and write back to questions.json
  masterQuestions.push(newQuestion);

  fs.writeFile(questionsFilePath, JSON.stringify(masterQuestions, null, 2), 'utf8', (err) => {
    if (err) {
      console.error('Failed to save questions.json:', err);
      return res.status(500).json({ success: false, message: 'Failed to write to file system.' });
    }
    return res.json({ success: true, totalQuestions: masterQuestions.length });
  });
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

// Game State
let players = {};
let activeQuestions = [];
let currentQuestionIndex = -1;
let questionTimer = null;
let intermissionTimer = null;
let timeLeft = QUESTION_DURATION;
let roundActive = false;

io.on('connection', (socket) => {
  // Player joins
  socket.on('player:join', (name) => {
    players[socket.id] = {
      name: name || `Player_${socket.id.substring(0, 4)}`,
      score: 0,
      currentAnswer: null,
      answerTimeLeft: 0,
      roundPointsEarned: 0
    };
    socket.emit('player:joined', { id: socket.id, name: players[socket.id].name });
    io.emit('game:player_list', getLeaderboard());
  });

  // Player submits answer
  socket.on('player:submit_answer', (answerIndex) => {
    if (roundActive && players[socket.id] && players[socket.id].currentAnswer === null) {
      players[socket.id].currentAnswer = answerIndex;
      players[socket.id].answerTimeLeft = timeLeft;
      socket.emit('player:answer_received', answerIndex);
    }
  });

  // Host starts game
  socket.on('host:start_game', (config) => {
    clearInterval(questionTimer);
    clearTimeout(intermissionTimer);

    Object.keys(players).forEach((id) => {
      players[id].score = 0;
      players[id].currentAnswer = null;
      players[id].answerTimeLeft = 0;
      players[id].roundPointsEarned = 0;
    });

    const requestedCategory = config.category || 'all';
    const requestedDifficulty = config.difficulty || 'all';
    const requestedCount = parseInt(config.count, 10) || 10;

    let eligibleQuestions = masterQuestions.filter((q) => {
      const cat = (q.category || '').toLowerCase();

      let matchesCategory = false;
      if (requestedCategory === 'all') {
        matchesCategory = true;
      } else if (requestedCategory === 'bible') {
        matchesCategory = cat.includes('bible');
      } else if (requestedCategory === 'movie') {
        matchesCategory = cat.includes('movie');
      } else if (requestedCategory === 'logos') {
        matchesCategory = cat.includes('logo');
      }

      if (!matchesCategory) return false;

      switch (requestedDifficulty) {
        case 'easy':
          return cat.includes('easy');
        case 'medium':
          return cat.includes('medium');
        case 'hard':
          return cat.includes('hard');
        case 'easy_medium':
          return cat.includes('easy') || cat.includes('medium');
        case 'medium_hard':
          return cat.includes('medium') || cat.includes('hard');
        case 'all':
        default:
          return true;
      }
    });

    if (eligibleQuestions.length === 0) {
      eligibleQuestions = masterQuestions;
    }

    const shuffled = shuffle(eligibleQuestions);
    activeQuestions = shuffled.slice(0, Math.min(requestedCount, shuffled.length));

    currentQuestionIndex = -1;
    startNextQuestion();
  });

  // Host forces game to stop
  socket.on('host:stop_game', () => {
    clearInterval(questionTimer);
    clearTimeout(intermissionTimer);
    roundActive = false;
    broadcastGameOver();
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit('game:player_list', getLeaderboard());
    }
  });
});

function startNextQuestion() {
  currentQuestionIndex++;

  if (currentQuestionIndex >= activeQuestions.length) {
    roundActive = false;
    broadcastGameOver();
    return;
  }

  Object.keys(players).forEach((id) => {
    players[id].currentAnswer = null;
    players[id].answerTimeLeft = 0;
    players[id].roundPointsEarned = 0;
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
  const correctAnswerIndex = currentQ.answer;
  const correctAnswerText = currentQ.options[correctAnswerIndex];

  Object.keys(players).forEach((id) => {
    const p = players[id];
    if (p.currentAnswer === correctAnswerIndex) {
      const bonus = Math.round((Math.max(1, p.answerTimeLeft) / QUESTION_DURATION) * 500);
      const earned = 500 + bonus;
      p.roundPointsEarned = earned;
      p.score += earned;
    } else {
      p.roundPointsEarned = 0;
    }
  });

  const leaderboard = getLeaderboard();

  io.sockets.sockets.forEach((socket) => {
    const player = players[socket.id];
    const rankIndex = leaderboard.findIndex((item) => item.id === socket.id);
    const rank = rankIndex !== -1 ? rankIndex + 1 : null;

    socket.emit('game:round_ended', {
      correctAnswer: correctAnswerIndex,
      correctAnswerText: correctAnswerText,
      questionText: currentQ.question,
      leaderboard: leaderboard,
      myRank: rank,
      myPointsEarned: player ? player.roundPointsEarned : 0,
      myTotalScore: player ? player.score : 0
    });
  });

  intermissionTimer = setTimeout(() => {
    startNextQuestion();
  }, 5000);
}

function broadcastGameOver() {
  const leaderboard = getLeaderboard();
  io.sockets.sockets.forEach((socket) => {
    const rankIndex = leaderboard.findIndex((item) => item.id === socket.id);
    const rank = rankIndex !== -1 ? rankIndex + 1 : null;

    socket.emit('game:over', {
      leaderboard: leaderboard,
      myRank: rank
    });
  });
}

function getLeaderboard() {
  return Object.keys(players)
    .map((id) => ({
      id: id,
      name: players[id].name,
      score: players[id].score
    }))
    .sort((a, b) => b.score - a.score);
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
