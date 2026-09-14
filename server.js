const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Load questions from questions.json
let masterQuestions = [];
try {
  const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
  masterQuestions = JSON.parse(data);
} catch (err) {
  console.error('Error loading questions.json:', err);
}

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
let timeLeft = 15;
let roundActive = false;

io.on('connection', (socket) => {
  // Player joins
  socket.on('player:join', (name) => {
    players[socket.id] = {
      name: name || `Player_${socket.id.substring(0, 4)}`,
      score: 0,
      currentAnswer: null
    };
    socket.emit('player:joined', { id: socket.id, name: players[socket.id].name });
    io.emit('game:player_list', getLeaderboard());
  });

  // Player submits answer
  socket.on('player:submit_answer', (answerIndex) => {
    if (roundActive && players[socket.id] && players[socket.id].currentAnswer === null) {
      players[socket.id].currentAnswer = answerIndex;
      socket.emit('player:answer_received', answerIndex);
    }
  });

  // Host starts game with question count and difficulty
  socket.on('host:start_game', (config) => {
    clearInterval(questionTimer);
    clearTimeout(intermissionTimer);

    // Reset scores for new game
    Object.keys(players).forEach((id) => {
      players[id].score = 0;
      players[id].currentAnswer = null;
    });

    const requestedCount = typeof config === 'object' ? config.count : config;
    const requestedDifficulty = typeof config === 'object' ? config.difficulty : 'all';

    // Filter master questions by requested difficulty
    let eligibleQuestions = masterQuestions.filter((q) => {
      const cat = (q.category || '').toLowerCase();
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

    // Fallback if filter returns empty
    if (eligibleQuestions.length === 0) {
      eligibleQuestions = masterQuestions;
    }

    const shuffled = shuffle(eligibleQuestions);
    const count = parseInt(requestedCount, 10) || eligibleQuestions.length;
    activeQuestions = shuffled.slice(0, Math.min(count, shuffled.length));

    currentQuestionIndex = -1;
    startNextQuestion();
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
    io.emit('game:over', getLeaderboard());
    return;
  }

  // Clear previous answers
  Object.keys(players).forEach((id) => {
    players[id].currentAnswer = null;
  });

  const currentQ = activeQuestions[currentQuestionIndex];
  roundActive = true;
  timeLeft = 15;

  io.emit('game:new_question', {
    category: currentQ.category,
    question: currentQ.question,
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

  // Score calculations
  Object.keys(players).forEach((id) => {
    if (players[id].currentAnswer === correctAnswerIndex) {
      players[id].score += 100;
    }
  });

  io.emit('game:round_ended', {
    correctAnswer: correctAnswerIndex,
    correctAnswerText: correctAnswerText,
    questionText: currentQ.question,
    leaderboard: getLeaderboard()
  });

  // Automatically advance after a 5-second results screen
  intermissionTimer = setTimeout(() => {
    startNextQuestion();
  }, 5000);
}

function getLeaderboard() {
  return Object.values(players)
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ name: p.name, score: p.score }));
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
