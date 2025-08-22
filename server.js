// server.js
// Node 18+
// Real-time poll service with WebSocket (Socket.IO) and in-memory storage

import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Simple in-memory store
/** @type {Map<string, any>} */
const polls = new Map(); // id -> poll
/** @type {Map<string, string>} */
const codeToPoll = new Map(); // code -> pollId

// Helpers
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const randCode = () => "V-" + Math.random().toString(36).substring(2, 8).toUpperCase();

function ensureCodeUnique(code){
  let c = (code || randCode()).toUpperCase();
  while(codeToPoll.has(c)) c = randCode();
  return c;
}

function broadcastPoll(pollId){
  const poll = polls.get(pollId);
  if(!poll) return;
  io.to("poll:"+pollId).emit("poll_updated", poll);
}

function cleanAllocations(alloc){
  const result = {};
  if(!alloc || typeof alloc !== "object") return result;
  for(const [k,v] of Object.entries(alloc)){
    const n = Number(v) || 0;
    if(n > 0) result[k] = Math.floor(n);
  }
  return result;
}

// REST endpoint for export (optional)
app.get("/api/poll/:id", (req,res) => {
  const poll = polls.get(req.params.id);
  if(!poll) return res.status(404).json({error:"not found"});
  res.json(poll);
});

// helper to get local network addresses (for user convenience)
app.get("/api/host", (_req,res)=>{
  const ifaces = os.networkInterfaces();
  const addrs = [];
  for(const [name, arr] of Object.entries(ifaces)){
    for(const info of arr || []){
      if(info.family === "IPv4" && !info.internal){
        addrs.append;
        addrs.push({ iface: name, address: info.address });
      }
    }
  }
  res.json({ addresses: addrs });
});

io.on("connection", (socket) => {
  // Create new poll
  socket.on("create_poll", (ack) => {
    const poll = {
      id: uid(),
      title: "",
      status: "draft", // 'open' | 'closed'
      options: [], // {id, label}
      voters: [], // {name, coins, code, submitted}
      votes: {} // code -> { optionId: coins }
    };
    polls.set(poll.id, poll);
    socket.join("poll:"+poll.id);
    if(typeof ack === "function") ack(poll);
  });

  // Join existing poll room and get data
  socket.on("join_poll", ({ id }, ack) => {
    const poll = polls.get(id);
    if(!poll){ if(typeof ack==="function") ack(null); return; }
    socket.join("poll:"+id);
    if(typeof ack==="function") ack(poll);
  });

  // Get poll by id
  socket.on("get_poll", ({ id }, ack)=>{
    const poll = polls.get(id) || null;
    if(typeof ack==="function") ack(poll);
  });

  // Find poll by access code
  socket.on("get_poll_by_code", ({ code }, ack) => {
    const pid = codeToPoll.get((code||"").toUpperCase());
    const poll = pid ? polls.get(pid) : null;
    if(typeof ack === "function") ack(poll || null);
  });

  // Mutations (organizer)
  socket.on("set_title", ({ id, title }) => {
    const p = polls.get(id); if(!p) return;
    p.title = title || "";
    broadcastPoll(id);
  });

  socket.on("set_status", ({ id, status }) => {
    const p = polls.get(id); if(!p) return;
    if(status==="open" || status==="closed" || status==="draft"){
      p.status = status;
      broadcastPoll(id);
    }
  });

  socket.on("add_option", ({ id, opt }) => {
    const p = polls.get(id); if(!p) return;
    const option = opt && opt.id ? opt : { id: uid(), label: "Новый вариант" };
    p.options.push({ id: String(option.id), label: String(option.label||"") });
    // Remove stale votes keys if any (not needed here)
    broadcastPoll(id);
  });

  socket.on("update_option", ({ id, optId, label }) => {
    const p = polls.get(id); if(!p) return;
    const o = p.options.find(x => x.id === optId);
    if(o){ o.label = String(label||""); broadcastPoll(id); }
  });

  socket.on("delete_option", ({ id, optId }) => {
    const p = polls.get(id); if(!p) return;
    p.options = p.options.filter(x => x.id !== optId);
    // purge allocations for this option
    for(const alloc of Object.values(p.votes)) delete alloc[optId];
    broadcastPoll(id);
  });

  socket.on("clear_options", ({ id }) => {
    const p = polls.get(id); if(!p) return;
    p.options = [];
    for(const alloc of Object.values(p.votes)){
      for(const k of Object.keys(alloc)) delete alloc[k];
    }
    broadcastPoll(id);
  });

  socket.on("add_voter", ({ id, voter }) => {
    const p = polls.get(id); if(!p) return;
    const v = Object.assign({ name: "Участник", coins: 10, submitted:false }, voter||{});
    const code = ensureCodeUnique(v.code);
    v.code = code;
    p.voters.push({ name: String(v.name||""), coins: Math.max(0, Number(v.coins)||0), code, submitted: !!v.submitted });
    codeToPoll.set(code, p.id);
    broadcastPoll(id);
  });

  socket.on("bulk_add_voters", ({ id, count, coins }) => {
    const p = polls.get(id); if(!p) return;
    const n = Math.max(1, Math.min(Number(count)||1, 200));
    const c = Math.max(0, Number(coins)||10);
    for(let i=0;i<n;i++){
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
      // Update code map
      const old = (v.code||"").toUpperCase();
      if(old) codeToPoll.delete(old);
      const newCode = ensureCodeUnique(String(value||""));
      v.code = newCode;
      codeToPoll.set(newCode, p.id);
    } else if(field === "coins"){
      v.coins = Math.max(0, Number(value)||0);
    } else if(field === "name"){
      v.name = String(value||"");
    } else if(field === "submitted"){
      v.submitted = !!value;
    }
    broadcastPoll(id);
  });

  socket.on("delete_voter", ({ id, index }) => {
    const p = polls.get(id); if(!p) return;
    const v = p.voters[index];
    if(v && v.code){ codeToPoll.delete((v.code||"").toUpperCase()); }
    p.voters.splice(index,1);
    broadcastPoll(id);
  });

  socket.on("reset_submits", ({ id }) => {
    const p = polls.get(id); if(!p) return;
    p.votes = {};
    for(const v of p.voters) v.submitted = false;
    broadcastPoll(id);
  });

  // Voting (participant)
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
    // nothing
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on http://localhost:"+PORT);
});