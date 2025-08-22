const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname)); // отдаём все файлы проекта

// --- Вспомогательные структуры ---
const polls = new Map(); // Map для опросов: id -> poll
const codeToPoll = new Map(); // Map для поиска poll по коду участника

// Генерация уникального id
const uid = () => Math.random().toString(36).substring(2, 10).toUpperCase();

// Уникальный код участника
const ensureCodeUnique = (code) => {
  let c = code ? String(code).toUpperCase() : uid();
  while (codeToPoll.has(c)) c = uid();
  return c;
};

// Очистка аллокаций голосов
const cleanAllocations = (alloc) => {
  const res = {};
  if (!alloc) return res;
  for (const [k, v] of Object.entries(alloc)) {
    const val = Math.max(0, Number(v) || 0);
    if (val > 0) res[k] = val;
  }
  return res;
};

// Отправка обновлений опроса всем клиентам
const broadcastPoll = (id) => {
  const p = polls.get(id);
  if (p) io.emit("poll_update", p);
};

// --- Socket.IO ---
io.on("connection", (socket) => {

  socket.on("add_option", ({ id, opt }) => {
    const p = polls.get(id); if(!p) return;
    const option = opt && opt.id ? opt : { id: uid(), label: "Новый вариант" };
    p.options.push({ id: String(option.id), label: String(option.label || "") });
    broadcastPoll(id);
  });

  socket.on("update_option", ({ id, optId, label }) => {
    const p = polls.get(id); if(!p) return;
    const o = p.options.find(x => x.id === optId);
    if(o) { o.label = String(label || ""); broadcastPoll(id); }
  });

  socket.on("delete_option", ({ id, optId }) => {
    const p = polls.get(id); if(!p) return;
    p.options = p.options.filter(x => x.id !== optId);
    for(const alloc of Object.values(p.votes)) delete alloc[optId];
    broadcastPoll(id);
  });

  socket.on("clear_options", ({ id }) => {
    const p = polls.get(id); if(!p) return;
    p.options = [];
    for(const alloc of Object.values(p.votes)) {
      for(const k of Object.keys(alloc)) delete alloc[k];
    }
    broadcastPoll(id);
  });

  socket.on("add_voter", ({ id, voter }) => {
    const p = polls.get(id); if(!p) return;
    const v = Object.assign({ name: "Участник", coins: 10, submitted:false }, voter || {});
    const code = ensureCodeUnique(v.code);
    v.code = code;
    p.voters.push({ name: String(v.name || ""), coins: Math.max(0, Number(v.coins) || 0), code, submitted: !!v.submitted });
    codeToPoll.set(code, p.id);
    broadcastPoll(id);
  });

  socket.on("bulk_add_voters", ({ id, count, coins }) => {
    const p = polls.get(id); if(!p) return;
    const n = Math.max(1, Math.min(Number(count) || 1, 200));
    const c = Math.max(0, Number(coins) || 10);
    for(let i=0; i<n; i++) {
      const code = ensureCodeUnique();
      p.voters.push({ name: `Участник ${p.voters.length+1}`, coins: c, code, submitted:false });
      codeToPoll.set(code, p.id);
    }
    broadcastPoll(id);
  });

  socket.on("update_voter", ({ id, index, field, value }) => {
    const p = polls.get(id); if(!p) return;
    const v = p.voters[index]; if(!v) return;
    if(field === "code"){
      const old = (v.code || "").toUpperCase();
      if(old) codeToPoll.delete(old);
      const newCode = ensureCodeUnique(String(value || ""));
      v.code = newCode;
      codeToPoll.set(newCode, p.id);
    } else if(field === "coins"){
      v.coins = Math.max(0, Number(value) || 0);
    } else if(field === "name"){
      v.name = String(value || "");
    } else if(field === "submitted"){
      v.submitted = !!value;
    }
    broadcastPoll(id);
  });

  socket.on("delete_voter", ({ id, index }) => {
    const p = polls.get(id); if(!p) return;
    const v = p.voters[index];
    if(v && v.code) codeToPoll.delete((v.code||"").toUpperCase());
    p.voters.splice(index,1);
    broadcastPoll(id);
  });

  socket.on("reset_submits", ({ id }) => {
    const p = polls.get(id); if(!p) return;
    p.votes = {};
    for(const v of p.voters) v.submitted = false;
    broadcastPoll(id);
  });

  socket.on("submit_vote", ({ id, code, allocations }, ack) => {
    const p = polls.get(id); if(!p){ if(typeof ack==="function") ack({ok:false, error:"not found"}); return; }
    if(p.status === "closed"){ if(typeof ack==="function") ack({ok:false, error:"closed"}); return; }
    const clean = cleanAllocations(allocations);
    p.votes[(code||"").toUpperCase()] = clean;
    const voter = p.voters.find(v => (v.code||"").toUpperCase() === (code||"").toUpperCase());
    if(voter) voter.submitted = true;
    broadcastPoll(id);
    if(typeof ack==="function") ack({ok:true});
  });

  socket.on("disconnect", () => {
    // ничего не делаем
  });

});

// --- Запуск сервера ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on port " + PORT);
});

