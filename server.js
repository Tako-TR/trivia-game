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

    // Reset scores for new game
    Object.keys(players).forEach((id) => {
      players[id].score = 0;
      players[id].currentAnswer = null;
      players[id].answerTimeLeft = 0;
      players[id].roundPointsEarned = 0;
    });

    const requestedCount = typeof config === 'object' ? config.count : config;
    const requestedDifficulty = typeof config === 'object' ? config.difficulty : 'all';

    // Filter questions by difficulty
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

    if (eligibleQuestions.length === 0) {
      eligibleQuestions = masterQuestions;
    }

    const shuffled = shuffle(eligibleQuestions);
    const count = parseInt(requestedCount, 10) || eligibleQuestions.length;
    activeQuestions = shuffled.slice(0, Math.min(count, shuffled.length));

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

  // Clear round answers
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

  // Speed-based scoring
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
