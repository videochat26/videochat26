import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, REDIRECT_BASE } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const el = (id) => document.getElementById(id);

export function showAlert(type, msg){
  const box = el("alert");
  box.style.display = "block";
  box.className = "alert " + (type === "err" ? "err" : "ok");
  box.textContent = msg;
}
export function hideAlert(){
  const box = el("alert");
  box.style.display = "none";
  box.textContent = "";
}

export async function exchangeCodeIfAny(){
  try{
    const url = new URL(window.location.href);
    if(url.searchParams.get("code")){
      await supabase.auth.exchangeCodeForSession(window.location.href);
      url.searchParams.delete("code");
      window.history.replaceState({}, "", url.toString());
    }
  }catch(e){}
}

export async function getUser(){
  const { data } = await supabase.auth.getUser();
  return data.user || null;
}

export async function getMyProfile(user){
  if(!user) return null;
  const { data } = await supabase
    .from("profiles")
    .select("nick, gender")
    .eq("user_id", user.id)
    .maybeSingle();
  return data || null;
}

export async function upsertMyProfile(user, nick, gender){
  const { error } = await supabase.from("profiles").upsert({
    user_id: user.id,
    nick,
    gender
  });
  if(error) throw error;

  // utile per prefill (ma in UI NON mostriamo email)
  try { await supabase.auth.updateUser({ data: { nick, gender } }); } catch(e){}
}

export async function signUpEmail(email, pass, nick, gender){
  const { error } = await supabase.auth.signUp({
    email,
    password: pass,
    options:{
      data: { nick, gender },
      emailRedirectTo: `${REDIRECT_BASE}/auth.html?mode=auth`
    }
  });
  if(error) throw error;
}

export async function signInEmail(email, pass){
  const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
  if(error) throw error;
}

export async function signInGuest(nick, gender){
  // richiede Anonymous enabled
  const { error } = await supabase.auth.signInAnonymously();
  if(error) throw error;

  const user = await getUser();
  if(!user) throw new Error("Sessione ospite non valida");

  await upsertMyProfile(user, nick, gender);
  return user;
}

export async function logout(){
  await supabase.auth.signOut();
}
