import { supabase, el, showAlert, hideAlert, getUser, getMyProfile, logout } from "./app.js";
import { SUPABASE_URL, ROOM_SLUG, ROOM_NAME } from "./config.js";

let user = null;
let profile = null;
let room = { slug: ROOM_SLUG, name: ROOM_NAME }; // stanza unica fissa
let channel = null;
let presenceState = {};
let jitsi = null;

function esc(str){
  return String(str)
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function addMsg({ type="public", nick, body, created_at, to_nick }){
  const div = document.createElement("div");
  div.className = "msg";

  const when = created_at ? new Date(created_at).toLocaleString("it-IT") : "";
  const badge = type === "dm"
    ? ` <span class="pill" style="font-size:11px;">DM → ${esc(to_nick||"")}</span>`
    : "";

  div.innerHTML = `
    <div class="meta"><b>${esc(nick||"—")}</b>${badge} · ${when}</div>
    <div class="bubble">${esc(body||"")}</div>
  `;
  el("messages").appendChild(div);
  el("messages").scrollTop = el("messages").scrollHeight;
}

function renderUsers(){
  const users = [];
  for(const k of Object.keys(presenceState)){
    for(const sess of presenceState[k]){
      users.push(sess);
    }
  }

  // dedup per user_id (in caso di multi-tab)
  const map = new Map();
  for(const u of users){
    map.set(u.user_id, u);
  }
  const list = Array.from(map.values())
    .sort((a,b)=> (a.nick||"").localeCompare(b.nick||"", "it"));

  el("users").innerHTML = list.map(u => `
    <li>
      <span>${esc(u.nick || "—")}</span>
      <span class="pill" style="font-size:11px">${esc(u.gender || "")}</span>
    </li>
  `).join("");

  el("count").textContent = String(list.length);
  el("countPill").textContent = String(list.length);

  // DM select (escludo me)
  const opts = list
    .filter(u => u.user_id !== user.id)
    .map(u => `<option value="${esc(u.user_id)}">${esc(u.nick || "—")}</option>`)
    .join("");

  el("dmTo").innerHTML = opts || `<option value="">(nessun utente)</option>`;
}

async function requireLogin(){
  user = await getUser();
  if(!user){
    window.location.href = "./auth.html";
    return false;
  }
  profile = await getMyProfile(user);

  const nick = profile?.nick || user.user_metadata?.nick || "Utente";
  el("me").textContent = `Ciao, ${nick}`;
  return true;
}

async function joinPresence(){
  // channel realtime con presence
  if(channel) { try { supabase.removeChannel(channel); } catch(e){} }

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
    // pubblico: messages table
    .on("postgres_changes",
      { event:"INSERT", schema:"public", table:"messages", filter:`room_slug=eq.${ROOM_SLUG}` },
      (payload) => addMsg({ ...payload.new, type:"public" })
    )
    // privati: direct_messages dove il destinatario sono io
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

async function loadHistory(){
  // pubblico (se hai già messages con room_id, dimmelo e lo adatto: qui uso room_slug fisso)
  const { data: pub, error: e1 } = await supabase
    .from("messages")
    .select("*")
    .eq("room_slug", ROOM_SLUG)
    .order("created_at", { ascending:true });

  if(!e1 && pub) pub.forEach(m => addMsg({ ...m, type:"public" }));

  // DM ricevuti
  const { data: dm, error: e2 } = await supabase
    .from("direct_messages")
    .select("*")
    .eq("to_user_id", user.id)
    .order("created_at", { ascending:true });

  if(!e2 && dm) dm.forEach(m => addMsg({ ...m, type:"dm" }));
}

async function sendPublic(){
  const body = el("text").value.trim();
  if(!body) return;

  // se vuoi continuare con Edge Function: la lasciamo (ma serve room_id/slug). Qui faccio insert diretto.
  const myNick = profile?.nick || user.user_metadata?.nick || "Utente";

  const { error } = await supabase.from("messages").insert({
    room_slug: ROOM_SLUG,
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

async function sendDM(){
  const to = el("dmTo").value;
  if(!to) return;

  const body = el("text").value.trim();
  if(!body) return;

  const myNick = profile?.nick || user.user_metadata?.nick || "Utente";

  // per mostrare “DM → nick” in UI, mi prendo il nick dal presence state
  let toNick = "";
  for(const k of Object.keys(presenceState)){
    for(const s of presenceState[k]){
      if(s.user_id === to) toNick = s.nick || "";
    }
  }

  const { error } = await supabase.from("direct_messages").insert({
    from_user_id: user.id,
    to_user_id: to,
    nick: myNick,
    to_nick: toNick,
    body
  });

  if(error){
    alert("Errore DM: " + error.message);
    return;
  }

  // mostro anche localmente “DM → …”
  addMsg({ type:"dm", nick: myNick, to_nick: toNick, body, created_at: new Date().toISOString() });
  el("text").value = "";
}

function startVideo(){
  const node = el("video");
  node.innerHTML = "";
  if(jitsi) { try{ jitsi.dispose(); }catch(e){} jitsi=null; }

  jitsi = new JitsiMeetExternalAPI("meet.jit.si",{
    roomName:`VIDEOCHAT26_${ROOM_SLUG}`,
    parentNode: node,
    lang:"it"
  });
}

el("send").onclick = sendPublic;
el("sendDm").onclick = sendDM;
el("text").addEventListener("keydown", (e)=>{ if(e.key==="Enter") sendPublic(); });

el("btnVideo").onclick = startVideo;
el("btnLogout").onclick = async () => {
  try{
    if(channel) supabase.removeChannel(channel);
  }catch(e){}
  await logout();
  window.location.href = "./index.html";
};

(async function init(){
  const ok = await requireLogin();
  if(!ok) return;

  // pulisco chat UI
  el("messages").innerHTML = "";
  addMsg({ nick:"Sistema", body:"Sei entrato nella stanza VIDEOCHAT 26.", created_at:new Date().toISOString(), type:"public" });

  await loadHistory();
  await joinPresence();
})();
