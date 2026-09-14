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
let questions = [];
try {
  const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
  questions = JSON.parse(data);
} catch (err) {
  console.error('Error loading questions.json:', err);
}

// Game State
let players = {}; // socketId -> { name, score, currentAnswer }
let currentQuestionIndex = -1;
let timer = null;
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

  // Host starts next question
  socket.on('host:next_question', () => {
    currentQuestionIndex++;
    if (currentQuestionIndex >= questions.length) {
      io.emit('game:over', getLeaderboard());
      return;
    }

    // Reset round answers
    Object.keys(players).forEach((id) => {
      players[id].currentAnswer = null;
    });

    const currentQ = questions[currentQuestionIndex];
    roundActive = true;
    timeLeft = 15;

    io.emit('game:new_question', {
      category: currentQ.category,
      question: currentQ.question,
      options: currentQ.options,
      questionNumber: currentQuestionIndex + 1,
      totalQuestions: questions.length,
      timeLeft: timeLeft
    });

    clearInterval(timer);
    timer = setInterval(() => {
      timeLeft--;
      io.emit('game:timer_tick', timeLeft);

      if (timeLeft <= 0) {
        clearInterval(timer);
        endRound();
      }
    }, 1000);
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit('game:player_list', getLeaderboard());
    }
  });
});

function endRound() {
  roundActive = false;
  const currentQ = questions[currentQuestionIndex];
  const correctAnswer = currentQ.answer;

  // Calculate points
  Object.keys(players).forEach((id) => {
    if (players[id].currentAnswer === correctAnswer) {
      players[id].score += 100;
    }
  });

  io.emit('game:round_ended', {
    correctAnswer: correctAnswer,
    leaderboard: getLeaderboard()
  });
}

function getLeaderboard() {
  return Object.values(players)
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ name: p.name, score: p.score }));
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});