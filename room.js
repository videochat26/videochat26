import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/* =============================
   CONFIG
============================= */
const SUPABASE_URL = "https://rslemfuzuoobslkrhqnx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_zGJKajM_m40ZAf0B301ycg_iqsTIVSr";

const ROOM_SLUG = "videochat26";   // deve esistere in public.rooms.slug
const ROOM_TITLE = "VIDEOCHAT 26"; // solo UI

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const el = (id) => document.getElementById(id);

/* =============================
   STATE
============================= */
let user = null;
let profile = null;
let room = null;

let channel = null;
let presenceState = {};
let jitsi = null;

/* =============================
   HELPERS
============================= */
function esc(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function addMsg({ type="public", nick, body, created_at, to_nick }){
  const div = document.createElement("div");
  div.className = "msg";

  const when = created_at ? new Date(created_at).toLocaleString("it-IT") : "";
  const badge = type === "dm"
    ? ` <span class="pill" style="font-size:11px;">DM → ${esc(to_nick || "")}</span>`
    : "";

  div.innerHTML = `
    <div class="meta"><b>${esc(nick || "—")}</b>${badge} · ${when}</div>
    <div class="bubble">${esc(body || "")}</div>
  `;

  el("messages").appendChild(div);
  el("messages").scrollTop = el("messages").scrollHeight;
}

function renderUsers(){
  const users = [];
  for(const k of Object.keys(presenceState)){
    for(const sess of presenceState[k]) users.push(sess);
  }

  // dedup per user_id (multi-tab)
  const map = new Map();
  for(const u of users) map.set(u.user_id, u);

  const list = Array.from(map.values()).sort((a,b)=> (a.nick||"").localeCompare(b.nick||"", "it"));

  el("users").innerHTML = list.map(u => `
    <li>
      <span>${esc(u.nick || "—")}</span>
      <span class="pill" style="font-size:11px;">${esc(u.gender || "")}</span>
    </li>
  `).join("");

  el("count").textContent = String(list.length);
  el("countPill").textContent = String(list.length);

  const opts = list
    .filter(u => u.user_id !== user.id)
    .map(u => `<option value="${esc(u.user_id)}">${esc(u.nick || "—")}</option>`)
    .join("");

  el("dmTo").innerHTML = opts || `<option value="">(nessun utente)</option>`;
}

/* =============================
   AUTH + PROFILE
============================= */
async function requireLogin(){
  const { data } = await supabase.auth.getUser();
  user = data.user || null;

  if(!user){
    window.location.href = "./auth.html";
    return false;
  }

  const { data: p } = await supabase
    .from("profiles")
    .select("nick, gender")
    .eq("user_id", user.id)
    .limit(1);

  profile = (p && p.length) ? p[0] : null;

  const nick = profile?.nick || user.user_metadata?.nick || "Utente";
  el("me").textContent = `Ciao, ${nick}`; // SOLO NICK
  return true;
}

/* =============================
   ROOM: load room by slug
   (NO single/maybeSingle => niente "coerce")
============================= */
async function loadRoom(){
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("slug", ROOM_SLUG)
    .order("id", { ascending: true })
    .limit(1);

  if(error) throw error;
  if(!data || data.length === 0) throw new Error(`Stanza non trovata: slug=${ROOM_SLUG}`);

  room = data[0];
}

/* =============================
   HISTORY
============================= */
async function loadHistory(){
  el("messages").innerHTML = "";
  addMsg({ nick:"Sistema", body:`Sei entrato nella stanza ${ROOM_TITLE}.`, created_at:new Date().toISOString() });

  // pubblici: messages.room_id
  const { data: pub, error: e1 } = await supabase
    .from("messages")
    .select("*")
    .eq("room_id", room.id)
    .order("created_at", { ascending:true });

  if(e1){
    console.warn("history messages error", e1);
  }else{
    (pub || []).forEach(m => addMsg({ ...m, type:"public" }));
  }

  // DM: inbox + outbox
  const { data: dm, error: e2 } = await supabase
    .from("direct_messages")
    .select("*")
    .or(`to_user_id.eq.${user.id},from_user_id.eq.${user.id}`)
    .order("created_at", { ascending:true });

  if(e2){
    console.warn("history dm error", e2);
  }else{
    (dm || []).forEach(m => addMsg({ ...m, type:"dm" }));
  }
}

/* =============================
   REALTIME + PRESENCE
============================= */
async function joinRealtime(){
  if(channel){
    try { supabase.removeChannel(channel); } catch(e){}
    channel = null;
  }

  channel = supabase.channel(`room:${ROOM_SLUG}`, {
    config: { presence: { key: user.id } }
  });

  channel
    .on("presence", { event: "sync" }, () => {
      presenceState = channel.presenceState();
      renderUsers();
    })
    .on("presence", { event: "join" }, () => {
      presenceState = channel.presenceState();
      renderUsers();
    })
    .on("presence", { event: "leave" }, () => {
      presenceState = channel.presenceState();
      renderUsers();
    })

    // pubblici
    .on("postgres_changes",
      { event:"INSERT", schema:"public", table:"messages", filter:`room_id=eq.${room.id}` },
      (payload) => addMsg({ ...payload.new, type:"public" })
    )

    // DM ricevuti
    .on("postgres_changes",
      { event:"INSERT", schema:"public", table:"direct_messages", filter:`to_user_id=eq.${user.id}` },
      (payload) => addMsg({ ...payload.new, type:"dm" })
    )

    .subscribe(async (status) => {
      if(status === "SUBSCRIBED"){
        const myNick = profile?.nick || user.user_metadata?.nick || "Utente";
        const myGender = profile?.gender || user.user_metadata?.gender || "";
        await channel.track({ user_id: user.id, nick: myNick, gender: myGender, at: Date.now() });
      }
    });
}

/* =============================
   SEND PUBLIC
============================= */
async function sendPublic(){
  if(!room) return;

  const body = (el("text").value || "").trim();
  if(!body) return;

  const myNick = profile?.nick || user.user_metadata?.nick || "Utente";

  const { error } = await supabase.from("messages").insert({
    room_id: room.id,
    user_id: user.id,
    nick: myNick,
    body
  });

  if(error){
    alert("Errore invio: " + error.message);
    return;
  }

  el("text").value = "";
}

/* =============================
   SEND DM
============================= */
async function sendDM(){
  const toUserId = el("dmTo").value;
  if(!toUserId) return;

  const body = (el("text").value || "").trim();
  if(!body) return;

  const myNick = profile?.nick || user.user_metadata?.nick || "Utente";

  let toNick = "";
  for(const k of Object.keys(presenceState)){
    for(const s of presenceState[k]){
      if(s.user_id === toUserId) toNick = s.nick || "";
    }
  }

  const { error } = await supabase.from("direct_messages").insert({
    from_user_id: user.id,
    to_user_id: toUserId,
    nick: myNick,
    to_nick: toNick,
    body
  });

  if(error){
    alert("Errore DM: " + error.message);
    return;
  }

  addMsg({ type:"dm", nick: myNick, to_nick: toNick, body, created_at: new Date().toISOString() });
  el("text").value = "";
}

/* =============================
   VIDEO (Jitsi)
============================= */
function startVideo(){
  if(!room) return;

  const node = el("video");
  node.innerHTML = "";

  if(jitsi){
    try { jitsi.dispose(); } catch(e){}
    jitsi = null;
  }

  jitsi = new JitsiMeetExternalAPI("meet.jit.si",{
    roomName: `VIDEOCHAT26_${room.slug}`,
    parentNode: node,
    lang: "it"
  });
}

/* =============================
   EXIT / LOGOUT
============================= */
async function exitRoom(){
  try{
    if(channel){ supabase.removeChannel(channel); channel = null; }
  }catch(e){}

  try{
    if(jitsi){ jitsi.dispose(); jitsi = null; }
  }catch(e){}

  await supabase.auth.signOut();
  window.location.href = "./index.html";
}

/* =============================
   WIRE UI
============================= */
function wireUI(){
  el("send").onclick = sendPublic;
  el("sendDm").onclick = sendDM;

  el("text").addEventListener("keydown", (e)=>{
    if(e.key === "Enter") sendPublic();
  });

  el("btnVideo").onclick = startVideo;
  el("btnLogout").onclick = exitRoom;
}

/* =============================
   INIT
============================= */
(async function init(){
  const ok = await requireLogin();
  if(!ok) return;

  try{
    await loadRoom(); // ✅ non può più fare "coerce"
  }catch(e){
    alert("Errore stanza: " + (e.message || e));
    return;
  }

  wireUI();
  await loadHistory();
  await joinRealtime();
})();
