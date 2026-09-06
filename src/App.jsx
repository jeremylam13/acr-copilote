import React, { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// ── Numéro de version — à incrémenter à chaque mise à jour déployée.
// Permet de vérifier en un coup d'œil (Réglages) que tous les téléphones
// de l'équipe tournent bien sur la même version après un déploiement.
const APP_VERSION = "2026.08.15-62";

// ── Mode équipe multi-device (sync temps réel via Supabase) ──────────────────
const supabaseUrl = "https://wofxgdobpphsjacfqeky.supabase.co";
const supabaseAnonKey = "sb_publishable_hRxmJi9SIcrRtQUO4dwo0Q_rnXNmDJz";
const supabaseTeam = createClient(supabaseUrl, supabaseAnonKey);

// Alphabet sans caractères ambigus (pas de 0/O, 1/I/L) — facile à lire à voix haute
// et à taper, tout en donnant ~700 millions de combinaisons possibles (vs 900 000
// pour un code à 6 chiffres), pour rendre le devinage d'une session active
// pratiquement impossible si l'app est diffusée à grande échelle.
const SESSION_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function genSessionCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += SESSION_CODE_ALPHABET[Math.floor(Math.random() * SESSION_CODE_ALPHABET.length)];
  return code;
}
function qrUrl(code) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(code)}`;
}

// Fusionne deux chronologies sans perdre d'entrées ajoutées en parallèle sur un autre device
function mergeEvents(localList, remoteList) {
  const key = e => `${e.id}|${e.time}|${e.label}`;
  const map = new Map();
  [...(localList || []), ...(remoteList || [])].forEach(e => map.set(key(e), e));
  const merged = [...map.values()].sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  // Déduplication supplémentaire pour les gestes à dose unique (adrénaline, cordarone) :
  // en mode équipe, deux membres peuvent chacun taper le bouton sur leur téléphone
  // pour la même administration réelle. Si deux entrées du même type tombent à
  // quelques secondes d'intervalle (fenêtre ci-dessous), on ne garde que la première
  // — ça évite un double comptage (décompte adrénaline relancé deux fois, etc.)
  // sans jamais fusionner deux doses réellement espacées dans le temps.
  const DEDUP_WINDOW_SEC = 90; // très inférieur à l'intervalle mini entre 2 doses réelles
  const DEDUP_IDS = ["adr", "cord", "cord300", "cord150"];
  const kept = [];
  merged.forEach(e => {
    if (!DEDUP_IDS.includes(e.id)) { kept.push(e); return; }
    const isDuplicate = kept.some(k => k.id === e.id && Math.abs((k.sec ?? 0) - (e.sec ?? 0)) <= DEDUP_WINDOW_SEC);
    if (!isDuplicate) kept.push(e);
  });
  return kept;
}

// Hook de synchronisation d'équipe multi-device (édition collaborative, dernier écrit gagne
// sauf pour la chronologie qui est fusionnée pour ne perdre aucun événement)
function useTeamSync({ events, setEvents, acrTime, setAcrTime, noFlowMin, setNoFlowMin,
  lowFlowMin, setLowFlowMin, trans, setTrans }) {
  const [teamCode, setTeamCode] = useState("");
  const [teamConnected, setTeamConnected] = useState(false);
  const [teamDeviceCount, setTeamDeviceCount] = useState(1);
  // Suivi de synchronisation : "idle" (rien à synchroniser) | "syncing" (envoi en
  // cours) | "synced" (dernier envoi réussi) | "error" (échec — réseau instable)
  const [syncStatus, setSyncStatus] = useState("idle");
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const channelRef = useRef(null);
  const pushTimerRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const lastPushedRef = useRef("");

  const buildState = () => ({ events, acrTime, noFlowMin, lowFlowMin, trans });

  const applyRemote = (remote) => {
    if (!remote) return;
    applyingRemoteRef.current = true;
    if (remote.events) setEvents(prev => mergeEvents(prev, remote.events));
    if (remote.acrTime !== undefined) setAcrTime(v => remote.acrTime || v);
    if (remote.noFlowMin !== undefined) setNoFlowMin(v => remote.noFlowMin || v);
    if (remote.lowFlowMin !== undefined) setLowFlowMin(v => remote.lowFlowMin || v);
    if (remote.trans) setTrans(prev => ({ ...prev, ...remote.trans }));
    setTimeout(() => { applyingRemoteRef.current = false; }, 50);
    // Une mise à jour reçue confirme que la liaison est bien active
    setLastSyncedAt(Date.now());
    setSyncStatus("synced");
  };

  const subscribeToCode = (code) => {
    if (channelRef.current) supabaseTeam.removeChannel(channelRef.current);
    const channel = supabaseTeam.channel(`acr_session_${code}`, {
      config: { presence: { key: Math.random().toString(36).slice(2) } },
    });
    channel.on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "acr_team_sessions", filter: `code=eq.${code}` },
      (payload) => applyRemote(payload.new?.state)
    );
    channel.on("presence", { event: "sync" }, () => {
      setTeamDeviceCount(Object.keys(channel.presenceState()).length || 1);
    });
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        setTeamConnected(true);
        setSyncStatus("synced");
        setLastSyncedAt(Date.now());
        await channel.track({ joined_at: Date.now() });
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setSyncStatus("error");
      }
    });
    channelRef.current = channel;
  };

  const startSession = async () => {
    const code = genSessionCode();
    await supabaseTeam.from("acr_team_sessions")
      .upsert({ code, state: buildState(), updated_at: new Date().toISOString() });
    setTeamCode(code);
    subscribeToCode(code);
    return code;
  };

  const joinSession = async (code) => {
    const { data, error } = await supabaseTeam.from("acr_team_sessions")
      .select("state").eq("code", code).maybeSingle();
    if (error || !data) return { ok: false, error: "Code introuvable" };
    applyRemote(data.state);
    setTeamCode(code);
    subscribeToCode(code);
    return { ok: true };
  };

  const disconnect = () => {
    if (channelRef.current) { supabaseTeam.removeChannel(channelRef.current); channelRef.current = null; }
    setTeamConnected(false); setTeamCode(""); setTeamDeviceCount(1);
    setSyncStatus("idle"); setLastSyncedAt(null);
  };

  useEffect(() => {
    if (!teamConnected || !teamCode || applyingRemoteRef.current) return;
    const snapshot = JSON.stringify(buildState());
    if (snapshot === lastPushedRef.current) return;
    setSyncStatus("syncing");
    clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      lastPushedRef.current = snapshot;
      supabaseTeam.from("acr_team_sessions")
        .upsert({ code: teamCode, state: buildState(), updated_at: new Date().toISOString() })
        .then(({ error }) => {
          if (error) { setSyncStatus("error"); return; }
          setSyncStatus("synced");
          setLastSyncedAt(Date.now());
        })
        .catch(() => setSyncStatus("error"));
    }, 700);
    return () => clearTimeout(pushTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, acrTime, noFlowMin, lowFlowMin, trans, teamConnected, teamCode]);

  useEffect(() => () => { if (channelRef.current) supabaseTeam.removeChannel(channelRef.current); }, []);

  return { teamCode, teamConnected, teamDeviceCount, syncStatus, lastSyncedAt, startSession, joinSession, disconnect };
}


// ── Error Boundary — filet de sécurité global ──────────────────────────────
// Si un composant plante, l'app reste debout et les données localStorage
// sont préservées (le médecin peut recharger sans perdre son dossier).
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) {
    this.setState({ info });
    try { console.error("[Copilote ACR] Erreur capturée :", error, info); } catch {}
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    const sans = "'Inter','system-ui',sans-serif";
    return (
      <div style={{ minHeight:"100vh", background:"#0A111B", display:"flex",
        flexDirection:"column", alignItems:"center", justifyContent:"center",
        padding:"24px", fontFamily:sans, textAlign:"center" }}>
        <div style={{ fontSize:52, marginBottom:16 }}>⚠️</div>
        <p style={{ margin:"0 0 6px", fontSize:11, fontWeight:700, color:"#FC8181",
          textTransform:"uppercase", letterSpacing:"0.15em" }}>
          Copilote ACR — Erreur inattendue
        </p>
        <p style={{ margin:"0 0 24px", fontSize:20, fontWeight:800, color:"#fff" }}>
          L'application a rencontré un problème
        </p>
        <p style={{ margin:"0 0 32px", fontSize:14, color:"rgba(255,255,255,0.6)",
          maxWidth:320, lineHeight:1.6 }}>
          Vos données de réanimation sont préservées.{"\n"}
          Rechargez l'app pour continuer — vous retrouverez votre session.
        </p>
        <button onClick={() => window.location.reload()}
          style={{ background:"linear-gradient(135deg,#E53E3E,#9B2C2C)", border:"none",
            borderRadius:14, color:"#fff", fontSize:16, fontWeight:700,
            padding:"16px 40px", cursor:"pointer", marginBottom:16 }}>
          🔄 Recharger l'application
        </button>
        <button onClick={() => this.setState({ hasError:false, error:null, info:null })}
          style={{ background:"transparent", border:"1px solid rgba(255,255,255,0.2)",
            borderRadius:14, color:"rgba(255,255,255,0.6)", fontSize:13,
            padding:"10px 24px", cursor:"pointer" }}>
          Essayer sans recharger
        </button>
        {this.state.error && (
          <details style={{ marginTop:24, color:"rgba(255,255,255,0.3)",
            fontSize:11, fontFamily:"monospace", maxWidth:360, wordBreak:"break-all" }}>
            <summary style={{ cursor:"pointer" }}>Détails techniques</summary>
            <p style={{ margin:"8px 0 0" }}>{String(this.state.error)}</p>
          </details>
        )}
      </div>
    );
  }
}

const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700;800&family=Archivo:wght@700;800;900&display=swap";
document.head.appendChild(fontLink);

const styleSheet = document.createElement("style");
styleSheet.textContent = `
  /* ===== THÈME NUIT (urgentiste, défaut) ===== */
  :root, .acr-night {
    --acr-bg:#070A10; --acr-surface:#121925; --acr-surfaceAlt:#1A2331;
    --acr-border:#28313F; --acr-borderSoft:#1E2735;
    --acr-text:#F4F8FE; --acr-textMid:#AAB8CA; --acr-textSoft:#8595AB;
    --acr-blue:#3B82F6; --acr-blueSoft:#15233C; --acr-blueText:#7DB0FF;
    --acr-rose:#FF3B47; --acr-roseSoft:#2C1418; --acr-roseText:#FF8A91;
    --acr-amber:#FFB020; --acr-amberSoft:#2A2110; --acr-amberText:#FFC966;
    --acr-green:#22D67B; --acr-greenSoft:#0F2A1C; --acr-greenText:#62E3A2;
    --acr-violet:#9D6BFF; --acr-violetSoft:#1F1733; --acr-violetText:#C4A8FF;
    --acr-slate:#7689A0; --acr-slateSoft:#1A2330; --acr-slateText:#AFBDD0;
    --acr-teal:#19B8A6; --acr-tealSoft:#0E2624; --acr-tealText:#5FD8CC;
  }
  /* ===== THÈME JOUR (haut contraste plein soleil) ===== */
  .acr-day {
    --acr-bg:#E9EEF5; --acr-surface:#FFFFFF; --acr-surfaceAlt:#F1F5FA;
    --acr-border:#C5CFDD; --acr-borderSoft:#E2E8F1;
    --acr-text:#0A111B; --acr-textMid:#46566F; --acr-textSoft:#76869E;
    --acr-blue:#1361DE; --acr-blueSoft:#E7F0FD; --acr-blueText:#0B43A0;
    --acr-rose:#DE1019; --acr-roseSoft:#FDEAEB; --acr-roseText:#A50710;
    --acr-amber:#B67100; --acr-amberSoft:#FBF3E2; --acr-amberText:#8A5500;
    --acr-green:#0C9A54; --acr-greenSoft:#E6F7EE; --acr-greenText:#06713C;
    --acr-violet:#6433C9; --acr-violetSoft:#F0EBFB; --acr-violetText:#491F9C;
    --acr-slate:#54657C; --acr-slateSoft:#EEF2F7; --acr-slateText:#3A4858;
    --acr-teal:#0C7B70; --acr-tealSoft:#E4F4F2; --acr-tealText:#085A52;
  }
  body { background:var(--acr-bg); transition:background .2s; }
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02); box-shadow: 0 8px 28px rgba(255,59,71,0.6); }
  }
  @keyframes acrConfirmIn {
    0% { opacity:0; transform: translate(-50%, 12px) scale(0.96); }
    12% { opacity:1; transform: translate(-50%, 0) scale(1); }
    82% { opacity:1; transform: translate(-50%, 0) scale(1); }
    100% { opacity:0; transform: translate(-50%, 6px) scale(0.98); }
  }
  @media print {
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body { background: #fff !important; }
    .acr-no-print { display: none !important; }
    .acr-pdfview {
      position: static !important;
      overflow: visible !important;
      z-index: auto !important;
    }
    .acr-pdfview-header {
      position: static !important;
      box-shadow: none !important;
      border-bottom: 1px solid #ddd !important;
    }
  }
`;
document.head.appendChild(styleSheet);
// thème par défaut (nuit) appliqué tôt pour éviter le flash blanc
try { if (!document.body.className.includes("acr-")) document.body.classList.add("acr-night"); } catch(e){}

const P = {
  bg:"var(--acr-bg)", surface:"var(--acr-surface)", surfaceAlt:"var(--acr-surfaceAlt)",
  border:"var(--acr-border)", borderSoft:"var(--acr-borderSoft)",
  text:"var(--acr-text)", textMid:"var(--acr-textMid)", textSoft:"var(--acr-textSoft)",
  blue:"var(--acr-blue)", blueSoft:"var(--acr-blueSoft)", blueText:"var(--acr-blueText)",
  rose:"var(--acr-rose)", roseSoft:"var(--acr-roseSoft)", roseText:"var(--acr-roseText)",
  amber:"var(--acr-amber)", amberSoft:"var(--acr-amberSoft)", amberText:"var(--acr-amberText)",
  green:"var(--acr-green)", greenSoft:"var(--acr-greenSoft)", greenText:"var(--acr-greenText)",
  violet:"var(--acr-violet)", violetSoft:"var(--acr-violetSoft)", violetText:"var(--acr-violetText)",
  slate:"var(--acr-slate)", slateSoft:"var(--acr-slateSoft)", slateText:"var(--acr-slateText)",
  teal:"var(--acr-teal)", tealSoft:"var(--acr-tealSoft)", tealText:"var(--acr-tealText)",
};
const sans = "'Inter', system-ui, sans-serif";
const mono = "'JetBrains Mono', ui-monospace, monospace";
const disp = "'Archivo', 'Inter', system-ui, sans-serif";

const getNow = () => new Date().toTimeString().slice(0, 5);
const fmtSec = s => `${Math.floor(s/60).toString().padStart(2,"0")}:${(s%60).toString().padStart(2,"0")}`;

// Formate le délai écoulé depuis la dernière synchro d'équipe ("à l'instant", "12s", "3 min")
function fmtSyncAge(lastSyncedAt) {
  if (!lastSyncedAt) return null;
  const s = Math.round((Date.now() - lastSyncedAt) / 1000);
  if (s < 5) return "à l'instant";
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)} min`;
}

// Petit badge de tendance (↑/↓) comparant une valeur en cours de saisie à la
// dernière mesure enregistrée — affiché en overlay sur un champ de saisie.
function TrendBadge({ current, last, P, goodDir }) {
  const c = parseFloat(String(current).replace(",", "."));
  const l = parseFloat(String(last).replace(",", "."));
  if (isNaN(c) || isNaN(l) || c === l) return null;
  const diff = c - l;
  const up = diff > 0;
  // goodDir : "up" si une hausse est plutôt rassurante (ex: TA, EtCO₂), "down" si une baisse l'est (ex: FC)
  const color = !goodDir ? P.textMid : (goodDir === "up" ? (up ? P.green : P.rose) : (up ? P.rose : P.green));
  return (
    <span style={{ position:"absolute", top:-6, right:-4, background:color, color:"#fff", borderRadius:6,
      fontSize:9, fontWeight:800, padding:"1px 4px", boxShadow:"0 1px 3px rgba(0,0,0,0.25)", zIndex:1,
      fontFamily:"monospace", whiteSpace:"nowrap" }}>
      {up ? "↑" : "↓"} {up ? "+" : ""}{Number.isInteger(diff) ? diff : diff.toFixed(1)}
    </span>
  );
}

// ── Reconnaissance vocale ─────────────────────────────────────────────────────
const SpeechRecognitionAPI = typeof window !== "undefined"
  ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
  : null;

// Normalise le texte pour la reconnaissance (supprime accents, minuscules)
function normalizeVoice(txt) {
  return txt.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
}

// Convertit un mot-nombre français en entier
function parseFrNumber(txt) {
  const map = {
    zero:0,un:1,une:1,deux:2,trois:3,quatre:4,cinq:5,six:6,sept:7,huit:8,neuf:9,
    dix:10,onze:11,douze:12,treize:13,quatorze:14,quinze:15,seize:16,
    "dix sept":17,"dix huit":18,"dix neuf":19,vingt:20,
    "vingt et un":21,"vingt deux":22,"vingt trois":23,"vingt quatre":24,
    "vingt cinq":25,"vingt six":26,"vingt sept":27,"vingt huit":28,"vingt neuf":29,
    trente:30,"trente et un":31,"trente cinq":35,quarante:40,cinquante:50,soixante:60,
  };
  const norm = normalizeVoice(txt);
  const digit = norm.match(/\d+/);
  if (digit) return parseInt(digit[0]);
  for (const [w, n] of Object.entries(map)) {
    if (norm.includes(w)) return n;
  }
  return null;
}

// Détecte si une phrase captée est une QUESTION (mot interrogatif) plutôt qu'un ORDRE.
// Testé en tout premier dans le pipeline vocal, avant toute liste de commandes —
// garantit qu'une question ("combien d'adrénaline ?") ne peut jamais être interprétée
// comme une action ("adrénaline" → log d'une nouvelle dose).
function isVoiceQuestion(n) {
  return /\b(combien|depuis quand|depuis combien|a combien|quel est|quelle est|quels sont|quelles sont|y a t il|ya t il)\b/.test(n);
}

// Formate une durée en secondes en texte parlé "X minutes Y secondes"
function speakDuration(totalSec) {
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  if (m <= 0) return `${s} secondes`;
  return `${m} minute${m>1?"s":""}${s>0?` ${s} seconde${s>1?"s":""}`:""}`;
}

// Construit l'expression de détection du mot-code vocal. Conserve la tolérance
// historique "co pilote" (en 2 mots) pour le mot-code par défaut, car la
// reconnaissance vocale le coupe parfois ainsi — cette tolérance spécifique
// n'est pas généralisable à un mot personnalisé choisi par l'utilisateur.
function buildWakeWordRegex(word) {
  const w = normalizeVoice(word || "").trim() || "copilote";
  if (w === "copilote") return /\bco\s?pilote\b/;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`);
}

// Lit une réponse à voix haute (mains libres, pas besoin de regarder l'écran)
function speakFr(text) {
  try {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // interrompt une lecture précédente en cours
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  } catch(e) {}
}

// Chronomètre basé sur l'HORLOGE RÉELLE (pas un compteur de ticks).
// → Continue de tourner juste même si l'app passe en arrière-plan (où les
//   intervalles JS sont ralentis/suspendus). Se recale au retour au 1er plan.
function useTimer(active) {
  const [s, setS] = useState(0);
  const sRef     = useRef(0);     // valeur affichée (toujours à jour)
  const baseRef  = useRef(0);     // secondes cumulées avant le segment courant
  const startRef = useRef(null);  // Date.now() au démarrage du segment courant
  const activeRef = useRef(active);
  sRef.current = s;

  // Setter externe (restauration / remise à zéro) : ré-ancre l'horloge
  const setExternal = (val) => {
    setS(prev => {
      const next = typeof val === "function" ? val(prev) : val;
      baseRef.current = next;
      startRef.current = activeRef.current ? Date.now() : null;
      sRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    activeRef.current = active;
    if (active) {
      // démarrage / reprise : on ancre sur l'heure courante
      baseRef.current = sRef.current;
      startRef.current = Date.now();
    } else if (startRef.current != null) {
      // pause : on fige la valeur réelle écoulée
      const frozen = baseRef.current + Math.floor((Date.now() - startRef.current) / 1000);
      baseRef.current = frozen;
      startRef.current = null;
      setS(frozen);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const recompute = () => {
      if (startRef.current == null) return;
      setS(baseRef.current + Math.floor((Date.now() - startRef.current) / 1000));
    };
    const id = setInterval(recompute, 500); // 500 ms : affichage fluide
    const onVis = () => { if (!document.hidden) recompute(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", recompute);
    window.addEventListener("pageshow", recompute);
    recompute(); // recale immédiatement
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", recompute);
      window.removeEventListener("pageshow", recompute);
    };
  }, [active]);

  return [s, setExternal];
}

function calcAge(ddn) {
  if (!ddn) return "";
  const naissance = new Date(ddn);
  if (isNaN(naissance)) return "";
  const today = new Date();
  let ans = today.getFullYear() - naissance.getFullYear();
  const moisDiff = today.getMonth() - naissance.getMonth();
  if (moisDiff < 0 || (moisDiff === 0 && today.getDate() < naissance.getDate())) ans--;
  if (ans < 0) return "";
  if (ans === 0) {
    const mois = today.getMonth() - naissance.getMonth() +
      (today.getDate() < naissance.getDate() ? -1 : 0) +
      (today.getMonth() < naissance.getMonth() ? 12 : 0);
    return mois <= 0 ? "< 1 mois" : `${mois} mois`;
  }
  return `${ans} ans`;
}

// ── PERSISTANCE LOCALE ─────────────────────────────────────────────────────────
function useLocalState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : initialValue;
    } catch { return initialValue; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch {}
  }, [key, value]);
  return [value, setValue];
}

function clearSession(prefix) {
  try {
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    });
  } catch {}
}

// ── ARCHIVES LOCALES DES ARRÊTS ────────────────────────────────────────────────
const ARCHIVE_KEY = "acr_archives";
const ARCHIVE_CAP = 200; // au-delà, prévenir plutôt que supprimer silencieusement (voir Dashboard)

// Réduit nom/prénom à leurs initiales ("Dupont Jean" → "D.J.") — utilisé pour
// l'affichage dashboard et systématiquement dans les exports de sauvegarde,
// qui peuvent quitter l'appareil (données médicales, minimisation RGPD).
function initials(nom, prenom) {
  const n = (nom || "").trim();
  const p = (prenom || "").trim();
  if (!n && !p) return null;
  return `${n ? n[0].toUpperCase()+"." : ""}${p ? p[0].toUpperCase()+"." : ""}`;
}

function loadArchives() {
  try { return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]"); }
  catch { return []; }
}
function saveArchive(snapshot) {
  try {
    const list = loadArchives();
    list.unshift(snapshot);                 // plus récent en tête
    const capped = list.slice(0, ARCHIVE_CAP);
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(capped));
    return capped;
  } catch { return loadArchives(); }
}
function deleteArchive(key) {
  try {
    const list = loadArchives().filter(a => a.key !== key);
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list));
    return list;
  } catch { return loadArchives(); }
}
function clearArchives() {
  try { localStorage.removeItem(ARCHIVE_KEY); } catch {}
  return [];
}

// ── SAUVEGARDE COMPLÈTE (export / import) ──────────────────────────────────
// Toutes les clés de l'app sont préfixées "acr_" — on exporte/importe tout ce
// périmètre en un seul fichier JSON, pour changer de téléphone ou se prémunir
// d'une perte de données (nettoyage accidentel, mise à jour d'OS, casse...).
// Réduit nom/prénom aux initiales dans une archive avant export — le fichier
// exporté peut quitter l'appareil (email, cloud), donc on y est strict même
// si le nom complet reste consultable dans le détail d'un cas sur ce téléphone.
function redactArchiveForExport(a) {
  if (!a) return a;
  const pat = a.props?.patient;
  if (!pat || (!pat.nom && !pat.prenom)) return a;
  const init = initials(pat.nom, pat.prenom);
  return {
    ...a,
    label: init || a.label,
    props: {
      ...a.props,
      patient: { ...pat, nom: pat.nom ? pat.nom[0].toUpperCase()+"." : pat.nom,
        prenom: pat.prenom ? pat.prenom[0].toUpperCase()+"." : pat.prenom },
    },
  };
}

function exportBackup() {
  const data = {};
  Object.keys(localStorage).forEach(k => {
    if (!k.startsWith("acr_")) return;
    const raw = localStorage.getItem(k);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    if (k === ARCHIVE_KEY && Array.isArray(parsed)) {
      parsed = parsed.map(redactArchiveForExport);
    }
    data[k] = parsed;
  });
  const payload = {
    app: "Copilote ACR",
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    note: "Noms/prénoms réduits aux initiales dans ce fichier (minimisation des données médicales).",
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `copilote-acr-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Importe un fichier de sauvegarde. Les archives sont FUSIONNÉES (dédupliquées
// par clé, plafonnées à 50) pour ne jamais perdre de cas en écrasant par erreur ;
// les réglages et sessions en cours sont, eux, remplacés par le contenu importé.
function importBackup(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const payload = JSON.parse(e.target.result);
        if (!payload || typeof payload.data !== "object") throw new Error("format invalide");
        Object.entries(payload.data).forEach(([k, v]) => {
          if (!k.startsWith("acr_")) return; // jamais en dehors du périmètre de l'app
          if (k === ARCHIVE_KEY) return; // traité séparément ci-dessous (fusion)
          localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
        });
        if (Array.isArray(payload.data[ARCHIVE_KEY])) {
          const current = loadArchives();
          const merged = new Map();
          [...payload.data[ARCHIVE_KEY], ...current].forEach(a => { if (a && a.key) merged.set(a.key, a); });
          const list = [...merged.values()].sort((a, b) => (b.key || 0) - (a.key || 0)).slice(0, ARCHIVE_CAP);
          localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list));
        }
        resolve({ ok: true });
      } catch (err) {
        resolve({ ok: false, error: "Fichier invalide ou corrompu" });
      }
    };
    reader.onerror = () => resolve({ ok: false, error: "Impossible de lire le fichier" });
    reader.readAsText(file);
  });
}


// ── WAKE LOCK : empêche le verrouillage écran ──────────────────────────────────
function useWakeLock(active) {
  useEffect(() => {
    if (!active) return;
    let wakeLock = null;
    let cancelled = false;

    const request = async () => {
      try {
        if ("wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch (e) { /* utilisateur refuse ou non supporté */ }
    };

    const handleVisibility = () => {
      if (!cancelled && document.visibilityState === "visible" && active) request();
    };

    request();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      if (wakeLock) { try { wakeLock.release(); } catch {} }
    };
  }, [active]);
}

// ── ALARME SONORE (Web Audio API) ──────────────────────────────────────────────
// IMPORTANT : sur iPhone, le bouton silencieux physique coupe le son du Web Audio.
// Aucune app web ne peut le contourner (seule une app native le peut). Sur Android,
// le son passe sur le canal média et joue même sonnerie coupée. La vibration ne
// fonctionne pas sur iOS Safari. → l'alarme VISUELLE plein écran reste le filet
// de sécurité fiable sur tous les appareils.
let _acrAudioCtx = null;
function getAudioCtx() {
  try {
    if (!_acrAudioCtx) _acrAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_acrAudioCtx && _acrAudioCtx.state === "suspended") _acrAudioCtx.resume().catch(() => {});
  } catch {}
  return _acrAudioCtx;
}
// À appeler sur un geste utilisateur pour « déverrouiller » l'audio (iOS).
function unlockAudio() { try { getAudioCtx(); } catch {} }

let _acrAlarmTimer = null;
let _acrAlarmCount = 0;
function _acrBeep() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    // Double bip perçant (onde carrée = plus fort qu'une sinusoïde)
    [0, 0.28].forEach(t => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.value = 880;
      const s = ctx.currentTime + t;
      gain.gain.setValueAtTime(0, s);
      gain.gain.linearRampToValueAtTime(0.5, s + 0.02);
      gain.gain.linearRampToValueAtTime(0, s + 0.24);
      osc.start(s); osc.stop(s + 0.26);
    });
  } catch {}
  try { if ("vibrate" in navigator) navigator.vibrate([300, 150, 300]); } catch {}
}

// ── Bip changement de cycle (double bip grave, distinct de l'alarme) ──────────
function playCycleBip() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const play = (t, freq, dur) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur + 0.01);
    };
    const t = ctx.currentTime;
    play(t,       523, 0.08); // C5
    play(t + 0.14, 659, 0.08); // E5
    try { if ("vibrate" in navigator) navigator.vibrate([40, 60, 40]); } catch {}
  } catch {}
}

// ── Tick métronome CPR 100 bpm (tick court aigu) ─────────────────────────────
// Note : cette fonction a été retirée du flux pédiatrique (elle faisait doublon
// avec le scheduler Web Audio lookahead, causant un effet de double bip). Le
// métronome des deux modules passe désormais uniquement par ce scheduler.

// Démarre l'alarme en boucle jusqu'à acquittement (plafond ~30 s de sécurité).
function startAlarm() {
  stopAlarm();
  _acrAlarmCount = 0;
  _acrBeep();
  _acrAlarmTimer = setInterval(() => {
    _acrAlarmCount += 1;
    if (_acrAlarmCount > 20) { stopAlarm(); return; } // sécurité : ~30 s max
    _acrBeep();
  }, 1500);
}
function stopAlarm() {
  if (_acrAlarmTimer) { clearInterval(_acrAlarmTimer); _acrAlarmTimer = null; }
  try { if ("vibrate" in navigator) navigator.vibrate(0); } catch {}
}

// ── COMPOSANT TIMER ADRÉNALINE (option C : discret puis impossible à manquer) ──
function AdrenalineTimer({ startSec, intervalMin, setIntervalMin, onAdminister, onCancel, running, P, mono, sans, fmtSec }) {
  // startSec = valeur de `sec` au moment où l'adré a été donnée
  // intervalMin = 3 / 4 / 5
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // recalcule à chaque tick : combien de secondes depuis la dose
  // mais on ne dispose pas de `sec` ici directement — donc on utilise un timestamp absolu
  // → on calcule différemment : `secAtStart` = timestamp absolu de la dose
  const elapsed = Math.floor((now - startSec) / 1000);
  const total = intervalMin * 60;
  const remaining = Math.max(0, total - elapsed);
  const expired = elapsed >= total;
  const [played, setPlayed] = useState(false);

  useEffect(() => {
    if (expired && !played) {
      startAlarm();
      setPlayed(true);
    }
  }, [expired, played]);
  // Arrêt de l'alarme si le timer n'est plus expiré (reset) ou au démontage
  useEffect(() => {
    if (!expired) stopAlarm();
    return () => stopAlarm();
  }, [expired]);
  const ack = (fn) => () => { stopAlarm(); fn && fn(); };

  if (!expired) {
    // Mode DISCRET : petite chip en haut à droite
    return (
      <div style={{
        position:"sticky", top:0, zIndex:8,
        display:"flex", justifyContent:"flex-end", padding:"4px 0",
        pointerEvents:"none",
      }}>
        <div style={{
          background:P.rose+"15", border:`1px solid color-mix(in srgb, ${P.rose} 27%, transparent)`, borderRadius:99,
          padding:"4px 10px", display:"flex", alignItems:"center", gap:6,
          pointerEvents:"auto", boxShadow:"0 1px 4px rgba(0,0,0,0.06)",
        }}>
          <span style={{ fontSize:11, color:P.roseText, fontFamily:mono, fontWeight:600 }}>
            ⏱ Prochaine adré
          </span>
          <span style={{ fontSize:13, color:P.roseText, fontFamily:mono, fontWeight:700 }}>
            {fmtSec(remaining)}
          </span>
          <span style={{ fontSize:10, color:P.roseText, fontFamily:mono, opacity:0.7 }}>
            ({intervalMin} min)
          </span>
          <button onClick={onCancel}
            style={{ background:"transparent", border:"none", color:P.roseText,
              fontSize:13, cursor:"pointer", padding:"0 2px", lineHeight:1, opacity:0.6 }}>×</button>
        </div>
      </div>
    );
  }

  // Mode ALERTE : gros bandeau orange clignotant
  return (
    <div style={{
      position:"sticky", top:0, zIndex:9,
      animation:"pulse 1.2s ease-in-out infinite",
      background:`linear-gradient(135deg, ${P.rose}, #C53030)`,
      borderRadius:14, padding:"12px 16px", margin:"0 0 10px",
      boxShadow:`0 6px 20px color-mix(in srgb, ${P.rose} 33%, transparent)`,
      display:"flex", alignItems:"center", gap:10,
    }}>
      <span style={{ fontSize:28 }}>💉</span>
      <div style={{ flex:1, minWidth:0 }}>
        <p style={{ margin:0, fontSize:14, fontWeight:700, color:"#fff" }}>
          Adrénaline 1 mg recommandée
        </p>
        <p style={{ margin:0, fontSize:11, color:"rgba(255,255,255,0.85)" }}>
          {intervalMin} min écoulées depuis la précédente
        </p>
      </div>
      <button onClick={ack(onAdminister)}
        style={{
          background:"#fff", border:"none", borderRadius:9,
          padding:"8px 14px", fontSize:13, fontWeight:700,
          color:P.roseText, cursor:"pointer", fontFamily:sans,
          boxShadow:"0 2px 8px rgba(0,0,0,0.15)",
        }}>
        Administrer
      </button>
      <button onClick={ack(onCancel)}
        style={{ background:"transparent", border:"none", color:"#fff",
          fontSize:18, cursor:"pointer", padding:"4px 6px", lineHeight:1 }}>×</button>
    </div>
  );
}

// ── ICÔNES SVG MÉDICALES ──────────────────────────────────────────────────────

const ICONS = {
  rythme: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,20 8,20 11,10 14,30 17,14 20,26 23,20 38,20" />
    </svg>
  ),
  fvtv: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,20 6,20 8,12 10,28 12,8 14,32 16,14 18,26 20,18 22,22 24,10 26,30 28,16 30,24 32,20 38,20" />
    </svg>
  ),
  asystolie: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="20" x2="36" y2="20" />
      <path d="M4,28 C8,28 8,24 12,24 C16,24 16,28 20,28 C24,28 24,24 28,24 C32,24 32,28 36,28" strokeWidth="1" opacity="0.3" />
    </svg>
  ),
  aesp: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4,20 10,20 13,14 16,26 19,20 26,20" />
      <line x1="26" y1="20" x2="36" y2="20" />
      <circle cx="20" cy="20" r="8" strokeDasharray="3,3" strokeWidth="1.5" />
    </svg>
  ),
  choc: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20,6 L14,20 L19,20 L13,34 L26,18 L21,18 Z" />
      <path d="M8,12 C4,16 4,24 8,28" strokeWidth="1.5" />
      <path d="M32,12 C36,16 36,24 32,28" strokeWidth="1.5" />
    </svg>
  ),
  doublechoc: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12,4 L7,17 L11,17 L6,30 L17,15 L13,15 Z" />
      <path d="M28,4 L23,17 L27,17 L22,30 L33,15 L29,15 Z" />
    </svg>
  ),
  racs: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20,34 C20,34 6,24 6,15 C6,10 10,6 15,6 C17,6 19,7 20,9 C21,7 23,6 25,6 C30,6 34,10 34,15 C34,24 20,34 20,34 Z" />
      <polyline points="12,20 15,14 18,22 21,16 24,20 28,20" strokeWidth="1.5" />
    </svg>
  ),
  vvp: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14,4 L26,4 C28,4 30,6 30,8 L30,22 C30,26 26,28 20,28 C14,28 10,26 10,22 L10,8 C10,6 12,4 14,4 Z" />
      <line x1="20" y1="4" x2="20" y2="1" />
      <circle cx="20" cy="1" r="1.5" />
      <path d="M11,16 C13,15 17,14 20,14 C23,14 27,15 29,16" strokeWidth="1" opacity="0.4" />
      <line x1="20" y1="28" x2="20" y2="33" />
      <rect x="17" y="32" width="6" height="3" rx="1.5" />
      <line x1="20" y1="35" x2="20" y2="38" />
      <circle cx="20" cy="38" r="1.5" />
    </svg>
  ),
  vio: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18,6 C20,6 23,7 23,10 C23,12 21,13 20,14 L20,28 C21,29 23,30 23,32 C23,35 20,36 18,36 C16,36 13,35 13,32 C13,30 15,29 16,28 L16,14 C15,13 13,12 13,10 C13,7 16,6 18,6 Z" />
      <line x1="23" y1="20" x2="35" y2="14" strokeWidth="2.5" />
      <path d="M35,14 L32,12 L33,16 Z" fill="currentColor" stroke="none" />
      <rect x="26" y="16" width="5" height="3" rx="1" />
    </svg>
  ),
  adr: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* corps seringue pré-remplie */}
      <rect x="8" y="15" width="22" height="10" rx="3" />
      {/* aiguille */}
      <line x1="30" y1="20" x2="38" y2="20" />
      {/* embase */}
      <rect x="5" y="14" width="4" height="12" rx="1" />
      {/* piston */}
      <rect x="2" y="16" width="4" height="8" rx="1" />
      <line x1="4" y1="16" x2="4" y2="24" strokeWidth="1" />
      {/* graduations */}
      <line x1="14" y1="15" x2="14" y2="25" strokeWidth="1" opacity="0.4" />
      <line x1="19" y1="15" x2="19" y2="25" strokeWidth="1" opacity="0.4" />
      <line x1="24" y1="15" x2="24" y2="25" strokeWidth="1" opacity="0.4" />
      {/* label */}
      <text x="19" y="13" fontSize="5" textAnchor="middle" fontFamily="'DM Mono', monospace" fill="currentColor" stroke="none" fontWeight="600">1 mg</text>
    </svg>
  ),
  amio: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="16" width="22" height="8" rx="2" />
      <line x1="30" y1="20" x2="37" y2="20" />
      <rect x="5" y="15" width="4" height="10" rx="1" />
      <line x1="14" y1="16" x2="14" y2="24" strokeWidth="1" opacity="0.5" />
      <line x1="19" y1="16" x2="19" y2="24" strokeWidth="1" opacity="0.5" />
      <line x1="24" y1="16" x2="24" y2="24" strokeWidth="1" opacity="0.5" />
      <text x="19" y="14" fontSize="5" textAnchor="middle" fontFamily="'DM Mono', monospace" fill="currentColor" stroke="none" fontWeight="500">AMIO</text>
    </svg>
  ),
  planche: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8,18 L8,10 C8,7 11,5 14,5 L26,5 C29,5 32,7 32,10 L32,18" />
      <rect x="16" y="5" width="8" height="6" rx="2" />
      <line x1="20" y1="11" x2="20" y2="20" strokeWidth="2.5" />
      <ellipse cx="20" cy="21" rx="5" ry="3" />
      <rect x="6" y="24" width="28" height="5" rx="2" />
      <path d="M8,24 L6,20 M32,24 L34,20" strokeWidth="1.5" />
      <line x1="20" y1="16" x2="20" y2="19" strokeWidth="1.5" strokeDasharray="1.5,1.5" />
    </svg>
  ),
  fast: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="15" y="18" width="10" height="16" rx="5" />
      <rect x="13" y="22" width="14" height="8" rx="3" />
      <path d="M20,34 C20,34 18,37 15,38" strokeWidth="1.5" />
      <path d="M10,16 C12,12 14,10 20,10 C26,10 28,12 30,16" strokeWidth="1.5" />
      <path d="M7,13 C10,8 14,5 20,5 C26,5 30,8 33,13" strokeWidth="1" opacity="0.6" />
      <path d="M4,10 C8,4 13,2 20,2 C27,2 32,4 36,10" strokeWidth="1" opacity="0.35" />
    </svg>
  ),
  iot: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8,36 L8,20 C8,14 12,10 18,10 L30,10" strokeWidth="3" />
      <ellipse cx="8" cy="30" rx="4.5" ry="3" />
      <path d="M11,28 L16,24" strokeWidth="1.5" />
      <circle cx="17" cy="23" r="1.5" />
      <rect x="28" y="7" width="8" height="6" rx="2" />
      <line x1="6" y1="22" x2="10" y2="22" strokeWidth="1.5" />
      <line x1="6" y1="26" x2="10" y2="26" strokeWidth="1.5" />
      <path d="M4,30 C4,27 12,27 12,30" strokeWidth="1" strokeDasharray="2,1.5" />
    </svg>
  ),
  deces: (
    <span style={{ fontSize:26, lineHeight:1, display:"flex", alignItems:"center", justifyContent:"center" }}>🕊️</span>
  ),
  note: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M28 6 L34 12 L16 30 L8 32 L10 24 Z" />
      <line x1="24" y1="10" x2="30" y2="16" />
      <line x1="8" y1="37" x2="32" y2="37" strokeWidth="1.5" strokeDasharray="3,2" />
    </svg>
  ),
  transmission: (
    <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {/* Camion de pompier */}
      {/* Cabine avant (gauche) */}
      <path d="M4 18 L4 28 L14 28 L14 14 L9 14 L4 18 Z" />
      {/* Caisse arrière */}
      <rect x="14" y="14" width="20" height="14" rx="1" />
      {/* Pare-brise cabine */}
      <line x1="6" y1="19" x2="12" y2="19" />
      <line x1="11" y1="14" x2="11" y2="19" />
      {/* Lignes de séparation caisse */}
      <line x1="22" y1="18" x2="22" y2="26" />
      <line x1="28" y1="18" x2="28" y2="26" />
      {/* Gyrophare sur le toit */}
      <rect x="18" y="11" width="6" height="3" rx="0.5" />
      {/* Échelle stylisée sur le toit */}
      <line x1="14" y1="12" x2="18" y2="12" strokeWidth="1.2" />
      <line x1="24" y1="12" x2="34" y2="12" strokeWidth="1.2" />
      {/* Roues */}
      <circle cx="9" cy="30" r="2.5" />
      <circle cx="20" cy="30" r="2.5" />
      <circle cx="29" cy="30" r="2.5" />
      {/* Châssis */}
      <line x1="4" y1="28" x2="34" y2="28" strokeWidth="1.5" />
    </svg>
  ),
};

// ── Composants de base ─────────────────────────────────────────────────────────

const Lbl = ({ children }) => (
  <p style={{ margin:"0 0 5px", fontSize:9.5, fontWeight:700, color:P.textSoft,
    textTransform:"uppercase", letterSpacing:"0.12em", fontFamily:mono }}>{children}</p>
);

const TInput = ({ value, onChange, placeholder, type="text" }) => (
  <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
    style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
      borderRadius:9, padding:"9px 12px", fontSize:13, color:P.text,
      fontFamily:sans, boxSizing:"border-box", outline:"none" }}
    onFocus={e => e.target.style.borderColor = P.blue}
    onBlur={e  => e.target.style.borderColor = P.border} />
);

const TArea = ({ value, onChange, placeholder, rows = 3 }) => (
  <textarea value={value} onChange={e => onChange(e.target.value)}
    placeholder={placeholder} rows={rows}
    style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
      borderRadius:9, padding:"9px 12px", fontSize:13, color:P.text,
      fontFamily:sans, boxSizing:"border-box", outline:"none",
      resize:"vertical", lineHeight:1.6 }}
    onFocus={e => e.target.style.borderColor = P.blue}
    onBlur={e  => e.target.style.borderColor = P.border} />
);

// Chips sélectionnables (pour Cormack, sonde, repère)
function ChipGroup({ options, value, onChange }) {
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
      {options.map(o => (
        <button key={o} onClick={() => onChange(value === o ? "" : o)}
          style={{ padding:"6px 12px", borderRadius:20, fontSize:13, fontWeight:500,
            border:`1.5px solid ${value===o ? P.violet : P.border}`,
            background: value===o ? P.violetSoft : P.surfaceAlt,
            color: value===o ? P.violetText : P.textMid,
            cursor:"pointer", fontFamily:sans, transition:"all 0.1s" }}>
          {o}
        </button>
      ))}
    </div>
  );
}

function Collapsible({ icon, title, children, badge }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14,
      overflow:"hidden", marginBottom:10 }}>
      <button onClick={() => setOpen(v => !v)}
        style={{ width:"100%", background:"transparent", border:"none", padding:"13px 16px",
          display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontFamily:sans }}>
        <span style={{ fontSize:16 }}>{icon}</span>
        <span style={{ flex:1, textAlign:"left", fontSize:13, fontWeight:500, color:P.text }}>{title}</span>
        {badge && <span style={{ fontSize:10, background:P.amberSoft, color:P.amberText,
          padding:"2px 8px", borderRadius:20, fontFamily:mono }}>{badge}</span>}
        <span style={{ color:P.textSoft, fontSize:12 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ padding:"0 16px 16px", borderTop:`1px solid ${P.borderSoft}` }}>
          <div style={{ paddingTop:12 }}>{children}</div>
        </div>
      )}
    </div>
  );
}

// ── Guide complet de l'application — cartes dépliables par thème ───────────
// Accessible depuis Réglages, la page d'accueil, et proposé au premier lancement.
function GuideApp({ onClose }) {
  const sections = [
    {
      title: "Repères de l'écran",
      color: "slate",
      items: [
        { icon:"🪪", title:"Encart Patient", desc:"Nom, âge, sexe — toujours accessible en un tap en haut de l'écran, à compléter dès que l'identité est connue. En mode Traumatique, un sélecteur de mécanisme lésionnel (AVP, chute, arme blanche/à feu, écrasement, blast...) y apparaît aussi — il préremplit automatiquement \"pénétrant\" et \"haute cinétique\" dans le calculateur BATT." },
        { icon:"📻", title:"Transmission", desc:"Ce qui s'est passé avant l'arrivée du SMUR : lieu de l'intervention, témoin, massage par un tiers, sapeurs-pompiers. Les heures saisies s'ajoutent automatiquement à la chronologie. Important : les chocs délivrés avant le SMUR sont comptés séparément (DSA pompiers / DSA public), mais les deux s'ajoutent aux chocs SMUR pour déclencher le rappel Cordarone au bon moment (3ᵉ puis 5ᵉ choc cumulé). Régulation est juste à côté, sur la même rangée." },
        { icon:"🔍", title:"Onglet Étiologie", desc:"ACR Adulte médical uniquement : liste des causes réversibles (5H/5T) à cocher au fur et à mesure qu'elles sont évoquées ou écartées — la réflexion diagnostique se retrouve ensuite dans la chronologie. En Traumatique, cet onglet est remplacé par la carte HOTT persistante (voir section Adulte & Traumatique)." },
        { icon:"💊", title:"Onglet Thérapeutiques", desc:"Regroupe amines, remplissage vasculaire et sédation — tout ce qui accompagne la réa sans être un geste d'urgence immédiat." },
        { icon:"⏱", title:"No-flow / Low-flow", desc:"Deux durées clés pour le pronostic : No-flow = temps sans massage avant la prise en charge ; Low-flow = temps de massage efficace depuis l'effondrement. À renseigner une fois — elles alimentent le compte-rendu et les critères d'arrêt." },
        { icon:"🔍", title:"Examen pupillaire initial", desc:"Une carte apparaît en tête de la grille d'actions dès le début de la réanimation (Adulte, Traumatique, Pédiatrique, VLI), à réaliser avant la 1ère injection d'adrénaline (qui peut elle-même provoquer une mydriase et fausser l'interprétation). Normales / Anormales / Non fait — si \"Anormales\", une liste dépliable précise en un seul tap : myosis bilatéral, mydriase bilatérale, ou anisocorie avec latéralité (œil droit/gauche en mydriase ou myosis). Disparaît automatiquement une fois répondue. Le même système de précision est disponible dans l'écran Soins post-RACS (onglet Hémo)." },
      ],
    },
    {
      title: "Général",
      color: "slate",
      items: [
        { icon:"⏱", title:"Chronomètre & minuteur adrénaline", desc:"Le chrono démarre au lancement de la réa. Un minuteur dédié rappelle l'échéance de la prochaine adrénaline avec une alarme sonore, et se relance automatiquement à chaque administration." },
        { icon:"🔄", title:"Cycle RCP · 2 min", desc:"Une barre de progression affiche le temps restant avant la prochaine analyse de rythme (cycle de 2 minutes, remis à zéro automatiquement à chaque nouveau cycle). Le bouton \"↺\" à côté permet de recaler manuellement ce cycle sur la réanimation réellement en cours — utile si vous reprenez une RCP déjà démarrée par une autre équipe et que le décompte affiché ne correspond plus au rythme réel des compressions. Le recalage est aussi tracé dans la chronologie." },
        { icon:"📋", title:"Chronologie complète", desc:"Chaque geste (choc, adrénaline, intubation, RACS...) est horodaté automatiquement. La liste est repliée par défaut pour ne pas encombrer l'écran — dépliez-la à tout moment. Un geste ajouté par erreur peut être annulé juste après (toast \"Annuler\")." },
        { icon:"🔴", title:"Badges & vibrations sur les boutons", desc:"Un badge \"!\" rouge clignote sur Adrénaline dès que le délai avant la prochaine dose est dépassé, \"FV\" apparaît sur Défibrillation après un rythme choquable, \"✓\" sur Intubation une fois faite. Chaque geste a aussi sa propre vibration (longue pour l'adrénaline, double pour le choc) pour le reconnaître sans regarder l'écran." },
        { icon:"➕", title:"Grille d'actions repliable", desc:"Les gestes les plus fréquents restent toujours visibles. Un bouton \"+ Plus d'actions\" révèle les gestes secondaires (Planche à masser, Fast-écho, Soins post-RACS, Constat de décès) pour garder l'écran principal lisible." },
        { icon:"📞", title:"Appel régulation", desc:"Bandeau toujours accessible pour horodater un appel à la régulation, avec un champ libre pour noter ce qui a été dit et la destination du patient." },
        { icon:"📝", title:"Note libre", desc:"Un encart de texte libre, entre les Soins post-RACS et la chronologie, pour consigner une information qui ne rentre dans aucune case." },
        { icon:"📄", title:"Compte-rendu automatique", desc:"Un rapport structuré façon SBAR est généré en continu à partir de la chronologie — prêt à copier, imprimer ou partager en fin de réanimation, sans ressaisie." },
        { icon:"🕐", title:"Frise chronologique visuelle", desc:"Graduation en minutes (0 min = début de la RCP), avec chaque geste positionné proportionnellement au temps écoulé. Si plusieurs gestes ont lieu à quelques secondes d'écart (ex : chocs rapprochés), ils s'empilent automatiquement sur des rangées distinctes avec leur heure affichée — jamais superposés ni illisibles." },
        { icon:"📑", title:"Export PDF sans coupure", desc:"Le PDF ne coupe jamais un encart entre deux pages — l'algorithme détecte quand un bloc (identité, bandeau, frise, section détaillée) déborderait sur la page suivante et bascule la coupure juste avant, pour que chaque encart reste toujours entier et lisible." },
        { icon:"🌗", title:"Thème jour / nuit", desc:"Bascule en un tap, en haut de l'écran. Le thème jour est pensé pour la lisibilité en plein soleil, le thème nuit pour ne pas éblouir en intervention de nuit." },
        { icon:"💾", title:"Sauvegarde automatique locale", desc:"Toutes les données sont enregistrées en continu sur l'appareil. Fermeture accidentelle, batterie déchargée, crash de l'app : rien n'est perdu, la session reprend exactement où elle s'est arrêtée." },
        { icon:"📦", title:"Export / import de sauvegarde", desc:"Depuis Réglages : exportez un fichier contenant toutes les archives et tous les réglages, à conserver ailleurs ou à transférer sur un nouveau téléphone. Utile avant un changement d'appareil, une mise à jour d'OS, ou simplement par précaution — les données restent sinon uniquement sur ce téléphone. Noms et prénoms sont automatiquement réduits à leurs initiales dans le fichier exporté (le fichier peut quitter l'appareil — minimisation des données médicales) ; ils restent en clair dans le détail d'un cas consulté directement sur le téléphone. À l'import, les archives sont fusionnées sans rien effacer ; les réglages, eux, sont remplacés par ceux du fichier importé (une confirmation est demandée avant)." },
        { icon:"✉️", title:"Contact / Retours", desc:"Depuis Réglages : trois boutons pour signaler un bug, suggérer une amélioration, ou simplement faire un retour positif — chacun ouvre l'app mail avec le sujet et la version de l'app déjà pré-remplis, pour ne rien avoir à taper à la main." },
        { icon:"📊", title:"Dashboard & statistiques", desc:"Chaque réanimation clôturée est archivée localement (durée, issue, données clés) et alimente automatiquement le tableau de bord — accessible depuis la page d'accueil. Filtrable par type (Adulte/Trauma/Pédiatrique) et par période (date de début/fin), tout le reste de l'écran se recalcule instantanément selon le filtre choisi.",
          list: [
            { label:"Taux de RACS global", detail:"avec durée moyenne de RCP" },
            { label:"Délais moyens", detail:"1er choc, 1ère adrénaline" },
            { label:"No-flow / Low-flow moyens", detail:"calculés sur les cas renseignés" },
            { label:"Taux de récidive après RACS", detail:"sur les cas ayant obtenu un RACS" },
            { label:"RACS selon le rythme initial", detail:"choquable vs non choquable" },
            { label:"RACS selon la RCP par témoin", detail:"avec vs sans avant l'arrivée du SMUR" },
            { label:"Répartition par type et par lieu", detail:"Adulte/Trauma/Pédiatrique, domicile/voie publique/etc." },
            { label:"Derniers cas archivés", detail:"consultables en détail (compte-rendu complet rouvert)" },
          ] },
        { icon:"⬇️", title:"Export des statistiques vers Excel", desc:"Depuis le Dashboard, deux boutons permettent d'exporter (pas d'importer — l'app ne relit pas de fichier Excel) les cas actuellement filtrés :",
          list: [
            { label:"Excel (.xlsx)", detail:"deux onglets — \"Résumé\" pré-agrégé (prêt pour créer un graphique en 2 clics dans Excel : sélectionner un tableau → Insertion → Graphique recommandé) et \"Cas archivés\" détaillé avec colonnes numériques natives, triables/filtrables directement" },
            { label:"CSV", detail:"format universel, une ligne par cas, compatible avec n'importe quel tableur" },
          ] },
      ],
    },
    {
      title: "ACR Adulte & Traumatique",
      color: "rose",
      items: [
        { icon:"🔍", title:"Carte HOTT persistante (trauma)", desc:"En ACR Traumatique, une carte reste visible en haut de l'onglet Actions tant que les 4 causes HOTT (Hypovolémie, Hypoxie, pneumothOrax, Tamponnade) n'ont pas toutes été recherchées. Chaque tap ouvre directement le bon geste (contrôle hémorragie, intubation, thoracostomie, Fast-écho) et coche la cause automatiquement. Une fois les 4 traitées, la carte se réduit en un simple bandeau vert — toujours visible, jamais masquée, réouvrable en un tap." },
        { icon:"⚡", title:"Analyse de rythme guidée", desc:"Toutes les 2 minutes, un flash rappelle d'analyser le rythme avec 4 choix en un tap (FV/TV, AESP, asystolie, RACS) — rien à chercher dans un menu pendant le no-flow." },
        { icon:"💊", title:"Cordarone — rappel automatique", desc:"Un rappel apparaît automatiquement au 3ᵉ choc (300 mg) puis au 5ᵉ choc (150 mg), conformément aux recommandations ERC 2021." },
        { icon:"🫁", title:"Ratio compressions/ventilation", desc:"L'affichage bascule automatiquement de 30:2 à un rythme continu dès que l'intubation est enregistrée." },
        { icon:"⚠️", title:"Intubation difficile", desc:"Un toggle en tête du modal Intubation (Adulte, Traumatique, Pédiatrique) permet de signaler une intubation difficile et de préciser la ou les techniques utilisées : mandrin d'Eschmann, vidéolaryngoscope, masque laryngé standard, Fastrach, dispositif supra-glottique de secours, cricothyroïdotomie — ainsi que le nombre de tentatives. Une case \"Inhalation objectivée\" est aussi disponible pour tracer une régurgitation. Tout s'ajoute automatiquement au compte-rendu." },
        { icon:"📈", title:"EtCO₂ & alertes intelligentes", desc:"Saisie rapide de l'EtCO₂ avec alertes si la valeur est insuffisante (MCE inefficace) ou si une remontée brutale évoque un RACS." },
        { icon:"💚", title:"Soins post-RACS — détail", desc:"Écran dédié en 3 onglets : Ventilation (FR, Vt, PEP, SpO₂, FiO₂, EtCO₂ — avec graphique live et alerte couleur si SpO₂ ou EtCO₂ sort de la cible), Sédation (Hypnovel, Sufentanyl, curare — le débit en mL/h saisi convertit automatiquement la dose en mg/h ou μg/h), Hémo. (TA avec PAM calculée automatiquement, FC, graphique live TA/FC, température, glycémie, pupilles — Normales/Anisocorie/Mydriase bilatérale, remplissage total, amines). Un badge ↑/↓ compare chaque nouvelle mesure (TA, FC, EtCO₂) à la dernière valeur enregistrée. Chaque valeur saisie s'ajoute au compte-rendu." },
        { icon:"🩸", title:"OctaplasLG & score BATT", desc:"Calculateur de score BATT avec préremplissage automatique depuis les dernières constantes saisies. En mode Traumatique, les cases \"pénétrant\" et \"haute cinétique\" se cochent aussi automatiquement selon le mécanisme lésionnel renseigné sur la fiche patient." },
        { icon:"🔍", title:"FAST écho (traumatique)", desc:"Sélecteurs rapides par espace anatomique (Morrison, Köhler, Douglas, plèvres, péricarde) pour tracer l'échographie ciblée. En mode Traumatique, Fast-écho remonte dans la grille principale (à la place de Cordarone, moins pertinent en arrêt traumatique) — Cordarone reste accessible derrière le bouton \"+ Plus d'actions\"." },
        { icon:"↩", title:"Récidive d'arrêt après RACS", desc:"Dès qu'un RACS est obtenu, un bandeau rouge \"Récidive d'arrêt\" apparaît en tête de la grille d'actions (au-dessus d'Adrénaline/Défibrillation, juste avant \"Soins post-RACS\") — plus besoin d'ouvrir un modal pour le trouver. Un tap relance immédiatement le mode réanimation active (métronome, minuteur adrénaline, cycle de compressions) sans perdre l'historique." },
        { icon:"⏱", title:"Critères d'arrêt de réanimation", desc:"Passé 20 minutes sans RACS, un rappel propose d'ouvrir la check-list des critères d'arrêt — à titre indicatif, la décision reste médicale. En Traumatique, la check-list est spécifique (HOTT, thoracostomies, contrôle hémorragique, pronostic selon mécanisme fermé/pénétrant) plutôt que les critères médicaux génériques." },
        { icon:"🕊️", title:"Constat de décès", desc:"Formulaire dédié avec champ libre pour préciser le destinataire du constat (\"sans OML\")." },
      ],
    },
    {
      title: "ACR Pédiatrique",
      color: "amber",
      items: [
        { icon:"⚖️", title:"Doses calculées par poids", desc:"Adrénaline, amiodarone, remplissage : toutes les doses s'ajustent automatiquement dès que le poids de l'enfant est renseigné — aucun calcul à faire en urgence." },
        { icon:"🧰", title:"Matériel adapté", desc:"Taille de sonde, repère à la commissure, matériel recommandé : tout est affiché selon le poids sélectionné (table pédiatrique standardisée)." },
        { icon:"🔁", title:"Mêmes automatismes que l'adulte", desc:"Flash d'analyse de rythme, minuteur adrénaline, suivi post-RACS, mode équipe et reconnaissance vocale existent aussi en pédiatrique, avec les doses et le vocabulaire adaptés." },
        { icon:"⏱", title:"Critères d'arrêt de réanimation (40 min)", desc:"Passé 40 minutes sans RACS (délai plus long qu'en adulte, la réanimation pédiatrique se poursuivant généralement davantage), un rappel propose une check-list dédiée : causes réversibles pédiatriques (hypoglycémie, intoxication, obstruction des voies aériennes, noyade, sepsis, mort inexpliquée du nourrisson), hypothermie, décision collégiale et accompagnement de la famille." },
        { icon:"💉", title:"Dilution adrénaline (Protocole 1 ou 2)", desc:"Deux protocoles de dilution disponibles, activables dans Réglages — dilution universelle par défaut (Protocole 2, la même préparation quel que soit le poids : 0,1 mg/mL, injecter 0,01 mg/kg) ou dilution adaptée au poids (Protocole 1, avec une double dilution spécifique en-dessous de 10 kg pour rester précis sur de petits volumes). Le guide de préparation est affiché à deux moments : dès la sélection du poids (avant de démarrer), et pendant la réanimation active — jamais besoin de revenir en arrière pour le retrouver." },
        { icon:"🕊️", title:"Mort inattendue du nourrisson (MIN)", desc:"Pour un enfant < 2 ans sans signe de violence évident, le constat de décès propose un parcours dédié conforme au protocole national (HAS/DGOS) : transport du corps avec les parents vers le Centre de Référence MIN (CRMIN) le plus proche, pas de constat classique sur place. Rappel des éléments à préserver pour l'enquête (position de découverte, literie, contexte) avec champs dédiés pour les documenter." },
      ],
    },
    {
      title: "Reconnaissance vocale",
      color: "violet",
      items: [
        { icon:"📍", title:"Emplacement du micro", desc:"Le bouton micro se trouve désormais dans l'en-tête, à côté du mode équipe et du réglage jour/nuit — un simple bouton compact à activer/désactiver, qui ne gêne plus jamais l'accès aux boutons d'action. Tant qu'il est actif, un bandeau fin reste affiché en haut de l'écran (fixe, toujours visible même en faisant défiler la page) : écoute en cours, transcription entendue, confirmation d'une commande reconnue, ou réponse à une question." },
        { icon:"🎤", title:"Mot-code vocal (personnalisable)", desc:"Toute commande ou question doit être précédée d'un mot-code — \"Alpha\" par défaut (ex : \"Alpha, adrénaline\"). Ce filtre évite que le brouhaha d'une réanimation ne déclenche une action par erreur — un flash vert du micro confirme que le mot-code a bien été entendu. Modifiable dans Réglages : choisissez un mot qui ne risque pas d'être prononcé par hasard pendant une prise en charge (évitez les mots médicaux courants comme \"urgence\" ou \"protocole\"), préférez un mot court, et si possible un mot qu'on ne prononcerait pas naturellement en deux temps avec une pause au milieu." },
        { icon:"💉", title:"Toutes les commandes d'action", desc:"Chaque commande logue un geste dans la chronologie après un bandeau de confirmation de 2,5s (annulable). Les doses affichées s'adaptent automatiquement en pédiatrique selon le poids.",
          list: [
            { label:"Alpha, adrénaline", detail:"log une dose d'adrénaline et relance le minuteur" },
            { label:"Alpha, choc", detail:"log directement une défibrillation 200 J (4 J/kg en pédiatrique) — aucune proposition, aucun modal, aussi : défibrillation, défib, cardioversion, fibrillation" },
            { label:"Alpha, cordarone", detail:"log une dose de Cordarone/Amiodarone (aussi : amiodarone, amio)" },
            { label:"Alpha, RACS", detail:"log un RACS directement (aussi : pouls, circulation, retour, spontané)" },
            { label:"Alpha, intubation", detail:"ouvre le modal Intubation (aussi : intuber, sonde)" },
            { label:"Alpha, pause", detail:"met le chrono/MCE en pause (aussi : stoppe, stop compressions)" },
            { label:"Alpha, reprendre", detail:"relance les compressions (aussi : continuer, resume, relancer)" },
            { label:"Alpha, annule", detail:"annule le dernier geste loggé, avec possibilité de le restaurer ensuite (aussi : annuler, supprime, efface)" },
            { label:"Alpha, décès", detail:"ouvre le constat de décès (aussi : constat, mort, décédé)" },
            { label:"Alpha, analyse", detail:"déclenche le flash d'analyse de rythme (aussi : rythme, check, vérification)" },
            { label:"Alpha, EtCO2 vingt-cinq", detail:"log directement la valeur dictée (aussi : capno + un chiffre)" },
          ] },
        { icon:"❓", title:"Toutes les questions à voix haute", desc:"Une question ne modifie jamais rien — réponse instantanée, parlée à voix haute et affichée en bandeau bleu. Se déclenche dès qu'un mot interrogatif (combien, depuis quand, à combien, quel est, y a-t-il...) est détecté avec le mot-code, avant même de regarder les commandes d'action.",
          list: [
            { label:"Combien de mg d'adrénaline ?", detail:"nombre de doses et total en mg" },
            { label:"Depuis quand pas d'adrénaline ?", detail:"délai depuis la dernière dose" },
            { label:"Combien de chocs ?", detail:"total délivré, dont doubles défibrillations" },
            { label:"Délai avant le premier choc ?", detail:"temps écoulé entre le début et le 1er choc" },
            { label:"À combien était la dernière EtCO2 ?", detail:"dernière valeur enregistrée, avec l'heure" },
            { label:"Combien de cordarone ?", detail:"doses de 300mg et 150mg administrées" },
            { label:"À combien était la dernière tension ?", detail:"TA et PAM calculée" },
            { label:"Quelle est la fréquence cardiaque ?", detail:"dernière FC enregistrée" },
            { label:"Quel est le Shock Index ?", detail:"calculé depuis les dernières constantes" },
            { label:"Combien de temps de no-flow ?", detail:"durée renseignée" },
            { label:"Quelles amines sont en cours ?", detail:"noradrénaline/dobutamine actives et doses" },
            { label:"Combien de remplissage ?", detail:"volume total perfusé" },
            { label:"Quelle est la température ?", detail:"dernière valeur post-RACS saisie" },
            { label:"Quel est le dernier geste fait ?", detail:"dernier événement de la chronologie, avec l'heure" },
            { label:"Y a-t-il eu un RACS ?", detail:"oui à telle heure, ou non pas encore" },
            { label:"Quel est le dernier rythme analysé ?", detail:"FV/TV, AESP ou asystolie" },
            { label:"Depuis combien de temps on est dessus ?", detail:"durée de réa écoulée" },
            { label:"On est en mode équipe ?", detail:"connecté ou non, nombre d'appareils (Adulte/Trauma)" },
            { label:"Quel est le poids de l'enfant ?", detail:"poids renseigné (Pédiatrique uniquement)" },
          ] },
        { icon:"✅", title:"Confirmation avant action", desc:"Chaque commande d'action affiche un bandeau annulable pendant 2,5 secondes avant d'être vraiment enregistrée — de quoi rattraper un mot mal compris." },
        { icon:"📡", title:"Nécessite une connexion internet", desc:"La reconnaissance vocale envoie l'audio à un service en ligne pour l'analyser — elle ne fonctionne pas hors connexion (zone blanche, sous-sol...), même micro activé. L'app le signale clairement (message à l'écran) si vous essayez d'activer le micro sans réseau, ou si la connexion se coupe pendant l'écoute. Le reste de l'application (chronologie, calculs, compte-rendu) continue de fonctionner normalement sans connexion." },
      ],
    },
    {
      title: "ACR VLI (protocole ISP)",
      color: "amber",
      items: [
        { icon:"🚒", title:"Adulte ou Pédiatrique — deux protocoles distincts", desc:"Le bouton \"ACR VLI\" de l'accueil propose un choix : Adulte ou Pédiatrique. Le protocole pédiatrique diffère sur plusieurs points clés — DIO en 1ère intention (pas seulement après échec de VVP), doses recalculées automatiquement au poids de l'enfant (mêmes tables que le module Pédiatrique médical), et onglet Situations particulières réduit à 3 cartes (pas d'hypothermie ni de femme enceinte, non applicables)." },
        { icon:"🚑", title:"Un module à part, en attente du médecin", desc:"Accent orange distinctif partout à l'écran. La grille d'actions est volontairement restreinte aux gestes autorisés par le protocole VLI local (Pompiers/ISP) : analyse de rythme, voie d'abord, adrénaline, défibrillation, cordarone, sécurisation des VAS, planche à masser. Le certificat de décès n'existe volontairement pas en VLI — un infirmier n'a jamais l'autorité de constater un décès, avec ou sans OML ; ce point relève uniquement du VLM ou de la régulation médicale. Fast-écho, ECMO, BATT et les thérapeutiques réservées au médecin restent inaccessibles tant que le VLM n'est pas arrivé." },
        { icon:"🫁", title:"Sécurisation des VAS", desc:"Choix explicite entre dispositif supra-glottique (geste infirmier) et intubation orotrachéale (réservée à l'IADE) — la chronologie garde une trace précise de ce qui a réellement été posé. Une case \"Inhalation objectivée\" est disponible avant de valider le choix, comme dans les modules médicaux." },
        { icon:"🎯", title:"Onglet Situations particulières (Adulte)", desc:"Remplace Étiologie/Thérapeutiques en VLI Adulte. Chaque situation du protocole ISP est accessible en un tap, avec le détail du protocole visible directement sur la carte.",
          list: [
            { label:"Hémorragie", detail:"Isofundine 500 mL/10 min, jusqu'à 2 VVP" },
            { label:"Obstruction VAS", detail:"Exposition douce au laryngoscope + Pince Magill" },
            { label:"Intoxication aux fumées", detail:"Cyanokit 5g/15min sur voie dédiée, renouvelable une fois" },
            { label:"Hypothermie", detail:"Pas d'adrénaline ni de cordarone si T<30°C, 3 CEE max" },
            { label:"Femme enceinte", detail:"Inclinaison utérine gauche continue" },
          ] },
        { icon:"🎯", title:"Onglet Situations particulières (Pédiatrique)", desc:"Version enfant, doses recalculées au poids automatiquement.",
          list: [
            { label:"Hémorragie", detail:"Isofundine 20 mL/kg sur 10 min, puis en garde veine" },
            { label:"Obstruction VAS", detail:"Exposition douce au laryngoscope + Pince Magill" },
            { label:"Intoxication aux fumées", detail:"Cyanokit 70 mg/kg sur 15 min (max 5g), voie dédiée" },
          ] },
        { icon:"🕊️", title:"Certificat de décès en VLI", desc:"Les infirmiers ne peuvent pas constater un obstacle médico-légal (OML). Le formulaire propose uniquement \"sans OML\", plus un bouton dédié \"Suspicion d'OML\" qui alerte le médecin régulateur sans rien constater." },
        { icon:"🫀", title:"RACS — surveillance uniquement", desc:"Pas d'administration d'amine ni de sédation en VLI (hors du cadre autorisé). L'écran affiche les objectifs du protocole ISP (SpO₂ 94-98%, EtCO₂ 35-45 mmHg, PAS>90/PAM>65 mmHg, glycémie>0,7 g/L) et permet de saisir les constantes de surveillance (FC, TA, SpO₂, FR, T°, EtCO₂, glycémie, Glasgow, pupilles). Les courbes EtCO₂ et Hémodynamique (PAS/PAD/PAM/FC) restent disponibles et se mettent à jour en direct, comme dans le module médicalisé — utile pour suivre une tendance en attendant le VLM." },
        { icon:"🚨", title:"Transition VLM — irréversible", desc:"Le bouton \"VLM arrivée\", toujours visible en haut de l'écran, débloque d'un tap (avec confirmation) la prise en charge médicale complète — grille entière, onglets Étiologie/Thérapeutiques. Rien n'est perdu : patient, transmission, chocs, adrénaline et toute la chronologie déjà saisie restent intacts, le médecin reprend exactement là où l'infirmier s'est arrêté. Pas de retour possible au mode restreint ensuite." },
      ],
    },
    {
      title: "Mode équipe multi-appareils",
      color: "blue",
      items: [
        { icon:"👥", title:"Synchronisation en temps réel", desc:"Plusieurs téléphones de l'équipe peuvent partager la même chronologie, l'heure d'ACR et les constantes en direct — utile quand plusieurs personnes documentent en parallèle." },
        { icon:"📶", title:"Statut de synchronisation", desc:"Dans le modal équipe, un indicateur précise si les données sont bien à jour : \"Synchronisé à l'instant/Xs/X min\" (tout va bien), \"🟡 Synchronisation en cours\" (envoi en cours), ou \"⚠️ Échec de synchronisation\" (réseau instable — la tentative suivante se fera automatiquement au prochain geste enregistré). Le petit point coloré sur le bouton équipe (🟢/🟡/🔴) donne le même statut en un coup d'œil, sans ouvrir le modal." },
        { icon:"📷", title:"Créer ou rejoindre une session", desc:"Un appareil crée une session (QR code + code à 6 caractères alphanumériques) ; les autres la rejoignent en scannant le QR ou en saisissant le code." },
        { icon:"🚀", title:"Préparer la connexion à l'avance", desc:"En pédiatrique, la session peut être créée dès l'écran de choix du poids — les téléphones sont déjà connectés quand la réanimation démarre réellement." },
        { icon:"🧹", title:"Anti-doublon automatique", desc:"Si deux membres de l'équipe loguent la même adrénaline ou cordarone à quelques secondes d'écart, un seul enregistrement est conservé — la chronologie reste fiable." },
      ],
    },
  ];

  return (
    <Modal title="Guide complet de l'application" icon="📖" soft={P.surfaceAlt} onClose={onClose}>
      <p style={{ margin:"0 0 18px", fontSize:12.5, color:P.textSoft, lineHeight:1.5 }}>
        Un aperçu de toutes les fonctionnalités importantes — à parcourir avant une
        première utilisation réelle. Dépliez chaque carte pour en savoir plus.
      </p>
      {sections.map((sec, si) => (
        <div key={si} style={{ marginBottom: si < sections.length - 1 ? 22 : 0 }}>
          <p style={{ margin:"0 0 10px", fontSize:10.5, fontWeight:800, color:P[sec.color+"Text"] || P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.12em", fontFamily:mono }}>
            {sec.title}
          </p>
          {sec.items.map((item, ii) => (
            <Collapsible key={ii} icon={item.icon} title={item.title}>
              {item.desc && (
                <p style={{ margin: item.list ? "0 0 10px" : 0, fontSize:12.5, color:P.textMid, lineHeight:1.55 }}>{item.desc}</p>
              )}
              {item.list && (
                <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                  {item.list.map((row, ri) => (
                    <div key={ri} style={{ display:"flex", gap:8, alignItems:"baseline" }}>
                      <span style={{ fontSize:12, color:P.textMid, lineHeight:1.5 }}>
                        <b style={{ color:P.text, fontFamily:mono, fontWeight:700 }}>{row.label}</b>
                        {row.detail && <> — {row.detail}</>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Collapsible>
          ))}
        </div>
      ))}
      <button onClick={onClose}
        style={{ width:"100%", background:P.text, border:"none", borderRadius:12,
          color:P.bg, fontSize:14, fontWeight:700, padding:"13px", cursor:"pointer",
          fontFamily:sans, marginTop:6 }}>
        ✓ J'ai compris
      </button>
    </Modal>
  );
}

function ActionBtn({ action, onClick }) {
  const [press, setPress] = useState(false);
  const [flash, setFlash] = useState(false);
  const vital = action.vital;
  const badge = action.badge; // { text, color, pulse } | undefined
  const haptic = () => {
    try {
      if (!navigator.vibrate) return;
      if (action.hapticType === "long") navigator.vibrate(200);
      else if (action.hapticType === "double") navigator.vibrate([100,50,100]);
      else navigator.vibrate(28);
    } catch(e) {}
  };
  return (
    <button
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerLeave={() => setPress(false)}
      onClick={() => { setFlash(true); setTimeout(() => setFlash(false), 700); haptic(); onClick(); }}
      style={vital ? {
        // ── Bouton VITAL : aplat saturé ──
        background:`linear-gradient(135deg, ${action.accent}, ${action.textC})`,
        border:"none", borderRadius:16, padding:"15px 14px", cursor:"pointer", fontFamily:sans,
        display:"flex", flexDirection:"column", alignItems:"flex-start", gap:7,
        position:"relative",
        transform: press ? "scale(0.96)" : "scale(1)",
        transition:"transform 0.08s, filter 0.15s",
        filter: flash ? "brightness(1.4)" : "brightness(1)",
        boxShadow:`0 5px 16px ${action.accent}55`,
        minWidth:0, boxSizing:"border-box", width:"100%", minHeight:90, color:"#fff",
      } : {
        // ── Bouton standard : carte + pastille colorée ──
        background: flash ? `color-mix(in srgb, ${P.green} 12%, ${P.surface})` : P.surface,
        border: `1.5px solid ${flash ? P.green : P.border}`,
        borderRadius:15, padding:"13px 12px", cursor:"pointer", fontFamily:sans,
        display:"flex", alignItems:"center", gap:11, textAlign:"left",
        position:"relative",
        transform: press ? "scale(0.96)" : "scale(1)",
        transition:"transform 0.08s, border-color 0.15s, box-shadow 0.15s, background 0.15s",
        boxShadow: flash ? `0 0 0 3px color-mix(in srgb, ${P.green} 25%, transparent)` : "0 1px 4px rgba(0,0,0,0.05)",
        minWidth:0, boxSizing:"border-box", width:"100%", minHeight:64,
      }}>
      {/* Badge dynamique (ex : ! alarme adrénaline, FV rythme choc, ✓ intubation faite) */}
      {badge && !flash && (
        <span style={{
          position:"absolute", top:-6, right:-6, minWidth:20, height:20, borderRadius:10,
          background: badge.color || P.rose, color:"#fff", fontSize:10.5, fontWeight:900,
          display:"flex", alignItems:"center", justifyContent:"center", padding:"0 5px",
          boxShadow:"0 2px 6px rgba(0,0,0,0.25)", fontFamily:sans, lineHeight:1, zIndex:2,
          animation: badge.pulse ? "rythmPulse 1.2s ease-in-out infinite" : "none",
        }}>
          {badge.text}
        </span>
      )}
      {/* Pastille d'icône (✓ vert pendant la confirmation) */}
      <span style={{
        width: vital ? 40 : 38, height: vital ? 40 : 38, borderRadius:11, flexShrink:0,
        background: flash ? (vital ? "rgba(255,255,255,0.30)" : `color-mix(in srgb, ${P.green} 20%, transparent)`)
                          : (vital ? "rgba(255,255,255,0.22)" : `color-mix(in srgb, ${action.accent} 16%, transparent)`),
        display:"flex", alignItems:"center", justifyContent:"center",
        color: flash ? (vital ? "#fff" : P.green) : (vital ? "#fff" : action.accent),
        transition:"all 0.15s",
      }}>
        {flash
          ? <span style={{ fontSize: vital ? 24 : 21, fontWeight:900, lineHeight:1 }}>✓</span>
          : action.svg
            ? <span style={{ width: vital ? 27 : 24, height: vital ? 27 : 24, display:"flex" }}>{action.svg}</span>
            : <span style={{ fontSize: vital ? 22 : 20 }}>{action.icon}</span>}
      </span>
      <div style={{ display:"flex", flexDirection:"column", gap:1, minWidth:0 }}>
        <span style={{
          fontFamily:sans, fontSize: vital ? 16 : 13.5, fontWeight: vital ? 800 : 700,
          color: vital ? "#fff" : P.text, lineHeight:1.1, letterSpacing:"0.005em",
        }}>
          {action.label}
        </span>
        {vital && action.dose && (
          <span style={{ fontFamily:mono, fontSize:11, fontWeight:700, color:"#fff", opacity:0.92 }}>
            {action.dose}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Modal bottom-sheet ─────────────────────────────────────────────────────────
function Modal({ title, icon, soft, onClose, children }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(28,43,58,0.5)", zIndex:80,
      display:"flex", alignItems:"flex-end", justifyContent:"center",
      backdropFilter:"blur(2px)" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background:P.surface, width:"100%", maxWidth:480, borderRadius:"20px 20px 0 0",
          padding:"24px 20px 40px", boxShadow:"0 -12px 40px rgba(0,0,0,0.15)",
          fontFamily:sans, maxHeight:"90vh", overflowY:"auto" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
          <div style={{ width:40, height:40, borderRadius:12, background:soft,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:20, color:P.textMid }}>{icon}</div>
          <p style={{ margin:0, fontSize:16, fontWeight:600, color:P.text }}>{title}</p>
          <button onClick={onClose} style={{ marginLeft:"auto", background:"transparent",
            border:"none", color:P.textSoft, fontSize:20, cursor:"pointer", padding:4 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ChoiceBtn({ label, sub, accent, soft, textC, onClick }) {
  const [press, setPress] = useState(false);
  return (
    <button onPointerDown={() => setPress(true)} onPointerUp={() => setPress(false)} onPointerLeave={() => setPress(false)}
      onClick={onClick}
      style={{ width:"100%", background: press ? soft : P.surfaceAlt,
        border:`1.5px solid ${press ? accent : P.border}`,
        borderRadius:12, padding:"14px 16px", cursor:"pointer", fontFamily:sans,
        textAlign:"left", marginBottom:10,
        transform: press ? "scale(0.98)" : "scale(1)", transition:"all 0.1s" }}>
      <p style={{ margin:0, fontSize:14, fontWeight:600, color: press ? textC : P.text }}>{label}</p>
      {sub && <p style={{ margin:"3px 0 0", fontSize:12, color:P.textSoft }}>{sub}</p>}
    </button>
  );
}

// ── PDF ────────────────────────────────────────────────────────────────────────
function PdfView({ patient, noFlow, lowFlow, acrTime, iot, events, totalSec, trans, hemocue, hemo, amines, etco2, onClose }) {
  const chocs = events.filter(e => e.id === "choc").length;
  const adrs  = events.filter(e => e.id === "adr").length;
  const rosc  = events.find(e => e.id === "rosc");
  const deces = events.find(e => e.id === "deces");
  const [copied, setCopied] = useState(false);

  // Génère le texte complet du compte-rendu
  const buildText = () => {
    const lines = [];
    lines.push("═══════════════════════════════════");
    lines.push("       COMPTE-RENDU DE SMUR");
    lines.push("═══════════════════════════════════");
    lines.push(`Date : ${new Date().toLocaleDateString("fr-FR")}  Heure : ${getNow()}`);
    lines.push("");

    if (patient?.nom || patient?.prenom) {
      lines.push("── PATIENT ─────────────────────────");
      if (patient.nom || patient.prenom)
        lines.push(`Nom : ${[patient.nom, patient.prenom].filter(Boolean).join(" ")}`);
      if (patient.ddn)
        lines.push(`DDN : ${new Date(patient.ddn).toLocaleDateString("fr-FR")}`);
      if (patient.age)  lines.push(`Âge : ${patient.age}`);
      if (patient.atcd) lines.push(`ATCD : ${patient.atcd}`);
      if (patient.histoire) lines.push(`Histoire : ${patient.histoire}`);
      lines.push("");
    }

    lines.push("── DONNÉES RCP ─────────────────────");
    lines.push(`Heure ACR      : ${acrTime || "Inconnue"}`);
    if (patient?.temp) lines.push(`Température     : ${patient.temp} °C`);
    lines.push(`No-flow        : ${noFlow  ? noFlow + " min" : "Inconnu"}`);
    lines.push(`Low-flow       : ${lowFlow ? lowFlow + " min" : "—"}`);
    lines.push(`Durée RCP      : ${fmtSec(totalSec)}`);
    lines.push(`Chocs élect.   : ${chocs || "Aucun"}`);
    lines.push(`Adrénaline     : ${adrs ? adrs + " × 1 mg" : "Non administrée"}`);
    lines.push(`Issue          : ${rosc ? "ROSC à " + rosc.time : deces ? deces.label : "Non renseignée"}`);
    lines.push("");

    if (iot?.sonde) {
      lines.push("── INTUBATION OT ───────────────────");
      if (iot.cormack) lines.push(`Cormack  : ${iot.cormack}`);
      lines.push(`Sonde    : ${iot.sonde} mm`);
      if (iot.repere)  lines.push(`Repère   : ${iot.repere} cm`);
      if (iot.capno)   lines.push(`EtCO₂    : ${iot.capno} mmHg`);
      lines.push("");
    }

    // Hemocue — suivi + tendance
    if (hemocue && hemocue.length > 0) {
      lines.push("── HEMOCUE (Hb) ────────────────────");
      hemocue.forEach(h => lines.push(`${h.time}  :  ${h.val} g/dL`));
      if (hemocue.length >= 2) {
        const last = parseFloat(String(hemocue[hemocue.length-1].val).replace(",", "."));
        const first = parseFloat(String(hemocue[0].val).replace(",", "."));
        const prev = parseFloat(String(hemocue[hemocue.length-2].val).replace(",", "."));
        if (!isNaN(last) && !isNaN(prev)) {
          const d = Math.round((last - prev) * 10) / 10;
          lines.push(`Écart 2 dern.  : ${d > 0 ? "+" : ""}${String(d).replace(".", ",")} g/dL`);
        }
        if (!isNaN(last) && !isNaN(first)) {
          const dg = Math.round((last - first) * 10) / 10;
          lines.push(`Tendance glob. : ${dg > 0 ? "+" : ""}${String(dg).replace(".", ",")} g/dL (${hemocue.length} mesures)`);
        }
      }
      lines.push("");
    }

    // Phase pré-SMUR (transmission des équipes en place)
    const t = trans;
    const hasTrans = t && (t.saved || t.hEffondrement || t.hArriveePompiers || t.hPoseDSA ||
      t.h1erChoc || t.temoin || t.mceTemoin || (parseInt(t.chocsPompiers)||0) > 0 || (parseInt(t.chocsPublic)||0) > 0 || t.rythmeDSA || t.gestesSecouristes || t.note);
    if (hasTrans) {
      const rythmeLabel = { choquable:"choquable", nonChoquable:"non choquable", nonAnalyse:"non analysé" };
      lines.push("── PHASE PRÉ-SMUR ──────────────────");
      if (t.hEffondrement)    lines.push(`Heure de l'ACR    : ${t.hEffondrement}`);
      if (t.temoin)           lines.push(`Témoin            : ${t.temoin}`);
      if (t.mceTemoin)        lines.push(`MCE par témoin    : ${t.mceTemoin}`);
      if (t.hArriveePompiers) lines.push(`Arrivée pompiers  : ${t.hArriveePompiers}`);
      if (t.hPoseDSA)         lines.push(`Pose DSA          : ${t.hPoseDSA}`);
      if (t.rythmeDSA)        lines.push(`Rythme initial    : ${rythmeLabel[t.rythmeDSA] || t.rythmeDSA}`);
      if (t.h1erChoc)         lines.push(`1er choc          : ${t.h1erChoc}`);
      if ((parseInt(t.chocsPompiers)||0) > 0) lines.push(`Chocs DSA pompiers: ${t.chocsPompiers}`);
      if ((parseInt(t.chocsPublic)||0) > 0)   lines.push(`Chocs DSA public  : ${t.chocsPublic}`);
      if (t.gestesSecouristes) lines.push(`Gestes secouristes: ${t.gestesSecouristes}`);
      if (t.note)             lines.push(`Note pré-SMUR     : ${t.note}`);
      lines.push("");
    }

    lines.push("── CHRONOLOGIE ─────────────────────");
    events.forEach(e => {
      lines.push(`${e.time}  ${e.label}`);
    });
    lines.push("");

    // EtCO₂ capnographie
    if (etco2 && etco2.length > 0) {
      lines.push("── EtCO₂ (capnographie) ────────────");
      etco2.forEach(e => lines.push(`${e.time}  :  ${e.val} mmHg`));
      lines.push("");
    }

    // Hémodynamique post-RACS
    if (hemo && hemo.length > 0) {
      lines.push("── HÉMODYNAMIQUE POST-RACS ─────────");
      hemo.forEach(m => {
        const pam = (m.pas && m.pad)
          ? Math.round(parseFloat(m.pad) + (parseFloat(m.pas) - parseFloat(m.pad)) / 3)
          : null;
        lines.push(`${m.time}  PAS ${m.pas||"—"} / PAD ${m.pad||"—"} / FC ${m.fc||"—"}${pam ? ` / PAM ${pam}` : ""}`);
      });
      if (amines && amines.length > 0) {
        lines.push("Amines :");
        amines.forEach(a => lines.push(`  ${a.time}  ${a.label}`));
      }
      lines.push("");
    }

    lines.push("── RÉSUMÉ ──────────────────────────");
    lines.push(
      `ACR pris en charge le ${new Date().toLocaleDateString("fr-FR")}.` +
      (patient?.nom ? ` Patient : ${patient.nom}.` : "") +
      (acrTime ? ` Heure d'arrêt : ${acrTime}.` : "") +
      (noFlow  ? ` No-flow : ${noFlow} min.` : " No-flow inconnu.") +
      (lowFlow ? ` Low-flow : ${lowFlow} min.` : "") +
      ` Durée RCP : ${fmtSec(totalSec)}.` +
      (chocs ? ` ${chocs} choc(s).` : "") +
      (adrs  ? ` Adrénaline ${adrs} fois.` : "") +
      (iot?.sonde ? ` IOT sonde ${iot.sonde} mm.` : "") +
      (rosc  ? ` ROSC à ${rosc.time}.` : deces ? ` ${deces.label}.` : " Issue non renseignée.")
    );
    lines.push("");

    // ── SBAR Transmission au réanimateur ──
    lines.push("══ TRANSMISSION SBAR ══════════════");
    // S — Situation
    lines.push("");
    lines.push("S — SITUATION");
    const patientDesc = [
      patient?.nom && patient?.prenom ? `${patient.nom} ${patient.prenom}` : patient?.nom || null,
      patient?.age ? `${patient.age}` : patient?.ddn ? calcAge(patient.ddn) : null,
    ].filter(Boolean).join(", ");
    lines.push(`Patient : ${patientDesc || "Identité non renseignée"}`);
    lines.push(`ACR extra-hospitalier — heure d'arrêt : ${acrTime || "inconnue"}`);
    lines.push(`No-flow : ${noFlow ? noFlow + " min" : "inconnu"} · Low-flow : ${lowFlow ? lowFlow + " min" : "—"} · Durée RCP : ${fmtSec(totalSec)}`);
    // B — Background
    lines.push("");
    lines.push("B — CONTEXTE");
    if (patient?.atcd) lines.push(`ATCD : ${patient.atcd}`);
    if (patient?.histoire) lines.push(`Circonstances : ${patient.histoire}`);
    if (patient?.temp) lines.push(`Température : ${patient.temp} °C`);
    const tSBAR = trans;
    if (tSBAR && (tSBAR.temoin || tSBAR.mceTemoin || tSBAR.chocsPompiers || tSBAR.chocsPublic)) {
      const preSMUR = [
        tSBAR.temoin && `témoin : ${tSBAR.temoin}`,
        tSBAR.mceTemoin && `MCE témoin : ${tSBAR.mceTemoin}`,
        (parseInt(tSBAR.chocsPompiers)||0) > 0 && `${tSBAR.chocsPompiers} choc(s) DSA pompiers`,
        (parseInt(tSBAR.chocsPublic)||0) > 0 && `${tSBAR.chocsPublic} choc(s) DSA public`,
        tSBAR.rythmeDSA && `rythme initial : ${tSBAR.rythmeDSA}`,
      ].filter(Boolean).join(" · ");
      lines.push(`Pré-SMUR : ${preSMUR}`);
    }
    // A — Assessment
    lines.push("");
    lines.push("A — ÉVALUATION");
    const rv = events.find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
    if (rv) lines.push(`Rythme initial SMUR : ${rv.label}`);
    lines.push(`Chocs électriques : ${chocs || "Aucun"}`);
    lines.push(`Adrénaline : ${adrs ? adrs + " × 1 mg = " + adrs + " mg au total" : "Non administrée"}`);
    const cordEvts = events.filter(e => e.id === "cord300" || e.id === "cord150");
    if (cordEvts.length > 0) lines.push(`Amiodarone : ${cordEvts.map(e => e.label).join(" + ")}`);
    if (iot?.sonde) lines.push(`Intubation : sonde ${iot.sonde} mm, repère ${iot.repere || "—"} cm${iot.capno ? `, EtCO₂ initial ${iot.capno} mmHg` : ""}`);
    lines.push(`Issue : ${rosc ? "RACS à " + rosc.time : deces ? deces.label : "Non renseignée"}`);
    // R — Résultat
    lines.push("");
    lines.push("R — RÉSULTAT / ÉTAT ACTUEL");
    if (rosc && hemo && hemo.length > 0) {
      const lastH = hemo[hemo.length - 1];
      const pam = (lastH.pas && lastH.pad)
        ? Math.round(parseFloat(lastH.pad) + (parseFloat(lastH.pas) - parseFloat(lastH.pad)) / 3) : null;
      lines.push(`Hémodynamique : TA ${lastH.pas||"—"}/${lastH.pad||"—"} mmHg · FC ${lastH.fc||"—"} bpm${pam ? ` · PAM ${pam} mmHg` : ""}`);
    }
    if (amines && amines.length > 0) lines.push(`Amines : ${amines.map(a => a.label).join(" + ")}`);
    if (etco2 && etco2.length > 0) lines.push(`EtCO₂ : ${etco2[etco2.length-1].val} mmHg`);
    if (!rosc) lines.push("Pas de RACS obtenu à ce stade.");
    lines.push("");
    lines.push("───────────────────────────────────");
    lines.push("Usage professionnel exclusif");
    lines.push("Outil d'aide cognitive — chaque");
    lines.push("professionnel reste responsable");
    lines.push("de ses prescriptions.");
    return lines.join("\n");
  };

  // ── Génération d'un rapport HTML autonome, structuré et coloré (pour le partage) ──
  const buildHtml = () => {
    const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    // Palette jour (fixe, fidèle au thème clair de l'app)
    const C = {
      bg:"#E9EEF5", surface:"#FFFFFF", surfaceAlt:"#F1F5FA", border:"#C5CFDD", borderSoft:"#E2E8F1",
      text:"#0A111B", textMid:"#46566F", textSoft:"#76869E",
      blue:"#1361DE", blueSoft:"#E7F0FD", blueText:"#0B43A0",
      rose:"#DE1019", roseSoft:"#FDEAEB", roseText:"#A50710",
      amber:"#B67100", amberSoft:"#FBF3E2", amberText:"#8A5500",
      green:"#0C9A54", greenSoft:"#E6F7EE", greenText:"#06713C",
      violet:"#6433C9", violetSoft:"#F0EBFB", violetText:"#491F9C",
      teal:"#0C7B70", tealSoft:"#E4F4F2", tealText:"#085A52",
    };

    const rosc2  = events.find(e => e.id === "rosc");
    const deces2 = events.find(e => e.id === "deces");
    const chocs2 = events.filter(e => e.id === "choc").length;
    const adrs2  = events.filter(e => e.id === "adr").length;
    const cordEvts2 = events.filter(e => e.id === "cord300" || e.id === "cord150");
    const rv2 = events.find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
    const startSec2 = events.find(e => e.id === "start")?.sec || 0;
    const firstChocEvt2 = events.find(e => e.id === "choc" || e.id === "doublechoc");
    const delaiChocSec2 = firstChocEvt2 ? firstChocEvt2.sec - startSec2 : null;
    const patientDesc2 = [
      patient?.nom && patient?.prenom ? `${patient.nom} ${patient.prenom}` : patient?.nom || null,
      patient?.age ? `${patient.age}` : patient?.ddn ? calcAge(patient.ddn) : null,
    ].filter(Boolean).join(", ");
    const lastH2 = (hemo && hemo.length > 0) ? hemo[hemo.length-1] : null;
    const lastPam2 = lastH2 && lastH2.pas && lastH2.pad
      ? Math.round(parseFloat(lastH2.pad) + (parseFloat(lastH2.pas) - parseFloat(lastH2.pad)) / 3) : null;
    const tT = trans;
    const preSMUR2 = tT && [
      tT.temoin && `Témoin : ${tT.temoin}`,
      tT.mceTemoin && `MCE témoin : ${tT.mceTemoin}`,
      (parseInt(tT.chocsPompiers)||0)>0 && `${tT.chocsPompiers} choc(s) DSA pompiers`,
      (parseInt(tT.chocsPublic)||0)>0 && `${tT.chocsPublic} choc(s) DSA public`,
      tT.rythmeDSA && `Rythme initial : ${tT.rythmeDSA}`,
    ].filter(Boolean).join(" · ");

    // ── Mini-graphiques SVG (autonomes, sans JS) ──
    const sparkline = (pts, { color, threshold, unit, w=560, h=130 } = {}) => {
      const padL=34, padR=14, padT=14, padB=22;
      if (!pts || pts.length === 0) return "";
      const vMax = Math.max(...pts.map(p=>p.v), threshold||0) * 1.15 || 10;
      const x = i => pts.length===1 ? (w-padL-padR)/2+padL : padL + (i/(pts.length-1))*(w-padL-padR);
      const y = v => padT + (1 - v/vMax) * (h-padT-padB);
      const path = pts.map((p,i)=>`${i===0?"M":"L"} ${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
      const last = pts[pts.length-1];
      let svg = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block" preserveAspectRatio="none">`;
      svg += `<line x1="${padL}" y1="${h-padB}" x2="${w-padR}" y2="${h-padB}" stroke="${C.border}" stroke-width="1"/>`;
      if (threshold) {
        svg += `<line x1="${padL}" y1="${y(threshold).toFixed(1)}" x2="${w-padR}" y2="${y(threshold).toFixed(1)}" stroke="${C.amber}" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>`;
        svg += `<text x="${padL-4}" y="${y(threshold).toFixed(1)+3}" text-anchor="end" font-size="10" fill="${C.amber}" font-family="monospace">${threshold}</text>`;
      }
      if (pts.length > 1) svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      pts.forEach((p,i) => { svg += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i===pts.length-1?4:2.5}" fill="${i===pts.length-1?color:C.surface}" stroke="${color}" stroke-width="1.5"/>`; });
      svg += `<text x="${x(pts.length-1).toFixed(1)+6}" y="${Math.max(y(last.v)-8,12)}" font-size="13" font-weight="700" fill="${color}" font-family="monospace">${last.v}${unit||""}</text>`;
      svg += `</svg>`;
      return svg;
    };

    const hemoSvg = (pts, amineList) => {
      const w=560,h=150,padL=36,padR=14,padT=14,padB=24;
      const valid = (pts||[]).filter(p=>p.pas||p.pad||p.fc);
      if (valid.length===0) return "";
      const pamPts = valid.filter(p=>p.pas&&p.pad).map(p=>({...p,pam:Math.round(parseFloat(p.pad)+(parseFloat(p.pas)-parseFloat(p.pad))/3)}));
      const vMax=220;
      const x = i => valid.length===1 ? (w-padL-padR)/2+padL : padL + (i/(valid.length-1))*(w-padL-padR);
      const y = v => padT + (1 - v/vMax) * (h-padT-padB);
      const lineOf = (key) => valid.map((p,i)=>p[key]?`${i===0?"M":"L"} ${x(i).toFixed(1)} ${y(parseFloat(p[key])).toFixed(1)}`:"").filter(Boolean).join(" ");
      let svg = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block" preserveAspectRatio="none">`;
      svg += `<line x1="${padL}" y1="${y(65).toFixed(1)}" x2="${w-padR}" y2="${y(65).toFixed(1)}" stroke="${C.amber}" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>`;
      svg += `<text x="${padL-4}" y="${y(65).toFixed(1)+3}" text-anchor="end" font-size="9" fill="${C.amber}" font-family="monospace">PAM65</text>`;
      if (valid.filter(p=>p.pas).length>1) svg += `<path d="${lineOf('pas')}" fill="none" stroke="${C.rose}" stroke-width="2"/>`;
      if (valid.filter(p=>p.pad).length>1) svg += `<path d="${lineOf('pad')}" fill="none" stroke="${C.blue}" stroke-width="2"/>`;
      if (valid.filter(p=>p.fc).length>1)  svg += `<path d="${lineOf('fc')}" fill="none" stroke="${C.violet}" stroke-width="1.5" stroke-dasharray="2 3"/>`;
      svg += `</svg>`;
      svg += `<div style="display:flex;gap:14px;margin-top:4px;flex-wrap:wrap">
        <span style="font-size:10px;font-weight:700;color:${C.rose};font-family:monospace">— PAS</span>
        <span style="font-size:10px;font-weight:700;color:${C.blue};font-family:monospace">— PAD</span>
        <span style="font-size:10px;font-weight:700;color:${C.violet};font-family:monospace">┄ FC</span>
      </div>`;
      return svg;
    };

    const section = (title, color, soft, inner) => `
      <div class="pdf-card" style="background:${C.surface};border:1px solid ${C.border};border-left:4px solid ${color};
        border-radius:12px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(10,17,27,0.06)">
        <p style="margin:0 0 10px;font-size:11px;font-weight:800;color:${color};text-transform:uppercase;
          letter-spacing:0.1em;font-family:'JetBrains Mono',monospace">${title}</p>
        ${inner}
      </div>`;

    const row = (label, value, valColor) => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:1px solid ${C.borderSoft}">
        <span style="font-size:13px;color:${C.textMid}">${esc(label)}</span>
        <span style="font-size:14px;font-weight:700;color:${valColor||C.text};font-family:'JetBrains Mono',monospace">${esc(value)}</span>
      </div>`;

    // Frise chronologique visuelle — repères proportionnels au temps écoulé.
    // Seuls Début / 1er choc / issue finale sont étiquetés en texte (évite toute
    // collision d'étiquettes quel que soit le nombre de gestes du cas) ; les
    // autres gestes (chocs suivants, adrénaline, cordarone, intubation)
    // apparaissent en simples pastilles colorées sur la ligne.
    const timelineHtml = () => {
      if (!totalSec || totalSec <= 0) return "";
      const pct = (sec) => Math.min(100, Math.max(0, ((sec - startSec2) / totalSec) * 100));
      const dots = [];
      events.forEach(e => {
        if (e.id === "start") return;
        if (e.id === "choc" || e.id === "doublechoc") dots.push({ sec:e.sec, icon:"⚡", color:C.blue, time:e.time });
        else if (e.id === "adr") dots.push({ sec:e.sec, icon:"💉", color:C.rose, time:e.time });
        else if (e.id === "cord300" || e.id === "cord150") dots.push({ sec:e.sec, icon:"💊", color:C.amber, time:e.time });
        else if (e.id === "iot") dots.push({ sec:e.sec, icon:"🫁", color:C.violet, time:e.time });
      });
      const finalEvt = rosc2 || deces2;
      if (dots.length === 0 && !finalEvt) return "";

      // Anti-chevauchement : deux gestes trop proches dans le temps sont empilés
      // sur des rangées différentes plutôt que superposés au même endroit.
      const minGapPct = 6;
      const placed_rows = [];
      const placedDots = [...dots].sort((a, b) => a.sec - b.sec).map(d => {
        const p = pct(d.sec);
        let row = 0;
        while (placed_rows.some(o => o.row === row && Math.abs(o.p - p) < minGapPct)) row++;
        placed_rows.push({ p, row });
        return { ...d, p, row };
      });
      const maxRow = placed_rows.reduce((m, o) => Math.max(m, o.row), 0);

      const dotsTop = 16, rowH = 22;
      const dotsBottom = dotsTop + (maxRow + 1) * rowH;
      const ticksY = dotsBottom + 10;
      const containerH = ticksY + 22;

      let h = `<div style="position:relative;height:${containerH}px;margin:10px 4px 6px">`;
      const lastPct = finalEvt ? pct(finalEvt.sec) : Math.max(...dots.map(d => pct(d.sec)));
      h += `<div style="position:absolute;top:24px;left:0;right:0;height:3px;background:${C.borderSoft};border-radius:2px"></div>`;
      h += `<div style="position:absolute;top:24px;left:0;width:${lastPct.toFixed(1)}%;height:3px;background:${finalEvt===rosc2?C.green:C.textMid};border-radius:2px"></div>`;

      // Règle des minutes — 0 = heure de l'arrêt cardiaque (début de la RCP)
      const totalMin = totalSec / 60;
      const tickInterval = totalMin <= 8 ? 1 : totalMin <= 16 ? 2 : totalMin <= 40 ? 5 : 10;
      for (let m = 0; m <= totalMin + 0.01; m += tickInterval) {
        const p = Math.min(100, (m * 60 / totalSec) * 100);
        h += `<div style="position:absolute;left:${p.toFixed(1)}%;top:${ticksY}px;width:1px;height:6px;background:${C.border};transform:translateX(-50%)"></div>`;
        h += `<p style="position:absolute;left:${p.toFixed(1)}%;top:${ticksY+7}px;font-size:8px;color:${C.textSoft};transform:translateX(-50%);white-space:nowrap;font-family:'JetBrains Mono',monospace">${Math.round(m)}min</p>`;
      }

      // Début (= 0 min = heure de l'arrêt cardiaque)
      h += `<div style="position:absolute;left:0%;top:16px;width:19px;height:19px;border-radius:50%;background:${C.textMid};border:2px solid ${C.surface};box-shadow:0 1px 4px rgba(10,17,27,0.2);transform:translateX(-50%)"></div>`;
      h += `<p style="position:absolute;left:0%;top:0;font-size:9px;font-weight:700;color:${C.textMid};transform:translateX(-50%);white-space:nowrap">Début (0 min)</p>`;

      // Gestes intermédiaires, empilés verticalement si trop proches
      placedDots.forEach(d => {
        const top = dotsTop + d.row * rowH;
        h += `<div style="position:absolute;left:${d.p.toFixed(1)}%;top:${top}px;width:19px;height:19px;border-radius:50%;background:${d.color};border:2px solid ${C.surface};box-shadow:0 1px 4px rgba(10,17,27,0.2);transform:translateX(-50%);display:flex;align-items:center;justify-content:center;font-size:10px">${d.icon}</div>`;
      });
      // 1er choc (repère clé du pronostic) + chaque geste empilé — sans heure visible,
      // impossible de distinguer 2 gestes empilés au même endroit sur l'axe.
      const firstChoc = placedDots.filter(d => d.icon === "⚡").sort((a,b) => a.sec - b.sec)[0];
      placedDots.forEach(d => {
        const isFirstChoc = d === firstChoc;
        if (!isFirstChoc && d.row === 0) return; // sur la ligne principale, déjà lisible via la règle des minutes
        const labelTop = dotsTop + d.row * rowH + 20;
        const col = isFirstChoc ? C.blueText : d.color;
        h += `<p style="position:absolute;left:${d.p.toFixed(1)}%;top:${labelTop}px;font-size:8.5px;font-weight:700;color:${col};transform:translateX(-50%);white-space:nowrap">${esc(d.time)}</p>`;
      });
      // Issue finale
      if (finalEvt) {
        const p = pct(finalEvt.sec).toFixed(1);
        const isRosc = finalEvt === rosc2;
        const col = isRosc ? C.greenText : C.textSoft;
        const lbl = isRosc ? `RACS ${finalEvt.time}` : finalEvt.label;
        h += `<div style="position:absolute;left:${p}%;top:14px;width:23px;height:23px;border-radius:50%;background:${isRosc?C.green:C.textMid};border:2.5px solid ${C.surface};box-shadow:0 2px 6px rgba(10,17,27,0.25);transform:translateX(-50%);display:flex;align-items:center;justify-content:center;font-size:11px">${isRosc?"✅":"⬛"}</div>`;
        h += `<p style="position:absolute;left:${p}%;top:0;font-size:9.5px;font-weight:800;color:${col};transform:translateX(-50%);white-space:nowrap">${esc(lbl)}</p>`;
      }
      h += `</div>`;
      h += `<p style="margin:4px 0 0;font-size:9.5px;color:${C.textSoft};text-align:center">Minutes écoulées depuis l'arrêt cardiaque (0 min = début RCP)</p>`;
      return h;
    };

    let html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compte-rendu SMUR${patient?.nom ? " — "+esc(patient.nom) : ""}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Archivo:wght@800;900&family=JetBrains+Mono:wght@600;700&display=swap');
  * { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { margin:0; background:${C.bg}; font-family:'Inter',system-ui,sans-serif; color:${C.text};
    padding:20px 14px 40px; }
  .wrap { max-width:640px; margin:0 auto; }
</style></head><body><div class="wrap">

  <!-- En-tête -->
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
    <div style="width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,${C.rose},${C.roseText});
      display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0">❤️‍🩹</div>
    <div>
      <p style="margin:0;font-size:10px;font-weight:800;color:${C.rose};text-transform:uppercase;
        letter-spacing:0.14em;font-family:'JetBrains Mono',monospace">Copilote ACR · Aide cognitive SMUR</p>
      <p style="margin:0;font-size:21px;font-weight:900;color:${C.text};font-family:'Archivo',sans-serif;letter-spacing:-0.02em">
        Compte-rendu de réanimation</p>
      <p style="margin:0;font-size:11px;color:${C.textSoft}">${new Date().toLocaleDateString("fr-FR")} · ${getNow()}</p>
    </div>
  </div>

  <!-- Identité patient compacte, tout en haut -->
  ${(patient?.nom || patient?.prenom || patient?.age || patient?.ddn) ? `
  <div class="pdf-card" style="background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:12px 16px;margin-bottom:14px;
    display:flex;align-items:center;gap:12px;box-shadow:0 1px 3px rgba(10,17,27,0.06)">
    <span style="font-size:20px;flex-shrink:0">🪪</span>
    <div style="flex:1;min-width:0">
      <p style="margin:0;font-size:16px;font-weight:800;color:${C.text};font-family:'Archivo',sans-serif;letter-spacing:-0.01em">${esc([patient.nom,patient.prenom].filter(Boolean).join(" ") || "Patient non identifié")}</p>
      <p style="margin:0;font-size:12px;color:${C.textSoft};font-family:'JetBrains Mono',monospace">${[patient.age && `${esc(patient.age)}`, patient.ddn && `né(e) le ${esc(new Date(patient.ddn).toLocaleDateString("fr-FR"))}`].filter(Boolean).join(" · ") || "—"}</p>
    </div>
  </div>` : ""}

  <!-- Bandeau "coup d'œil" -->
  <div class="pdf-card" style="background:linear-gradient(135deg,${rosc2?C.green:deces2?C.textMid:C.amber},${rosc2?C.greenText:deces2?C.text:C.amberText});
    border-radius:16px;padding:18px 20px;margin-bottom:16px;box-shadow:0 6px 20px rgba(10,17,27,0.2)">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <span style="font-size:28px">${rosc2?"✅":deces2?"⬛":"❓"}</span>
      <div>
        <p style="margin:0;font-size:10px;font-weight:800;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:0.12em;font-family:'JetBrains Mono',monospace">Issue</p>
        <p style="margin:0;font-size:22px;font-weight:900;color:#fff;font-family:'Archivo',sans-serif;letter-spacing:-0.01em">${esc(rosc2?`RACS obtenu à ${rosc2.time}`:deces2?deces2.label:"Non stabilisé à ce stade")}</p>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px">
      ${[["Durée RCP",fmtSec(totalSec)],["No-flow",noFlow?noFlow+" min":"—"],["Low-flow",lowFlow?lowFlow+" min":"—"],["Délai 1er choc",delaiChocSec2!==null?fmtSec(delaiChocSec2):"—"]].map(([l,v])=>`
      <div style="background:rgba(255,255,255,0.15);border-radius:10px;padding:8px 6px;text-align:center">
        <p style="margin:0;font-size:17px;font-weight:800;color:#fff;font-family:'JetBrains Mono',monospace">${esc(v)}</p>
        <p style="margin:0;font-size:9px;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:0.06em">${esc(l)}</p>
      </div>`).join("")}
    </div>
  </div>

  <!-- Frise chronologique visuelle -->
  ${(() => { const tl = timelineHtml(); return tl ? section("🕐 Frise chronologique", C.blue, C.blueSoft, tl) : ""; })()}`;

    // SBAR — résumé de transmission, remonté juste après la frise (avant le détail)
    const sbarRows = [
      { L:"S", title:"Situation", c:C.rose, soft:C.roseSoft, lines:[
        `${patientDesc2||"Patient"} · ACR extra-hospitalier${LIEUX_INTERVENTION.find(l => l.id === trans?.lieu)?.label ? " · " + LIEUX_INTERVENTION.find(l => l.id === trans.lieu).label : ""}`,
        `Heure arrêt : ${acrTime||"inconnue"} · No-flow : ${noFlow||"?"}min · Low-flow : ${lowFlow||"—"}min · Durée : ${fmtSec(totalSec)}`,
      ]},
      { L:"B", title:"Contexte", c:C.blue, soft:C.blueSoft, lines:[
        MECANISMES_TRAUMA.find(m => m.id === patient?.mecanisme)?.label && `Mécanisme : ${MECANISMES_TRAUMA.find(m => m.id === patient.mecanisme).label}`,
        patient?.atcd && `ATCD : ${patient.atcd}`,
        patient?.histoire && `Circonstances : ${patient.histoire}`,
        patient?.temp && `Température : ${patient.temp} °C`,
        preSMUR2 && `Pré-SMUR : ${preSMUR2}`,
      ].filter(Boolean)},
      { L:"A", title:"Évaluation", c:C.amber, soft:C.amberSoft, lines:[
        rv2 && `Rythme initial SMUR : ${rv2.label}`,
        chocs2 ? `${chocs2} choc(s) électrique(s)` : "Aucun choc",
        adrs2 ? `Adrénaline : ${adrs2} × 1 mg = ${adrs2} mg` : "Adrénaline non administrée",
        cordEvts2.length>0 && cordEvts2.map(e=>e.label).join(" + "),
        iot?.sonde && `Intubation : sonde ${iot.sonde} mm · repère ${iot.repere||"—"} cm${iot.capno?` · EtCO₂ initial ${iot.capno} mmHg`:""}`,
        rosc2 ? `RACS à ${rosc2.time}` : deces2 ? deces2.label : "Issue non renseignée",
      ].filter(Boolean)},
      { L:"R", title:"Résultat / État actuel", c:C.green, soft:C.greenSoft, lines:[
        lastH2 && `Hémodynamique : TA ${lastH2.pas||"—"}/${lastH2.pad||"—"} mmHg · FC ${lastH2.fc||"—"} bpm${lastPam2?` · PAM ${lastPam2} mmHg`:""}`,
        amines&&amines.length>0 && `Amines : ${amines.map(a=>a.label).join(" + ")}`,
        etco2&&etco2.length>0 && `EtCO₂ : ${etco2[etco2.length-1].val} mmHg`,
        !rosc2 && "Pas de RACS obtenu à ce stade.",
      ].filter(Boolean)},
    ];
    html += `<div style="margin-bottom:14px">
      <p style="margin:0 0 10px;font-size:13px;font-weight:800;color:${C.text};font-family:'Archivo',sans-serif">
        📢 Résumé de transmission (SBAR)</p>
      ${sbarRows.map(r => `
        <div class="pdf-card" style="display:flex;gap:10px;background:${r.soft};border:1px solid ${r.c}33;border-radius:11px;
          padding:11px 13px;margin-bottom:8px">
          <div style="width:28px;height:28px;border-radius:9px;background:${r.c};flex-shrink:0;
            display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;
            font-family:'JetBrains Mono',monospace;font-size:13px">${r.L}</div>
          <div style="flex:1;min-width:0">
            <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:${r.c};text-transform:uppercase;
              letter-spacing:0.1em;font-family:'JetBrains Mono',monospace">${r.title}</p>
            ${r.lines.length>0 ? r.lines.map((l,i)=>`<p style="margin:${i===0?0:"2px"} 0 0;font-size:13px;
              font-weight:${i===0?700:400};color:${C.text};line-height:1.5">${esc(l)}</p>`).join("")
              : `<p style="margin:0;font-size:12px;color:${C.textSoft};font-style:italic">Non renseigné</p>`}
          </div>
        </div>`).join("")}
    </div>
    <p style="text-align:center;font-size:10.5px;color:${C.textSoft};margin:0 0 16px;text-transform:uppercase;letter-spacing:0.08em;font-family:'JetBrains Mono',monospace">— Détail complet ci-dessous —</p>`;

    // Identité
    if (patient?.nom || patient?.prenom || patient?.age || patient?.atcd || patient?.histoire || patient?.mecanisme) {
      const mecLabel = MECANISMES_TRAUMA.find(m => m.id === patient.mecanisme)?.label;
      html += section("🪪 Identité patient", C.blue, C.blueSoft, `
        ${(patient.nom||patient.prenom) ? row("Nom", [patient.nom,patient.prenom].filter(Boolean).join(" ")) : ""}
        ${patient.age ? row("Âge", patient.age) : ""}
        ${mecLabel ? row("Mécanisme lésionnel", mecLabel) : ""}
        ${patient.atcd ? row("ATCD", patient.atcd) : ""}
        ${patient.histoire ? row("Circonstances", patient.histoire) : ""}
      `);
    }

    // Contexte de transmission (lieu, témoin) — affiché dès qu'une info est renseignée
    const lieuLabel2 = LIEUX_INTERVENTION.find(l => l.id === trans?.lieu)?.label;
    if (lieuLabel2 || trans?.temoin || trans?.mceTemoin) {
      html += section("📻 Contexte de transmission", C.amber, C.amberSoft, `
        ${lieuLabel2 ? row("Lieu de l'intervention", lieuLabel2) : ""}
        ${trans.temoin ? row("Témoin de l'effondrement", trans.temoin) : ""}
        ${trans.mceTemoin ? row("MCE par témoin", trans.mceTemoin) : ""}
      `);
    }

    // Données RCP
    html += section("🫀 Données de réanimation", C.rose, C.roseSoft, `
      ${row("Heure ACR", acrTime || "Inconnue")}
      ${row("No-flow", noFlow ? noFlow+" min" : "Inconnu")}
      ${row("Low-flow", lowFlow ? lowFlow+" min" : "—")}
      ${row("Durée RCP", fmtSec(totalSec))}
      ${row("Chocs électriques", chocs2 || "Aucun")}
      ${row("Adrénaline", adrs2 ? adrs2+" × 1 mg = "+adrs2+" mg" : "Non administrée")}
      ${row("Issue", rosc2 ? "RACS à "+rosc2.time : deces2 ? deces2.label : "Non renseignée", rosc2?C.greenText:deces2?C.textSoft:C.amberText)}
    `);

    // Intubation
    if (iot?.sonde) {
      html += section("🫁 Intubation oro-trachéale", C.violet, C.violetSoft, `
        ${iot.cormack ? row("Cormack", iot.cormack) : ""}
        ${row("Sonde", iot.sonde+" mm")}
        ${iot.repere ? row("Repère", iot.repere+" cm") : ""}
        ${iot.capno ? row("EtCO₂ initial", iot.capno+" mmHg") : ""}
      `);
    }

    // Hemocue
    if (hemocue && hemocue.length > 0) {
      const hPts = hemocue.map(h => ({ v: parseFloat(String(h.val).replace(",",".")) })).filter(p=>!isNaN(p.v));
      html += section("🩸 Hemocue (Hb)", C.rose, C.roseSoft,
        sparkline(hPts, { color:C.rose, threshold:7, unit:" g/dL" }) +
        `<div style="margin-top:8px">` + hemocue.map(h => row(h.time, h.val+" g/dL")).join("") + `</div>`
      );
    }

    // Pré-SMUR
    if (preSMUR2) {
      html += section("📋 Phase pré-SMUR", C.slate || C.textSoft, C.surfaceAlt, `
        <p style="margin:0;font-size:13px;color:${C.textMid};line-height:1.6">${esc(preSMUR2)}</p>
      `);
    }

    // EtCO2
    if (etco2 && etco2.length > 0) {
      const ePts = etco2.map(e => ({ v: parseFloat(String(e.val).replace(",",".")) })).filter(p=>!isNaN(p.v));
      html += section("📈 EtCO₂ — capnographie", C.teal, C.tealSoft,
        sparkline(ePts, { color:C.teal, threshold:10, unit:" mmHg" })
      );
    }

    // Hémodynamique post-RACS
    if (hemo && hemo.length > 0) {
      html += section("💓 Hémodynamique post-RACS", C.green, C.greenSoft,
        hemoSvg(hemo, amines) +
        (lastPam2 !== null ? `<p style="margin:8px 0 0;font-size:13px;font-weight:700;color:${lastPam2<65?C.roseText:C.greenText}">PAM actuelle : ${lastPam2} mmHg</p>` : "") +
        (amines && amines.length>0 ? `<div style="margin-top:8px">` + amines.map(a=>row(a.time, a.label)).join("") + `</div>` : "")
      );
    }

    // Chronologie
    html += section(`🕐 Chronologie (${events.length} événements)`, C.blue, C.blueSoft,
      `<div style="border:1px solid ${C.borderSoft};border-radius:8px;overflow:hidden">` +
      events.map((e,i) => `
        <div class="pdf-card" style="display:flex;gap:10px;align-items:center;padding:7px 10px;
          background:${i%2===0?C.surface:C.surfaceAlt}">
          <span style="font-family:'JetBrains Mono',monospace;color:${C.blueText};font-weight:700;font-size:12px;flex-shrink:0">${esc(e.time)}</span>
          <span style="font-size:13px;color:${C.text};flex:1">${esc(e.label)}</span>
        </div>`).join("") +
      `</div>`
    );

    html += `
      <p style="text-align:center;font-size:10px;color:${C.textSoft};margin-top:18px;font-style:italic;line-height:1.6">
        Usage professionnel exclusif · Outil d'aide cognitive — chaque professionnel demeure
        responsable de ses prescriptions et décisions thérapeutiques.
      </p>
    </div></body></html>`;

    return html;
  };

  const handleShare = async () => {
    const text = buildText();
    const html = buildHtml();
    const date = new Date().toISOString().slice(0,10);
    const nom  = patient?.nom ? `_${patient.nom}` : "";
    const filenameHtml = `Compte-rendu-SMUR${nom}_${date}.html`;
    const filenameTxt  = `ACR${nom}_${date}.txt`;

    // Méthode 1 : Web Share API — partage le rapport HTML coloré et structuré
    if (navigator.share) {
      try {
        const fileHtml = new File([html], filenameHtml, { type: "text/html" });
        if (navigator.canShare && navigator.canShare({ files: [fileHtml] })) {
          await navigator.share({ files: [fileHtml], title: "Compte-rendu SMUR" });
          return;
        }
        // Si le partage de fichier HTML n'est pas supporté, tenter le texte brut en fichier
        const fileTxt = new File([text], filenameTxt, { type: "text/plain" });
        if (navigator.canShare && navigator.canShare({ files: [fileTxt] })) {
          await navigator.share({ files: [fileTxt], title: "Compte-rendu ACR" });
          return;
        }
        // Partage sans fichier (texte seul)
        await navigator.share({ title: "Compte-rendu ACR", text });
        return;
      } catch (e) {
        if (e.name !== "AbortError") console.error(e);
        else return;
      }
    }

    // Méthode 2 : téléchargement du rapport HTML coloré (fallback Android / desktop)
    try {
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameHtml;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    } catch(e) {}

    // Méthode 3 : ouvrir le rapport HTML coloré dans un nouvel onglet (dernier recours)
    const w = window.open("", "_blank");
    if (w) {
      w.document.write(html);
      w.document.close();
    }
  };

  const handleCopy = () => {
    const text = buildText();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }).catch(() => {
        // Fallback pour les contextes sans clipboard API
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const Section = ({ title, children }) => (
    <div style={{ marginBottom:14 }}>
      <p style={{ margin:"0 0 6px", fontSize:9, fontWeight:600, color:P.textSoft,
        textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>{title}</p>
      {children}
    </div>
  );

  const Field = ({ label, value }) => value ? (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
      padding:"6px 0", borderBottom:`1px solid ${P.borderSoft}`, gap:8 }}>
      <span style={{ fontSize:12, color:P.textMid }}>{label}</span>
      <span style={{ fontSize:13, fontWeight:600, color:P.text, fontFamily:mono,
        textAlign:"right", flexShrink:0 }}>{value}</span>
    </div>
  ) : null;

  return (
    <div className="acr-pdfview" style={{ position:"fixed", inset:0, background:P.bg, zIndex:60,
      overflowY:"auto", fontFamily:sans, boxSizing:"border-box" }}>

      {/* Header sticky */}
      <div className="acr-pdfview-header" style={{ position:"sticky", top:0, background:P.surface,
        borderBottom:`1px solid ${P.border}`, padding:"12px 14px",
        display:"flex", alignItems:"center", gap:8,
        zIndex:10, boxShadow:"0 2px 8px rgba(0,0,0,0.06)" }}>
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ margin:0, fontSize:14, fontWeight:700, color:P.text, fontFamily:disp }}>Compte-rendu SMUR</p>
          <p style={{ margin:0, fontSize:10, color:P.textSoft, fontFamily:mono }}>
            {new Date().toLocaleDateString("fr-FR")} · {getNow()}
          </p>
        </div>
        <button className="acr-no-print" onClick={onClose}
          style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`,
            borderRadius:10, padding:"8px 12px", cursor:"pointer",
            fontFamily:sans, fontSize:12, fontWeight:500, color:P.textMid, flexShrink:0 }}>
          ← Retour
        </button>
      </div>

      <div style={{ padding:"16px 14px 100px", maxWidth:600, margin:"0 auto",
        boxSizing:"border-box", width:"100%" }}>

        {/* Patient */}
        {(patient?.nom || patient?.prenom || patient?.ddn || patient?.age) && (
          <div style={{ background:P.tealSoft, border:`1px solid #B2DADA`,
            borderRadius:12, padding:"12px 14px", marginBottom:14 }}>
            <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:600, color:P.tealText,
              textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Patient</p>
            <p style={{ margin:0, fontSize:16, fontWeight:700, color:P.text }}>
              {[patient.nom, patient.prenom].filter(Boolean).join(" ") || "—"}
            </p>
            <p style={{ margin:"3px 0 0", fontSize:12, color:P.textMid }}>
              {[
                patient.ddn && `Né(e) le ${new Date(patient.ddn).toLocaleDateString("fr-FR")}`,
                patient.age,
                patient.sexe
              ].filter(Boolean).join(" · ")}
            </p>
          </div>
        )}

        {/* Données RCP */}
        <Section title="Données RCP">
          <div style={{ background:P.surface, border:`1px solid ${P.border}`,
            borderRadius:12, padding:"4px 14px" }}>
            <Field label="Heure ACR"         value={acrTime || "Inconnue"} />
            <Field label="Température"        value={patient?.temp ? `${patient.temp} °C` : null} />
            <Field label="No-flow"           value={noFlow  ? `${noFlow} min` : "Inconnu"} />
            <Field label="Low-flow"          value={lowFlow ? `${lowFlow} min` : null} />
            <Field label="Durée RCP"         value={fmtSec(totalSec)} />
            <Field label="Chocs électriques" value={chocs ? `${chocs} choc(s)` : "Aucun"} />
            <Field label="Adrénaline"        value={adrs ? `${adrs} × 1 mg` : "Non administrée"} />
            <Field label="Issue"             value={rosc ? `✓ ROSC — ${rosc.time}` : deces ? deces.label : "Non renseignée"} />
          </div>
        </Section>

        {/* IOT */}
        {iot?.sonde && (
          <Section title="Intubation oro-trachéale">
            <div style={{ background:P.violetSoft, border:`1px solid #C4BBEE`,
              borderRadius:12, padding:"4px 14px" }}>
              {iot.cormack && <Field label="Cormack" value={iot.cormack} />}
              <Field label="Sonde"  value={`${iot.sonde} mm`} />
              {iot.repere && <Field label="Repère"  value={`${iot.repere} cm`} />}
              {iot.capno  && <Field label="EtCO₂"   value={`${iot.capno} mmHg`} />}
            </div>
          </Section>
        )}

        {patient?.atcd && (
          <Section title="Antécédents">
            <p style={{ margin:0, fontSize:13, color:P.textMid, background:P.surfaceAlt,
              borderRadius:9, padding:"9px 12px", lineHeight:1.6 }}>{patient.atcd}</p>
          </Section>
        )}
        {patient?.histoire && (
          <Section title="Histoire de la maladie">
            <p style={{ margin:0, fontSize:13, color:P.textMid, background:P.surfaceAlt,
              borderRadius:9, padding:"9px 12px", lineHeight:1.6 }}>{patient.histoire}</p>
          </Section>
        )}

        {/* Phase pré-SMUR — transmission équipes */}
        {(() => {
          const t = trans;
          const hasTrans = t && (t.saved || t.hEffondrement || t.hArriveePompiers || t.hPoseDSA ||
            t.h1erChoc || t.temoin || t.mceTemoin || (parseInt(t.chocsPompiers)||0) > 0 || (parseInt(t.chocsPublic)||0) > 0 || t.rythmeDSA || t.gestesSecouristes || t.note);
          if (!hasTrans) return null;
          const rythmeLabel = { choquable:"Choquable", nonChoquable:"Non choquable", nonAnalyse:"Non analysé" };
          return (
            <Section title="Phase pré-SMUR (équipes en place)">
              <div style={{ background:P.amberSoft, border:`1px solid #F5C99E`, borderRadius:12, padding:"4px 14px" }}>
                {t.hEffondrement    && <Field label="Heure de l'ACR"     value={t.hEffondrement} />}
                {t.temoin           && <Field label="Témoin"             value={t.temoin} />}
                {t.mceTemoin        && <Field label="MCE par témoin"     value={t.mceTemoin} />}
                {t.hArriveePompiers && <Field label="Arrivée pompiers"   value={t.hArriveePompiers} />}
                {t.hPoseDSA         && <Field label="Pose DSA"           value={t.hPoseDSA} />}
                {t.rythmeDSA        && <Field label="Rythme initial"     value={rythmeLabel[t.rythmeDSA] || t.rythmeDSA} />}
                {t.h1erChoc         && <Field label="1er choc"           value={t.h1erChoc} />}
                {(parseInt(t.chocsPompiers)||0) > 0 && <Field label="Chocs DSA pompiers" value={String(t.chocsPompiers)} />}
                {(parseInt(t.chocsPublic)||0) > 0 && <Field label="Chocs DSA public" value={String(t.chocsPublic)} />}
                {t.note             && <Field label="Note pré-SMUR"      value={t.note} />}
              </div>
            </Section>
          );
        })()}

        {/* Hemocue — suivi Hb */}
        {hemocue && hemocue.length > 0 && (
          <Section title="Hemocue (Hb)">
            {/* Courbe Hb */}
            <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"8px 10px", marginBottom:10 }}>
              <div style={{ display:"flex", gap:14, marginBottom:5 }}>
                {[{c:P.rose,l:"Hb (g/dL)"},{c:P.green,l:"12 g/dL",dash:true},{c:P.rose,l:"7 g/dL",dash:true}].map(({c,l,dash},i)=>(
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:3 }}>
                    <svg width="14" height="8" viewBox="0 0 14 8"><line x1="0" y1="4" x2="14" y2="4" stroke={c} strokeWidth={dash?1.5:2.5} strokeDasharray={dash?"3 2":undefined} /></svg>
                    <span style={{ fontSize:8.5, color:c, fontFamily:mono, fontWeight:700 }}>{l}</span>
                  </div>
                ))}
                <span style={{ fontSize:8.5, color:P.textSoft, fontFamily:mono, marginLeft:"auto" }}>0 min = heure de l'arrêt</span>
              </div>
              <HemocueCurve data={hemocue} P={P} mono={mono} refSec={0} />
            </div>
            <div style={{ border:`1px solid ${P.border}`, borderRadius:12, overflow:"hidden" }}>
              {hemocue.map((h, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"7px 14px", background: i%2===0 ? P.surface : P.surfaceAlt }}>
                  <span style={{ fontSize:12, color:P.textSoft, fontFamily:mono }}>{h.time}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:P.text, fontFamily:mono }}>{h.val} g/dL</span>
                </div>
              ))}
              {hemocue.length >= 2 && (() => {
                const last = parseFloat(String(hemocue[hemocue.length-1].val).replace(",", "."));
                const prev = parseFloat(String(hemocue[hemocue.length-2].val).replace(",", "."));
                const first = parseFloat(String(hemocue[0].val).replace(",", "."));
                if (isNaN(last) || isNaN(prev)) return null;
                const d = Math.round((last - prev) * 10) / 10;
                const dg = !isNaN(first) ? Math.round((last - first) * 10) / 10 : null;
                return (
                  <div style={{ padding:"8px 14px", background:P.violetSoft,
                    borderTop:`1px solid ${P.border}` }}>
                    <p style={{ margin:0, fontSize:12, fontWeight:700, color: d < 0 ? P.roseText : P.greenText }}>
                      Écart 2 dernières : {d > 0 ? "+" : ""}{String(d).replace(".", ",")} g/dL {d < 0 ? "↓" : d > 0 ? "↑" : "→"}
                    </p>
                    {dg !== null && (
                      <p style={{ margin:"2px 0 0", fontSize:11, color:P.textMid }}>
                        Tendance globale : {dg > 0 ? "+" : ""}{String(dg).replace(".", ",")} g/dL sur {hemocue.length} mesures
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          </Section>
        )}

        {/* Hémodynamique post-RACS */}
        {hemo && hemo.length > 0 && (
          <Section title="Hémodynamique post-RACS">
            <div style={{ border:`1px solid ${P.border}`, borderRadius:12, overflow:"hidden", marginBottom:10 }}>
              <div style={{ display:"grid", gridTemplateColumns:"auto 1fr 1fr 1fr 1fr 1fr" }}>
                {["Heure","PAS","PAD","PAM","FC","SI"].map((h,i)=>(
                  <div key={h} style={{ padding:"5px 8px", background:P.surfaceAlt, fontSize:10,
                    fontWeight:700, color:P.textSoft, fontFamily:mono, borderBottom:`1px solid ${P.border}`,
                    textAlign:i===0?"left":"center" }}>{h}</div>
                ))}
                {hemo.map((m,i)=>{
                  const pam=(m.pas&&m.pad)?Math.round(parseFloat(m.pad)+(parseFloat(m.pas)-parseFloat(m.pad))/3):"—";
                  const si=(m.fc&&m.pas)?Math.round(parseFloat(m.fc)/parseFloat(m.pas)*100)/100:"—";
                  const siC=typeof si==="number"?(si<0.9?P.greenText:si<=1.4?P.amberText:P.roseText):P.text;
                  return [
                    <div key={`t${i}`} style={{ padding:"6px 8px",background:i%2===0?P.surface:P.surfaceAlt,
                      fontSize:11,color:P.textSoft,fontFamily:mono,borderBottom:`1px solid ${P.border}` }}>{m.time}</div>,
                    ...[m.pas,m.pad,pam,m.fc].map((v,j)=>(
                      <div key={`v${i}${j}`} style={{ padding:"6px 4px",background:i%2===0?P.surface:P.surfaceAlt,
                        fontSize:13,fontWeight:700,fontFamily:mono,textAlign:"center",
                        color:j===2&&typeof pam==="number"?(pam<65?P.roseText:P.greenText):P.text,
                        borderBottom:`1px solid ${P.border}` }}>{v||"—"}</div>
                    )),
                    <div key={`si${i}`} style={{ padding:"6px 4px",background:i%2===0?P.surface:P.surfaceAlt,
                      fontSize:12,fontWeight:800,fontFamily:mono,textAlign:"center",color:siC,
                      borderBottom:`1px solid ${P.border}` }}>{si||"—"}</div>
                  ];
                })}
              </div>
            </div>
            {amines && amines.length > 0 && (
              <div>
                <p style={{ margin:"0 0 5px",fontSize:10,fontWeight:700,color:P.textSoft,fontFamily:mono,letterSpacing:"0.1em" }}>AMINES VASOACTIVES</p>
                {amines.map((a,i)=>(
                  <div key={i} style={{ display:"flex",justifyContent:"space-between",
                    padding:"6px 12px",background:i%2===0?P.greenSoft:P.surface,
                    borderRadius:8,marginBottom:3,border:`1px solid ${P.border}` }}>
                    <span style={{ fontSize:11,fontWeight:700,color:P.text }}>{a.label}</span>
                    <span style={{ fontSize:11,color:P.textSoft,fontFamily:mono }}>{a.time}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {/* EtCO₂ — courbe capnographie */}
        {etco2 && etco2.length > 0 && (
          <Section title="EtCO₂ — capnographie">
            <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"8px 10px", marginBottom:10 }}>
              <div style={{ display:"flex", gap:16, marginBottom:6 }}>
                {[{c:P.teal,l:"EtCO₂"},{c:P.amber,l:"Seuil 10 mmHg",dash:true}].map(({c,l,dash})=>(
                  <div key={l} style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <svg width="18" height="8" viewBox="0 0 18 8"><line x1="0" y1="4" x2="18" y2="4" stroke={c} strokeWidth="2" strokeDasharray={dash?"3 3":undefined} /></svg>
                    <span style={{ fontSize:9, color:c, fontFamily:mono, fontWeight:700 }}>{l}</span>
                  </div>
                ))}
                <span style={{ fontSize:9, color:P.textSoft, fontFamily:mono, marginLeft:"auto" }}>0 min = heure de l'arrêt</span>
              </div>
              <Etco2Curve data={etco2} P={P} mono={mono} refSec={0} />
            </div>
            <div style={{ border:`1px solid ${P.border}`, borderRadius:10, overflow:"hidden" }}>
              {etco2.map((e, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between",
                  padding:"5px 12px", background:i%2===0?P.surface:P.surfaceAlt,
                  borderBottom:`1px solid ${P.border}` }}>
                  <span style={{ fontSize:11, color:P.textSoft, fontFamily:mono }}>{e.time}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:P.tealText, fontFamily:mono }}>{e.val} mmHg</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Hémodynamique post-RACS — courbe */}
        {hemo && hemo.length > 0 && (
          <Section title="Hémodynamique post-RACS — courbe">
            <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"8px 10px", marginBottom:8 }}>
              <div style={{ display:"flex", gap:12, marginBottom:6, flexWrap:"wrap" }}>
                {[{c:P.rose,l:"PAS"},{c:P.blue,l:"PAD"},{c:P.amber,l:"PAM",dash:true},{c:P.violet,l:"FC",dot:true}].map(({c,l,dash,dot})=>(
                  <div key={l} style={{ display:"flex", alignItems:"center", gap:3 }}>
                    <svg width="18" height="8" viewBox="0 0 18 8"><line x1="0" y1="4" x2="18" y2="4" stroke={c} strokeWidth="2" strokeDasharray={dash?"5 3":dot?"2 3":undefined} /></svg>
                    <span style={{ fontSize:9, fontWeight:700, color:c, fontFamily:mono }}>{l}</span>
                  </div>
                ))}
                <span style={{ fontSize:9, color:P.textSoft, fontFamily:mono, marginLeft:"auto" }}>0 min = heure du RACS</span>
              </div>
              <HemoCurve hemoList={hemo} amineList={amines} P={P} mono={mono}
                refSec={events.find(e=>e.id==="rosc")?.sec||0} />
            </div>
          </Section>
        )}

        {/* Chronologie */}
        <Section title={`Chronologie (${events.length} événements)`}>
          <div style={{ border:`1px solid ${P.border}`, borderRadius:12, overflow:"hidden" }}>
            {events.length === 0 && (
              <p style={{ margin:0, padding:"12px 14px", fontSize:12, color:P.textSoft }}>
                Aucun événement
              </p>
            )}
            {events.map((e, i) => (
              <div key={i} style={{ display:"flex", gap:10, padding:"8px 14px",
                background: i%2===0 ? P.surface : P.surfaceAlt, alignItems:"center",
                overflow:"hidden" }}>
                <span style={{ fontFamily:mono, color:P.blue, fontWeight:600,
                  fontSize:11, flexShrink:0 }}>{e.time}</span>
                <span style={{ fontSize:12, color:P.textMid, flex:1, minWidth:0,
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {e.icon} {e.label}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* ── SBAR Transmission au réanimateur ── */}
        <Section title="Transmission SBAR — au réanimateur">
          {(() => {
            const patientDesc = [
              patient?.nom && patient?.prenom ? `${patient.nom} ${patient.prenom}` : patient?.nom,
              patient?.age || (patient?.ddn ? calcAge(patient.ddn) : null),
            ].filter(Boolean).join(", ");
            const cordEvts = events.filter(e => e.id==="cord300"||e.id==="cord150");
            const rv = events.find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
            const lastH = (hemo&&hemo.length>0) ? hemo[hemo.length-1] : null;
            const lastPam = lastH&&lastH.pas&&lastH.pad
              ? Math.round(parseFloat(lastH.pad)+(parseFloat(lastH.pas)-parseFloat(lastH.pad))/3) : null;
            const t = trans;
            const preSMUR = t && [
              t.temoin && `Témoin : ${t.temoin}`,
              t.mceTemoin && `MCE témoin : ${t.mceTemoin}`,
              (parseInt(t.chocsPompiers)||0)>0 && `${t.chocsPompiers} choc(s) DSA pompiers`,
              (parseInt(t.chocsPublic)||0)>0 && `${t.chocsPublic} choc(s) DSA public`,
              t.rythmeDSA && `Rythme initial : ${t.rythmeDSA}`,
            ].filter(Boolean).join(" · ");
            const rows = [
              {
                label:"S", title:"Situation", c:P.rose, soft:P.roseSoft,
                lines:[
                  `${patientDesc || "Patient"} · ACR extra-hospitalier`,
                  `Heure arrêt : ${acrTime||"inconnue"} · No-flow : ${noFlow||"?"}min · Low-flow : ${lowFlow||"—"}min · Durée : ${fmtSec(totalSec)}`,
                ].filter(Boolean),
              },
              {
                label:"B", title:"Contexte", c:P.blue, soft:P.blueSoft,
                lines:[
                  patient?.atcd && `ATCD : ${patient.atcd}`,
                  patient?.histoire && `Circonstances : ${patient.histoire}`,
                  patient?.temp && `Température : ${patient.temp} °C`,
                  preSMUR && `Pré-SMUR : ${preSMUR}`,
                ].filter(Boolean),
              },
              {
                label:"A", title:"Évaluation", c:P.amber, soft:P.amberSoft,
                lines:[
                  rv && `Rythme initial SMUR : ${rv.label}`,
                  chocs ? `${chocs} choc(s) électrique(s)` : "Aucun choc",
                  adrs ? `Adrénaline : ${adrs} × 1 mg = ${adrs} mg` : "Adrénaline non administrée",
                  cordEvts.length>0 && cordEvts.map(e=>e.label).join(" + "),
                  iot?.sonde && `Intubation : sonde ${iot.sonde} mm · repère ${iot.repere||"—"} cm${iot.capno?` · EtCO₂ initial ${iot.capno} mmHg`:""}`,
                  rosc ? `RACS à ${rosc.time}` : deces ? deces.label : "Issue non renseignée",
                ].filter(Boolean),
              },
              {
                label:"R", title:"Résultat / État actuel", c:P.green, soft:P.greenSoft,
                lines:[
                  lastH && `Hémodynamique : TA ${lastH.pas||"—"}/${lastH.pad||"—"} mmHg · FC ${lastH.fc||"—"} bpm${lastPam?` · PAM ${lastPam} mmHg`:""}`,
                  amines&&amines.length>0 && `Amines : ${amines.map(a=>a.label).join(" + ")}`,
                  etco2&&etco2.length>0 && `EtCO₂ : ${etco2[etco2.length-1].val} mmHg`,
                  !rosc && "Pas de RACS obtenu à ce stade.",
                ].filter(Boolean),
              },
            ];
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {rows.map(r => (
                  <div key={r.label} style={{ display:"flex", gap:10, background:r.soft,
                    borderRadius:11, padding:"10px 12px", border:`1px solid color-mix(in srgb, ${r.c} 30%, transparent)` }}>
                    <div style={{ width:28, height:28, borderRadius:9, background:r.c,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      color:"#fff", fontSize:13, fontWeight:900, fontFamily:mono, flexShrink:0, marginTop:1 }}>
                      {r.label}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ margin:"0 0 4px", fontSize:10, fontWeight:700, color:r.c,
                        textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>{r.title}</p>
                      {r.lines.map((l, i) => (
                        <p key={i} style={{ margin:i===0?"0":"2px 0 0", fontSize:12, fontWeight: i===0?700:400,
                          color:P.text, lineHeight:1.5 }}>{l}</p>
                      ))}
                      {r.lines.length===0 && <p style={{ margin:0, fontSize:12, color:P.textSoft, fontStyle:"italic" }}>Non renseigné</p>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Section>

      </div>

      {/* ── Séparateur entre le premier et le deuxième bloc d'affichage ── */}
      <div className="acr-pdfview-header" style={{ position:"sticky", top:0, background:P.surface,
        borderBottom:`1px solid ${P.border}`, padding:"12px 14px",
        display:"flex", alignItems:"center", gap:8,
        zIndex:10, boxShadow:"0 2px 8px rgba(0,0,0,0.06)" }}>
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ margin:0, fontSize:14, fontWeight:700, color:P.text, fontFamily:disp }}>Compte-rendu SMUR</p>
          <p style={{ margin:0, fontSize:10, color:P.textSoft, fontFamily:mono }}>
            {new Date().toLocaleDateString("fr-FR")} · {getNow()}
          </p>
        </div>
        <button className="acr-no-print" onClick={onClose}
          style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`,
            borderRadius:10, padding:"8px 12px", cursor:"pointer",
            fontFamily:sans, fontSize:12, fontWeight:500, color:P.textMid, flexShrink:0 }}>
          ← Retour
        </button>
      </div>

      <div style={{ padding:"16px 14px 110px", maxWidth:600, margin:"0 auto", boxSizing:"border-box", width:"100%" }}>

        {/* Patient */}
        {(patient?.nom || patient?.prenom || patient?.ddn || patient?.age) && (
          <div style={{ background:P.tealSoft, border:`1px solid #B2DADA`, borderRadius:12,
            padding:"12px 14px", marginBottom:14 }}>
            <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:600, color:P.tealText,
              textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Patient</p>
            <p style={{ margin:0, fontSize:16, fontWeight:700, color:P.text }}>
              {[patient.nom, patient.prenom].filter(Boolean).join(" ") || "—"}
            </p>
            <p style={{ margin:"3px 0 0", fontSize:12, color:P.textMid }}>
              {[
                patient.ddn && `Né(e) le ${new Date(patient.ddn).toLocaleDateString("fr-FR")}`,
                patient.age && `${patient.age}`,
                patient.sexe
              ].filter(Boolean).join(" · ")}
            </p>
          </div>
        )}

        {/* Données RCP */}
        <Section title="Données RCP">
          <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:12, padding:"4px 14px" }}>
            <Field label="Heure ACR"    value={acrTime || "Inconnue"} />
            <Field label="No-flow"      value={noFlow  ? `${noFlow} min` : "Inconnu"} />
            <Field label="Low-flow"     value={lowFlow ? `${lowFlow} min` : null} />
            <Field label="Durée RCP"    value={fmtSec(totalSec)} />
            <Field label="Chocs électriques" value={chocs ? `${chocs} choc(s)` : "Aucun"} />
            <Field label="Adrénaline"   value={adrs ? `${adrs} × 1 mg` : "Non administrée"} />
            <Field label="Issue"        value={rosc ? `✓ ROSC — ${rosc.time}` : deces ? deces.label : "Non renseignée"} />
          </div>
        </Section>

        {/* IOT */}
        {iot?.sonde && (
          <Section title="Intubation oro-trachéale">
            <div style={{ background:P.violetSoft, border:`1px solid #C4BBEE`, borderRadius:12, padding:"4px 14px" }}>
              {iot.cormack && <Field label="Cormack" value={iot.cormack} />}
              <Field label="Sonde"  value={`${iot.sonde} mm`} />
              {iot.repere && <Field label="Repère"  value={`${iot.repere} cm`} />}
              {iot.capno  && <Field label="EtCO₂"   value={`${iot.capno} mmHg`} />}
            </div>
          </Section>
        )}

        {/* Antécédents / Histoire */}
        {patient?.atcd && (
          <Section title="Antécédents">
            <p style={{ margin:0, fontSize:13, color:P.textMid, background:P.surfaceAlt,
              borderRadius:9, padding:"9px 12px", lineHeight:1.6 }}>{patient.atcd}</p>
          </Section>
        )}
        {patient?.histoire && (
          <Section title="Histoire de la maladie">
            <p style={{ margin:0, fontSize:13, color:P.textMid, background:P.surfaceAlt,
              borderRadius:9, padding:"9px 12px", lineHeight:1.6 }}>{patient.histoire}</p>
          </Section>
        )}

        {/* Phase pré-SMUR — transmission équipes */}
        {(() => {
          const t = trans;
          const hasTrans = t && (t.saved || t.hEffondrement || t.hArriveePompiers || t.hPoseDSA ||
            t.h1erChoc || t.temoin || t.mceTemoin || (parseInt(t.chocsPompiers)||0) > 0 || (parseInt(t.chocsPublic)||0) > 0 || t.rythmeDSA || t.gestesSecouristes || t.note);
          if (!hasTrans) return null;
          const rythmeLabel = { choquable:"Choquable", nonChoquable:"Non choquable", nonAnalyse:"Non analysé" };
          return (
            <Section title="Phase pré-SMUR (équipes en place)">
              <div style={{ background:P.amberSoft, border:`1px solid #F5C99E`, borderRadius:12, padding:"4px 14px" }}>
                {t.hEffondrement    && <Field label="Heure de l'ACR"     value={t.hEffondrement} />}
                {t.temoin           && <Field label="Témoin"             value={t.temoin} />}
                {t.mceTemoin        && <Field label="MCE par témoin"     value={t.mceTemoin} />}
                {t.hArriveePompiers && <Field label="Arrivée pompiers"   value={t.hArriveePompiers} />}
                {t.hPoseDSA         && <Field label="Pose DSA"           value={t.hPoseDSA} />}
                {t.rythmeDSA        && <Field label="Rythme initial"     value={rythmeLabel[t.rythmeDSA] || t.rythmeDSA} />}
                {t.h1erChoc         && <Field label="1er choc"           value={t.h1erChoc} />}
                {(parseInt(t.chocsPompiers)||0) > 0 && <Field label="Chocs DSA pompiers" value={String(t.chocsPompiers)} />}
                {(parseInt(t.chocsPublic)||0) > 0 && <Field label="Chocs DSA public" value={String(t.chocsPublic)} />}
                {t.note             && <Field label="Note pré-SMUR"      value={t.note} />}
              </div>
            </Section>
          );
        })()}

        {/* Hemocue — suivi Hb */}
        {hemocue && hemocue.length > 0 && (
          <Section title="Hemocue (Hb)">
            {/* Courbe Hb */}
            <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"8px 10px", marginBottom:10 }}>
              <div style={{ display:"flex", gap:14, marginBottom:5 }}>
                {[{c:P.rose,l:"Hb (g/dL)"},{c:P.green,l:"12 g/dL",dash:true},{c:P.rose,l:"7 g/dL",dash:true}].map(({c,l,dash},i)=>(
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:3 }}>
                    <svg width="14" height="8" viewBox="0 0 14 8"><line x1="0" y1="4" x2="14" y2="4" stroke={c} strokeWidth={dash?1.5:2.5} strokeDasharray={dash?"3 2":undefined} /></svg>
                    <span style={{ fontSize:8.5, color:c, fontFamily:mono, fontWeight:700 }}>{l}</span>
                  </div>
                ))}
                <span style={{ fontSize:8.5, color:P.textSoft, fontFamily:mono, marginLeft:"auto" }}>0 min = heure de l'arrêt</span>
              </div>
              <HemocueCurve data={hemocue} P={P} mono={mono} refSec={0} />
            </div>
            <div style={{ border:`1px solid ${P.border}`, borderRadius:12, overflow:"hidden" }}>
              {hemocue.map((h, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"7px 14px", background: i%2===0 ? P.surface : P.surfaceAlt }}>
                  <span style={{ fontSize:12, color:P.textSoft, fontFamily:mono }}>{h.time}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:P.text, fontFamily:mono }}>{h.val} g/dL</span>
                </div>
              ))}
              {hemocue.length >= 2 && (() => {
                const last = parseFloat(String(hemocue[hemocue.length-1].val).replace(",", "."));
                const prev = parseFloat(String(hemocue[hemocue.length-2].val).replace(",", "."));
                const first = parseFloat(String(hemocue[0].val).replace(",", "."));
                if (isNaN(last) || isNaN(prev)) return null;
                const d = Math.round((last - prev) * 10) / 10;
                const dg = !isNaN(first) ? Math.round((last - first) * 10) / 10 : null;
                return (
                  <div style={{ padding:"8px 14px", background:P.violetSoft,
                    borderTop:`1px solid ${P.border}` }}>
                    <p style={{ margin:0, fontSize:12, fontWeight:700, color: d < 0 ? P.roseText : P.greenText }}>
                      Écart 2 dernières : {d > 0 ? "+" : ""}{String(d).replace(".", ",")} g/dL {d < 0 ? "↓" : d > 0 ? "↑" : "→"}
                    </p>
                    {dg !== null && (
                      <p style={{ margin:"2px 0 0", fontSize:11, color:P.textMid }}>
                        Tendance globale : {dg > 0 ? "+" : ""}{String(dg).replace(".", ",")} g/dL sur {hemocue.length} mesures
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          </Section>
        )}

        {/* EtCO₂ — courbe capnographie */}
        {etco2 && etco2.length > 0 && (
          <Section title="EtCO₂ — capnographie">
            <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"8px 10px", marginBottom:10 }}>
              <div style={{ display:"flex", gap:16, marginBottom:6 }}>
                {[{c:P.teal,l:"EtCO₂"},{c:P.amber,l:"Seuil 10 mmHg",dash:true}].map(({c,l,dash})=>(
                  <div key={l} style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <svg width="18" height="8" viewBox="0 0 18 8"><line x1="0" y1="4" x2="18" y2="4" stroke={c} strokeWidth="2" strokeDasharray={dash?"3 3":undefined} /></svg>
                    <span style={{ fontSize:9, color:c, fontFamily:mono, fontWeight:700 }}>{l}</span>
                  </div>
                ))}
                <span style={{ fontSize:9, color:P.textSoft, fontFamily:mono, marginLeft:"auto" }}>0 min = heure de l'arrêt</span>
              </div>
              <Etco2Curve data={etco2} P={P} mono={mono} refSec={0} />
            </div>
            <div style={{ border:`1px solid ${P.border}`, borderRadius:10, overflow:"hidden" }}>
              {etco2.map((e, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between",
                  padding:"5px 12px", background:i%2===0?P.surface:P.surfaceAlt,
                  borderBottom:`1px solid ${P.border}` }}>
                  <span style={{ fontSize:11, color:P.textSoft, fontFamily:mono }}>{e.time}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:P.tealText, fontFamily:mono }}>{e.val} mmHg</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Hémodynamique post-RACS — courbe */}
        {hemo && hemo.length > 0 && (
          <Section title="Hémodynamique post-RACS — courbe">
            <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"8px 10px", marginBottom:8 }}>
              <div style={{ display:"flex", gap:12, marginBottom:6, flexWrap:"wrap" }}>
                {[{c:P.rose,l:"PAS"},{c:P.blue,l:"PAD"},{c:P.amber,l:"PAM",dash:true},{c:P.violet,l:"FC",dot:true}].map(({c,l,dash,dot})=>(
                  <div key={l} style={{ display:"flex", alignItems:"center", gap:3 }}>
                    <svg width="18" height="8" viewBox="0 0 18 8"><line x1="0" y1="4" x2="18" y2="4" stroke={c} strokeWidth="2" strokeDasharray={dash?"5 3":dot?"2 3":undefined} /></svg>
                    <span style={{ fontSize:9, fontWeight:700, color:c, fontFamily:mono }}>{l}</span>
                  </div>
                ))}
                <span style={{ fontSize:9, color:P.textSoft, fontFamily:mono, marginLeft:"auto" }}>0 min = heure du RACS</span>
              </div>
              <HemoCurve hemoList={hemo} amineList={amines} P={P} mono={mono}
                refSec={events.find(e=>e.id==="rosc")?.sec||0} />
            </div>
          </Section>
        )}

        {/* Chronologie */}
        <Section title={`Chronologie (${events.length} événements)`}>
          <div style={{ border:`1px solid ${P.border}`, borderRadius:12, overflow:"hidden" }}>
            {events.length === 0 && (
              <p style={{ margin:0, padding:"12px 14px", fontSize:12, color:P.textSoft }}>Aucun événement</p>
            )}
            {events.map((e, i) => (
              <div key={i} style={{ display:"flex", gap:10, padding:"8px 14px",
                background: i%2===0 ? P.surface : P.surfaceAlt,
                alignItems:"center", overflow:"hidden" }}>
                <span style={{ fontFamily:mono, color:P.blue, fontWeight:600,
                  fontSize:11, flexShrink:0 }}>{e.time}</span>
                <span style={{ fontSize:12, color:P.textMid, flex:1, minWidth:0,
                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {e.icon} {e.label}
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* Résumé texte */}
        <Section title="Transmission SBAR — au réanimateur">
          {(() => {
            const patientDesc = [
              patient?.nom && patient?.prenom ? `${patient.nom} ${patient.prenom}` : patient?.nom,
              patient?.age || (patient?.ddn ? calcAge(patient.ddn) : null),
            ].filter(Boolean).join(", ");
            const cordEvts = events.filter(e => e.id==="cord300"||e.id==="cord150");
            const rv = events.find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
            const lastH = (hemo&&hemo.length>0) ? hemo[hemo.length-1] : null;
            const lastPam = lastH&&lastH.pas&&lastH.pad
              ? Math.round(parseFloat(lastH.pad)+(parseFloat(lastH.pas)-parseFloat(lastH.pad))/3) : null;
            const t = trans;
            const preSMUR = t && [
              t.temoin && `Témoin : ${t.temoin}`,
              t.mceTemoin && `MCE témoin : ${t.mceTemoin}`,
              (parseInt(t.chocsPompiers)||0)>0 && `${t.chocsPompiers} choc(s) DSA pompiers`,
              (parseInt(t.chocsPublic)||0)>0 && `${t.chocsPublic} choc(s) DSA public`,
              t.rythmeDSA && `Rythme initial : ${t.rythmeDSA}`,
            ].filter(Boolean).join(" · ");
            const rows = [
              { label:"S", title:"Situation", c:P.rose, soft:P.roseSoft, lines:[
                `${patientDesc||"Patient"} · ACR extra-hospitalier`,
                `Heure arrêt : ${acrTime||"inconnue"} · No-flow : ${noFlow||"?"}min · Low-flow : ${lowFlow||"—"}min · Durée : ${fmtSec(totalSec)}`,
              ]},
              { label:"B", title:"Contexte", c:P.blue, soft:P.blueSoft, lines:[
                patient?.atcd && `ATCD : ${patient.atcd}`,
                patient?.histoire && `Circonstances : ${patient.histoire}`,
                patient?.temp && `Température : ${patient.temp} °C`,
                preSMUR && `Pré-SMUR : ${preSMUR}`,
              ].filter(Boolean)},
              { label:"A", title:"Évaluation", c:P.amber, soft:P.amberSoft, lines:[
                rv && `Rythme initial SMUR : ${rv.label}`,
                chocs ? `${chocs} choc(s) électrique(s)` : "Aucun choc",
                adrs ? `Adrénaline : ${adrs} × 1 mg = ${adrs} mg` : "Adrénaline non administrée",
                cordEvts.length>0 && cordEvts.map(e=>e.label).join(" + "),
                iot?.sonde && `Intubation : sonde ${iot.sonde} mm · repère ${iot.repere||"—"} cm${iot.capno?` · EtCO₂ initial ${iot.capno} mmHg`:""}`,
                rosc ? `RACS à ${rosc.time}` : deces ? deces.label : "Issue non renseignée",
              ].filter(Boolean)},
              { label:"R", title:"Résultat / État actuel", c:P.green, soft:P.greenSoft, lines:[
                lastH && `Hémodynamique : TA ${lastH.pas||"—"}/${lastH.pad||"—"} mmHg · FC ${lastH.fc||"—"} bpm${lastPam?` · PAM ${lastPam} mmHg`:""}`,
                amines&&amines.length>0 && `Amines : ${amines.map(a=>a.label).join(" + ")}`,
                etco2&&etco2.length>0 && `EtCO₂ : ${etco2[etco2.length-1].val} mmHg`,
                !rosc && "Pas de RACS obtenu à ce stade.",
              ].filter(Boolean)},
            ];
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {rows.map(r => (
                  <div key={r.label} style={{ display:"flex", gap:10, background:r.soft,
                    borderRadius:11, padding:"10px 12px", border:`1px solid color-mix(in srgb, ${r.c} 30%, transparent)` }}>
                    <div style={{ width:28, height:28, borderRadius:9, background:r.c,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      color:"#fff", fontSize:13, fontWeight:900, fontFamily:mono, flexShrink:0, marginTop:1 }}>
                      {r.label}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ margin:"0 0 4px", fontSize:10, fontWeight:700, color:r.c,
                        textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>{r.title}</p>
                      {r.lines.map((l, i) => (
                        <p key={i} style={{ margin:i===0?"0":"2px 0 0", fontSize:12, fontWeight:i===0?700:400,
                          color:P.text, lineHeight:1.5 }}>{l}</p>
                      ))}
                      {r.lines.length===0 && <p style={{ margin:0, fontSize:12, color:P.textSoft, fontStyle:"italic" }}>Non renseigné</p>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Section>

        <p style={{ textAlign:"center", fontSize:9, color:P.textSoft, marginTop:8, fontStyle:"italic" }}>
          Usage professionnel exclusif · Outil d'aide cognitive — chaque professionnel demeure responsable de ses prescriptions
        </p>

      </div>

      {/* ── Barre fixe en bas : PDF / Partager / Copier ── */}
      <div className="acr-no-print" style={{
        position:"fixed", bottom:0, left:0, right:0, zIndex:20,
        background:P.surface, borderTop:`1px solid ${P.border}`,
        padding:"10px 14px 14px", boxShadow:"0 -4px 18px rgba(0,0,0,0.10)" }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, maxWidth:600, margin:"0 auto" }}>
          <button onClick={async () => {
            try {
              const html = buildHtml();
              const { default: jsPDF } = await import('jspdf');
              const { default: html2canvas } = await import('html2canvas');
              // Créer un iframe invisible pour rendre le HTML
              const iframe = document.createElement('iframe');
              iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:640px;height:1px;opacity:0;border:none';
              document.body.appendChild(iframe);
              iframe.contentDocument.write(html);
              iframe.contentDocument.close();
              await new Promise(r => setTimeout(r, 600));
              const canvas = await html2canvas(iframe.contentDocument.body, {
                scale: 1.5, useCORS: true, allowTaint: true,
                backgroundColor: '#E9EEF5', width: 640,
                height: iframe.contentDocument.body.scrollHeight
              });
              // Repère la position (en pixels canvas) de chaque carte du compte-rendu,
              // pour ne jamais couper une page en plein milieu de l'une d'elles.
              const scale = 1.5;
              const cards = Array.from(iframe.contentDocument.querySelectorAll('.pdf-card')).map(el => {
                const r = el.getBoundingClientRect();
                return { top: r.top * scale, bottom: r.bottom * scale };
              });
              document.body.removeChild(iframe);
              const pdf = new jsPDF({ format: 'a4', orientation: 'portrait', unit: 'pt' });
              const w = pdf.internal.pageSize.getWidth();
              const ratio = canvas.width / w;
              const pageH = pdf.internal.pageSize.getHeight() * ratio;
              const minChunk = pageH * 0.25; // évite une page quasi vide si une carte est très grande
              let srcY = 0;
              while (srcY < canvas.height) {
                let sliceEnd = Math.min(srcY + pageH, canvas.height);
                for (const c of cards) {
                  // Une carte commencée sur cette page mais qui déborderait de la coupure :
                  // on recule la coupure juste avant elle, sauf si ça laisserait une page trop vide.
                  if (c.top > srcY && c.top < sliceEnd && c.bottom > sliceEnd) {
                    if (c.top - srcY >= minChunk) sliceEnd = Math.min(sliceEnd, c.top);
                  }
                }
                const pageCanvas = document.createElement('canvas');
                pageCanvas.width = canvas.width;
                pageCanvas.height = sliceEnd - srcY;
                pageCanvas.getContext('2d').drawImage(canvas, 0, srcY, canvas.width, pageCanvas.height, 0, 0, canvas.width, pageCanvas.height);
                if (srcY > 0) pdf.addPage();
                pdf.addImage(pageCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, w, pageCanvas.height / ratio);
                srcY = sliceEnd;
              }
              const nom = patient?.nom ? `_${patient.nom}` : '';
              pdf.save(`CR-SMUR${nom}_${new Date().toISOString().slice(0,10)}.pdf`);
            } catch(e) {
              // Fallback : impression navigateur
              window.print();
            }
          }}
            style={{ background:`linear-gradient(135deg, ${P.blue}, ${P.blueText})`,
              border:"none", borderRadius:13, padding:"13px 8px", cursor:"pointer",
              fontFamily:disp, fontSize:13, fontWeight:800, color:"#fff",
              display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              boxShadow:`0 5px 14px color-mix(in srgb, ${P.blue} 30%, transparent)` }}>
            🖨️ PDF
          </button>
          <button onClick={handleShare}
            style={{ background:`linear-gradient(135deg, ${P.teal}, ${P.tealText})`,
              border:"none", borderRadius:13, padding:"13px 8px", cursor:"pointer",
              fontFamily:disp, fontSize:13, fontWeight:800, color:"#fff",
              display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              boxShadow:`0 5px 14px color-mix(in srgb, ${P.teal} 30%, transparent)` }}>
            📤 Partager
          </button>
          <button onClick={handleCopy}
            style={{ background: copied
              ? `linear-gradient(135deg, ${P.green}, ${P.greenText})`
              : P.surfaceAlt,
              border: copied ? "none" : `1px solid ${P.border}`,
              borderRadius:13, padding:"13px 8px", cursor:"pointer",
              fontFamily:disp, fontSize:13, fontWeight:800,
              color: copied ? "#fff" : P.text,
              display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              boxShadow: copied ? `0 5px 14px color-mix(in srgb, ${P.green} 30%, transparent)` : "none",
              transition:"all 0.2s" }}>
            {copied ? "✓ Copié" : "📋 Copier"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── REMPLISSAGE VASCULAIRE ────────────────────────────────────────────────────

const VOLUMES_RAPIDES = [100, 250, 500, 1000];
const SOLUTES = ["NaCl 0,9%", "Ringer Lactate", "Isofundine", "Autre"];

function RemplissageSection({ racs, setRacs }) {
  const [vol,     setVol]     = useState(500);
  const [sol,     setSol]     = useState("NaCl 0,9%");
  const [autre,   setAutre]   = useState("");

  const total = (racs.remplissages || []).reduce((s,r) => s + r.vol, 0);

  const ajouter = () => {
    const solLabel = sol === "Autre" ? (autre || "Autre") : sol;
    const entry = { vol, sol: solLabel, time: getNow() };
    setRacs(p => ({ ...p, remplissages: [...(p.remplissages||[]), entry] }));
    if (sol === "Autre") setAutre("");
  };

  const retirer = (i) =>
    setRacs(p => ({ ...p, remplissages: p.remplissages.filter((_,idx) => idx !== i) }));

  return (
    <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px", marginBottom:10 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <p style={{ margin:0, fontSize:9, fontWeight:500, color:P.textSoft,
          textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>
          Remplissage vasculaire
        </p>
        {total > 0 && (
          <span style={{ fontSize:13, fontWeight:700, color:P.blueText, fontFamily:mono }}>
            Total : {total} mL
          </span>
        )}
      </div>

      {/* Molette volume */}
      <div style={{ display:"flex", gap:6, marginBottom:8 }}>
        {VOLUMES_RAPIDES.map(v => (
          <button key={v} onClick={() => setVol(v)}
            style={{ flex:1, padding:"7px 4px", borderRadius:9, fontSize:13, fontWeight:700,
              border:`1.5px solid ${vol===v ? P.blue : P.border}`,
              background: vol===v ? P.blueSoft : P.surface,
              color: vol===v ? P.blueText : P.textMid,
              cursor:"pointer", fontFamily:mono }}>
            {v}
          </button>
        ))}
      </div>
      <p style={{ margin:"0 0 8px", fontSize:9, color:P.textSoft, textAlign:"center", fontFamily:mono }}>mL</p>

      {/* Choix soluté */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:8 }}>
        {SOLUTES.map(s => (
          <button key={s} onClick={() => setSol(s)}
            style={{ padding:"7px 6px", borderRadius:9, fontSize:11, fontWeight:500,
              border:`1.5px solid ${sol===s ? P.teal : P.border}`,
              background: sol===s ? P.tealSoft : P.surface,
              color: sol===s ? P.tealText : P.textMid,
              cursor:"pointer", fontFamily:sans }}>
            {s}
          </button>
        ))}
      </div>

      {sol === "Autre" && (
        <input value={autre} onChange={e => setAutre(e.target.value)}
          placeholder="Préciser le soluté..."
          style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
            borderRadius:8, padding:"8px 10px", fontSize:13, color:P.text, fontFamily:sans,
            boxSizing:"border-box", outline:"none", marginBottom:8 }}
          onFocus={e => e.target.style.borderColor = P.teal}
          onBlur={e  => e.target.style.borderColor = P.border} />
      )}

      {/* Bouton ajouter */}
      <button onClick={ajouter}
        style={{ width:"100%", background:`linear-gradient(135deg,${P.blue},${P.blueText})`,
          border:"none", borderRadius:9, padding:"10px", color:"#fff",
          fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:sans,
          boxShadow:`0 3px 10px color-mix(in srgb, ${P.blue} 20%, transparent)`, marginBottom: (racs.remplissages||[]).length>0 ? 10 : 0 }}>
        + Ajouter {vol} mL {sol !== "Autre" ? sol : (autre || "Autre")}
      </button>

      {/* Liste des remplissages */}
      {(racs.remplissages||[]).length > 0 && (
        <div style={{ borderTop:`1px solid ${P.border}`, paddingTop:8 }}>
          {racs.remplissages.map((r, i) => (
            <div key={i} style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"5px 0", borderBottom: i<racs.remplissages.length-1 ? `1px solid ${P.borderSoft}` : "none" }}>
              <span style={{ fontSize:12, color:P.textMid }}>{r.time} · {r.vol} mL {r.sol}</span>
              <button onClick={() => retirer(i)}
                style={{ background:"transparent", border:"none", color:P.textSoft,
                  cursor:"pointer", fontSize:14, padding:"0 4px", lineHeight:1 }}>✕</button>
            </div>
          ))}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
            marginTop:8, padding:"7px 10px",
            background:P.blueSoft, borderRadius:8, border:`1px solid color-mix(in srgb, ${P.blue} 27%, transparent)` }}>
            <span style={{ fontSize:11, color:P.textSoft }}>Total remplissage</span>
            <span style={{ fontSize:17, fontWeight:700, color:P.blueText, fontFamily:mono }}>{total} mL</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MODULE PÉDIATRIQUE ────────────────────────────────────────────────────────

// Table de référence exacte — source : tableau pédiatrique de référence SMUR
// Colonnes : poids, masque, sondeAspi(Ch), lame, mandrin, sondeIOT, repere, guedel, fr, vt, defibJ, adrMg, amioMg
// Colonnes normes post-RACS : fc, pas, pamTC, pamHorsTC, vtRange, frRange, ie, peep, sng, fio2
const PED_TABLE = [
  // Sédation : midPSE = vitesse PSE midazolam mL/h (0.1mg/kg/h) | sufBolus = bolus sufentanyl mL (0.2μg/kg) | sufPSE = PSE sufentanyl mL/h (0.2μg/kg/h)
  { age:"NN",       p:3,  masque:"00-0",  aspi:"6",    lame:"Dte 0/1", mandrin:"6",      sonde:"3",   repere:9,  guedel:"00", fr:25, vt:"BAVU",  ezio:"E-ZIO 15mm",         adrMg:0.05, adrMl:0.5, amioMg:15,  amioMl:0.5, defib4:12,  defib6:18,  defib8:24,  fcN:135, pasN:60,  pamTC:45, pamHTC:35, vtR:"30-50",  frR:"40",  ie:"1/2", peep:5, sng:6,  fio2:"100% puis QSP 94-98%", midPSE:0.3, sufBolus:0.6, sufPSE:0.6 , nimbex1:0.9, nimbex2:0.45, rempliVol:30, rempliDebit:12, adrPSE1:1.8, adrPSE2:4.5, adrPSE3:9, adrPSE4:13.5 },
  { age:"NN",       p:4,  masque:"00-0",  aspi:"6",    lame:"Dte 0/1", mandrin:"6",      sonde:"3",   repere:9,  guedel:"00", fr:25, vt:"BAVU",  ezio:"E-ZIO 15mm",         adrMg:0.05, adrMl:0.5, amioMg:20,  amioMl:0.5, defib4:16,  defib6:24,  defib8:32,  fcN:130, pasN:60,  pamTC:45, pamHTC:35, vtR:"30-50",  frR:"40",  ie:"1/2", peep:5, sng:6,  fio2:"100% puis QSP 94-98%", midPSE:0.4, sufBolus:0.8, sufPSE:0.8 , nimbex1:1.2, nimbex2:0.4, rempliVol:40, rempliDebit:16, adrPSE1:2.4, adrPSE2:6, adrPSE3:12, adrPSE4:18 },
  { age:"3 mois",   p:5,  masque:"0-1",  aspi:"6",  lame:"Dte 0/1", mandrin:"6",      sonde:"3.5", repere:10, guedel:"0",   fr:25, vt:"BAVU",  ezio:"E-ZIO 15mm",         adrMg:0.05, adrMl:0.5, amioMg:25,  amioMl:0.5, defib4:20,  defib6:30,  defib8:40,  fcN:120, pasN:80,  pamTC:55, pamHTC:40, vtR:"30",     frR:"40",  ie:"1/2", peep:5, sng:6,  fio2:"100% puis QSP 94-98%", midPSE:0.5, sufBolus:1.0, sufPSE:1.0 , nimbex1:1.5, nimbex2:0.5, rempliVol:50, rempliDebit:20, adrPSE1:3, adrPSE2:7.5, adrPSE3:15, adrPSE4:22.5 },
  { age:"4-5 mois", p:6,  masque:"0-1",  aspi:"6-8",  lame:"1",       mandrin:"6",      sonde:"3.5", repere:10, guedel:"0",   fr:25, vt:50,  ezio:"E-ZIO 25mm",         adrMg:0.1,  adrMl:1,   amioMg:30,  amioMl:1,   defib4:25,  defib6:36,  defib8:50,  fcN:120, pasN:80,  pamTC:55, pamHTC:40, vtR:"25-30",  frR:"25",  ie:"1/2", peep:5, sng:8,  fio2:"100% puis QSP 94-98%", midPSE:0.6, sufBolus:1.2, sufPSE:1.2 , nimbex1:1.8, nimbex2:0.6, rempliVol:60, rempliDebit:24, adrPSE1:3.6, adrPSE2:9, adrPSE3:18, adrPSE4:27 },
  { age:"6 mois",   p:7,  masque:"0-1",  aspi:"6-8",  lame:"1",       mandrin:"6",      sonde:"3.5", repere:10, guedel:"0",   fr:25, vt:50,  ezio:"E-ZIO 25mm",         adrMg:0.1,  adrMl:1,   amioMg:35,  amioMl:1,   defib4:30,  defib6:42,  defib8:60,  fcN:120, pasN:80,  pamTC:55, pamHTC:40, vtR:"25-30",  frR:"25",  ie:"1/2", peep:5, sng:8,  fio2:"100% puis QSP 94-98%", midPSE:0.7, sufBolus:1.4, sufPSE:1.4 , nimbex1:2, nimbex2:0.7, rempliVol:70, rempliDebit:28, adrPSE1:4.2, adrPSE2:10.5, adrPSE3:21, adrPSE4:31.5 },
  { age:"8 mois",   p:8,  masque:"0-1",  aspi:"6-8",  lame:"1",       mandrin:"6",      sonde:"3.5", repere:11, guedel:"0",   fr:25, vt:50,  ezio:"E-ZIO 25mm",         adrMg:0.1,  adrMl:1,   amioMg:40,  amioMl:1,   defib4:35,  defib6:48,  defib8:70,  fcN:115, pasN:80,  pamTC:55, pamHTC:40, vtR:"25-30",  frR:"25",  ie:"1/2", peep:5, sng:8,  fio2:"100% puis QSP 94-98%", midPSE:0.8, sufBolus:1.6, sufPSE:1.6 , nimbex1:2.4, nimbex2:0.8, rempliVol:80, rempliDebit:32, adrPSE1:4.8, adrPSE2:12, adrPSE3:24, adrPSE4:36 },
  { age:"12 mois",  p:10, masque:"1-2",  aspi:"8",    lame:"1",       mandrin:"10",     sonde:"4",   repere:11, guedel:"1",   fr:20, vt:60,  ezio:"E-ZIO 25mm",         adrMg:0.1,  adrMl:1,   amioMg:50,  amioMl:1,   defib4:40,  defib6:60,  defib8:80,  fcN:110, pasN:90,  pamTC:55, pamHTC:40, vtR:"25-30",  frR:"25",  ie:"1/2", peep:5, sng:8,  fio2:"100% puis QSP 94-98%", midPSE:1.0, sufBolus:2.0, sufPSE:2.0 , nimbex1:3, nimbex2:1, rempliVol:100, rempliDebit:40, adrPSE1:6, adrPSE2:15, adrPSE3:30, adrPSE4:45 },
  { age:"18 mois",  p:11, masque:"1-2",  aspi:"8",    lame:"1-2",     mandrin:"10",     sonde:"4",   repere:12, guedel:"1",   fr:20, vt:66,  ezio:"E-ZIO 25mm",         adrMg:0.10, adrMl:1.0, amioMg:55,  amioMl:1.5, defib4:45,  defib6:66,  defib8:90,  fcN:110, pasN:90,  pamTC:57, pamHTC:42, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.1, sufBolus:2.2, sufPSE:2.2 , nimbex1:3.3, nimbex2:1.1, rempliVol:110, rempliDebit:40, adrPSE1:1.3, adrPSE2:3.3, adrPSE3:6.6, adrPSE4:9.9 },
  { age:"2 ans",    p:12, masque:"1-2",  aspi:"8",    lame:"1-2",     mandrin:"10",     sonde:"4",   repere:12, guedel:"1",   fr:20, vt:72,  ezio:"E-ZIO 25mm",         adrMg:0.10, adrMl:1.0, amioMg:60,  amioMl:1.5, defib4:50,  defib6:72,  defib8:100, fcN:110, pasN:100, pamTC:58, pamHTC:43, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.2, sufBolus:2.4, sufPSE:2.4 , nimbex1:3.6, nimbex2:1.2, rempliVol:120, rempliDebit:40, adrPSE1:1.4, adrPSE2:3.6, adrPSE3:7.2, adrPSE4:10.8 },
  { age:"3 ans",    p:14, masque:"3",  aspi:"8",    lame:"1-2",     mandrin:"10",     sonde:"4",   repere:13, guedel:"1",   fr:20, vt:84,  ezio:"E-ZIO 25mm",         adrMg:0.15, adrMl:1.5, amioMg:70,  amioMl:1.5, defib4:55,  defib6:84,  defib8:110, fcN:105, pasN:100, pamTC:60, pamHTC:45, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.4, sufBolus:2.8, sufPSE:2.8 , nimbex1:4.2, nimbex2:1.4, rempliVol:140, rempliDebit:40, adrPSE1:1.7, adrPSE2:4.2, adrPSE3:8.4, adrPSE4:12.6 },
  { age:"4 ans",    p:15, masque:"3",    aspi:"8-10", lame:"1-2",     mandrin:"10",     sonde:"4.5", repere:14, guedel:"1",   fr:20, vt:90,  ezio:"E-ZIO 25mm",         adrMg:0.15, adrMl:1.5, amioMg:75,  amioMl:1.5, defib4:60,  defib6:90,  defib8:120, fcN:105, pasN:100, pamTC:61, pamHTC:46, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.5, sufBolus:3.0, sufPSE:3.0 , nimbex1:4.5, nimbex2:1.5, rempliVol:150, rempliDebit:40, adrPSE1:1.8, adrPSE2:4.5, adrPSE3:9, adrPSE4:13.5 },
  { age:"5 ans",    p:17, masque:"3",    aspi:"8-10", lame:"1-2",     mandrin:"10",     sonde:"4.5", repere:14, guedel:"1",   fr:20, vt:102, ezio:"E-ZIO 25mm",         adrMg:0.15, adrMl:1.5, amioMg:85,  amioMl:2,   defib4:70,  defib6:102, defib8:140, fcN:105, pasN:105, pamTC:63, pamHTC:48, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.7, sufBolus:3.4, sufPSE:3.4 , nimbex1:5, nimbex2:1.7, rempliVol:170, rempliDebit:40, adrPSE1:2, adrPSE2:5.1, adrPSE3:10.2, adrPSE4:15.3 },
  { age:"6-7 ans",  p:20, masque:"3",  aspi:"10",   lame:"2-3",     mandrin:"10",     sonde:"5",   repere:15, guedel:"2",   fr:20, vt:120, ezio:"E-ZIO 25mm",         adrMg:0.2,  adrMl:2,   amioMg:100, amioMl:2,   defib4:80,  defib6:120, defib8:160, fcN:100, pasN:105, pamTC:66, pamHTC:51, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:2.0, sufBolus:4.2, sufPSE:4.2 , nimbex1:1.5, nimbex2:2.1, rempliVol:200, rempliDebit:40, adrPSE1:2.5, adrPSE2:6.3, adrPSE3:12.6, adrPSE4:18.9 },
  { age:"8 ans",    p:25, masque:"3-4",  aspi:"10",   lame:"2-3",     mandrin:"12",     sonde:"5.5", repere:16, guedel:"2",   fr:15, vt:150, ezio:"E-ZIO 25mm",         adrMg:0.25, adrMl:2.5, amioMg:125, amioMl:2.5, defib4:100, defib6:150, defib8:200, fcN:95,  pasN:105, pamTC:67, pamHTC:52, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:2.5, sufBolus:5.0, sufPSE:5.0 , nimbex1:1.8, nimbex2:2.5, rempliVol:250, rempliDebit:40, adrPSE1:3, adrPSE2:7.5, adrPSE3:15, adrPSE4:22.5 },
  { age:"9 ans",    p:28, masque:"3-4",  aspi:"12",   lame:"2-3",     mandrin:"12-14",  sonde:"6",   repere:"16-17", guedel:"2",   fr:15, vt:168, ezio:"E-ZIO 25mm",         adrMg:0.3,  adrMl:3,   amioMg:140, amioMl:2.8,   defib4:150, defib6:150, defib8:300, fcN:95,  pasN:105, pamTC:69, pamHTC:54, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:2.8, sufBolus:5.6, sufPSE:5.6 , nimbex1:2.1, nimbex2:2.8, rempliVol:280, rempliDebit:40, adrPSE1:3.3, adrPSE2:8.4, adrPSE3:16.8, adrPSE4:25.2 },
  { age:"10 ans",   p:32, masque:"3-4",    aspi:"12",   lame:"3",       mandrin:"14-15",  sonde:"6.5", repere:17, guedel:"2",   fr:15, vt:192, ezio:"E-ZIO 25mm",         adrMg:0.3,  adrMl:3,   amioMg:160, amioMl:3,   defib4:150, defib6:200, defib8:300, fcN:95,  pasN:105, pamTC:70, pamHTC:55, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:3.2, sufBolus:6.4, sufPSE:6.4 , nimbex1:2.4, nimbex2:3.2, rempliVol:320, rempliDebit:40, adrPSE1:3.8, adrPSE2:9.6, adrPSE3:19.2, adrPSE4:28.8 },
  { age:"11 ans",   p:35, masque:"4",    aspi:"12",   lame:"3",       mandrin:"14-15",  sonde:"6.5", repere:"17-18", guedel:"2",   fr:15, vt:210, ezio:"E-ZIO 25mm",         adrMg:0.35, adrMl:3.5, amioMg:175, amioMl:3.5, defib4:150, defib6:200, defib8:300, fcN:90,  pasN:105, pamTC:72, pamHTC:57, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:3.5, sufBolus:7.0, sufPSE:7.0 , nimbex1:2.6, nimbex2:3.5, rempliVol:350, rempliDebit:40, adrPSE1:4.2, adrPSE2:10.5, adrPSE3:21, adrPSE4:31.5 },
  { age:"12 ans",   p:40, masque:"4",    aspi:"12",   lame:"3",       mandrin:"14-15",  sonde:"6.5", repere:18, guedel:"2-3",   fr:10, vt:240, ezio:"E-ZIO 25mm ou 45mm", adrMg:0.4,  adrMl:4,   amioMg:200, amioMl:4,   defib4:175, defib6:250, defib8:300, fcN:80,  pasN:110, pamTC:80, pamHTC:65, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:14, fio2:"100% puis QSP 94-98%", midPSE:4.0, sufBolus:8.0, sufPSE:8.0 , nimbex1:3, nimbex2:4, rempliVol:400, rempliDebit:"Garde veine", adrPSE1:4.8, adrPSE2:12, adrPSE3:24, adrPSE4:36 },
  { age:"15 ans",   p:50, masque:"4-5",  aspi:"12",   lame:"3",       mandrin:"14-15",  sonde:"7",   repere:"19-20", guedel:"2-3",   fr:10, vt:300, ezio:"E-ZIO 25mm ou 45mm", adrMg:0.5,  adrMl:5,   amioMg:250, amioMl:5,   defib4:200, defib6:250, defib8:300, fcN:75,  pasN:120, pamTC:80, pamHTC:65, vtR:"12-20",  frR:"15",  ie:"1/2", peep:5, sng:14, fio2:"100% puis QSP 94-98%", midPSE:5.0, sufBolus:10.0, sufPSE:10.0 , nimbex1:3.7, nimbex2:5, rempliVol:500, rempliDebit:"Garde veine", adrPSE1:6, adrPSE2:15, adrPSE3:30, adrPSE4:45 },
];

// Lieu de l'intervention — catégories standard des registres SAMU/SMUR,
// utile pour les statistiques de service (ciblage formation grand public,
// implantation de défibrillateurs) et corrèle avec le taux de RCP par témoin.
const LIEUX_INTERVENTION = [
  { id:"domicile",  label:"Domicile / lieu privé",        icon:"🏠" },
  { id:"sante",     label:"Établissement de santé",        icon:"🏥" },
  { id:"medico",    label:"Établissement médico-social",   icon:"🏛️" },
  { id:"travail",   label:"Lieu de travail",               icon:"🏢" },
  { id:"public",    label:"Lieu public",                   icon:"🏬" },
  { id:"voie",      label:"Voie publique",                 icon:"🛣️" },
  { id:"autre",     label:"Autre",                         icon:"❓" },
];

// Précisions pupillaires — liste plate en un seul tap, révélée uniquement si
// l'examen pupillaire est jugé anormal (évite de surcharger l'écran par défaut).
// left/right : taille relative de chaque pupille (small = myosis, medium = référence
// normale pour une anisocorie, large = mydriase) — rendue en vrais cercles SVG par
// PupilIcon plutôt qu'en émojis, pour un contraste net et identique sur tous les téléphones.
const PUPILLES_DETAIL = [
  { v:"Myosis bilatéral",                left:"small",  right:"small" },
  { v:"Mydriase bilatérale",             left:"large",  right:"large" },
  { v:"Anisocorie — droite en mydriase", left:"medium", right:"large" },
  { v:"Anisocorie — gauche en mydriase", left:"large",  right:"medium" },
  { v:"Anisocorie — droite en myosis",   left:"medium", right:"small" },
  { v:"Anisocorie — gauche en myosis",   left:"small",  right:"medium" },
];
const PUPIL_SIZE = { small:4, medium:6, large:9 };
const PUPIL_STYLE = {
  small:  { fill:"#fff",    stroke:"#0A111B", sw:2   }, // myosis — petit cercle blanc
  medium: { fill:"#C5CFDD", stroke:"#46566F", sw:1.5 }, // référence normale (anisocorie)
  large:  { fill:"#0A111B", stroke:"#0A111B", sw:1   }, // mydriase — grand cercle noir plein
};
function PupilIcon({ left, right }) {
  const r1 = PUPIL_SIZE[left], s1 = PUPIL_STYLE[left];
  const r2 = PUPIL_SIZE[right], s2 = PUPIL_STYLE[right];
  return (
    <div style={{ background:"#EDF0F4", borderRadius:8, padding:"5px 9px",
      display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r1} fill={s1.fill} stroke={s1.stroke} strokeWidth={s1.sw} />
      </svg>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r2} fill={s2.fill} stroke={s2.stroke} strokeWidth={s2.sw} />
      </svg>
    </div>
  );
}

// Trouver la ligne la plus proche par poids
function findPedRow(poids) {
  if (!poids || parseFloat(poids) <= 0) return null;
  const p = parseFloat(poids);
  let best = PED_TABLE[0];
  let bestDist = Math.abs(p - best.p);
  for (const row of PED_TABLE) {
    const dist = Math.abs(p - row.p);
    if (dist < bestDist) { best = row; bestDist = dist; }
  }
  return best;
}

function calcMateriel(poids) {
  const row = findPedRow(poids);
  if (!row) return null;
  const p = parseFloat(poids);
  return {
    masque:             row.masque,
    sondeAspi:          row.aspi + " Ch",
    lame:               row.lame,
    mandrin:            row.mandrin + " Ch",
    sondeAvecBallonnet: row.sonde,
    sondeSansBallonnet: row.sonde,
    repereLab:          row.repere,
    guedel:             row.guedel,
    fr:                 row.fr,
    vt:                 row.vt,
    ezio:               row.ezio,
    // Calculé en direct depuis le poids (10 μg/kg exact) — jamais depuis la table
    // statique (row.adrMg/adrMl), pour garantir une cohérence parfaite et permanente
    // avec le calcul affiché dans le guide de dilution (Protocole 1 et 2), quel que
    // soit le poids, sans dépendre d'une valeur pré-calculée qui pourrait diverger.
    adrenalineMg:       Math.round(p * 0.01 * 1000) / 1000,
    adrenalineMl:       Math.round(p * 0.1 * 100) / 100,
    amioMg:             row.amioMg,
    amioMl:             row.amioMl,
    defibJ:             row.defib4,
    defib4:             row.defib4,
    defib6:             row.defib6,
    defib8:             row.defib8,
    remplissage10:      Math.round(p * 10),
    remplissage20:      Math.round(p * 20),
    amio:               row.amioMg,
    sondeGastrique:     row.sng + " Ch",
    // Normes post-RACS
    fcN:    row.fcN,
    pasN:   row.pasN,
    pamTC:  row.pamTC,
    pamHTC: row.pamHTC,
    vtR:    row.vtR,
    frR:    row.frR,
    ie:     row.ie,
    peep:   row.peep,
    fio2:   row.fio2,
    // Sédation
    midPSE:   row.midPSE,
    sufBolus: row.sufBolus,
    sufPSE:   row.sufPSE,
    // Curare Nimbex
    nimbex1:     row.nimbex1,
    nimbex2:     row.nimbex2,
    // Remplissage
    rempliVol:   row.rempliVol,
    rempliDebit: row.rempliDebit,
    // Adrénaline IVSE
    adrDilution: parseFloat(poids) <= 10 ? "0,02 mg/mL (1mg/50mL)" : "0,1 mg/mL (5mg/50mL)",
    adrPSE1: row.adrPSE1,
    adrPSE2: row.adrPSE2,
    adrPSE3: row.adrPSE3,
    adrPSE4: row.adrPSE4,
    // Thérapeutiques spécifiques pédiatriques (calculées au poids)
    bicarMl:     Math.round(p * 1 * 10) / 10,         // 1 mEq/kg = 1 mL/kg de 8,4 %
    calciumMl:   Math.min(Math.round(p * 0.5 * 10) / 10, 20),  // 0,5 mL/kg, max 20 mL
    magnesiumMg: Math.min(Math.round(p * 50), 2000),  // 50 mg/kg, max 2 g
    naloxoneMg:  Math.min(Math.round(p * 0.1 * 100) / 100, 2), // 0,1 mg/kg, max 2 mg
    glucoseMl:   Math.round(p * 2),                    // G10 % : 2 mL/kg
    intralipMl:  Math.round(p * 1.5),                  // 1,5 mL/kg bolus
    alteplaseMg: Math.min(Math.round(p * 0.6), 50),    // 0,6 mg/kg max 50 mg
  };
}

// Listes pour les molettes
const POIDS_LISTE = PED_TABLE.map(r => r.p);
const AGE_LISTE   = PED_TABLE.map(r => r.age);

const VOLUMES_PED = [50, 100, 150, 200, 250, 500];

function RemplissageVasculairePed({ racs, setRacs, localMat }) {
  const [vol,   setVol]   = useState(localMat?.rempliVol || 100);
  const [sol,   setSol]   = useState("NaCl 0,9%");
  const [autre, setAutre] = useState("");

  const total = (racs.remplissagesPed || []).reduce((s,r) => s + r.vol, 0);

  const ajouter = () => {
    const solLabel = sol === "Autre" ? (autre || "Autre") : sol;
    const entry = { vol, sol: solLabel, time: getNow() };
    setRacs(p => ({ ...p, remplissagesPed: [...(p.remplissagesPed||[]), entry] }));
    if (sol === "Autre") setAutre("");
  };

  const retirer = (i) =>
    setRacs(p => ({ ...p, remplissagesPed: (p.remplissagesPed||[]).filter((_,idx) => idx !== i) }));

  return (
    <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px", marginBottom:10 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <p style={{ margin:0, fontSize:9, fontWeight:500, color:P.textSoft,
          textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>
          Remplissage vasculaire
          {localMat && <span style={{ fontWeight:400, marginLeft:6, color:P.textSoft }}>
            (10 mL/kg = {localMat.rempliVol} mL)
          </span>}
        </p>
        {total > 0 && (
          <span style={{ fontSize:13, fontWeight:700, color:P.blueText, fontFamily:mono }}>
            Total : {total} mL
          </span>
        )}
      </div>

      {/* Molette volume */}
      <div style={{ display:"flex", gap:5, marginBottom:6, flexWrap:"wrap" }}>
        {VOLUMES_PED.map(v => (
          <button key={v} onClick={() => setVol(v)}
            style={{ flex:1, minWidth:"calc(33% - 4px)", padding:"7px 2px", borderRadius:9,
              fontSize:12, fontWeight:700,
              border:`1.5px solid ${vol===v ? P.blue : P.border}`,
              background: vol===v ? P.blueSoft : P.surface,
              color: vol===v ? P.blueText : P.textMid,
              cursor:"pointer", fontFamily:mono }}>
            {v}
          </button>
        ))}
      </div>
      <p style={{ margin:"0 0 8px", fontSize:9, color:P.textSoft, textAlign:"center", fontFamily:mono }}>mL</p>

      {/* Solutés */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:8 }}>
        {SOLUTES.map(s => (
          <button key={s} onClick={() => setSol(s)}
            style={{ padding:"7px 6px", borderRadius:9, fontSize:11, fontWeight:500,
              border:`1.5px solid ${sol===s ? P.teal : P.border}`,
              background: sol===s ? P.tealSoft : P.surface,
              color: sol===s ? P.tealText : P.textMid,
              cursor:"pointer", fontFamily:sans }}>
            {s}
          </button>
        ))}
      </div>

      {sol === "Autre" && (
        <input value={autre} onChange={e => setAutre(e.target.value)}
          placeholder="Préciser le soluté..."
          style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
            borderRadius:8, padding:"8px 10px", fontSize:13, color:P.text, fontFamily:sans,
            boxSizing:"border-box", outline:"none", marginBottom:8 }}
          onFocus={e => e.target.style.borderColor = P.teal}
          onBlur={e  => e.target.style.borderColor = P.border} />
      )}

      <button onClick={ajouter}
        style={{ width:"100%", background:`linear-gradient(135deg,${P.blue},${P.blueText})`,
          border:"none", borderRadius:9, padding:"10px", color:"#fff",
          fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:sans,
          boxShadow:`0 3px 10px color-mix(in srgb, ${P.blue} 20%, transparent)`,
          marginBottom: (racs.remplissagesPed||[]).length>0 ? 10 : 0 }}>
        + Ajouter {vol} mL {sol !== "Autre" ? sol : (autre || "Autre")}
      </button>

      {(racs.remplissagesPed||[]).length > 0 && (
        <div style={{ borderTop:`1px solid ${P.border}`, paddingTop:8 }}>
          {racs.remplissagesPed.map((r, i) => (
            <div key={i} style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"5px 0", borderBottom: i<racs.remplissagesPed.length-1 ? `1px solid ${P.borderSoft}` : "none" }}>
              <span style={{ fontSize:12, color:P.textMid }}>{r.time} · {r.vol} mL {r.sol}</span>
              <button onClick={() => retirer(i)}
                style={{ background:"transparent", border:"none", color:P.textSoft,
                  cursor:"pointer", fontSize:14, padding:"0 4px", lineHeight:1 }}>✕</button>
            </div>
          ))}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
            marginTop:8, padding:"7px 10px",
            background:P.blueSoft, borderRadius:8, border:`1px solid color-mix(in srgb, ${P.blue} 27%, transparent)` }}>
            <span style={{ fontSize:11, color:P.textSoft }}>Total remplissage</span>
            <span style={{ fontSize:17, fontWeight:700, color:P.blueText, fontFamily:mono }}>{total} mL</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RCP PÉDIATRIQUE ───────────────────────────────────────────────────────────

function RcpPediatrique({ onBack, onHome, acrTime, poids, mat, theme, setTheme, initialTeamCode, isVLI = false }) {
  const [vliUnlockedPed, setVliUnlockedPed] = useLocalState("acr_vli_ped_unlocked", false);
  const [pupillesInitExpandedPed, setPupillesInitExpandedPed] = useState(false);
  const [racsPupillesExpandedPed, setRacsPupillesExpandedPed] = useState(false);
  const [modalVliTransitionPed, setModalVliTransitionPed] = useState(false);
  const [modalVasVLIPed, setModalVasVLIPed] = useState(false);
  const [vasVLIInhalationPed, setVasVLIInhalationPed] = useState(false);
  const [running,      setRunning]      = useState(false);
  const [secStored,    setSecStored]    = useLocalState("acr_ped_sec", 0);
  const [sec,          setSec]          = useTimer(running);
  useEffect(() => { if (secStored > 0 && sec === 0) setSec(secStored); }, []);
  useEffect(() => { setSecStored(sec); }, [sec]);

  const [cycleOffset,  setCycleOffset]  = useLocalState("acr_ped_cycleOffset", 0);
  const [events,       setEvents]       = useLocalState("acr_ped_events", []);
  const [alert,        setAlert]        = useState(null);
  const [showLog,      setShowLog]      = useState(false);
  const [showPdf,      setShowPdf]      = useState(false);
  const initIdx = PED_TABLE.findIndex(r => r.p === parseFloat(poids));
  const [localPoidsIdx, setLocalPoidsIdx] = useLocalState("acr_ped_poidsIdx", initIdx >= 0 ? initIdx : 0);
  const [showPoidsEdit, setShowPoidsEdit] = useState(false);
  const localRow  = PED_TABLE[localPoidsIdx];
  const localMat  = calcMateriel(localRow.p);
  const localPoids = localRow.p;

  // Wake Lock — empêche le verrouillage écran pendant la réa
  useWakeLock(true);

  const [modalDecesPed, setModalDecesPed] = useState(false);
  const [omlStepPed,    setOmlStepPed]    = useState(0);
  const [minPositionPed, setMinPositionPed] = useState("");
  const [minContextePed, setMinContextePed] = useState("");
  const [modalCriteresPed, setModalCriteresPed] = useState(false);
  const [omlTxtPed,     setOmlTxtPed]     = useState("");
  const [decesRemisAPed, setDecesRemisAPed] = useState("");
  const [showPatPed,    setShowPatPed]    = useState(false);
  const [patPed, setPatPed] = useLocalState("acr_ped_pat", { nom:"", prenom:"", ddn:"", age:"", poids:"", temp:"", atcd:"", traitement:"", histoire:"", lieu:"" });
  const spf = k => v => setPatPed(p => ({ ...p, [k]: v }));
  const [showNotePed,  setShowNotePed]   = useState(false);
  const [noteTextPed,  setNoteTextPed]   = useState("");
  // Transmission équipes pré-SMUR
  const [modalTransPed, setModalTransPed] = useState(false);
  const [modalPatPed, setModalPatPed] = useState(false);
  const [etco2ListPed, setEtco2ListPed] = useLocalState("acr_ped_etco2", []);
  const [modalEtco2Ped, setModalEtco2Ped] = useState(false);
  const [etco2ValPed, setEtco2ValPed] = useState("");
  const [etco2OpenPed, setEtco2OpenPed] = useState(true);
  // Undo pédiatrique
  const [undoToastPed, setUndoToastPed] = useState(null);
  const undoLastPed = () => {
    const undoable = events.filter(e => e.id !== "start");
    if (undoable.length === 0) return;
    const last = undoable[undoable.length - 1];
    setEvents(prev => prev.filter(e => e !== last));
    setUndoToastPed({ event: last, label: last.label, key: Date.now() });
    try { if (navigator.vibrate) navigator.vibrate(20); } catch(e) {}
  };
  const restoreEventPed = () => {
    if (!undoToastPed) return;
    setEvents(prev => [...prev, undoToastPed.event]);
    setUndoToastPed(null);
  };
  useEffect(() => {
    if (!undoToastPed) return;
    const t = setTimeout(() => setUndoToastPed(null), 5000);
    return () => clearTimeout(t);
  }, [undoToastPed]);
  // Hémodynamique post-RACS pédiatrique
  const [hemoListPed, setHemoListPed] = useLocalState("acr_ped_hemo", []);
  const [amineListPed, setAmineListPed] = useLocalState("acr_ped_amines", []);
  const [modalHemoPed, setModalHemoPed] = useState(false);
  const [modalAminePed, setModalAminePed] = useState(false);
  const [hemoOpenPed, setHemoOpenPed] = useState(true);
  const [hemoFormPed, setHemoFormPed] = useState({ pas:"", pad:"", fc:"" });
  const [amineFormPed, setAmineFormPed] = useState({ type:"Noradrénaline", dose:"", unit:"mg/h" });
  // CCF pédiatrique (réglage partagé)
  const [ccfEnabled] = useLocalState("acr_ccf_enabled", false);
  const [debriefEnabled] = useLocalState("acr_debrief_enabled", false);
  const [pedDiluEnabled] = useLocalState("acr_ped_dilu_enabled", false);
  const [pedDiluMode] = useLocalState("acr_ped_dilu_mode", "2");
  const [metronomeEnabled] = useLocalState("acr_metronome_enabled", false);
  const [adrIntervalGlobal] = useLocalState("acr_adr_interval", 4);
  const [voiceWakeWord] = useLocalState("acr_voice_wakeword", "Alpha");
  // Métronome pédiatrique — le scheduler précis (Web Audio lookahead) est plus
  // bas dans le fichier ; l'ancien système ici a été retiré (il faisait doublon
  // et produisait un effet de double bip désynchronisé, contrairement à l'adulte
  // qui n'a jamais eu qu'un seul système).
  const [metronomeMutedPed, setMetronomeMutedPed] = useState(false);
  const [showDebriefPed, setShowDebriefPed] = useState(false);

  // Bip cycle pédiatrique
  const prevCpPedRef = useRef(null);
  useEffect(() => {
    if (!running) { prevCpPedRef.current = null; return; }
    const cp = (sec - cycleOffset) % 120;
    if (prevCpPedRef.current !== null && prevCpPedRef.current > 0 && cp === 0) playCycleBip();
    prevCpPedRef.current = cp;
  }, [sec, cycleOffset, running]);
  const [ccfPausedTotalPed, setCcfPausedTotalPed] = useLocalState("acr_ped_ccfPaused", 0);
  const [ccfPausedSincePed, setCcfPausedSincePed] = useLocalState("acr_ped_ccfSince", null);
  const [transPed, setTransPed] = useLocalState("acr_ped_trans", {
    hEffondrement:"", temoin:"", mceTemoin:"", lieu:"",
    hArriveePompiers:"", hPoseDSA:"", h1erChoc:"",
    chocsPompiers:0, chocsPublic:0, rythmeDSA:"",
    note:"", saved:false,
  });
  // Minuteur Adrénaline pédiatrique
  const [adrTimerStartPed, setAdrTimerStartPed] = useLocalState("acr_ped_adrStart", 0);
  // Onglets pédiatrique
  const [mainTabPed,       setMainTabPed]       = useLocalState("acr_ped_mainTab", "actions");
  // Garde-fou anti-blocage : si mainTabPed reste sur un onglet qui n'existe pas dans le
  // contexte courant (ex : "ther"/"etio" alors qu'on est en VLI restreint, ou "vli_sit"
  // après la transition VLM), on redirige vers "actions" pour ne jamais afficher un écran vide.
  useEffect(() => {
    if (isVLI && !vliUnlockedPed && (mainTabPed === "etio" || mainTabPed === "ther")) setMainTabPed("actions");
    if (!(isVLI && !vliUnlockedPed) && mainTabPed === "vli_sit") setMainTabPed("actions");
  }, [isVLI, vliUnlockedPed, mainTabPed]);
  const [showMoreActionsPed, setShowMoreActionsPed] = useState(false);
  const [suspectedPed,     setSuspectedPed]     = useLocalState("acr_ped_suspected", []);
  const [modalEcmoPed,     setModalEcmoPed]     = useState(false);
  const stp = k => v => setTransPed(p => ({ ...p, [k]: v }));

  const [noFlowMin,    setNoFlowMin]    = useLocalState("acr_ped_noFlow", "");
  const [lowFlowMin,   setLowFlowMin]   = useLocalState("acr_ped_lowFlow", "");
  const [lowFlowStart, setLowFlowStart] = useLocalState("acr_ped_lowFlowStart", "");
  const [localAcrTime, setLocalAcrTime] = useLocalState("acr_ped_acrTime", acrTime || "");

  // Mode équipe multi-device — instance dédiée au module pédiatrique (données
  // totalement séparées de celles du module adulte/traumatique)
  const teamPed = useTeamSync({ events, setEvents, acrTime: localAcrTime, setAcrTime: setLocalAcrTime,
    noFlowMin, setNoFlowMin, lowFlowMin, setLowFlowMin, trans: transPed, setTrans: setTransPed });
  const [modalTeamPed, setModalTeamPed] = useState(false);
  const [teamJoinCodePed, setTeamJoinCodePed] = useState("");
  const [teamJoinErrorPed, setTeamJoinErrorPed] = useState("");
  // Reprend la session préparée avant le début de la réa (bouton équipe sur
  // l'écran de sélection du poids) — l'équipe n'a pas à se reconnecter.
  useEffect(() => {
    if (initialTeamCode) { teamPed.joinSession(initialTeamCode); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Modals
  const [modalRythme,  setModalRythme]  = useState(false);
  const [modalChocPed, setModalChocPed] = useState(false);
  const [modalVvpPed,  setModalVvpPed]  = useState(false);
  const [modalIotPed,  setModalIotPed]  = useState(false);
  const [modalFastPed, setModalFastPed] = useState(false);
  const [modalRegulPed,setModalRegulPed]= useState(false);
  const [modalEcgPed,  setModalEcgPed]  = useState(false);
  const [modalRacsPed, setModalRacsPed] = useState(false);

  // Données saisies
  const [joules,       setJoules]       = useState(mat ? String(mat.defibJ) : "4");
  const [fastTxt,      setFastTxt]      = useState("");
  const [regulTxt,     setRegulTxt]     = useState("");
  const [regulDest,    setRegulDest]    = useState("");
  const [ecgTxt,       setEcgTxt]       = useState("");
  const [iotSonde,     setIotSonde]     = useState(mat?.sondeAvecBallonnet || "");
  const [iotRepere,    setIotRepere]    = useState(localMat?.repereLab ? String(localMat.repereLab) : "");
  const [iotCapno,     setIotCapno]     = useState("");
  const [iotDifficilePed, setIotDifficilePed] = useState(false);
  const [iotTechDifficilePed, setIotTechDifficilePed] = useState([]);
  const [iotNbTentativesPed, setIotNbTentativesPed] = useState("");
  const [iotInhalationPed, setIotInhalationPed] = useState(false);
  const [racsTabPed,   setRacsTabPed]   = useState("ventil");
  const [showDopee,    setShowDopee]    = useState(false);
  const [racsPed, setRacsPed] = useState({
    fr:"", volume:"", pep:"", sat:"", fio2:"", capno:"",
    tas:"", tad:"", fc:"", tempRacs:"", glycemie:"", glasgow:"", pupilles:"", noradrV:"",
    midazolamV:"", sufentaV:"", autresHemo:"",
    remplissagesPed:[]
  });
  const srp = k => v => setRacsPed(p => ({ ...p, [k]: v }));

  // Valeurs hémodynamique éditables — pré-remplies depuis localMat
  const [adrPalier,   setAdrPalier]   = useState(0); // index 0-3
  const [adrVitesse,  setAdrVitesse]  = useState("");
  const [rempliVol,   setRempliVol]   = useState("");
  const [rempliDebit, setRempliDebit] = useState("");
  const [nimbex1Val,  setNimbex1Val]  = useState("");
  const [nimbex2Val,  setNimbex2Val]  = useState("");

  const alertRef = useRef(null);

  useEffect(() => {
    if (!running || sec === 0 || sec % 120 !== 0) return;
    setAlert("Analyser le rythme · Changer le masseur");
    clearTimeout(alertRef.current);
    alertRef.current = setTimeout(() => setAlert(null), 7000);
  }, [sec, running]);

  const [confirmAdd, setConfirmAdd] = useState(null); // { label, key }
  const addEvent = (id, label, icon, customTime) => {
    setEvents(p => [...p, { id, label, icon, time: customTime || getNow(), sec }]);
    setConfirmAdd({ label, key: Date.now() });
    try { if (navigator.vibrate) navigator.vibrate(28); } catch(e){}
  };
  useEffect(() => {
    if (!confirmAdd) return;
    const t = setTimeout(() => setConfirmAdd(null), 1500);
    return () => clearTimeout(t);
  }, [confirmAdd]);

  // ── Reconnaissance vocale pédiatrique (déclarée avant les useEffect qui l'utilisent) ──
  const [voiceActivePed,     setVoiceActivePed]     = useState(false);
  const [voiceTranscriptPed, setVoiceTranscriptPed] = useState("");
  const [voiceToastPed,      setVoiceToastPed]      = useState(null); // { label, icon, confirm, cancel }
  const [voiceAnswerPed,     setVoiceAnswerPed]     = useState(null); // { label, icon, speak, key }
  const [voiceWakeFlashPed,  setVoiceWakeFlashPed]  = useState(false);
  const voiceRecRefPed = useRef(null);
  const voiceToastRefPed = useRef(null);
  const voiceAnswerRefPed = useRef(null);
  const lastWakeWordTimeRefPed = useRef(0);
  const matchVoiceCommandPedRef = useRef(null);
  const voiceWakeWordRefPed = useRef(voiceWakeWord);
  useEffect(() => { voiceWakeWordRefPed.current = voiceWakeWord; }, [voiceWakeWord]);

  // ── Questions vocales pédiatriques — réponse immédiate parlée, ne modifie jamais rien ──
  const answerVoiceQuestionPed = React.useCallback((raw, n) => {
    const lastAdr = [...events].reverse().find(e => e.id === "adr");
    const lastHemo = hemoListPed.length > 0 ? hemoListPed[hemoListPed.length - 1] : null;
    const lastEtco2 = etco2ListPed.length > 0 ? etco2ListPed[etco2ListPed.length - 1] : null;
    const lastEvt = events.length > 0 ? events[events.length - 1] : null;

    if (n.includes("depuis") && (n.includes("adrenaline") || n.includes("adre"))) {
      return lastAdr
        ? { label:"💉 Délai adrénaline", icon:"💉", speak:`Dernière adrénaline il y a ${speakDuration(sec - lastAdr.sec)}.` }
        : { label:"💉 Adrénaline", icon:"💉", speak:"Aucune adrénaline n'a encore été administrée." };
    }
    if (n.includes("adrenaline") || n.includes("adre") || n.includes("epinephrine")) {
      const count = events.filter(e => e.id === "adr").length;
      const doseMg = localMat?.adrenalineMg || "";
      return { label:"💉 Adrénaline", icon:"💉",
        speak: count === 0 ? "Aucune adrénaline administrée pour l'instant."
          : `${count} dose${count>1?"s":""} d'adrénaline administrée${count>1?"s":""}${doseMg?`, de ${doseMg} milligrammes chacune`:""}.` };
    }
    if (n.includes("choc") && (n.includes("premier") || n.includes("1er") || n.includes("delai"))) {
      const firstChoc = events.find(e => e.id === "choc" || e.id === "doublechoc");
      return firstChoc
        ? { label:"⚡ Délai 1er choc", icon:"⚡", speak:`Premier choc délivré à ${speakDuration(firstChoc.sec)} après le début.` }
        : { label:"⚡ Chocs", icon:"⚡", speak:"Aucun choc délivré pour l'instant." };
    }
    if (n.includes("choc") || n.includes("defibrillation") || n.includes("defib")) {
      const simple = events.filter(e => e.id === "choc").length;
      const double = events.filter(e => e.id === "doublechoc").length;
      const total = simple + double * 2;
      return { label:"⚡ Chocs", icon:"⚡",
        speak: total === 0 ? "Aucun choc délivré pour l'instant."
          : `${total} choc${total>1?"s":""} délivré${total>1?"s":""}${double>0?`, dont ${double} double défibrillation${double>1?"s":""}`:""}.` };
    }
    if (n.match(/etco|capno|\bco2\b/)) {
      return lastEtco2
        ? { label:"📈 EtCO₂", icon:"📈", speak:`Dernière EtCO₂ : ${lastEtco2.val} millimètres de mercure, à ${lastEtco2.time}.` }
        : { label:"📈 EtCO₂", icon:"📈", speak:"Aucune EtCO₂ enregistrée pour l'instant." };
    }
    if (n.includes("cordarone") || n.includes("amiodarone") || n.includes("amio")) {
      const count = events.filter(e => e.id === "cord").length;
      const doseMg = localMat?.amio || "";
      return { label:"💊 Amiodarone", icon:"💊",
        speak: count === 0 ? "Pas d'amiodarone administrée pour l'instant."
          : `${count} dose${count>1?"s":""} d'amiodarone administrée${count>1?"s":""}${doseMg?`, de ${doseMg} milligrammes chacune`:""}.` };
    }
    if (n.includes("tension") || n.includes("arterielle") || n.includes("pression arterielle") || /\bta\b/.test(n)) {
      if (!lastHemo || (!lastHemo.pas && !lastHemo.pad)) return { label:"🩺 Tension", icon:"🩺", speak:"Aucune tension artérielle enregistrée pour l'instant." };
      const pam = (lastHemo.pas && lastHemo.pad)
        ? Math.round(parseFloat(lastHemo.pad) + (parseFloat(lastHemo.pas) - parseFloat(lastHemo.pad)) / 3) : null;
      return { label:"🩺 Tension", icon:"🩺",
        speak:`Dernière tension : ${lastHemo.pas||"—"} sur ${lastHemo.pad||"—"}${pam?`, PAM ${pam}`:""}, à ${lastHemo.time}.` };
    }
    if (n.includes("frequence cardiaque") || n.includes("frequence") || /\bfc\b/.test(n)) {
      return (lastHemo && lastHemo.fc)
        ? { label:"❤️ FC", icon:"❤️", speak:`Dernière fréquence cardiaque : ${lastHemo.fc} battements par minute, à ${lastHemo.time}.` }
        : { label:"❤️ FC", icon:"❤️", speak:"Aucune fréquence cardiaque enregistrée pour l'instant." };
    }
    if (n.includes("shock index") || n.includes("index de choc")) {
      if (!lastHemo || !lastHemo.fc || !lastHemo.pas || parseFloat(lastHemo.pas) === 0) {
        return { label:"📊 Shock Index", icon:"📊", speak:"Impossible de calculer le Shock Index, pas assez de données." };
      }
      const si = parseFloat(lastHemo.fc) / parseFloat(lastHemo.pas);
      return { label:"📊 Shock Index", icon:"📊",
        speak:`Shock index : ${si.toFixed(2)}, ${si<0.9?"normal":si<=1.4?"inquiétant":"critique"}.` };
    }
    if (n.includes("no flow") || n.includes("noflow")) {
      return { label:"⏱ No-flow", icon:"⏱",
        speak: noFlowMin ? `No-flow renseigné : ${noFlowMin} minutes.` : "No-flow non renseigné." };
    }
    if (n.includes("amine")) {
      const byType = {};
      amineListPed.forEach(a => { byType[a.type] = a; });
      const active = Object.values(byType);
      return { label:"💧 Amines", icon:"💧",
        speak: active.length ? `Amines en cours : ${active.map(a=>a.label).join(", ")}.` : "Aucune amine en cours." };
    }
    if (n.includes("remplissage")) {
      const total = (racsPed.remplissagesPed || []).reduce((s,r) => s + r.vol, 0);
      return { label:"💧 Remplissage", icon:"💧",
        speak: total > 0 ? `Remplissage total : ${total} millilitres.` : "Aucun remplissage enregistré pour l'instant." };
    }
    if (n.includes("poids")) {
      return { label:"⚖️ Poids", icon:"⚖️",
        speak: poids ? `Poids renseigné : ${poids} kilos.` : "Poids non renseigné." };
    }
    if (n.includes("temperature") || n.includes("temp")) {
      return { label:"🌡 Température", icon:"🌡",
        speak: racsPed.tempRacs ? `Dernière température : ${racsPed.tempRacs} degrés.` : "Température non renseignée." };
    }
    if ((n.includes("dernier") || n.includes("derniere")) && (n.includes("geste") || n.includes("action") || n.includes("fait"))) {
      return { label:"📋 Dernier geste", icon:"📋",
        speak: lastEvt ? `Dernier geste : ${lastEvt.label}, à ${lastEvt.time}.` : "Aucun geste enregistré pour l'instant." };
    }
    if (n.includes("rythme")) {
      const rv = [...events].reverse().find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
      return { label:"⚡ Dernier rythme", icon:"⚡",
        speak: rv ? `Dernier rythme analysé : ${rv.label.replace("Rythme : ","")}, à ${rv.time}.` : "Aucune analyse de rythme enregistrée pour l'instant." };
    }
    if (n.includes("racs")) {
      const rosc = events.find(e => e.id === "rosc");
      return { label:"💚 RACS", icon:"💚",
        speak: rosc ? `Oui, RACS obtenu à ${rosc.time}.` : "Non, pas de RACS obtenu pour l'instant." };
    }
    if (n.includes("depuis combien de temps") || (n.includes("depuis") && (n.includes("debut") || n.includes("dessus")))) {
      return { label:"⏱ Durée", icon:"⏱", speak:`Réanimation en cours depuis ${speakDuration(sec)}.` };
    }
    return { label:"❓ Question", icon:"❓", speak:"Je n'ai pas cette information pour l'instant." };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sec, events, hemoListPed, etco2ListPed, amineListPed, noFlowMin, racsPed, localMat, poids]);

  const matchVoiceCommandPed = React.useCallback((raw, wakeWordActive) => {
    const n = normalizeVoice(raw);
    // Mot-code : tolérance de ~4s entre "copilote" et la commande (une pause
    // naturelle après la virgule coupe souvent la phrase en deux segments
    // distincts côté reconnaissance vocale).
    if (!wakeWordActive) return null;

    // Question ? Toujours testé AVANT la liste de commandes, pour qu'une phrase
    // comme "combien de mg d'adrénaline" ne puisse jamais être interprétée comme
    // l'ordre "adrénaline" (qui loguerait une nouvelle dose).
    if (isVoiceQuestion(n)) {
      return { ...answerVoiceQuestionPed(raw, n), isQuestion: true };
    }

    // EtCO2 avec valeur : "copilote etco2 vingt-cinq" / "copilote capno trente"
    if (n.match(/etco|capno|co2/)) {
      const val = parseFrNumber(raw);
      if (val !== null && val >= 0 && val <= 100) {
        return {
          label: `EtCO₂ ${val} mmHg`, icon: "📈",
          confirm: () => {
            setEtco2ListPed(prev => [...prev, { val: String(val), sec, time: getNow() }]);
            addEvent("etco2_voice", `EtCO₂ ${val} mmHg`, "📈");
          }
        };
      }
    }
    const cmds = [
      { kw:["adrenaline","adre","epinephrine"], label:`Adrénaline ${localMat?.adrenalineMg||""}mg IV/IO`, icon:"💉",
        confirm:()=>{ addEvent("adr",`Adrénaline ${localMat?.adrenalineMg||""}mg IV/IO (10μg/kg)`,"💉"); setAdrTimerStartPed(Date.now()); }},
      { kw:["choc","defibrillation","defib","cardioversion","fibrillation"], label:`Défibrillation ${localMat?.defibJ||""} J`, icon:"⚡",
        confirm:()=> addEvent("choc",`Défibrillation ${localMat?.defibJ||""} J délivrée`,"⚡") },
      { kw:["racs","pouls","circulation","retour","spontane"], label:"RACS", icon:"💚",
        confirm:()=> addEvent("rosc","RACS","💚") },
      { kw:["cordarone","amiodarone","amio"], label:`Amiodarone ${localMat?.amio||""}mg IV/IO`, icon:"💊",
        confirm:()=> addEvent("cord",`Amiodarone ${localMat?.amio||""}mg IV/IO (5mg/kg)`,"💊") },
      { kw:["intubation","intuber","sonde"], label: (isVLI && !vliUnlockedPed) ? "Sécurisation VAS" : "Intubation", icon:"🫁",
        confirm:()=> (isVLI && !vliUnlockedPed) ? setModalVasVLIPed(true) : setModalIotPed(true) },
      { kw:["pause","stoppe","stop compressions"], label:"Pause compressions", icon:"⏸",
        confirm:()=> setRunning(false) },
      { kw:["reprendre","continuer","resume","relancer"], label:"Reprendre compressions", icon:"▶",
        confirm:()=> setRunning(true) },
      { kw:["annule","annuler","supprime","efface"], label:"Annuler le dernier geste", icon:"↩️",
        confirm:()=> undoLastPed() },
      // "Constat de décès" — jamais disponible en VLI restreint : un IDE n'a pas
      // l'autorité de constater un décès, avec ou sans OML (cohérent avec le retrait
      // du bouton visuel équivalent). Le filtre ci-dessous exclut cette commande.
      ...((!(isVLI && !vliUnlockedPed)) ? [
        { kw:["deces","constat","mort","decede"], label:"Constat de décès", icon:"🕊️",
          confirm:()=> setModalDecesPed(true) },
      ] : []),
      { kw:["analyse","rythme","check","verification"], label:"Analyse de rythme", icon:"⚡",
        confirm:()=> setShowRythmFlashPed(true) },
    ];
    for (const cmd of cmds) {
      if (cmd.kw.some(k => n.includes(k))) return cmd;
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sec, events, localMat, isVLI, vliUnlockedPed]);

  // La fonction de matching change à chaque seconde (elle dépend de `sec`) — on la
  // range dans une ref à jour en continu, SANS jamais redéclencher le useEffect
  // ci-dessous qui crée la session micro.
  useEffect(() => { matchVoiceCommandPedRef.current = matchVoiceCommandPed; }, [matchVoiceCommandPed]);

  useEffect(() => {
    if (!voiceActivePed || !SpeechRecognitionAPI) return;

    const rec = new SpeechRecognitionAPI();
    rec.lang = "fr-FR";
    rec.continuous = false;        // une phrase = une session ; évite l'accumulation instable du mode continu
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    voiceRecRefPed.current = rec;

    rec.onresult = (e) => {
      const results = Array.from(e.results);
      const interim = results.map(r => r[0].transcript).join(" ");
      setVoiceTranscriptPed(interim);
      if (buildWakeWordRegex(voiceWakeWordRefPed.current).test(normalizeVoice(interim))) {
        lastWakeWordTimeRefPed.current = Date.now();
      }

      const finalResult = results.find(r => r.isFinal);
      if (finalResult) {
        const text = Array.from(e.results).map(r => r[0].transcript).join(" ");
        const hasWakeWordNow = buildWakeWordRegex(voiceWakeWordRefPed.current).test(normalizeVoice(text));
        if (hasWakeWordNow) {
          lastWakeWordTimeRefPed.current = Date.now();
          setVoiceWakeFlashPed(true);
          setTimeout(() => setVoiceWakeFlashPed(false), 700);
        }
        const wakeWordActive = hasWakeWordNow || (Date.now() - lastWakeWordTimeRefPed.current < 4000);
        const cmd = matchVoiceCommandPedRef.current(text, wakeWordActive);
        setVoiceTranscriptPed("");
        if (cmd) {
          if (cmd.isQuestion) {
            clearTimeout(voiceAnswerRefPed.current);
            setVoiceAnswerPed({ ...cmd, key: Date.now() });
            speakFr(cmd.speak);
            voiceAnswerRefPed.current = setTimeout(() => setVoiceAnswerPed(null), 6000);
          } else {
            clearTimeout(voiceToastRefPed.current);
            setVoiceToastPed({ ...cmd, cancel: () => { setVoiceToastPed(null); clearTimeout(voiceToastRefPed.current); } });
            voiceToastRefPed.current = setTimeout(() => {
              cmd.confirm();
              setVoiceToastPed(null);
            }, 2500);
          }
        }
      }
    };

    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      const messages = {
        "not-allowed": "🚫 Micro refusé — autorisez l'accès dans les réglages du navigateur",
        "service-not-allowed": "🚫 Micro refusé — autorisez l'accès dans les réglages du navigateur",
        "audio-capture": "🚫 Aucun micro détecté sur cet appareil",
        "network": "🚫 Reconnaissance vocale indisponible hors connexion",
      };
      setVoiceTranscriptPed(messages[e.error] || ("Erreur micro : " + e.error));
      setTimeout(() => setVoiceTranscriptPed(""), 5000);
    };

    rec.onend = () => {
      if (voiceRecRefPed.current === rec) {
        setTimeout(() => {
          if (voiceRecRefPed.current === rec) {
            try { rec.start(); }
            catch(err) { setVoiceTranscriptPed("🚫 Micro interrompu — réactivez-le"); setTimeout(() => setVoiceTranscriptPed(""), 4000); }
          }
        }, 300);
      }
    };

    try { rec.start(); } catch(e) { setVoiceTranscriptPed("🚫 Impossible de démarrer le micro"); setTimeout(() => setVoiceTranscriptPed(""), 4000); }

    // Perte de connexion en cours de session : la reconnaissance vocale en dépend
    // (traitement audio à distance) — on prévient clairement plutôt que de laisser
    // le micro "actif" sans jamais rien reconnaître.
    const onOffline = () => {
      setVoiceTranscriptPed("🚫 Connexion perdue — reconnaissance vocale interrompue");
      setTimeout(() => setVoiceTranscriptPed(""), 5000);
      setVoiceActivePed(false);
    };
    window.addEventListener("offline", onOffline);

    return () => {
      voiceRecRefPed.current = null;
      try { rec.abort(); } catch(e) {}
      clearTimeout(voiceToastRefPed.current);
      setVoiceTranscriptPed("");
      window.removeEventListener("offline", onOffline);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceActivePed]);

  const start = () => {
    const lf = getNow();
    setLowFlowStart(lf);
    setRunning(true);
    setEvents([{ id:"start", label:"Début RCP médicalisée", icon:"🫀", time:lf, sec:0 }]);
  };
  useEffect(() => { window.scrollTo(0, 0); start(); }, []);

  // Clôturer & archiver la réa pédiatrique
  const cloturerEtArchiver = () => {
    if (typeof window !== "undefined" &&
        !window.confirm("Clôturer cette réanimation pédiatrique ?\nElle sera archivée puis la session sera effacée.")) return;
    if (debriefEnabled) { setShowDebriefPed(true); return; }
    _doCloture();
  };
  const _doCloture = () => {
    const hasContent = (events && events.length > 1) || patPed.nom || sec > 0;
    if (hasContent) {
      const outcome = events.find(e => e.id === "rosc") ? "RACS"
                    : events.find(e => e.id === "deces") ? "Décès" : "—";
      const recidive = events.some(e => e.id === "re_arret");
      saveArchive({
        key: Date.now(),
        archivedAt: new Date().toISOString(),
        type: isVLI ? (vliUnlockedPed ? "VLI Pédiatrique → Médicalisé" : "VLI Pédiatrique") : "Pédiatrique",
        label: patPed.nom ? `${patPed.nom} ${patPed.prenom}`.trim() : `${poids} kg`,
        durationSec: sec,
        outcome,
        recidive,
        props: {
          patient: { nom:patPed.nom, prenom:patPed.prenom, ddn:patPed.ddn,
            age: patPed.age || calcAge(patPed.ddn) || localRow?.age || "", sexe:"",
            temp:patPed.temp, atcd:patPed.atcd, histoire:patPed.histoire },
          noFlow: noFlowMin, lowFlow: lowFlowMin, acrTime: localAcrTime,
          iot: { cormack:"", sonde:localMat?.sondeAvecBallonnet||"", repere:localMat?.repereLab||"", capno:"" },
          events: [...events], totalSec: sec, trans: { ...transPed }, hemocue: [],
        },
      });
    }
    teamPed.disconnect();
    setVliUnlockedPed(false); setModalVliTransitionPed(false);
    clearSession("acr_ped_");
    if (onHome) onHome();
  };

  // ── Modal Mode équipe pédiatrique ──
  const teamModalPed = modalTeamPed && (
    <Modal title="Mode équipe" icon="👥" soft={P.surfaceAlt} onClose={() => setModalTeamPed(false)}>
      {!teamPed.teamConnected ? (
        <>
          <p style={{ margin:"0 0 16px", fontSize:12.5, color:P.textSoft, lineHeight:1.5 }}>
            Synchronise la chronologie, l'heure d'ACR, le no-flow/low-flow et la transmission
            entre plusieurs appareils de l'équipe en temps réel.
          </p>
          <button onClick={async () => {
              if (!navigator.onLine) { setTeamJoinErrorPed("🚫 Pas de connexion internet — le mode équipe nécessite un réseau"); return; }
              setTeamJoinErrorPed("");
              try { await teamPed.startSession(); }
              catch { setTeamJoinErrorPed("Impossible de créer la session — vérifiez la connexion"); }
            }}
            style={{ width:"100%", background:`linear-gradient(135deg,${P.blue},${P.blueText})`,
              border:"none", borderRadius:13, color:"#fff", fontSize:14, fontWeight:700,
              padding:"14px", cursor:"pointer", fontFamily:sans, marginBottom:16,
              boxShadow:`0 5px 16px color-mix(in srgb, ${P.blue} 30%, transparent)` }}>
            + Créer une session d'équipe
          </button>
          {teamJoinErrorPed && (
            <p style={{ margin:"-10px 0 16px", fontSize:11.5, color:P.roseText, textAlign:"center" }}>{teamJoinErrorPed}</p>
          )}
          <div style={{ borderTop:`1px solid ${P.borderSoft}`, margin:"4px 0 16px" }} />
          <Lbl>Rejoindre avec un code (6 caractères)</Lbl>
          <div style={{ display:"flex", gap:8 }}>
            <input value={teamJoinCodePed}
              onChange={e => { setTeamJoinCodePed(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6)); setTeamJoinErrorPed(""); }}
              placeholder="X7K4M2"
              style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:10, padding:"12px", fontSize:20, color:P.text, fontFamily:mono,
                textAlign:"center", fontWeight:700, letterSpacing:"0.1em", outline:"none",
                textTransform:"uppercase" }}
              onFocus={e => e.target.style.borderColor = P.blue}
              onBlur={e  => e.target.style.borderColor = P.border} />
            <button onClick={async () => {
              if (teamJoinCodePed.length !== 6) { setTeamJoinErrorPed("Code à 6 caractères"); return; }
              const r = await teamPed.joinSession(teamJoinCodePed);
              if (!r.ok) setTeamJoinErrorPed(r.error); else setModalTeamPed(false);
            }} style={{ background:P.blue, border:"none", borderRadius:10, color:"#fff",
              padding:"0 18px", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
              Rejoindre
            </button>
          </div>
          {teamJoinErrorPed && <p style={{ margin:"8px 0 0", fontSize:12, color:P.roseText }}>{teamJoinErrorPed}</p>}
        </>
      ) : (
        <>
          <div style={{ textAlign:"center", marginBottom:16 }}>
            <p style={{ margin:"0 0 6px", fontSize:10, fontWeight:700, color:P.textSoft,
              textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Code de session</p>
            <p style={{ margin:"0 0 14px", fontSize:38, fontWeight:900, color:P.text,
              fontFamily:mono, letterSpacing:"0.1em" }}>{teamPed.teamCode}</p>
            <img src={qrUrl(teamPed.teamCode)} alt="QR code session"
              style={{ width:180, height:180, borderRadius:12, border:`1px solid ${P.border}` }} />
            <p style={{ margin:"10px 0 0", fontSize:12, color:P.greenText, fontWeight:700 }}>
              🟢 {teamPed.teamDeviceCount} appareil(s) connecté(s)
            </p>
            <p style={{ margin:"4px 0 0", fontSize:10.5,
              color: teamPed.syncStatus === "error" ? P.roseText : P.textSoft }}>
              {teamPed.syncStatus === "error" ? "⚠️ Échec de synchronisation — nouvelle tentative au prochain geste"
                : teamPed.syncStatus === "syncing" ? "🟡 Synchronisation en cours…"
                : teamPed.lastSyncedAt ? `Synchronisé ${fmtSyncAge(teamPed.lastSyncedAt)}` : "En attente de données…"}
            </p>
          </div>
          <button onClick={() => { teamPed.disconnect(); setModalTeamPed(false); }}
            style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
              borderRadius:12, color:P.textMid, fontSize:13, fontWeight:600,
              padding:"12px", cursor:"pointer", fontFamily:sans }}>
            Quitter la session
          </button>
        </>
      )}
    </Modal>
  );

  // DebriefModal pédiatrique
  const debriefPedRender = showDebriefPed && (
    <DebriefModal
      events={events} totalSec={sec} noFlow={noFlowMin} lowFlow={lowFlowMin}
      etco2List={etco2ListPed} ccfEnabled={ccfEnabled} ccfPct={ccfPctPed}
      onClose={() => { setShowDebriefPed(false); _doCloture(); }}
      P={P} mono={mono} sans={sans} disp={disp} fmtSec={fmtSec}
    />
  );

  // CCF pédiatrique — bascule pause/reprise des compressions
  const prevCpRefPed = useRef(-1);
  useEffect(() => {
    if (!running) return;
    const cp = (sec - cycleOffset) % 120;
    if (prevCpRefPed.current > 0 && cp === 0) {
      playCycleBip();
      if (!events.find(e => e.id === "rosc") && !events.find(e => e.id === "deces")) {
        setShowRythmFlashPed(true);
      }
    }
    prevCpRefPed.current = cp;
  }, [sec]);
  // Métronome pédiatrique — scheduler Web Audio lookahead (robuste)
  const [showRythmFlashPed, setShowRythmFlashPed] = useState(false);
  const metroCtxPedRef   = useRef(null);
  const metroNextPedRef  = useRef(0);
  const metroTimerPedRef = useRef(null);
  const mutedPedRef2     = useRef(metronomeMutedPed);
  useEffect(() => { mutedPedRef2.current = metronomeMutedPed; }, [metronomeMutedPed]);
  const roscPedRef2      = useRef(!!events.find(e=>e.id==="rosc"));
  useEffect(() => { roscPedRef2.current = !!events.find(e=>e.id==="rosc"); }, [events]);

  const schedulePed = () => {
    const ctx = metroCtxPedRef.current;
    if (!ctx || ctx.state === "closed") return;
    while (metroNextPedRef.current < ctx.currentTime + 0.2) {
      if (!mutedPedRef2.current && !roscPedRef2.current) {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "square"; o.frequency.value = 1000;
        const t = metroNextPedRef.current;
        g.gain.setValueAtTime(0.15, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
        o.start(t); o.stop(t + 0.03);
      }
      metroNextPedRef.current += 0.6;
    }
  };

  useEffect(() => {
    if (!metronomeEnabled || !running) {
      clearInterval(metroTimerPedRef.current);
      metroTimerPedRef.current = null;
      if (metroCtxPedRef.current) { metroCtxPedRef.current.close().catch(()=>{}); metroCtxPedRef.current = null; }
      return;
    }
    const startSchedulerPed = () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        ctx.resume().catch(()=>{});
        metroCtxPedRef.current = ctx;
        metroNextPedRef.current = ctx.currentTime + 0.05;
        schedulePed();
        metroTimerPedRef.current = setInterval(schedulePed, 50);
      } catch(e) {}
    };
    if (!metroCtxPedRef.current || metroCtxPedRef.current.state === "closed") {
      startSchedulerPed();
    }
    return () => {
      clearInterval(metroTimerPedRef.current);
      metroTimerPedRef.current = null;
      if (metroCtxPedRef.current) { metroCtxPedRef.current.close().catch(()=>{}); metroCtxPedRef.current = null; }
    };
  }, [metronomeEnabled, running]);
  const compPausedPed = ccfPausedSincePed != null;
  const ccfPausedNowPed = ccfPausedTotalPed + (compPausedPed ? Math.max(0, sec - ccfPausedSincePed) : 0);
  const ccfPctPed = sec > 0 ? Math.max(0, Math.min(100, Math.round(((sec - ccfPausedNowPed) / sec) * 100))) : 100;
  const toggleCompressionsPed = () => {
    if (compPausedPed) {
      setCcfPausedTotalPed(t => t + Math.max(0, sec - ccfPausedSincePed));
      setCcfPausedSincePed(null);
    } else {
      setCcfPausedSincePed(sec);
    }
    try { if (navigator.vibrate) navigator.vibrate(20); } catch(e){}
  };

  const cp = (sec - cycleOffset)%120, pct=(cp/120)*100, rem=120-cp;
  const warn=rem<=30, crit=rem<=8;
  const bar=crit?P.rose:warn?P.amber:P.blue;

  const adrLabel  = localMat ? `Adrénaline ${localMat.adrenalineMg} mg` : "Adrénaline";
  const amioLabel = localMat ? `Amiodarone ${localMat.amio} mg`         : "Amiodarone";

  // Style bouton de rythme dans modal
  const RythmBtn = ({ r, extra }) => (
    <button
      onClick={() => { addEvent(r.id, r.log || `Rythme : ${r.label}`, "📈"); setModalRythme(false); if(extra) extra(); }}
      style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
        borderRadius:12, padding:"12px 14px", cursor:"pointer", fontFamily:sans,
        textAlign:"left", marginBottom:10, display:"flex", alignItems:"center", gap:14 }}
      onPointerDown={e=>{e.currentTarget.style.background=r.soft;e.currentTarget.style.borderColor=r.accent;}}
      onPointerUp={e=>{e.currentTarget.style.background=P.surfaceAlt;e.currentTarget.style.borderColor=P.border;}}
      onPointerLeave={e=>{e.currentTarget.style.background=P.surfaceAlt;e.currentTarget.style.borderColor=P.border;}}>
      <div style={{width:44,height:44,background:r.soft,borderRadius:12,padding:8,boxSizing:"border-box",color:r.accent,flexShrink:0}}>{r.svg}</div>
      <div><p style={{margin:0,fontSize:15,fontWeight:600,color:P.text}}>{r.label}</p>
        <p style={{margin:"2px 0 0",fontSize:12,color:P.textSoft}}>{r.sub}</p></div>
    </button>
  );

  const SmInput = ({ value, onChange, placeholder, label, unit, accent }) => (
    <div style={{ marginBottom:10 }}>
      {label && <Lbl>{label}</Lbl>}
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <input type="number" inputMode="decimal" value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`, borderRadius:9,
            padding:"10px 8px", fontSize:16, color:P.text, fontFamily:mono, outline:"none",
            textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
          onFocus={e=>e.target.style.borderColor=accent||P.blue}
          onBlur={e=>e.target.style.borderColor=P.border} />
        {unit && <span style={{fontSize:11,color:P.textSoft,whiteSpace:"nowrap"}}>{unit}</span>}
      </div>
    </div>
  );

  return (
    <div style={{ background:P.bg, minHeight:"100vh", fontFamily:sans, paddingBottom:70,
      overflowX:"hidden", boxSizing:"border-box", width:"100%" }}>

      {/* ── MODALS ── */}

      {/* Analyse rythme */}
      {modalRythme && (
        <Modal title="Analyse de rythme" icon={<div style={{width:24,height:24}}>{ICONS.rythme}</div>}
          soft={P.amberSoft} onClose={() => setModalRythme(false)}>
          {[
            { id:"rv_fvtv", label:"FV / TV",   sub:"Fibrillation ou TV",            svg:ICONS.fvtv,      accent:P.rose,  soft:P.roseSoft,  textC:P.roseText  },
            { id:"rv_aesp", label:"AESP",       sub:"Activité électrique sans pouls",svg:ICONS.aesp,      accent:P.amber, soft:P.amberSoft, textC:P.amberText },
            { id:"rv_asy",  label:"Asystolie",  sub:"Absence d'activité électrique", svg:ICONS.asystolie, accent:P.slate, soft:P.slateSoft, textC:P.slateText },
            { id:"rosc",    label:"RACS",        sub:"Retour activité cardiaque",     svg:ICONS.racs,      accent:P.green, soft:P.greenSoft, textC:P.greenText,
              log:"RACS — Retour activité cardiaque spontanée" },
          ].map(r => <RythmBtn key={r.id} r={r} />)}
          <div style={{ borderTop:`1px solid ${P.borderSoft}`, margin:"4px 0 12px" }} />
          <button onClick={() => { setModalRythme(false); setModalEcgPed(true); }}
            style={{ width:"100%", background:P.tealSoft, border:`1.5px solid #B2DADA`,
              borderRadius:12, padding:"12px 14px", cursor:"pointer", fontFamily:sans,
              textAlign:"left", display:"flex", alignItems:"center", gap:14 }}>
            <div style={{width:44,height:44,background:"#B2DADA",borderRadius:12,padding:8,boxSizing:"border-box",color:P.teal,flexShrink:0}}>
              <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="4" y="8" width="32" height="26" rx="4"/>
                <polyline points="8,21 12,21 15,13 18,29 21,17 24,25 27,21 32,21"/>
              </svg>
            </div>
            <div>
              <p style={{margin:0,fontSize:15,fontWeight:600,color:P.tealText}}>ECG post-RACS</p>
              <p style={{margin:"2px 0 0",fontSize:12,color:P.teal}}>{ecgTxt?"Décrit ✓ — Modifier":"Décrire l'électrocardiogramme"}</p>
            </div>
          </button>
        </Modal>
      )}

      {/* Modals hémodynamiques pédiatriques */}
      {modalHemoPed && (
        <Modal title="Mesure hémodynamique" icon="💓" soft={P.greenSoft} onClose={() => setModalHemoPed(false)}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:12 }}>
            {[{k:"pas",l:"PAS",c:P.rose},{k:"pad",l:"PAD",c:P.blue},{k:"fc",l:"FC",c:P.violet}].map(({k,l,c}) => (
              <div key={k}>
                <p style={{ margin:"0 0 5px", fontSize:9, fontWeight:700, color:c, fontFamily:mono, letterSpacing:"0.1em" }}>{l}</p>
                <input type="number" inputMode="numeric" value={hemoFormPed[k]}
                  onChange={e => setHemoFormPed(f => ({...f,[k]:e.target.value}))} placeholder="—"
                  style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                    borderRadius:10, padding:"12px 8px", fontSize:22, color:P.text, fontFamily:mono,
                    textAlign:"center", fontWeight:800, boxSizing:"border-box", outline:"none" }}
                  onFocus={e => e.target.style.borderColor = c}
                  onBlur={e  => e.target.style.borderColor = P.border} />
              </div>
            ))}
          </div>
          {(hemoFormPed.pas && hemoFormPed.pad) && (
            <div style={{ background:P.amberSoft, border:`1px solid ${P.amber}`, borderRadius:9,
              padding:"7px 12px", marginBottom:12, display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:9.5, fontWeight:700, color:P.amberText, fontFamily:mono }}>PAM :</span>
              <span style={{ fontSize:20, fontWeight:800, color:P.amberText, fontFamily:mono }}>
                {Math.round(parseFloat(hemoFormPed.pad) + (parseFloat(hemoFormPed.pas) - parseFloat(hemoFormPed.pad)) / 3)} mmHg
              </span>
            </div>
          )}
          {(hemoFormPed.fc && hemoFormPed.pas) && (() => {
            const si = parseFloat(hemoFormPed.fc) / parseFloat(hemoFormPed.pas);
            const siR = Math.round(si * 100) / 100;
            const siC = si < 0.9 ? P.greenText : si <= 1.4 ? P.amberText : P.roseText;
            const siL = si < 0.9 ? "Normal" : si <= 1.4 ? "Inquiétant" : "Critique";
            return (
              <div style={{ background: si < 0.9 ? P.greenSoft : si <= 1.4 ? P.amberSoft : P.roseSoft,
                border:`1px solid ${siC}`, borderRadius:9, padding:"7px 12px", marginBottom:12,
                display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:9.5, fontWeight:700, color:siC, fontFamily:mono }}>Shock Index :</span>
                <span style={{ fontSize:20, fontWeight:800, color:siC, fontFamily:mono }}>{siR}</span>
                <span style={{ fontSize:9.5, fontWeight:700, color:siC }}>{si < 0.9 ? "✅ Normal" : si <= 1.4 ? "⚠️ Inquiétant" : "🔴 Critique"}</span>
              </div>
            );
          })()}
          <button onClick={() => {
            if (!hemoFormPed.pas && !hemoFormPed.pad && !hemoFormPed.fc) { setModalHemoPed(false); return; }
            setHemoListPed(prev => [...prev, { sec, time: getNow(), ...hemoFormPed }]);
            try { if (navigator.vibrate) navigator.vibrate(28); } catch(e){}
            setModalHemoPed(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.green}, ${P.greenText})`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
            padding:"13px", cursor:"pointer", fontFamily:sans }}>✓ Enregistrer</button>
        </Modal>
      )}
      {modalAminePed && (
        <Modal title="Instauration amine" icon="💊" soft={P.greenSoft} onClose={() => setModalAminePed(false)}>
          <Lbl>Médicament</Lbl>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
            {["Noradrénaline","Adrénaline","Dobutamine","Autre"].map(t => (
              <button key={t} onClick={() => setAmineFormPed(f => ({...f, type:t}))}
                style={{ background: amineFormPed.type===t ? P.greenSoft : P.surfaceAlt,
                  border:`1.5px solid ${amineFormPed.type===t ? P.green : P.border}`,
                  borderRadius:10, padding:"10px 8px", cursor:"pointer", fontFamily:sans,
                  fontSize:12, fontWeight:700, color: amineFormPed.type===t ? P.greenText : P.text }}>{t}</button>
            ))}
          </div>
          <Lbl>Dose</Lbl>
          <div style={{ display:"flex", gap:8, marginBottom:14 }}>
            <input type="number" inputMode="decimal" value={amineFormPed.dose}
              onChange={e => setAmineFormPed(f => ({...f, dose:e.target.value}))} placeholder="ex : 0.2"
              style={{ flex:2, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:10, padding:"12px", fontSize:22, color:P.text, fontFamily:mono,
                textAlign:"center", fontWeight:800, outline:"none" }}
              onFocus={e => e.target.style.borderColor = P.green}
              onBlur={e  => e.target.style.borderColor = P.border} />
            <select value={amineFormPed.unit} onChange={e => setAmineFormPed(f => ({...f, unit:e.target.value}))}
              style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:10, padding:"8px", fontSize:12, color:P.text, fontFamily:mono, fontWeight:700, outline:"none" }}>
              {["mg/h","µg/kg/min","µg/min","mL/h"].map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <button onClick={() => {
            if (!amineFormPed.dose) { setModalAminePed(false); return; }
            const label = `${amineFormPed.type} ${amineFormPed.dose} ${amineFormPed.unit}`;
            setAmineListPed(prev => [...prev, { sec, time: getNow(), type: amineFormPed.type, dose: amineFormPed.dose, unit: amineFormPed.unit, label }]);
            addEvent("amine", label, "💊");
            try { if (navigator.vibrate) navigator.vibrate(28); } catch(e){}
            setModalAminePed(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.green}, ${P.greenText})`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
            padding:"13px", cursor:"pointer", fontFamily:sans }}>✓ Enregistrer</button>
        </Modal>
      )}

      {/* Modal saisie EtCO₂ pédiatrique */}
      {modalEtco2Ped && (
        <Modal title="EtCO₂ — capnographie" icon="📈" soft={P.tealSoft} onClose={() => setModalEtco2Ped(false)}>
          <Lbl>Valeur mesurée (mmHg)</Lbl>
          <input type="number" inputMode="numeric" value={etco2ValPed}
            onChange={e => setEtco2ValPed(e.target.value)} placeholder="ex : 22" autoFocus
            style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
              borderRadius:12, padding:"16px", fontSize:30, color:P.text, fontFamily:mono,
              textAlign:"center", fontWeight:800, boxSizing:"border-box", outline:"none" }}
            onFocus={e => e.target.style.borderColor = P.teal}
            onBlur={e  => e.target.style.borderColor = P.border} />
          <p style={{ margin:"10px 0 0", fontSize:11, color:P.textSoft, lineHeight:1.5 }}>
            Repère : &lt; 10 mmHg → optimiser le MCE · remontée brutale → possible RACS · chute brutale → sonde déplacée
          </p>
          <button onClick={() => {
            const v = parseFloat(String(etco2ValPed).replace(",", "."));
            if (!isNaN(v)) {
              setEtco2ListPed(prev => [...prev, { val: String(etco2ValPed).replace(",", "."), sec, time: getNow() }]);
              try { if (navigator.vibrate) navigator.vibrate(28); } catch(e){}
            }
            setModalEtco2Ped(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.teal}, ${P.tealText})`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
            padding:"14px", cursor:"pointer", fontFamily:sans, marginTop:14,
            boxShadow:`0 5px 16px color-mix(in srgb, ${P.teal} 30%, transparent)` }}>
            ✓ Ajouter à la courbe
          </button>
        </Modal>
      )}

      {/* ECG post-RACS */}
      {modalEcgPed && (
        <Modal title="ECG post-RACS" icon="📈" soft={P.tealSoft} onClose={() => setModalEcgPed(false)}>
          <p style={{margin:"0 0 10px",fontSize:12,color:P.textSoft}}>Décrivez le tracé ECG obtenu après retour de circulation</p>
          <textarea value={ecgTxt} onChange={e => setEcgTxt(e.target.value)}
            placeholder={"RSR, axe, BBG, sus-ST...\nTSV, FC, QT allongé..."}
            rows={5} style={{width:"100%",background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
              borderRadius:10,padding:"12px 14px",fontSize:14,color:P.text,fontFamily:sans,
              boxSizing:"border-box",outline:"none",resize:"vertical",lineHeight:1.7}}
            onFocus={e=>e.target.style.borderColor=P.teal} onBlur={e=>e.target.style.borderColor=P.border} />
          <div style={{display:"flex",gap:10,marginTop:14}}>
            <button onClick={() => setModalEcgPed(false)}
              style={{flex:1,background:P.surfaceAlt,border:`1px solid ${P.border}`,borderRadius:11,
                padding:"12px",color:P.textMid,fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:sans}}>← Retour</button>
            <button onClick={() => { if(ecgTxt.trim()) addEvent("ecg",`ECG post-RACS : ${ecgTxt.trim()}`,"📈"); setModalEcgPed(false); }}
              style={{flex:2,background:`linear-gradient(135deg,${P.teal},#1A6A6A)`,border:"none",borderRadius:11,
                padding:"12px",color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:sans}}>
              ✓ Enregistrer l'ECG</button>
          </div>
        </Modal>
      )}

      {/* Défibrillation pédiatrique */}
      {modalChocPed && (
        <Modal title="Défibrillation" icon={<div style={{width:24,height:24,color:P.blue}}>{ICONS.choc}</div>}
          soft={P.blueSoft} onClose={() => setModalChocPed(false)}>
          <div style={{background:P.blueSoft,borderRadius:12,padding:"14px",marginBottom:12,border:`1.5px solid ${P.blue}`}}>
            <p style={{margin:"0 0 10px",fontSize:13,fontWeight:600,color:P.blueText}}>
              ⚡ Recommandé : {localMat ? `${localMat.defibJ} J` : "—"}
            </p>
            <div style={{display:"flex",gap:8,marginBottom:10}}>
              {[localMat?.defibJ, localMat?Math.round(localMat.defibJ*1.5):null, localMat?Math.round(localMat.defibJ*2):null]
                .filter(Boolean).map(j=>(
                <button key={j} onClick={()=>setJoules(String(j))}
                  style={{flex:1,padding:"8px 4px",borderRadius:10,
                    border:`1.5px solid ${joules===String(j)?P.blue:P.border}`,
                    background:joules===String(j)?P.blue:P.surface,
                    color:joules===String(j)?"#fff":P.textMid,
                    fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:mono}}>{j}</button>
              ))}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
              <span style={{fontSize:12,color:P.textMid}}>Autre :</span>
              <input type="number" value={joules} onChange={e=>setJoules(e.target.value)}
                style={{width:70,background:P.surface,border:`1.5px solid ${P.border}`,borderRadius:9,
                  padding:"7px 8px",fontSize:16,color:P.text,fontFamily:mono,outline:"none",
                  textAlign:"center",fontWeight:700,boxSizing:"border-box"}}
                onFocus={e=>e.target.style.borderColor=P.blue} onBlur={e=>e.target.style.borderColor=P.border}/>
              <span style={{fontSize:12,color:P.textSoft}}>J</span>
            </div>
            <button onClick={()=>{addEvent("choc",`Défibrillation ${joules} J`,"⚡");setModalChocPed(false);}}
              style={{width:"100%",background:`linear-gradient(135deg,${P.blue},${P.blueText})`,
                border:"none",borderRadius:11,color:"#fff",fontSize:14,fontWeight:600,
                padding:"13px",cursor:"pointer",fontFamily:sans}}>✓ Choc {joules} J délivré</button>
          </div>
          <button onClick={()=>{addEvent("patchs","Changement de patchs — Position antéro-postérieure","🔄");setModalChocPed(false);}}
            style={{width:"100%",background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
              borderRadius:12,padding:"12px 16px",cursor:"pointer",fontFamily:sans,textAlign:"left",marginBottom:8}}>
            <p style={{margin:"0 0 2px",fontSize:14,fontWeight:600,color:P.text}}>🔄 Changement de patchs</p>
            <p style={{margin:0,fontSize:12,color:P.textSoft}}>Position antéro-postérieure</p>
          </button>
          <button onClick={()=>{addEvent("doublechoc","Double défibrillation délivrée","⚡⚡");setModalChocPed(false);}}
            style={{width:"100%",background:P.blueSoft,border:`1.5px solid color-mix(in srgb, ${P.blue} 27%, transparent)`,
              borderRadius:12,padding:"12px 16px",cursor:"pointer",fontFamily:sans,textAlign:"left",
              display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:30,height:30,color:P.blue,flexShrink:0}}>{ICONS.doublechoc}</div>
            <div>
              <p style={{margin:"0 0 2px",fontSize:14,fontWeight:600,color:P.blueText}}>Double défibrillation</p>
              <p style={{margin:0,fontSize:12,color:P.textSoft}}>Deux chocs simultanés délivrés</p>
            </div>
          </button>
        </Modal>
      )}

      {/* Voie d'abord */}
      {modalVvpPed && (
        <Modal title="Voie d'abord" icon={<div style={{width:24,height:24,color:P.green}}>{ICONS.vvp}</div>} soft={P.greenSoft} onClose={() => setModalVvpPed(false)}>
          <ChoiceBtn label="Voie veineuse périphérique" sub="VVP — cathéter veineux périphérique"
            accent={P.green} soft={P.greenSoft} textC={P.greenText}
            onClick={()=>{addEvent("vvp","Voie veineuse périphérique (VVP) posée","🩹");setModalVvpPed(false);}} />
          <ChoiceBtn label="Voie intra-osseuse" sub="VIO — E-ZIO"
            accent={P.teal} soft={P.tealSoft} textC={P.tealText}
            onClick={()=>{addEvent("vio","Voie intra-osseuse (VIO) posée","🦴");setModalVvpPed(false);}} />
        </Modal>
      )}

      {/* Intubation pédiatrique */}
      {modalIotPed && (
        <Modal title="Intubation oro-trachéale" icon={<div style={{width:24,height:24,color:P.violet}}>{ICONS.iot}</div>}
          soft={P.violetSoft} onClose={() => setModalIotPed(false)}>

          {/* ── Intubation difficile — dépliable, techniques utilisées ── */}
          <div style={{ background: iotDifficilePed ? P.roseSoft : P.surfaceAlt,
            border:`1.5px solid ${iotDifficilePed ? P.rose : P.border}`, borderRadius:12,
            padding:"12px 14px", marginBottom:14 }}>
            <button onClick={() => setIotDifficilePed(v => !v)}
              style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
                background:"transparent", border:"none", cursor:"pointer", padding:0, textAlign:"left" }}>
              <span style={{ fontSize:18, flexShrink:0 }}>{iotDifficilePed ? "⚠️" : "🫁"}</span>
              <span style={{ flex:1, fontSize:13.5, fontWeight:800,
                color: iotDifficilePed ? P.roseText : P.text }}>Intubation difficile</span>
              <span style={{ width:44, height:26, borderRadius:13, flexShrink:0,
                background: iotDifficilePed ? P.rose : P.border, position:"relative", transition:"background 0.15s" }}>
                <span style={{ position:"absolute", top:2, left: iotDifficilePed ? 20 : 2, width:22, height:22,
                  borderRadius:"50%", background:"#fff", transition:"left 0.15s", boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }} />
              </span>
            </button>
            {iotDifficilePed && (
              <div style={{ marginTop:12 }}>
                <Lbl>Technique(s) utilisée(s)</Lbl>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {["Mandrin d'Eschmann (bougie)","Vidéolaryngoscope","Masque laryngé standard","Fastrach (ML intubation)","Dispositif supra-glottique (secours)","Cricothyroïdotomie"].map(t => {
                    const active = iotTechDifficilePed.includes(t);
                    return (
                      <button key={t} onClick={() => setIotTechDifficilePed(
                          active ? iotTechDifficilePed.filter(x => x !== t) : [...iotTechDifficilePed, t]
                        )}
                        style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                          borderRadius:9, border:`1.5px solid ${active ? P.rose : P.border}`,
                          background: active ? P.rose : P.surface, color: active ? "#fff" : P.textMid,
                          fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:sans, textAlign:"left" }}>
                        <span style={{ width:16, height:16, borderRadius:4, flexShrink:0,
                          border:`1.5px solid ${active ? "#fff" : P.border}`,
                          background: active ? "rgba(255,255,255,0.25)" : "transparent",
                          display:"flex", alignItems:"center", justifyContent:"center", fontSize:10 }}>
                          {active && "✓"}
                        </span>
                        {t}
                      </button>
                    );
                  })}
                </div>
                <div style={{ marginTop:12 }}>
                  <Lbl>Nombre de tentatives</Lbl>
                  <ChipGroup options={["1","2","3","4+"]} value={iotNbTentativesPed} onChange={setIotNbTentativesPed} />
                </div>
              </div>
            )}
          </div>

          <div style={{background:P.amberSoft,border:`1px solid color-mix(in srgb, ${P.amber} 27%, transparent)`,borderRadius:10,padding:"10px 14px",marginBottom:14}}>
            <p style={{margin:"0 0 4px",fontSize:11,fontWeight:600,color:P.amberText}}>Tailles recommandées</p>
            <p style={{margin:0,fontSize:12,color:P.amberText}}>
              Sonde : {localMat?.sondeAvecBallonnet||"—"} mm (avec ballonnet) · {localMat?.sondeSansBallonnet||"—"} mm (sans)<br/>
              Repère lèvre : {localMat?.repereLab||"—"} cm · Lame : {localMat?.lame||"—"}
            </p>
          </div>
          <Lbl>Taille sonde utilisée (mm)</Lbl>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
            {["2.0","2.5","3.0","3.5","4.0","4.5","5.0","5.5","6.0"].map(s=>(
              <button key={s} onClick={()=>setIotSonde(s)}
                style={{padding:"7px 12px",borderRadius:20,fontSize:13,fontWeight:500,
                  border:`1.5px solid ${iotSonde===s?P.violet:P.border}`,
                  background:iotSonde===s?P.violetSoft:P.surfaceAlt,
                  color:iotSonde===s?P.violetText:P.textMid,cursor:"pointer",fontFamily:sans}}>
                {s}
              </button>
            ))}
          </div>

          {/* Repère — input inline direct */}
          <div style={{marginBottom:14}}>
            <Lbl>Repère à la lèvre (cm)</Lbl>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <input
                type="number" inputMode="decimal"
                value={iotRepere}
                onChange={e => setIotRepere(e.target.value)}
                placeholder={String(localMat?.repereLab||"")}
                style={{flex:1,background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
                  borderRadius:9,padding:"12px 10px",fontSize:18,color:P.text,fontFamily:mono,
                  outline:"none",textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                onFocus={e=>e.target.style.borderColor=P.violet}
                onBlur={e=>e.target.style.borderColor=P.border}
              />
              <span style={{fontSize:12,color:P.textSoft,flexShrink:0}}>cm</span>
            </div>
          </div>

          {/* Capno — input inline direct */}
          <div style={{marginBottom:16}}>
            <Lbl>Capno à l'intubation (EtCO₂)</Lbl>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <input
                type="number" inputMode="decimal"
                value={iotCapno}
                onChange={e => setIotCapno(e.target.value)}
                placeholder="35"
                style={{flex:1,background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
                  borderRadius:9,padding:"12px 10px",fontSize:18,color:P.text,fontFamily:mono,
                  outline:"none",textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                onFocus={e=>e.target.style.borderColor=P.violet}
                onBlur={e=>e.target.style.borderColor=P.border}
              />
              <span style={{fontSize:12,color:P.textSoft,flexShrink:0}}>mmHg</span>
            </div>
          </div>

          <button onClick={() => setIotInhalationPed(v => !v)}
            style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
              background: iotInhalationPed ? P.amberSoft : P.surfaceAlt,
              border:`1.5px solid ${iotInhalationPed ? P.amber : P.border}`, borderRadius:11,
              padding:"11px 13px", marginBottom:16, cursor:"pointer", fontFamily:sans, textAlign:"left" }}>
            <span style={{ fontSize:16, flexShrink:0 }}>{iotInhalationPed ? "🟠" : "💧"}</span>
            <span style={{ flex:1, fontSize:12.5, fontWeight:700, color: iotInhalationPed ? P.amberText : P.textMid }}>
              Inhalation objectivée (régurgitation/liquide gastrique)
            </span>
            <span style={{ width:20, height:20, borderRadius:6, flexShrink:0,
              border:`1.5px solid ${iotInhalationPed ? P.amber : P.border}`,
              background: iotInhalationPed ? P.amber : "transparent",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:"#fff" }}>
              {iotInhalationPed && "✓"}
            </span>
          </button>

          <button onClick={()=>{
            const parts = [iotSonde&&`sonde ${iotSonde}mm`, iotRepere&&`repère ${iotRepere}cm`, iotCapno&&`ETCO2 ${iotCapno}mmHg`].filter(Boolean);
            if (iotDifficilePed) {
              const techPart = iotTechDifficilePed.length ? " (" + iotTechDifficilePed.join(", ") + ")" : "";
              const tentPart = iotNbTentativesPed ? ` — ${iotNbTentativesPed} tentative${parseInt(iotNbTentativesPed) > 1 ? "s" : ""}` : "";
              parts.push(`intubation difficile${techPart}${tentPart}`);
            }
            if (iotInhalationPed) parts.push("inhalation objectivée");
            const detail = parts.join(", ");
            addEvent("iot",`Intubation${detail?` (${detail})`:""}`, "🫁");
            if (iotCapno) {
              setEtco2ListPed(prev => [...prev, { val: iotCapno, sec, time: getNow() }]);
            }
            setIotDifficilePed(false); setIotTechDifficilePed([]); setIotNbTentativesPed(""); setIotInhalationPed(false);
            setModalIotPed(false);
          }} style={{width:"100%",background:`linear-gradient(135deg,${P.violet},#5A4E8A)`,
            border:"none",borderRadius:12,color:"#fff",fontSize:14,fontWeight:600,
            padding:"14px",cursor:"pointer",fontFamily:sans,
            boxShadow:`0 6px 18px color-mix(in srgb, ${P.violet} 20%, transparent)`}}>
            ✓ Valider l'intubation</button>
        </Modal>
      )}

      {/* Fast-écho */}
      {modalFastPed && (
        <Modal title="Fast-écho" icon={<div style={{width:24,height:24,color:P.blue}}>{ICONS.fast}</div>}
          soft={P.blueSoft} onClose={() => setModalFastPed(false)}>
          <p style={{margin:"0 0 10px",fontSize:12,color:P.textSoft}}>Résultat de l'échographie</p>
          <textarea value={fastTxt} onChange={e=>setFastTxt(e.target.value)}
            placeholder={"Activité cardiaque présente / absente\nÉpanchement péricardique\nPneumothorax D / G\nCavités collabées..."}
            rows={4} style={{width:"100%",background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
              borderRadius:10,padding:"12px 14px",fontSize:14,color:P.text,fontFamily:sans,
              boxSizing:"border-box",outline:"none",resize:"vertical",lineHeight:1.6}}
            onFocus={e=>e.target.style.borderColor=P.blue} onBlur={e=>e.target.style.borderColor=P.border}/>
          <button onClick={()=>{
            const detail=fastTxt.trim()?` — ${fastTxt.trim()}`:"";
            addEvent("fast",`Fast-écho${detail}`,"🔊");setFastTxt(""); setModalFastPed(false);
          }} style={{width:"100%",background:`linear-gradient(135deg,${P.blue},${P.blueText})`,
            border:"none",borderRadius:12,color:"#fff",fontSize:14,fontWeight:600,
            padding:"14px",cursor:"pointer",fontFamily:sans,marginTop:14}}>
            ✓ Valider le Fast-écho</button>
        </Modal>
      )}

      {/* Appel régulation */}
      {modalRegulPed && (
        <Modal title="Appel régulation" icon="📞" soft={P.amberSoft} onClose={() => setModalRegulPed(false)}>
          <Lbl>Destination</Lbl>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:14}}>
            {["PICU","Réanimation péd.","SAUV","Déchocage","Autre"].map(d=>(
              <button key={d} onClick={()=>setRegulDest(regulDest===d?"":d)}
                style={{padding:"7px 14px",borderRadius:20,fontSize:13,fontWeight:500,
                  border:`1.5px solid ${regulDest===d?P.blue:P.border}`,
                  background:regulDest===d?P.blueSoft:P.surfaceAlt,
                  color:regulDest===d?P.blueText:P.textMid,cursor:"pointer",fontFamily:sans}}>
                {d}
              </button>
            ))}
          </div>
          <Lbl>Compte-rendu de l'appel</Lbl>
          <textarea value={regulTxt} onChange={e=>setRegulTxt(e.target.value)}
            placeholder={"Médecin régulateur contacté...\nConsignes reçues...\nHeure départ prévue..."}
            rows={4} style={{width:"100%",background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
              borderRadius:10,padding:"12px 14px",fontSize:14,color:P.text,fontFamily:sans,
              boxSizing:"border-box",outline:"none",resize:"vertical",lineHeight:1.7,marginBottom:14}}
            onFocus={e=>e.target.style.borderColor=P.blue} onBlur={e=>e.target.style.borderColor=P.border}/>
          <button onClick={()=>{
            const dest=regulDest?` — ${regulDest}`:"";
            const txt=regulTxt.trim()?` — ${regulTxt.trim()}`:"";
            addEvent("regul",`Appel régulation${dest}${txt}`,"📞");
            setModalRegulPed(false);
          }} style={{width:"100%",background:"linear-gradient(135deg,#F97316,#EA6010)",
            border:"none",borderRadius:12,color:"#fff",fontSize:14,fontWeight:600,
            padding:"14px",cursor:"pointer",fontFamily:sans}}>
            ✓ Enregistrer l'appel</button>
        </Modal>
      )}

      {/* Soins post-RACS pédiatrique */}
      {/* ── Soins post-RACS — VLI Pédiatrique restreint : surveillance seule, sans amines/sédation ── */}
      {modalRacsPed && isVLI && !vliUnlockedPed && (
        <div style={{ position:"fixed", inset:0, background:"rgba(28,43,58,0.6)", zIndex:80,
          display:"flex", flexDirection:"column", justifyContent:"flex-end", backdropFilter:"blur(2px)" }}
          onClick={() => setModalRacsPed(false)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:P.surface, width:"100%", borderRadius:"20px 20px 0 0",
              padding:"20px 16px 36px", boxShadow:"0 -12px 40px rgba(0,0,0,0.18)",
              fontFamily:sans, maxHeight:"90vh", overflowY:"auto", overflowX:"hidden",
              boxSizing:"border-box" }}>
            <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:16 }}>
              <div style={{ width:42, height:42, borderRadius:13,
                background:"linear-gradient(135deg, #EA6A12, #B24E0A)",
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:22,
                boxShadow:"0 5px 16px rgba(234,106,18,0.32)" }}>🫀</div>
              <div>
                <p style={{ margin:"0 0 1px", fontSize:9.5, fontWeight:700, color:"#B24E0A",
                  textTransform:"uppercase", letterSpacing:"0.14em", fontFamily:mono }}>RACS · Protocole ISP Pédiatrique</p>
                <p style={{ margin:0, fontSize:18, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>Surveillance</p>
              </div>
              <button onClick={() => setModalRacsPed(false)}
                style={{ marginLeft:"auto", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:20, cursor:"pointer" }}>×</button>
            </div>

            <div style={{ background:"rgba(234,106,18,0.1)", border:"1px solid #EA6A12", borderRadius:10,
              padding:"10px 12px", marginBottom:14 }}>
              <p style={{ margin:"0 0 6px", fontSize:10, fontWeight:700, color:"#B24E0A",
                textTransform:"uppercase", letterSpacing:"0.06em", fontFamily:mono }}>Objectifs</p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"3px 12px" }}>
                {[["SpO₂","94–98 %"],["Monitorage","FC·PA·SpO₂·FR·T°"],["EtCO₂ / HGT","à surveiller"],
                  ["Glasgow / Pupilles","à surveiller"],["Reprise conscience","à évaluer"]].map(([l,v]) => (
                  <div key={l} style={{ display:"flex", justifyContent:"space-between" }}>
                    <span style={{ fontSize:10.5, color:"#B24E0A" }}>{l}</span>
                    <span style={{ fontSize:10.5, fontWeight:700, color:"#B24E0A", fontFamily:mono }}>{v}</span>
                  </div>
                ))}
              </div>
              <p style={{ margin:"6px 0 0", fontSize:9.5, color:"#B24E0A", fontStyle:"italic" }}>
                Surveillance uniquement — pas d'administration d'amine ou de sédation (protocole VLI)
              </p>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, marginBottom:9 }}>
              {[["fc","FC","/min"],["tas","PAS","mmHg"],["sat","SpO₂","%"],["fr","FR","/min"],
                ["tempRacs","T°","°C"],["capno","EtCO₂","mmHg"],["glycemie","HGT","g/L"],["glasgow","Glasgow","/15"]].map(([k,l,u]) => (
                <div key={k}>
                  <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                    textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>{l}</p>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <input type="number" inputMode="decimal" value={racsPed[k]} onChange={e => srp(k)(e.target.value)}
                      style={{ flex:1, minWidth:0, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                        borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text, fontFamily:mono,
                        outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                      onFocus={e => e.target.style.borderColor = "#EA6A12"}
                      onBlur={e  => e.target.style.borderColor = P.border} />
                    <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>{u}</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginBottom:14 }}>
              <Lbl>Pupilles</Lbl>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                {["Normales","Anormales","Non fait"].map(v => (
                  <button key={v} onClick={() => {
                      if (v === "Anormales") { setRacsPupillesExpandedPed(x => !x); return; }
                      srp("pupilles")(v); setRacsPupillesExpandedPed(false);
                    }}
                    style={{ padding:"8px 4px", borderRadius:9, fontSize:10.5, fontWeight:600,
                      border:`1.5px solid #EA6A12`,
                      background: (v==="Anormales" && racsPupillesExpandedPed) || (v!=="Anormales" && racsPed.pupilles===v) ? "#EA6A12" : P.surface,
                      color: (v==="Anormales" && racsPupillesExpandedPed) || (v!=="Anormales" && racsPed.pupilles===v) ? "#fff" : "#B24E0A",
                      cursor:"pointer", fontFamily:sans }}>
                    {v}
                  </button>
                ))}
              </div>
              {racsPed.pupilles && !["Normales","Non fait"].includes(racsPed.pupilles) && !racsPupillesExpandedPed && (
                <p style={{ margin:"6px 0 0", fontSize:10.5, color:"#B24E0A", fontWeight:700 }}>{racsPed.pupilles}</p>
              )}
              {racsPupillesExpandedPed && (
                <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                  {PUPILLES_DETAIL.map(({v,left,right}) => (
                    <button key={v} onClick={() => { srp("pupilles")(v); setRacsPupillesExpandedPed(false); }}
                      style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                        borderRadius:9, border:`1.5px solid ${P.border}`, background:P.surface,
                        fontSize:11.5, fontWeight:600, color:P.text, cursor:"pointer",
                        fontFamily:sans, textAlign:"left" }}>
                      <PupilIcon left={left} right={right} />{v}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <p style={{ margin:"0 0 14px", fontSize:11, color:P.textSoft, fontStyle:"italic" }}>
              📋 Penser à réaliser l'ECG 12 dérivations et évaluer la reprise de conscience.
            </p>

            <button onClick={() => {
              const parts = [];
              if (racsPed.fc) parts.push(`FC ${racsPed.fc}/min`);
              if (racsPed.tas) parts.push(`PAS ${racsPed.tas} mmHg`);
              if (racsPed.sat) parts.push(`SpO₂ ${racsPed.sat}%`);
              if (racsPed.fr) parts.push(`FR ${racsPed.fr}/min`);
              if (racsPed.tempRacs) parts.push(`T° ${racsPed.tempRacs}°C`);
              if (racsPed.capno) parts.push(`EtCO₂ ${racsPed.capno} mmHg`);
              if (racsPed.glycemie) parts.push(`HGT ${racsPed.glycemie} g/L`);
              if (racsPed.glasgow) parts.push(`Glasgow ${racsPed.glasgow}/15`);
              if (racsPed.pupilles) parts.push(`Pupilles ${racsPed.pupilles}`);
              addEvent("racs_surveillance_vli", parts.length ? `Surveillance post-RACS : ${parts.join(" · ")}` : "Surveillance post-RACS", "🫀");
              if (racsPed.tas || racsPed.fc) {
                setHemoListPed(prev => [...prev, { sec, time: getNow(), pas:racsPed.tas, pad:racsPed.tad, fc:racsPed.fc }]);
              }
              if (racsPed.capno) {
                setEtco2ListPed(prev => [...prev, { val: racsPed.capno, sec, time: getNow() }]);
              }
              setModalRacsPed(false);
            }} style={{ width:"100%", background:"linear-gradient(135deg,#EA6A12,#B24E0A)",
              border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
              padding:"14px", cursor:"pointer", fontFamily:sans }}>
              ✓ Enregistrer les constantes
            </button>
          </div>
        </div>
      )}

      {modalRacsPed && !(isVLI && !vliUnlockedPed) && (
        <div style={{position:"fixed",inset:0,background:"rgba(28,43,58,0.6)",zIndex:80,
          display:"flex",flexDirection:"column",justifyContent:"flex-end",backdropFilter:"blur(2px)"}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:P.surface,width:"100%",borderRadius:"20px 20px 0 0",
              padding:"20px 16px 40px",boxShadow:"0 -12px 40px rgba(0,0,0,0.18)",
              fontFamily:sans,maxHeight:"90vh",display:"flex",flexDirection:"column"}}>
            <div style={{display:"flex",alignItems:"center",gap:11,marginBottom:16,flexShrink:0}}>
              <div style={{width:42,height:42,borderRadius:13,
                background:`linear-gradient(135deg, ${P.green}, ${P.greenText})`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,
                boxShadow:`0 5px 16px color-mix(in srgb, ${P.green} 32%, transparent)`}}>🫀</div>
              <div>
                <p style={{margin:"0 0 1px",fontSize:9.5,fontWeight:700,color:P.green,
                  textTransform:"uppercase",letterSpacing:"0.14em",fontFamily:mono}}>Après RACS · Pédiatrie</p>
                <p style={{margin:0,fontSize:18,fontWeight:800,color:P.text,fontFamily:disp,letterSpacing:"-0.01em",lineHeight:1}}>Soins post-RACS</p>
              </div>
              <button onClick={()=>setModalRacsPed(false)}
                style={{marginLeft:"auto",background:"transparent",border:"none",color:P.textSoft,fontSize:20,cursor:"pointer"}}>×</button>
            </div>
            {/* Onglets */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,
              background:P.surfaceAlt,borderRadius:12,padding:4,marginBottom:14,flexShrink:0}}>
              {[{id:"ventil",label:"Ventil.",icon:"🌬️"},{id:"sedat",label:"Sédation",icon:"💊"},{id:"hemo",label:"Hémo.",icon:"💓"}].map(t=>(
                <button key={t.id} onClick={()=>setRacsTabPed(t.id)}
                  style={{padding:"9px 4px",borderRadius:9,border:"none",
                    background:racsTabPed===t.id?P.greenSoft:"transparent",
                    color:racsTabPed===t.id?P.greenText:P.textSoft,
                    fontSize:11,fontWeight:racsTabPed===t.id?800:600,cursor:"pointer",
                    fontFamily:racsTabPed===t.id?disp:sans,
                    boxShadow:racsTabPed===t.id?`inset 0 0 0 1px color-mix(in srgb, ${P.green} 30%, transparent)`:"none",
                    display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                  <span>{t.icon}</span>{t.label}
                </button>
              ))}
            </div>
            <div style={{flex:1,overflowY:"auto"}}>
              {racsTabPed==="ventil" && (
                <div style={{width:"100%"}}>
                  {/* Encadré normes ventilation */}
                  {localMat && (
                    <div style={{background:P.amberSoft,border:`1px solid color-mix(in srgb, ${P.amber} 27%, transparent)`,
                      borderRadius:10,padding:"10px 12px",marginBottom:12}}>
                      <p style={{margin:"0 0 6px",fontSize:9,fontWeight:600,color:P.amberText,
                        textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
                        Objectifs ventilation — {localPoids} kg · {localRow.age}
                      </p>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 10px"}}>
                        {[
                          ["Vt cible",  `${localMat.vtR} mL`],
                          ["FR",        `${localMat.frR} /min`],
                          ["I/E",       localMat.ie],
                          ["PEEP",      `${localMat.peep} cmH₂O`],
                          ["FiO₂",      "100% puis ↓"],
                          ["SpO₂",      "94–98%"],
                          ["EtCO₂",     "35–40 mmHg"],
                        ].map(([l,v])=>(
                          <div key={l} style={{display:"flex",justifyContent:"space-between",
                            alignItems:"center",padding:"1px 0"}}>
                            <span style={{fontSize:10,color:P.amberText}}>{l}</span>
                            <span style={{fontSize:11,fontWeight:700,color:P.amberText,fontFamily:mono}}>{v}</span>
                          </div>
                        ))}
                      </div>
                      <p style={{margin:"6px 0 0",fontSize:8,color:P.amberText,fontStyle:"italic",lineHeight:1.4}}>
                        {localMat.p <= 8
                          ? "< 8 kg : ventilation pression contrôlée · débuter 20-25 cmH₂O"
                          : "> 8 kg : ventilation volume contrôlé · gonfler ballonnet sonde IOT"}
                      </p>
                    </div>
                  )}
                  {[
                    [["fr","FR","/min"],["volume","Vol. Vt","mL"]],
                    [["pep","PEP","cmH₂O"],["fio2","FiO₂","%"]],
                    [["sat","SpO₂","%"],["capno","EtCO₂","mmHg"]],
                  ].map((pair,ri)=>(
                    <div key={ri} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                      {pair.map(([k,l,u])=>{
                        const isSpo2 = k === "sat";
                        const isEtco2 = k === "capno";
                        const val = parseFloat(String(racsPed[k]).replace(",","."));
                        const spo2Out = isSpo2 && !isNaN(val) && (val < 94 || val > 98);
                        const etco2Out = isEtco2 && !isNaN(val) && (val < 35 || val > 45);
                        const alertColor = spo2Out || etco2Out ? P.rose : isEtco2 && !isNaN(val) ? P.green : null;
                        const lastEtco2 = isEtco2 && etco2ListPed.length > 0 ? etco2ListPed[etco2ListPed.length-1].val : null;
                        return (
                        <div key={k} style={{minWidth:0, position:"relative"}}>
                          <p style={{margin:"0 0 4px",fontSize:9,fontWeight:500,color:P.textSoft,
                            textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>{l}</p>
                          {isEtco2 && lastEtco2 != null && <TrendBadge current={racsPed.capno} last={lastEtco2} P={P} goodDir="up" />}
                          <div style={{display:"flex",alignItems:"center",gap:4}}>
                            <input type="number" inputMode="decimal" value={racsPed[k]} onChange={e=>srp(k)(e.target.value)}
                              style={{flex:1,minWidth:0,
                                background: alertColor ? (alertColor===P.rose?P.roseSoft:P.greenSoft) : P.surfaceAlt,
                                border:`1.5px solid ${alertColor || P.border}`,
                                borderRadius:8,padding:"9px 4px",fontSize:15,
                                color: alertColor ? (alertColor===P.rose?P.roseText:P.greenText) : P.text,
                                fontFamily:mono, outline:"none",textAlign:"center",
                                fontWeight: alertColor ? 800 : 600, boxSizing:"border-box"}}
                              onFocus={e=>e.target.style.borderColor=P.blue}
                              onBlur={e=>e.target.style.borderColor=alertColor || P.border}/>
                            <span style={{fontSize:9, color: alertColor ? (alertColor===P.rose?P.roseText:P.greenText) : P.textSoft,
                              flexShrink:0, whiteSpace:"nowrap", fontWeight: alertColor ? 700 : 400}}>{u}</span>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  ))}
                  {(() => {
                    const spo2 = parseFloat(String(racsPed.sat).replace(",","."));
                    const spo2Out = !isNaN(spo2) && (spo2 < 94 || spo2 > 98);
                    const etco2 = parseFloat(String(racsPed.capno).replace(",","."));
                    const etco2Out = !isNaN(etco2) && (etco2 < 35 || etco2 > 45);
                    if (spo2Out) return <p style={{margin:"2px 0 10px",fontSize:9.5,color:P.roseText,fontWeight:700,textAlign:"right"}}>⚠️ SpO₂ {spo2>98?"> 98% — risque d'hyperoxie":"< 94% — hypoxie"}</p>;
                    if (etco2Out) return <p style={{margin:"2px 0 10px",fontSize:9.5,color:P.roseText,fontWeight:700,textAlign:"right"}}>⚠️ EtCO₂ hors cible (35–45 mmHg)</p>;
                    return <p style={{margin:"2px 0 10px",fontSize:9,color:P.textSoft,fontStyle:"italic",textAlign:"right"}}>SpO₂ 94–98 % · EtCO₂ 35–45 mmHg</p>;
                  })()}

                  {/* Graphique live EtCO2 */}
                  {etco2ListPed.length > 0 && (
                    <div style={{background:P.surfaceAlt,borderRadius:12,padding:"10px 12px",marginBottom:12}}>
                      <p style={{margin:"0 0 6px",fontSize:9,fontWeight:700,color:P.textMid,
                        textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
                        EtCO₂ — {etco2ListPed.length} mesure{etco2ListPed.length>1?"s":""}
                      </p>
                      <Etco2Curve data={etco2ListPed} P={P} mono={mono} refSec={events.find(e=>e.id==="rosc")?.sec||0} />
                    </div>
                  )}

                  {/* Accordéon DOPÉE */}
                  <div style={{marginTop:12}}>
                    <button onClick={()=>setShowDopee(v=>!v)}
                      style={{width:"100%",background:showDopee?P.amberSoft:P.amberSoft,
                        border:`1.5px solid ${P.amber}`,
                        borderRadius:10,padding:"10px 14px",cursor:"pointer",fontFamily:sans,
                        display:"flex",alignItems:"center",justifyContent:"space-between",
                        transition:"all 0.15s"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:16}}>⚠️</span>
                        <div style={{textAlign:"left"}}>
                          <p style={{margin:0,fontSize:13,fontWeight:600,color:P.amberText}}>
                            Vérifier DOPÉE
                          </p>
                          <p style={{margin:0,fontSize:9,color:P.amberText,fontStyle:"italic"}}>
                            Problème de ventilation
                          </p>
                        </div>
                      </div>
                      <span style={{fontSize:12,color:P.amberText,fontWeight:600}}>
                        {showDopee?"▲":"▼"}
                      </span>
                    </button>

                    {showDopee && (
                      <div style={{background:P.amberSoft,border:`1.5px solid ${P.amber}`,
                        borderTop:"none",borderRadius:"0 0 10px 10px",
                        padding:"4px 12px 12px",marginTop:-2}}>
                        {[
                          { letter:"D", label:"Déplacement de la sonde",   detail:"Vérifier la position — Auscultation · Capno · RX",    color:"#DC2626" },
                          { letter:"O", label:"Obstruction",                detail:"Sonde bouchée — Aspiration · Changement de sonde",    color:"#EA580C" },
                          { letter:"P", label:"Pb pulmonaire",              detail:"Pneumothorax — Auscultation · FAST-écho thoracique",  color:"#D97706" },
                          { letter:"É", label:"Équipement à vérifier",      detail:"Respirateur · Circuit · Connexions · O₂",            color:"#65A30D" },
                          { letter:"E", label:"Estomac à vider",            detail:"SNG en aspiration · Décompression gastrique",         color:"#0891B2" },
                        ].map((item,i)=>(
                          <div key={item.letter} style={{
                            display:"flex",alignItems:"flex-start",gap:10,
                            padding:"8px 0",
                            borderBottom: i<4 ? "1px solid #FDE68A" : "none"}}>
                            <div style={{width:28,height:28,borderRadius:8,
                              background:item.color,flexShrink:0,
                              display:"flex",alignItems:"center",justifyContent:"center"}}>
                              <span style={{fontSize:14,fontWeight:800,color:"#fff",fontFamily:mono}}>
                                {item.letter}
                              </span>
                            </div>
                            <div style={{minWidth:0}}>
                              <p style={{margin:0,fontSize:13,fontWeight:600,color:"#78350F",lineHeight:1.3}}>
                                {item.label}
                              </p>
                              <p style={{margin:"2px 0 0",fontSize:11,color:P.amberText,lineHeight:1.4}}>
                                {item.detail}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {racsTabPed==="sedat" && (
                <div style={{width:"100%"}}>
                  {/* Encadré rappel doses calculées */}
                  {localMat && (
                    <div style={{background:P.amberSoft,border:`1px solid color-mix(in srgb, ${P.amber} 27%, transparent)`,
                      borderRadius:10,padding:"10px 12px",marginBottom:12}}>
                      <p style={{margin:"0 0 6px",fontSize:9,fontWeight:600,color:P.amberText,
                        textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
                        Doses sédation — {localPoids} kg · {localRow.age}
                      </p>
                      {/* Midazolam */}
                      <div style={{marginBottom:8,paddingBottom:8,borderBottom:`1px solid color-mix(in srgb, ${P.amber} 20%, transparent)`}}>
                        <p style={{margin:"0 0 3px",fontSize:10,fontWeight:600,color:P.amberText}}>
                          Midazolam — 50 mg / 50 mL (1 mg/mL)
                        </p>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"3px 10px"}}>
                          {[
                            ["PSE 0,1 mg/kg/h", `${localMat.midPSE} mL/h`],
                            ["Plage PSE",        `${localMat.midPSE}–${(localMat.midPSE*3).toFixed(1)} mL/h`],
                          ].map(([l,v])=>(
                            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span style={{fontSize:9,color:P.amberText}}>{l}</span>
                              <span style={{fontSize:11,fontWeight:700,color:P.amberText,fontFamily:mono}}>{v}</span>
                            </div>
                          ))}
                        </div>
                        <p style={{margin:"3px 0 0",fontSize:8,color:P.amberText,fontStyle:"italic"}}>
                          Diluer 50 mg dans 50 mL NaCl 0,9% → 1 mg/mL
                        </p>
                      </div>
                      {/* Sufentanyl */}
                      <div>
                        <p style={{margin:"0 0 3px",fontSize:10,fontWeight:600,color:P.amberText}}>
                          Sufentanyl — 50 μg / 50 mL (1 μg/mL)
                        </p>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"3px 10px"}}>
                          {[
                            ["Bolus IVD 0,2 μg/kg", `${localMat.sufBolus} mL`],
                            ["PSE 0,2 μg/kg/h",     `${localMat.sufPSE} mL/h`],
                            ["Plage PSE",            `${localMat.sufPSE}–${(localMat.sufPSE*5).toFixed(1)} mL/h`],
                          ].map(([l,v])=>(
                            <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span style={{fontSize:9,color:P.amberText}}>{l}</span>
                              <span style={{fontSize:11,fontWeight:700,color:P.amberText,fontFamily:mono}}>{v}</span>
                            </div>
                          ))}
                        </div>
                        <p style={{margin:"3px 0 0",fontSize:8,color:P.amberText,fontStyle:"italic"}}>
                          Diluer 50 μg dans 50 mL NaCl 0,9% → 1 μg/mL
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Midazolam — champ vitesse + posologie calculée */}
                  <div style={{background:P.surfaceAlt,borderRadius:10,padding:"10px",marginBottom:10}}>
                    <p style={{margin:"0 0 6px",fontSize:9,fontWeight:500,color:P.textSoft,
                      textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
                      Midazolam — 50 mg / 50 mL (1 mg/mL)
                    </p>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:7}}>
                      <input type="number" inputMode="decimal" value={racsPed.midazolamV||""}
                        onChange={e=>srp("midazolamV")(e.target.value)} placeholder={String(localMat?.midPSE||"")}
                        style={{flex:1,minWidth:0,background:P.surface,border:`1.5px solid ${P.border}`,
                          borderRadius:8,padding:"9px 4px",fontSize:15,color:P.text,fontFamily:mono,
                          outline:"none",textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                        onFocus={e=>e.target.style.borderColor=P.violet}
                        onBlur={e=>e.target.style.borderColor=P.border}/>
                      <span style={{fontSize:9,color:P.textSoft,flexShrink:0}}>mL/h</span>
                    </div>
                    {(()=>{
                      const v=parseFloat(racsPed.midazolamV||""),ok=!isNaN(v)&&v>0,dose=ok?(v*1).toFixed(2):null;
                      return (
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                          background:ok?P.violet+"22":P.borderSoft,borderRadius:7,padding:"7px 10px",
                          border:`1.5px solid ${ok?P.violet:P.border}`}}>
                          <span style={{fontSize:11,color:P.textSoft}}>→ Posologie</span>
                          <span style={{fontSize:17,fontWeight:700,color:ok?P.violetText:P.textSoft,fontFamily:mono}}>
                            {ok?`${dose} mg/h`:"—"}
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Sufentanyl — champ vitesse + posologie calculée */}
                  <div style={{background:P.surfaceAlt,borderRadius:10,padding:"10px"}}>
                    <p style={{margin:"0 0 6px",fontSize:9,fontWeight:500,color:P.textSoft,
                      textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
                      Sufentanyl — 50 μg / 50 mL (1 μg/mL)
                    </p>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:7}}>
                      <input type="number" inputMode="decimal" value={racsPed.sufentaV||""}
                        onChange={e=>srp("sufentaV")(e.target.value)} placeholder={String(localMat?.sufPSE||"")}
                        style={{flex:1,minWidth:0,background:P.surface,border:`1.5px solid ${P.border}`,
                          borderRadius:8,padding:"9px 4px",fontSize:15,color:P.text,fontFamily:mono,
                          outline:"none",textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                        onFocus={e=>e.target.style.borderColor=P.violet}
                        onBlur={e=>e.target.style.borderColor=P.border}/>
                      <span style={{fontSize:9,color:P.textSoft,flexShrink:0}}>mL/h</span>
                    </div>
                    {(()=>{
                      const v=parseFloat(racsPed.sufentaV||""),ok=!isNaN(v)&&v>0,dose=ok?(v*1).toFixed(2):null;
                      return (
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                          background:ok?P.violet+"22":P.borderSoft,borderRadius:7,padding:"7px 10px",
                          border:`1.5px solid ${ok?P.violet:P.border}`}}>
                          <span style={{fontSize:11,color:P.textSoft}}>→ Posologie</span>
                          <span style={{fontSize:17,fontWeight:700,color:ok?P.violetText:P.textSoft,fontFamily:mono}}>
                            {ok?`${dose} μg/h`:"—"}
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  {/* NIMBEX dans sédation */}
                  {localMat && (
                    <div style={{background:P.violetSoft,border:`1px solid color-mix(in srgb, ${P.violet} 27%, transparent)`,borderRadius:10,padding:"10px 12px"}}>
                      <p style={{margin:"0 0 3px",fontSize:10,fontWeight:600,color:P.violetText}}>
                        Nimbex <span style={{fontWeight:400,fontSize:9,color:P.violet,fontStyle:"italic"}}>Cisatracurium — Curare non dépolarisant</span>
                      </p>
                      <p style={{margin:"0 0 8px",fontSize:9,color:P.violetText,fontStyle:"italic"}}>
                        {localPoids<20?"0,5 mg/mL — 10 mg dans 20 mL NaCl 0,9%":"PUR 2 mg/mL"}
                      </p>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        <div>
                          <p style={{margin:"0 0 4px",fontSize:9,color:P.textSoft,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>1re dose (0,15 mg/kg)</p>
                          <div style={{display:"flex",alignItems:"center",gap:5}}>
                            <input type="number" inputMode="decimal"
                              value={nimbex1Val !== "" ? nimbex1Val : String(localMat.nimbex1)}
                              onChange={e=>setNimbex1Val(e.target.value)}
                              style={{flex:1,minWidth:0,background:P.surface,border:`1.5px solid ${P.border}`,borderRadius:8,
                                padding:"9px 4px",fontSize:16,color:P.text,fontFamily:mono,outline:"none",
                                textAlign:"center",fontWeight:700,boxSizing:"border-box"}}
                              onFocus={e=>{if(nimbex1Val==="")setNimbex1Val(String(localMat.nimbex1));e.target.style.borderColor=P.violet;}}
                              onBlur={e=>e.target.style.borderColor=P.border}/>
                            <span style={{fontSize:9,color:P.textSoft,flexShrink:0}}>mL</span>
                          </div>
                        </div>
                        <div>
                          <p style={{margin:"0 0 4px",fontSize:9,color:P.textSoft,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>2e dose à 20 min</p>
                          <div style={{display:"flex",alignItems:"center",gap:5}}>
                            <input type="number" inputMode="decimal"
                              value={nimbex2Val !== "" ? nimbex2Val : String(localMat.nimbex2)}
                              onChange={e=>setNimbex2Val(e.target.value)}
                              style={{flex:1,minWidth:0,background:P.surface,border:`1.5px solid ${P.border}`,borderRadius:8,
                                padding:"9px 4px",fontSize:16,color:P.text,fontFamily:mono,outline:"none",
                                textAlign:"center",fontWeight:700,boxSizing:"border-box"}}
                              onFocus={e=>{if(nimbex2Val==="")setNimbex2Val(String(localMat.nimbex2));e.target.style.borderColor=P.violet;}}
                              onBlur={e=>e.target.style.borderColor=P.border}/>
                            <span style={{fontSize:9,color:P.textSoft,flexShrink:0}}>mL</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {racsTabPed==="hemo" && (
                <div style={{width:"100%"}}>
                  {/* Encadré normes */}
                  {localMat && (
                    <div style={{background:P.amberSoft,border:`1px solid color-mix(in srgb, ${P.amber} 27%, transparent)`,borderRadius:10,padding:"10px 12px",marginBottom:12}}>
                      <p style={{margin:"0 0 6px",fontSize:9,fontWeight:600,color:P.amberText,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
                        Objectifs — {localPoids} kg · {localRow.age}
                      </p>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 10px"}}>
                        {[["FC",`≈ ${localMat.fcN} /min`],["PAS cible",`> ${localMat.pasN} mmHg`],["PAM hors TC",`> ${localMat.pamHTC} mmHg`],["PAM si TC",`> ${localMat.pamTC} mmHg`]].map(([l,v])=>(
                          <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1px 0"}}>
                            <span style={{fontSize:10,color:P.amberText}}>{l}</span>
                            <span style={{fontSize:12,fontWeight:700,color:P.amberText,fontFamily:mono}}>{v}</span>
                          </div>
                        ))}
                      </div>
                      <p style={{margin:"5px 0 0",fontSize:8,color:P.amberText,fontStyle:"italic"}}>ACSOS : normotout · O₂/EtCO₂/Hb {">"} 7g/L · T°/Glycémie</p>
                    </div>
                  )}
                  {/* TAs / TAd / FC — 3 colonnes compactes sans overflow, avec tendance */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,marginBottom:4}}>
                    {[["tas","TAs",P.rose,"up"],["tad","TAd",P.rose,"up"],["fc","FC",P.rose,"down"]].map(([k,l,a,goodDir])=>{
                      const lastVal = hemoListPed.length > 0 ? hemoListPed[hemoListPed.length - 1][k] : null;
                      return (
                      <div key={k} style={{minWidth:0, position:"relative"}}>
                        <p style={{margin:"0 0 3px",fontSize:9,fontWeight:500,color:P.textSoft,
                          textTransform:"uppercase",letterSpacing:"0.06em",fontFamily:mono}}>{l}</p>
                        {lastVal != null && <TrendBadge current={racsPed[k]} last={lastVal} P={P} goodDir={goodDir} />}
                        <input type="number" inputMode="decimal" value={racsPed[k]} onChange={e=>srp(k)(e.target.value)}
                          style={{width:"100%",minWidth:0,background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
                            borderRadius:8,padding:"8px 2px",fontSize:14,color:P.text,fontFamily:mono,
                            outline:"none",textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                          onFocus={e=>e.target.style.borderColor=a} onBlur={e=>e.target.style.borderColor=P.border}/>
                      </div>
                      );
                    })}
                  </div>
                  {hemoListPed.length > 0 && (
                    <p style={{margin:"6px 0 10px",fontSize:9,color:P.textSoft,textAlign:"right",fontStyle:"italic"}}>
                      vs dernière mesure enregistrée
                    </p>
                  )}
                  {/* PAM calculée */}
                  {(()=>{
                    const sys=parseFloat(racsPed.tas),dia=parseFloat(racsPed.tad);
                    const pam=(!isNaN(sys)&&!isNaN(dia)&&sys>0&&dia>0)?Math.round((sys+2*dia)/3):null;
                    const pamOk=localMat&&pam!==null&&pam>=localMat.pamHTC;
                    return (
                      <div style={{marginBottom:14}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
                          <span style={{fontSize:9,color:P.textSoft,fontFamily:mono,textTransform:"uppercase",letterSpacing:"0.08em"}}>PAM calculée</span>
                          <span style={{fontSize:16,fontWeight:700,fontFamily:mono,color:pam!==null?(pamOk?P.greenText:P.roseText):P.textSoft}}>{pam!==null?`${pam} mmHg`:"—"}</span>
                        </div>
                        {pam!==null&&localMat&&(<p style={{margin:0,fontSize:9,color:P.textSoft,fontStyle:"italic"}}>Objectif hors TC {">"} {localMat.pamHTC} · si TC {">"} {localMat.pamTC} mmHg</p>)}
                      </div>
                    );
                  })()}

                  {/* Graphique live — évolution TA/FC (mesures déjà enregistrées) */}
                  {hemoListPed.length > 0 && (
                    <div style={{background:P.surfaceAlt,borderRadius:12,padding:"10px 12px",marginBottom:14}}>
                      <p style={{margin:"0 0 6px",fontSize:9,fontWeight:700,color:P.textMid,
                        textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
                        Évolution — {hemoListPed.length} mesure{hemoListPed.length>1?"s":""}
                      </p>
                      <HemoCurve hemoList={hemoListPed} amineList={amineListPed} P={P} mono={mono}
                        refSec={events.find(e=>e.id==="rosc")?.sec||0} />
                    </div>
                  )}

                  {/* Température — contrôle ciblé (ERC 2025 : prévention stricte de l'hyperthermie) */}
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10,
                    background: parseFloat(String(racsPed.tempRacs).replace(",",".")) > 37.5 ? P.roseSoft : P.amberSoft,
                    border:`1px solid ${parseFloat(String(racsPed.tempRacs).replace(",",".")) > 37.5 ? P.rose : P.amber}`,
                    borderRadius:9, padding:"7px 10px" }}>
                    <span style={{ fontSize:13, flexShrink:0 }}>🌡️</span>
                    <input type="number" inputMode="decimal" step="0.1" value={racsPed.tempRacs}
                      onChange={e => srp("tempRacs")(e.target.value)} placeholder="36,5"
                      style={{ width:62,
                        background:P.surface,
                        border:`1px solid ${parseFloat(String(racsPed.tempRacs).replace(",",".")) > 37.5 ? P.rose : P.amber}`,
                        borderRadius:7, padding:"5px 4px", fontSize:14, color:P.text,
                        fontFamily:mono, outline:"none", textAlign:"center", fontWeight:700,
                        boxSizing:"border-box", flexShrink:0 }}
                      onFocus={e => e.target.style.borderColor = P.amberText}
                      onBlur={e  => e.target.style.borderColor = P.amber} />
                    <span style={{ fontSize:12,
                      color: parseFloat(String(racsPed.tempRacs).replace(",",".")) > 37.5 ? P.roseText : P.amberText,
                      fontWeight:600, flexShrink:0 }}>°C</span>
                    <span style={{ fontSize:10,
                      color: parseFloat(String(racsPed.tempRacs).replace(",",".")) > 37.5 ? P.roseText : P.amberText,
                      fontWeight: parseFloat(String(racsPed.tempRacs).replace(",",".")) > 37.5 ? 700 : 400,
                      lineHeight:1.3 }}>
                      {parseFloat(String(racsPed.tempRacs).replace(",",".")) > 37.5
                        ? "⚠️ > 37,5 °C — hyperthermie à traiter"
                        : "Objectif : éviter > 37,5 °C (72h)"}
                    </span>
                  </div>

                  {/* Glycémie — ACSOS : éviter hypo/hyperglycémie */}
                  {(() => {
                    const g = parseFloat(String(racsPed.glycemie).replace(",","."));
                    const out = !isNaN(g) && (g < 0.7 || g > 1.8);
                    return (
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10,
                        background: out ? P.roseSoft : P.amberSoft,
                        border:`1px solid ${out ? P.rose : P.amber}`,
                        borderRadius:9, padding:"7px 10px" }}>
                        <span style={{ fontSize:13, flexShrink:0 }}>🩸</span>
                        <input type="number" inputMode="decimal" step="0.01" value={racsPed.glycemie}
                          onChange={e => srp("glycemie")(e.target.value)} placeholder="0,90"
                          style={{ width:62, background:P.surface, border:`1px solid ${out ? P.rose : P.amber}`,
                            borderRadius:7, padding:"5px 4px", fontSize:14, color:P.text,
                            fontFamily:mono, outline:"none", textAlign:"center", fontWeight:700,
                            boxSizing:"border-box", flexShrink:0 }}
                          onFocus={e => e.target.style.borderColor = P.amberText}
                          onBlur={e  => e.target.style.borderColor = P.amber} />
                        <span style={{ fontSize:12, color: out ? P.roseText : P.amberText, fontWeight:600, flexShrink:0 }}>g/L</span>
                        <span style={{ fontSize:10, color: out ? P.roseText : P.amberText,
                          fontWeight: out ? 700 : 400, lineHeight:1.3 }}>
                          {out ? "⚠️ Hors cible — corriger hypo/hyperglycémie" : "Objectif : 0,7-1,8 g/L (éviter hypo/hyper)"}
                        </span>
                      </div>
                    );
                  })()}

                  {/* Pupilles — examen neurologique rapide */}
                  <div style={{ marginBottom:10 }}>
                    <Lbl>Pupilles</Lbl>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                      {["Normales","Anormales","Non fait"].map(v => (
                        <button key={v} onClick={() => {
                            if (v === "Anormales") { setRacsPupillesExpandedPed(x => !x); return; }
                            srp("pupilles")(v); setRacsPupillesExpandedPed(false);
                          }}
                          style={{ padding:"8px 4px", borderRadius:9, fontSize:10.5, fontWeight:600,
                            border:`1.5px solid ${P.violet}`,
                            background: (v==="Anormales" && racsPupillesExpandedPed) || (v!=="Anormales" && racsPed.pupilles===v) ? P.violet : P.surface,
                            color: (v==="Anormales" && racsPupillesExpandedPed) || (v!=="Anormales" && racsPed.pupilles===v) ? "#fff" : P.violetText,
                            cursor:"pointer", fontFamily:sans }}>
                          {v}
                        </button>
                      ))}
                    </div>
                    {racsPed.pupilles && !["Normales","Non fait"].includes(racsPed.pupilles) && !racsPupillesExpandedPed && (
                      <p style={{ margin:"6px 0 0", fontSize:10.5, color:P.violetText, fontWeight:700 }}>{racsPed.pupilles}</p>
                    )}
                    {racsPupillesExpandedPed && (
                      <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                        {PUPILLES_DETAIL.map(({v,left,right}) => (
                          <button key={v} onClick={() => { srp("pupilles")(v); setRacsPupillesExpandedPed(false); }}
                            style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                              borderRadius:9, border:`1.5px solid ${P.border}`, background:P.surface,
                              fontSize:11.5, fontWeight:600, color:P.text, cursor:"pointer",
                              fontFamily:sans, textAlign:"left" }}>
                            <PupilIcon left={left} right={right} />{v}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* ADRÉNALINE IVSE — paliers cliquables + vitesse éditable */}
                  {localMat && (
                    <div style={{background:P.roseSoft,border:`1px solid color-mix(in srgb, ${P.rose} 27%, transparent)`,borderRadius:10,padding:"10px 12px",marginBottom:10}}>
                      <p style={{margin:"0 0 3px",fontSize:10,fontWeight:600,color:P.roseText}}>Adrénaline IVSE</p>
                      <p style={{margin:"0 0 8px",fontSize:9,color:P.roseText,fontStyle:"italic"}}>
                        {localPoids<=10?"1 mg/50 mL → 0,02 mg/mL":"5 mg/50 mL → 0,1 mg/mL"} · débuter 0,1–0,2 μg/kg/min ↑ par palier 0,1
                      </p>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:10}}>
                        {[[`0,2 μg/kg/min`,localMat.adrPSE1],[`0,5 μg/kg/min`,localMat.adrPSE2],[`1,0 μg/kg/min`,localMat.adrPSE3],[`1,5 μg/kg/min`,localMat.adrPSE4]].map(([palier,vitesse],i)=>(
                          <button key={palier} onClick={()=>{setAdrPalier(i);setAdrVitesse(String(vitesse));}}
                            style={{background:adrPalier===i?"rgba(217,107,107,0.18)":"rgba(255,255,255,0.6)",
                              border:`1.5px solid ${adrPalier===i?P.rose:"rgba(217,107,107,0.2)"}`,
                              borderRadius:8,padding:"5px 6px",cursor:"pointer",fontFamily:sans,textAlign:"left",
                              minWidth:0,overflow:"hidden"}}>
                            <p style={{margin:"0 0 1px",fontSize:8,color:P.roseText,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{palier}</p>
                            <p style={{margin:0,fontSize:13,fontWeight:700,color:P.roseText,fontFamily:mono}}>{vitesse} mL/h</p>
                          </button>
                        ))}
                      </div>
                      <p style={{margin:"0 0 4px",fontSize:9,color:P.textSoft,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>Vitesse PSE en cours</p>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <input type="number" inputMode="decimal" value={adrVitesse}
                          onChange={e=>setAdrVitesse(e.target.value)}
                          placeholder={String(localMat.adrPSE1)}
                          style={{flex:1,background:P.surface,border:`1.5px solid ${P.border}`,borderRadius:8,
                            padding:"10px 6px",fontSize:17,color:P.text,fontFamily:mono,outline:"none",
                            textAlign:"center",fontWeight:700,boxSizing:"border-box"}}
                          onFocus={e=>e.target.style.borderColor=P.rose}
                          onBlur={e=>e.target.style.borderColor=P.border}/>
                        <span style={{fontSize:11,color:P.textSoft,flexShrink:0}}>mL/h</span>
                      </div>
                    </div>
                  )}

                  {/* REMPLISSAGE — même composant que l'adulte */}
                  <RemplissageVasculairePed racs={racsPed} setRacs={setRacsPed} localMat={localMat} />


                  <p style={{margin:"4px 0 4px",fontSize:9,fontWeight:500,color:P.textSoft,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>Autres thérapeutiques</p>
                  <TArea value={racsPed.autresHemo||""} onChange={v=>srp("autresHemo")(v)} placeholder="Ex : Dobutamine, Vasopressine..." rows={2}/>
                </div>
              )}
            </div>
            <button onClick={()=>{
              const p=[];
              // Ventilation — seulement si saisi
              if(racsPed.fr)     p.push(`FR ${racsPed.fr}/min`);
              if(racsPed.volume) p.push(`Vt ${racsPed.volume}mL`);
              if(racsPed.pep)    p.push(`PEP ${racsPed.pep}cmH₂O`);
              if(racsPed.sat)    p.push(`SpO₂ ${racsPed.sat}%`);
              if(racsPed.fio2)   p.push(`FiO₂ ${racsPed.fio2}%`);
              if(racsPed.capno)  p.push(`EtCO₂ ${racsPed.capno}mmHg`);
              // Sédation — seulement si vitesse saisie
              if(racsPed.midazolamV) p.push(`Midazolam ${racsPed.midazolamV}mL/h`);
              if(racsPed.sufentaV)   p.push(`Sufentanyl ${racsPed.sufentaV}mL/h`);
              // Nimbex — seulement si modifié par rapport à la valeur par défaut
              if(nimbex1Val !== "" && localMat && nimbex1Val !== String(localMat.nimbex1))
                p.push(`Nimbex 1re dose ${nimbex1Val}mL`);
              else if(nimbex1Val !== "" && !localMat)
                p.push(`Nimbex 1re dose ${nimbex1Val}mL`);
              if(nimbex2Val !== "" && localMat && nimbex2Val !== String(localMat.nimbex2))
                p.push(`Nimbex 2e dose ${nimbex2Val}mL`);
              // Hémodynamique — seulement si saisi
              if(racsPed.tas && racsPed.tad) p.push(`TA ${racsPed.tas}/${racsPed.tad}mmHg`);
              if(racsPed.fc)  p.push(`FC ${racsPed.fc}/min`);
              if(racsPed.tempRacs) p.push(`T° ${racsPed.tempRacs} °C`);
              if(racsPed.pupilles) p.push(`Pupilles ${racsPed.pupilles}`);
              // Amines — seulement si vitesse saisie
              if(adrVitesse)  p.push(`Adrénaline IVSE ${adrVitesse}mL/h`);
              // Remplissage pédiatrique
              const totalRempli = (racsPed.remplissagesPed||[]).reduce((s,r)=>s+r.vol,0);
              if(totalRempli > 0) p.push(`Remplissage total ${totalRempli}mL`);
              // Remplissage — seulement si modifié
              if(rempliVol !== "" && localMat && rempliVol !== String(localMat.rempliVol))
                p.push(`Remplissage ${rempliVol}mL`);
              if(rempliDebit !== "" && localMat && rempliDebit !== String(localMat.rempliDebit))
                p.push(`Débit ${rempliDebit}mL/h`);
              if(racsPed.autresHemo) p.push(racsPed.autresHemo);
              addEvent("racs_soins", p.length ? `Post-RACS : ${p.join(" · ")}` : "Soins post-RACS initiés", "🫀");
              if (racsPed.tas || racsPed.fc) {
                setHemoListPed(prev => [...prev, { sec, time: getNow(), pas: racsPed.tas, pad: racsPed.tad, fc: racsPed.fc }]);
              }
              if (racsPed.capno) {
                setEtco2ListPed(prev => [...prev, { val: racsPed.capno, sec, time: getNow() }]);
              }
              setModalRacsPed(false);
            }} style={{width:"100%",background:"linear-gradient(135deg,#3EA876,#2A7D57)",
              border:"none",borderRadius:14,color:"#fff",fontSize:14,fontWeight:600,
              padding:"14px",cursor:"pointer",fontFamily:sans,marginTop:12,flexShrink:0}}>
              ✓ Enregistrer
            </button>

            {/* Le bouton "Récidive d'arrêt" a été déplacé en tête de la grille d'actions,
                bien plus visible qu'enfoui ici en bas du modal. */}
          </div>
        </div>
      )}

      {/* Alerte 2 min */}
      {alert && (
        <div onClick={()=>setAlert(null)} style={{position:"fixed",top:0,left:0,right:0,zIndex:50,
          background:"linear-gradient(90deg,#C89435,#D4A040)",padding:"12px 18px",
          display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
          <span style={{fontSize:18}}>⏱</span>
          <div>
            <p style={{margin:0,color:"#fff",fontSize:14,fontWeight:600}}>2 minutes écoulées</p>
            <p style={{margin:0,color:"rgba(255,255,255,0.8)",fontSize:12}}>{alert}</p>
          </div>
          <span style={{marginLeft:"auto",color:"rgba(255,255,255,0.5)",fontSize:16}}>×</span>
        </div>
      )}

      {/* ── Bandeau vocal fin, fixe — toujours visible tant que le micro est actif, même en défilant ── */}
      {SpeechRecognitionAPI && voiceActivePed && (() => {
        const bannerTop = alert ? 56 : 0;
        if (voiceToastPed) return (
          <div style={{ position:"fixed", top:bannerTop, left:0, right:0, zIndex:49,
            background:`linear-gradient(135deg, ${P.green}, #2A7D57)`, padding:"7px 14px",
            boxShadow:"0 2px 8px rgba(0,0,0,0.15)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:16, flexShrink:0 }}>{voiceToastPed.icon}</span>
              <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:"#fff", flex:1 }}>{voiceToastPed.label}</p>
              <span style={{ fontSize:10, color:"rgba(255,255,255,0.85)", flexShrink:0 }}>2s…</span>
              <button onClick={voiceToastPed.cancel}
                style={{ background:"rgba(255,255,255,0.25)", border:"none", borderRadius:7,
                  color:"#fff", fontSize:11, fontWeight:700, padding:"4px 8px", cursor:"pointer", flexShrink:0 }}>
                Annuler
              </button>
            </div>
          </div>
        );
        if (voiceAnswerPed) return (
          <div style={{ position:"fixed", top:bannerTop, left:0, right:0, zIndex:49,
            background:`linear-gradient(135deg, ${P.blue}, #0B43A0)`, padding:"7px 14px",
            boxShadow:"0 2px 8px rgba(0,0,0,0.15)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:16, flexShrink:0 }}>{voiceAnswerPed.icon}</span>
              <p style={{ margin:0, fontSize:12.5, fontWeight:700, color:"#fff", flex:1 }}>{voiceAnswerPed.speak}</p>
              <button onClick={() => setVoiceAnswerPed(null)}
                style={{ background:"transparent", border:"none", color:"rgba(255,255,255,0.8)",
                  fontSize:16, cursor:"pointer", flexShrink:0, padding:0 }}>✕</button>
            </div>
          </div>
        );
        if (voiceTranscriptPed) return (
          <div style={{ position:"fixed", top:bannerTop, left:0, right:0, zIndex:49,
            background:"rgba(10,17,27,0.85)", padding:"7px 14px" }}>
            <p style={{ margin:0, fontSize:12, color:"rgba(255,255,255,0.85)", fontFamily:mono }}>
              🎙️ "{voiceTranscriptPed}"
            </p>
          </div>
        );
        return (
          <div style={{ position:"fixed", top:bannerTop, left:0, right:0, zIndex:49,
            background: voiceWakeFlashPed ? `linear-gradient(135deg, ${P.green}, #2A7D57)` : `linear-gradient(135deg, ${P.rose}, #9B2C2C)`,
            padding:"6px 14px", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ width:7, height:7, borderRadius:"50%", background:"#fff", flexShrink:0,
              boxShadow:"0 0 0 3px rgba(255,255,255,0.3)" }} />
            <p style={{ margin:0, fontSize:11, fontWeight:700, color:"#fff", flex:1 }}>
              🎙️ À l'écoute — dites « {voiceWakeWord || "Alpha"} » avant une commande
            </p>
          </div>
        );
      })()}

      {/* Header */}
      <div style={{background:P.surface,borderBottom:`1px solid ${P.border}`,
        padding:`${alert ? 56 + (voiceActivePed?34:0) : voiceActivePed ? 34+14 : 14}px 16px 14px`,boxShadow:"0 2px 10px rgba(0,0,0,0.04)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <button onClick={onBack}
              style={{background:"transparent",border:"none",color:P.textMid,
                fontSize:22,cursor:"pointer",padding:"0 6px",lineHeight:1,fontFamily:sans}}>‹</button>
            <div>
              <p style={{margin:0,fontSize:14,fontWeight:800,color:P.text,fontFamily:disp,letterSpacing:"-0.01em"}}>{isVLI ? (vliUnlockedPed ? "ACR VLI Pédiatrique → Médicalisé" : "ACR VLI Pédiatrique") : "ACR Pédiatrique"}</p>
              <div style={{display:"flex",alignItems:"center",gap:5,marginTop:2}}>
                <span style={{fontSize:11,color:P.textSoft}}>ACR =</span>
                <input type="time" value={localAcrTime} onChange={e=>{setLocalAcrTime(e.target.value);stp("hEffondrement")(e.target.value);}}
                  style={{background:"transparent",border:"none",borderBottom:`1px solid ${P.border}`,
                    fontSize:11,color:P.text,fontFamily:mono,fontWeight:600,
                    outline:"none",padding:"0 2px",width:52,cursor:"pointer",textAlign:"center"}}
                  onFocus={e=>e.target.style.borderBottomColor=P.amber}
                  onBlur={e=>e.target.style.borderBottomColor=P.border}/>
              </div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {SpeechRecognitionAPI && (
              <button
                onClick={() => {
                  if (!voiceActivePed) {
                    if (!navigator.onLine) {
                      setVoiceTranscriptPed("🚫 Pas de connexion internet — la reconnaissance vocale ne fonctionne pas hors ligne");
                      setTimeout(() => setVoiceTranscriptPed(""), 5000);
                      return;
                    }
                    try { new (window.AudioContext||window.webkitAudioContext)().resume(); } catch(e){}
                  }
                  setVoiceActivePed(v => !v);
                }}
                style={{ background: voiceWakeFlashPed ? `linear-gradient(135deg, ${P.green}, #2A7D57)`
                    : voiceActivePed ? `linear-gradient(135deg, ${P.rose}, #9B2C2C)` : P.surfaceAlt,
                  border: voiceActivePed ? "none" : `1px solid ${P.border}`, borderRadius:10,
                  padding:"6px 9px", cursor:"pointer", fontFamily:sans, display:"flex",
                  alignItems:"center", flexShrink:0,
                  boxShadow: voiceActivePed ? `0 2px 8px color-mix(in srgb, ${P.rose} 35%, transparent)` : "none" }}>
                <span style={{ fontSize:14 }}>🎙️</span>
              </button>
            )}
            <button onClick={() => setModalTeamPed(true)}
              style={{ background: teamPed.teamConnected ? P.greenSoft : P.surfaceAlt,
                border:`1px solid ${teamPed.teamConnected ? P.green : P.border}`, borderRadius:10,
                padding:"6px 9px", cursor:"pointer", fontFamily:sans, display:"flex",
                alignItems:"center", gap:5, flexShrink:0 }}>
              <span style={{ fontSize:13 }}>{teamPed.syncStatus === "error" ? "🔴" : teamPed.syncStatus === "syncing" ? "🟡" : teamPed.teamConnected ? "🟢" : "👥"}</span>
              <span style={{ fontSize:10.5, fontWeight:700, color: teamPed.teamConnected ? P.greenText : P.textMid }}>
                {teamPed.teamConnected ? `${teamPed.teamCode} · ${teamPed.teamDeviceCount}` : "Équipe"}
              </span>
            </button>
            <ThemeToggle theme={theme} setTheme={setTheme} compact />
          </div>
        </div>

        {/* Bandeau d'information VLI — rappel du cadre du protocole, tant que non déverrouillé */}
        {isVLI && !vliUnlockedPed && (
          <div style={{ background:"rgba(234,106,18,0.12)", border:"1px solid #EA6A12", borderRadius:9,
            padding:"6px 10px", display:"flex", alignItems:"center", gap:6, marginBottom:10 }}>
            <span style={{ fontSize:12 }}>ℹ️</span>
            <span style={{ fontSize:10, fontWeight:700, color:"#B24E0A" }}>
              Actes limités au protocole VLI pédiatrique en vigueur
            </span>
          </div>
        )}

        {/* Sélecteur poids — compact éditable */}
        <div style={{marginBottom:10}}>
          <button onClick={()=>setShowPoidsEdit(v=>!v)}
            style={{width:"100%",background:P.surfaceAlt,border:`1.5px solid ${showPoidsEdit?P.amber:P.border}`,
              borderRadius:10,padding:"8px 14px",cursor:"pointer",fontFamily:sans,
              display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:18}}>⚖️</span>
              <div style={{textAlign:"left"}}>
                <p style={{margin:0,fontSize:14,fontWeight:700,color:P.amber,fontFamily:mono}}>
                  {localPoids} kg
                </p>
                <p style={{margin:0,fontSize:10,color:P.textSoft}}>≈ {localRow.age}</p>
              </div>
            </div>
            <span style={{fontSize:11,color:P.textSoft}}>
              {showPoidsEdit ? "▲ Fermer" : "✏️ Modifier"}
            </span>
          </button>

          {showPoidsEdit && (
            <div style={{background:P.surface,border:`1.5px solid ${P.amber}`,borderRadius:10,
              padding:"10px",marginTop:4}}>
              {/* Boutons − + */}
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <button onClick={()=>setLocalPoidsIdx(i=>Math.max(0,i-1))}
                  style={{width:44,height:44,borderRadius:10,fontSize:20,fontWeight:700,
                    border:`1.5px solid ${P.border}`,background:P.surfaceAlt,
                    color:P.text,cursor:"pointer",fontFamily:mono,flexShrink:0}}>−</button>
                <div style={{flex:1,textAlign:"center"}}>
                  <span style={{fontSize:28,fontWeight:700,color:P.amber,fontFamily:mono}}>{localPoids} kg</span>
                  <span style={{fontSize:12,color:P.textSoft,marginLeft:6}}>≈ {localRow.age}</span>
                </div>
                <button onClick={()=>setLocalPoidsIdx(i=>Math.min(PED_TABLE.length-1,i+1))}
                  style={{width:44,height:44,borderRadius:10,fontSize:20,fontWeight:700,
                    border:`1.5px solid ${P.border}`,background:P.surfaceAlt,
                    color:P.text,cursor:"pointer",fontFamily:mono,flexShrink:0}}>+</button>
              </div>
              {/* Chips rapides */}
              <div style={{display:"flex",flexWrap:"wrap",gap:4,justifyContent:"center"}}>
                {PED_TABLE.map((r,i)=>(
                  <button key={r.p} onClick={()=>{setLocalPoidsIdx(i);setShowPoidsEdit(false);}}
                    style={{padding:"3px 8px",borderRadius:7,fontSize:10,fontWeight:600,
                      border:`1.5px solid ${i===localPoidsIdx?P.amber:"transparent"}`,
                      background:i===localPoidsIdx?P.amber:"transparent",
                      color:i===localPoidsIdx?"#fff":P.amberText,
                      cursor:"pointer",fontFamily:mono}}>
                    {r.p}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Chronomètre — style moniteur */}
        <div style={{textAlign:"center",marginBottom:12}}>
          <p style={{margin:"0 0 2px",fontSize:9.5,color:P.textSoft,letterSpacing:"0.14em",
            textTransform:"uppercase",fontFamily:mono,fontWeight:700,
            display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            {running && <span style={{width:7,height:7,borderRadius:"50%",background:P.rose,
              display:"inline-block",animation:"pulse 1.4s infinite"}} />}
            Début RCP médicalisé</p>
          <span style={{fontSize:60,fontWeight:800,letterSpacing:"-0.04em",
            color:running?P.text:P.textSoft,fontFamily:mono,lineHeight:0.95,
            fontVariantNumeric:"tabular-nums"}}>{fmtSec(sec)}</span>

          {/* Sous-ligne moniteur : no-flow / low-flow en pastilles discrètes */}
          <div style={{display:"flex",justifyContent:"center",gap:7,marginTop:9,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:5,background:P.surfaceAlt,
              border:`1px solid ${P.border}`,borderRadius:20,padding:"4px 11px"}}>
              <span style={{fontSize:9,fontWeight:700,color:P.amberText,fontFamily:mono,letterSpacing:"0.06em"}}>NO-FLOW</span>
              <select value={noFlowMin} onChange={e=>setNoFlowMin(e.target.value)}
                style={{background:"transparent",border:"none",borderBottom:`1px solid ${P.border}`,
                  fontSize:13,fontWeight:700,color:P.text,fontFamily:mono,textAlign:"center",outline:"none",
                  padding:"0 2px 1px",cursor:"pointer",appearance:"none",WebkitAppearance:"none"}}>
                <option value="">—</option>
                {Array.from({length:61},(_,i)=>(<option key={i} value={String(i)}>{i}</option>))}
              </select>
              <span style={{fontSize:9,color:P.textSoft}}>min</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:5,background:P.surfaceAlt,
              border:`1px solid ${P.border}`,borderRadius:20,padding:"4px 11px"}}>
              <span style={{fontSize:9,fontWeight:700,color:P.blueText,fontFamily:mono,letterSpacing:"0.06em"}}>LOW-FLOW</span>
              <select value={lowFlowMin} onChange={e=>setLowFlowMin(e.target.value)}
                style={{background:"transparent",border:"none",borderBottom:`1px solid ${P.border}`,
                  fontSize:13,fontWeight:700,color:P.text,fontFamily:mono,textAlign:"center",outline:"none",
                  padding:"0 2px 1px",cursor:"pointer",appearance:"none",WebkitAppearance:"none"}}>
                <option value="">—</option>
                {Array.from({length:61},(_,i)=>(<option key={i} value={String(i)}>{i}</option>))}
              </select>
              <span style={{fontSize:9,color:P.textSoft}}>min</span>
            </div>
          </div>
        </div>

        {/* ── Suivi CCF pédiatrique (si activé) ── */}
        {ccfEnabled && running && !events.find(e => e.id === "rosc") && (
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10,
            background:P.surface, border:`1.5px solid ${compPausedPed ? P.amber : P.border}`,
            borderRadius:12, padding:"9px 12px", boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
            <span style={{ fontSize:9, fontWeight:700, color:P.textSoft, fontFamily:mono, letterSpacing:"0.08em" }}>CCF</span>
            <span style={{ fontSize:20, fontWeight:800, fontFamily:mono, fontVariantNumeric:"tabular-nums", lineHeight:1,
              color: ccfPctPed >= 60 ? P.greenText : P.amberText }}>{ccfPctPed}%</span>
            {compPausedPed && <span style={{ fontSize:9.5, fontWeight:700, color:P.amberText, fontFamily:mono }}>● COMPRESSIONS ARRÊTÉES</span>}
            <button onClick={toggleCompressionsPed}
              style={{ marginLeft:"auto", border:`1px solid ${compPausedPed ? P.green : P.amber}`,
                background: compPausedPed ? `color-mix(in srgb, ${P.green} 14%, transparent)` : `color-mix(in srgb, ${P.amber} 14%, transparent)`,
                color: compPausedPed ? P.greenText : P.amberText, borderRadius:9, padding:"7px 11px",
                fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>
              {compPausedPed ? "▶ Reprendre" : "⏸ Pause compressions"}
            </button>
          </div>
        )}

        {/* Minuteur Adrénaline pédiatrique */}
        {adrTimerStartPed > 0 && running && !events.find(e => e.id === "rosc") && (
          <AdrenalineTimer
            startSec={adrTimerStartPed}
            intervalMin={adrIntervalGlobal}
            setIntervalMin={null}
            onAdminister={() => { addEvent("adr",`Adrénaline ${localMat?.adrenalineMg||""}mg IV/IO (10μg/kg)`,"💉"); setAdrTimerStartPed(Date.now()); }}
            onCancel={() => setAdrTimerStartPed(0)}
            running={running}
            P={P} mono={mono} sans={sans} fmtSec={fmtSec}
          />
        )}

        {/* Compteur chocs cumulés + rappel Amiodarone */}
        {(() => {
          const chocsSmur  = events.filter(e => e.id === "choc").length;
          const chocsPomp  = (parseInt(transPed.chocsPompiers) || 0) + (parseInt(transPed.chocsPublic) || 0);
          const chocsTotal = chocsSmur + chocsPomp;
          const adrCount   = events.filter(e => e.id === "adr").length;
          const amioCount  = events.filter(e => e.id === "cord" || e.id === "amio").length;
          if (chocsTotal === 0 && !running && events.length === 0) return null;
          const showAmio1 = chocsTotal >= 3 && amioCount === 0;
          const showAmio2 = chocsTotal >= 5 && amioCount === 1;
          return (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              <div style={{background: chocsTotal > 0 ? P.blueSoft : P.surfaceAlt,
                border:`1px solid ${chocsTotal > 0 ? P.blue+"44" : P.border}`,
                borderRadius:10,padding:"7px 10px"}}>
                <p style={{margin:"0 0 2px",fontSize:9,color:P.textSoft,textTransform:"uppercase",
                  letterSpacing:"0.09em",fontFamily:mono}}>Chocs cumulés</p>
                <div style={{display:"flex",alignItems:"baseline",gap:5}}>
                  <span style={{fontSize:24,fontWeight:700,color:P.blueText,fontFamily:mono,lineHeight:1}}>
                    {chocsTotal}
                  </span>
                  {chocsPomp > 0 && (
                    <span style={{fontSize:10,color:P.textSoft,fontFamily:mono}}>
                      ({chocsPomp} avant SMUR + {chocsSmur} SMUR)
                    </span>
                  )}
                </div>
              </div>
              <div style={{background: adrCount > 0 ? P.roseSoft : P.surfaceAlt,
                border:`1px solid ${adrCount > 0 ? P.rose+"44" : P.border}`,
                borderRadius:10,padding:"7px 10px"}}>
                <p style={{margin:"0 0 2px",fontSize:9,color:P.textSoft,textTransform:"uppercase",
                  letterSpacing:"0.09em",fontFamily:mono}}>Adré · Amio</p>
                <span style={{fontSize:16,fontWeight:700,color:P.roseText,fontFamily:mono}}>
                  {adrCount} × · {amioCount}
                </span>
              </div>
              {(showAmio1 || showAmio2) && localMat && (
                <div style={{gridColumn:"1 / -1",background:P.amberSoft,
                  border:`1.5px solid ${P.amber}`,borderRadius:10,padding:"8px 12px",
                  display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:18}}>💊</span>
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{margin:0,fontSize:11,fontWeight:700,color:P.amberText}}>
                      Rappel : Amiodarone {localMat.amio} mg ({localMat.amioMl} mL)
                    </p>
                    <p style={{margin:0,fontSize:10,color:P.amberText}}>
                      Après le {showAmio1 ? "3ᵉ" : "5ᵉ"} choc cumulé · 5 mg/kg · {localPoids} kg
                    </p>
                  </div>
                  <button onClick={() => addEvent("cord",`Amiodarone ${localMat.amio}mg IV/IO (5mg/kg)`,"💊")}
                    style={{background:P.amber,border:"none",borderRadius:7,
                      color:"#fff",padding:"6px 10px",fontSize:11,fontWeight:600,
                      cursor:"pointer",fontFamily:sans}}>
                    Administrer
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
          <span style={{fontSize:10,color:P.textSoft,fontFamily:mono}}>Cycle RCP · 2 min</span>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:10,fontWeight:500,color:warn?bar:P.textSoft,fontFamily:mono}}>{warn?`⚠ ${rem}s`:`${rem}s`}</span>
            <button onClick={()=>{setCycleOffset(sec);prevCpPedRef.current=null;addEvent("cycle","↺ Cycle remis à zéro","↺");}}
              style={{background:P.surfaceAlt,border:`1px solid ${P.border}`,borderRadius:6,
                padding:"2px 8px",fontSize:10,color:P.textMid,cursor:"pointer",
                fontFamily:sans,lineHeight:1.4}}>
              ↺ Reset
            </button>
          </div>
        </div>
        <div style={{background:P.surfaceAlt,borderRadius:99,height:5,overflow:"hidden"}}>
          <div style={{width:`${pct}%`,height:5,borderRadius:99,background:bar,transition:"width 1s linear,background 0.5s"}}/>
        </div>
        <p style={{margin:"6px 0 0",fontSize:10,color:P.textSoft,textAlign:"center"}}>
          {events.find(e => e.id === "iot")
            ? <span style={{ color:P.violetText, fontWeight:700 }}>🫁 IOT — Compressions continues · 10/min</span>
            : "Nourrisson : 2 doigts · 4 cm · 15:2 · 100–120/min"
          }
        </p>
      </div>

      <div style={{padding:"10px 12px 0", boxSizing:"border-box", width:"100%"}}>

        {/* Rappel doses + matériel */}
        {localMat && (
          <div style={{background:P.amberSoft,border:`1px solid color-mix(in srgb, ${P.amber} 27%, transparent)`,borderRadius:12,
            padding:"10px 14px",marginBottom:10}}>
            <p style={{margin:"0 0 6px",fontSize:10,fontWeight:600,color:P.amberText,
              textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>Doses · Matériel — {localPoids} kg</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"3px 12px"}}>
              {[
                [`💉 Adr`,    `${localMat.adrenalineMg} mg`],
                [`⚡ Défib`,   `${localMat.defibJ} J`],
                [`💊 Amio`,   `${localMat.amio} mg`],
                [`💧 Rempli`, `${localMat.remplissage10}–${localMat.remplissage20} mL`],
                [`🫁 Sonde`,  `${localMat.sondeAvecBallonnet} mm`],
                [`📏 Repère`, `${localMat.repereLab} cm`],
                [`🎭 Lame`,   localMat.lame],
                [`🔵 Aspir.`, localMat.sondeAspi],
                [`🟡 SNG`,    localMat.sondeGastrique],
                [`🫧 Guedel`, localMat.guedel],
              ].map(([k,v])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"2px 0"}}>
                  <span style={{fontSize:10,color:P.amberText}}>{k}</span>
                  <span style={{fontSize:11,fontWeight:700,color:P.amberText,fontFamily:mono}}>{v}</span>
                </div>
              ))}
            </div>
            <p style={{margin:"8px 0 0",fontSize:9,color:P.roseText,fontWeight:600,
              lineHeight:1.4,borderTop:"1px solid #F5C99E",paddingTop:6}}>
              ⚠️ Doses à recalculer et vérifier avant administration — le praticien demeure seul responsable.
            </p>
          </div>
        )}

        {/* ── Bouton transition VLM (VLI pédiatrique uniquement, tant que non déverrouillé) ── */}
        {isVLI && !vliUnlockedPed && (
          <button onClick={() => setModalVliTransitionPed(true)}
            style={{ width:"100%", background:"linear-gradient(135deg,#EA6A12,#B24E0A)", border:"none",
              borderRadius:13, padding:"12px 14px", marginBottom:12, display:"flex", alignItems:"center",
              gap:10, cursor:"pointer", boxShadow:"0 4px 14px rgba(234,106,18,0.4)" }}>
            <span style={{ fontSize:20 }}>🚒</span>
            <div style={{ textAlign:"left", flex:1 }}>
              <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:"#fff" }}>VLM arrivée</p>
              <p style={{ margin:0, fontSize:10, color:"rgba(255,255,255,0.85)" }}>Débloquer la prise en charge médicale complète</p>
            </div>
            <span style={{ color:"#fff", fontSize:16 }}>›</span>
          </button>
        )}

        {/* ── Rangée d'accès rapide : Patient · Transmission · Régulation ── */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
          <button onClick={() => setModalPatPed(true)}
            style={{ background:P.surface, border:`1px solid ${patPed.nom ? P.blue : P.border}`, borderRadius:14,
              padding:"11px 6px", cursor:"pointer", fontFamily:sans, display:"flex",
              flexDirection:"column", alignItems:"center", gap:6, minWidth:0,
              boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
            <span style={{ width:34, height:34, borderRadius:10,
              background:`color-mix(in srgb, ${P.blue} 16%, transparent)`,
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:17, color:P.blue }}>🪪</span>
            <span style={{ fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>Patient</span>
            <span style={{ fontSize:8.5, color:P.textSoft, fontFamily:mono, letterSpacing:"0.03em",
              maxWidth:"100%", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{patPed.nom ? `${patPed.nom}` : "à renseigner"}</span>
          </button>
          <button onClick={() => setModalTransPed(true)}
            style={{ background: transPed.saved ? P.greenSoft : P.amberSoft,
              border:`1px solid ${transPed.saved ? P.green : P.amber}`, borderRadius:14,
              padding:"11px 6px", cursor:"pointer", fontFamily:sans, display:"flex",
              flexDirection:"column", alignItems:"center", gap:6, minWidth:0,
              boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
            <span style={{ width:34, height:34, borderRadius:10,
              background: transPed.saved ? `color-mix(in srgb, ${P.green} 20%, transparent)` : `color-mix(in srgb, ${P.amber} 20%, transparent)`,
              display:"flex", alignItems:"center", justifyContent:"center",
              color: transPed.saved ? P.greenText : P.amberText }}>
              <span style={{ width:18, height:18, display:"flex" }}>{ICONS.transmission}</span>
            </span>
            <span style={{ fontSize:11.5, fontWeight:800, color: transPed.saved ? P.greenText : P.amberText, fontFamily:disp }}>Transmission</span>
            <span style={{ fontSize:8.5, color: transPed.saved ? P.greenText : P.amberText, opacity:0.85, fontFamily:mono, letterSpacing:"0.03em" }}>{transPed.saved ? "enregistrée" : "à compléter"}</span>
          </button>
          <button onClick={() => setModalRegulPed(true)}
            style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14,
              padding:"11px 6px", cursor:"pointer", fontFamily:sans, display:"flex",
              flexDirection:"column", alignItems:"center", gap:6, minWidth:0,
              boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
            <span style={{ width:34, height:34, borderRadius:10,
              background:`color-mix(in srgb, ${P.teal} 16%, transparent)`,
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, color:P.teal }}>📞</span>
            <span style={{ fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>Régulation</span>
            <span style={{ fontSize:8.5, color:P.textSoft, fontFamily:mono, letterSpacing:"0.03em" }}>SAMU</span>
          </button>
        </div>

        {/* ── Carte EtCO₂ (capnographie, courbe en direct) ── */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:13,
          padding:"9px 12px", marginBottom:10, boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: etco2OpenPed ? 5 : 0 }}>
            <button onClick={() => setEtco2OpenPed(v => !v)}
              style={{ display:"flex", alignItems:"center", gap:7, background:"transparent", border:"none",
                cursor:"pointer", padding:0, flex:1, minWidth:0, textAlign:"left" }}>
              <span style={{ width:24, height:24, borderRadius:8,
                background:`color-mix(in srgb, ${P.teal} 16%, transparent)`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:P.teal }}>📈</span>
              <p style={{ margin:0, fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>EtCO₂ <span style={{ fontSize:8, fontWeight:600, color:P.textSoft, fontFamily:mono }}>mmHg</span></p>
              <span style={{ fontSize:10, color:P.textSoft, marginLeft:4 }}>{etco2OpenPed ? "▾" : "▸"}</span>
            </button>
            <div style={{ display:"flex", alignItems:"center", gap:9 }}>
              {etco2ListPed.length > 0 && (
                <span style={{ fontSize:20, fontWeight:800, color:P.tealText, fontFamily:mono, fontVariantNumeric:"tabular-nums", lineHeight:1 }}>{etco2ListPed[etco2ListPed.length - 1].val}</span>
              )}
              <button onClick={() => { setEtco2ValPed(""); setModalEtco2Ped(true); }}
                style={{ background:`color-mix(in srgb, ${P.teal} 14%, transparent)`, color:P.tealText,
                  border:`1px solid ${P.teal}`, borderRadius:9, padding:"6px 11px", fontSize:11,
                  fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>+ Valeur</button>
            </div>
          </div>
          {etco2OpenPed && <Etco2Curve data={etco2ListPed} P={P} mono={mono} />}
        </div>

        {/* ── Carte Hémodynamique post-RACS pédiatrique ── */}
        {events.find(e => e.id === "rosc") && (
          <div style={{ background:P.surface, border:`1px solid ${P.green}`, borderRadius:13,
            padding:"9px 12px", marginBottom:10, boxShadow:`0 2px 8px color-mix(in srgb, ${P.green} 14%, transparent)` }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: hemoOpenPed ? 6 : 0 }}>
              <button onClick={() => setHemoOpenPed(v => !v)}
                style={{ display:"flex", alignItems:"center", gap:7, background:"transparent", border:"none",
                  cursor:"pointer", padding:0, flex:1, minWidth:0, textAlign:"left" }}>
                <span style={{ width:24, height:24, borderRadius:8, background:P.greenSoft,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:13 }}>💓</span>
                <p style={{ margin:0, fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>Hémodynamique <span style={{ fontSize:8, fontWeight:600, color:P.textSoft, fontFamily:mono }}>post-RACS</span></p>
                <span style={{ fontSize:10, color:P.textSoft, marginLeft:4 }}>{hemoOpenPed ? "▾" : "▸"}</span>
              </button>
              <div style={{ display:"flex", gap:7 }}>
                <button onClick={() => { setAmineFormPed({ type:"Noradrénaline", dose:"", unit:"mg/h" }); setModalAminePed(true); }}
                  style={{ background:`color-mix(in srgb, ${P.green} 14%, transparent)`, color:P.greenText,
                    border:`1px solid ${P.green}`, borderRadius:9, padding:"5px 9px", fontSize:10.5,
                    fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>+ Amine</button>
                <button onClick={() => { setHemoFormPed({ pas:"", pad:"", fc:"" }); setModalHemoPed(true); }}
                  style={{ background:`color-mix(in srgb, ${P.green} 14%, transparent)`, color:P.greenText,
                    border:`1px solid ${P.green}`, borderRadius:9, padding:"5px 9px", fontSize:10.5,
                    fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>+ Mesure</button>
              </div>
            </div>
            {hemoOpenPed && hemoListPed.length > 0 && (
              <div style={{ display:"flex", gap:12, marginBottom:5 }}>
                {[{c:P.rose,l:"PAS"},{c:P.blue,l:"PAD"},{c:P.amber,l:"PAM",dash:true},{c:P.violet,l:"FC",dot:true}].map(({c,l,dash,dot})=>(
                  <div key={l} style={{ display:"flex", alignItems:"center", gap:3 }}>
                    <svg width="18" height="8" viewBox="0 0 18 8"><line x1="0" y1="4" x2="18" y2="4" stroke={c} strokeWidth="2" strokeDasharray={dash?"5 3":dot?"2 3":undefined} /></svg>
                    <span style={{ fontSize:9, fontWeight:700, color:c, fontFamily:mono }}>{l}</span>
                  </div>
                ))}
              </div>
            )}
            {hemoOpenPed && <HemoCurve hemoList={hemoListPed} amineList={amineListPed} P={P} mono={mono} refSec={events.find(e=>e.id==="rosc")?.sec||0} />}
          </div>
        )}

        {/* ── Tab bar Actions / Étiologie / Thérapeutiques / (Situations particulières VLI) ── */}
        <div style={{display:"grid",gridTemplateColumns: (isVLI && !vliUnlockedPed) ? "1fr 1fr" : "1fr 1fr 1fr",gap:5,
          background:P.surfaceAlt,borderRadius:12,padding:4,marginBottom:10}}>
          {(isVLI && !vliUnlockedPed ? [
            { id:"actions", label:"Actions",    icon:"⚡" },
            { id:"vli_sit", label:"Situations", icon:"🎯" },
          ] : [
            { id:"actions", label:"Actions",       icon:"⚡" },
            { id:"etio",    label:"Étiologie",     icon:"🔍" },
            { id:"ther",    label:"Thérapeutiques", icon:"💊" },
          ]).map(t => (
            <button key={t.id} onClick={() => setMainTabPed(t.id)}
              style={{ padding:"8px 4px", borderRadius:9, border:"none",
                background: mainTabPed===t.id ? P.surface : "transparent",
                color: mainTabPed===t.id ? P.text : P.textSoft,
                fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:sans,
                boxShadow: mainTabPed===t.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                display:"flex", alignItems:"center", justifyContent:"center", gap:4 }}>
              <span>{t.icon}</span>{t.label}
            </button>
          ))}
        </div>

        {/* ── Contenu Actions — VLI Pédiatrique restreint ── */}
        {mainTabPed === "actions" && isVLI && !vliUnlockedPed && (() => {
          const adrAlarmActivePed = adrTimerStartPed > 0 && running && !events.find(e => e.id === "rosc")
            && ((Date.now() - adrTimerStartPed) / 1000 >= adrIntervalGlobal * 60);
          const lastRhythm = [...events].reverse().find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
          return (
            <div style={{ display:"flex", flexDirection:"column", gap:9, marginBottom:10 }}>
              {/* ── Récidive d'arrêt + RACS Surveillance — en tête dès que RACS est obtenu ── */}
              {events.some(e => e.id === "rosc") && (
                <>
                  <button onClick={() => {
                    const roscTime = events.find(e => e.id === "rosc")?.time || "?";
                    addEvent("re_arret", `↩ Récidive d'arrêt — RACS précédent à ${roscTime}`, "🔴");
                    setEvents(prev => prev.filter(e => e.id !== "rosc"));
                    setAdrTimerStartPed(Date.now());
                    setCycleOffset(sec);
                    prevCpPedRef.current = null;
                    setRunning(true);
                  }}
                    style={{ width:"100%", background:`linear-gradient(135deg, ${P.rose}, #9B1010)`,
                      border:"none", borderRadius:13, color:"#fff", padding:"12px 14px",
                      cursor:"pointer", fontFamily:sans, display:"flex", alignItems:"center", gap:10,
                      boxShadow:`0 6px 18px color-mix(in srgb, ${P.rose} 35%, transparent)` }}>
                    <span style={{ fontSize:20, flexShrink:0 }}>🔴</span>
                    <div style={{ textAlign:"left", flex:1, minWidth:0 }}>
                      <p style={{ margin:0, fontSize:13, fontWeight:800 }}>Récidive d'arrêt</p>
                      <p style={{ margin:0, fontSize:10.5, opacity:0.85 }}>Reprendre la réanimation</p>
                    </div>
                    <span style={{ fontSize:15, flexShrink:0 }}>↩</span>
                  </button>

                  <button onClick={() => setModalRacsPed(true)}
                    style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
                      background:`color-mix(in srgb, ${P.green} 12%, ${P.surface})`,
                      border:`1.5px solid ${P.green}`, borderRadius:13, padding:"12px 14px",
                      cursor:"pointer", fontFamily:sans, textAlign:"left",
                      boxShadow:`0 2px 8px color-mix(in srgb, ${P.green} 18%, transparent)` }}>
                    <span style={{ width:36, height:36, borderRadius:10,
                      background:`color-mix(in srgb, ${P.green} 20%, transparent)`,
                      display:"flex", alignItems:"center", justifyContent:"center", fontSize:19, flexShrink:0 }}>🫀</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ margin:0, fontSize:13.5, fontWeight:800, color:P.greenText, fontFamily:disp }}>
                        RACS — Surveillance
                      </p>
                      <p style={{ margin:0, fontSize:10.5, color:P.greenText, opacity:0.85 }}>
                        Constantes à renseigner en attendant le VLM
                      </p>
                    </div>
                    <span style={{ fontSize:16, color:P.greenText, flexShrink:0 }}>›</span>
                  </button>
                </>
              )}

              {/* Examen pupillaire initial — disparaît une fois répondu */}
              {!events.some(e => e.id === "pupilles_initial") && (
                <div style={{ background:"rgba(234,106,18,0.1)", border:"1.5px solid #EA6A12", borderRadius:13, padding:"11px 13px" }}>
                  <p style={{ margin:0, fontSize:12, fontWeight:800, color:"#B24E0A", fontFamily:disp }}>
                    🔍 Examen pupillaire initial
                  </p>
                  <p style={{ margin:"1px 0 8px", fontSize:9.5, color:"#B24E0A", opacity:0.75, fontStyle:"italic" }}>
                    à réaliser avant la 1ère injection d'adrénaline
                  </p>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                    {["Normales","Anormales","Non fait"].map(v => (
                      <button key={v} onClick={() => {
                          if (v === "Anormales") { setPupillesInitExpandedPed(x => !x); return; }
                          addEvent("pupilles_initial", `Examen pupillaire initial : ${v}`, "🔍");
                        }}
                        style={{ padding:"9px 4px", borderRadius:9, fontSize:11, fontWeight:700,
                          border:"1.5px solid #EA6A12",
                          background: v==="Anormales" && pupillesInitExpandedPed ? "#EA6A12" : P.surface,
                          color: v==="Anormales" && pupillesInitExpandedPed ? "#fff" : "#B24E0A",
                          cursor:"pointer", fontFamily:sans }}>
                        {v}
                      </button>
                    ))}
                  </div>
                  {pupillesInitExpandedPed && (
                    <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                      {PUPILLES_DETAIL.map(({v,left,right}) => (
                        <button key={v} onClick={() => {
                            addEvent("pupilles_initial", `Examen pupillaire initial : Anormales — ${v}`, "🔍");
                            setPupillesInitExpandedPed(false);
                          }}
                          style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                            borderRadius:9, border:"1.5px solid #C5CFDD", background:P.surface,
                            fontSize:11.5, fontWeight:600, color:P.text, cursor:"pointer",
                            fontFamily:sans, textAlign:"left" }}>
                          <PupilIcon left={left} right={right} />{v}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
                <ActionBtn action={{ label:"Adrénaline", dose:`${localMat?.adrenalineMg||""} mg IV/IO`, vital:true, svg:ICONS.adr, accent:P.rose, soft:P.roseSoft, textC:P.roseText,
                    hapticType:"long", badge: adrAlarmActivePed ? { text:"!", color:P.rose, pulse:true } : null }}
                  onClick={() => { addEvent("adr",`Adrénaline ${localMat?.adrenalineMg||""}mg IV/IO (10μg/kg)`,"💉"); setAdrTimerStartPed(Date.now()); }} />
                <ActionBtn action={{ label:"Défibrillation", dose:"selon DSA", vital:true, svg:ICONS.choc, accent:P.blue, soft:P.blueSoft, textC:P.blueText,
                    hapticType:"double", badge: lastRhythm?.id === "rv_fvtv" ? { text:"FV", color:P.blue, pulse:false } : null }}
                  onClick={() => setModalChocPed(true)} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
                <ActionBtn action={{ label:"Analyse de rythme", svg:ICONS.rythme, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                  onClick={() => setModalRythme(true)} />
                <ActionBtn action={{ label:"Voie d'abord", dose:"DIO 1ère intention", svg:ICONS.vvp, accent:P.green, soft:P.greenSoft, textC:P.greenText }}
                  onClick={() => setModalVvpPed(true)} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
                <ActionBtn action={{ label:"Cordarone", dose:`${localMat?.amio||""} mg`, svg:ICONS.amio, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                  onClick={() => addEvent("cord",`Amiodarone ${localMat?.amio||""}mg IV/IO (5mg/kg)`,"💊")} />
                <ActionBtn action={{ label:"Sécurisation VAS", svg:ICONS.iot, accent:"#EA6A12", soft:"rgba(234,106,18,0.12)", textC:"#B24E0A",
                    badge: (events.some(e => e.id === "iot") || events.some(e => e.id === "vas_supraglottique")) ? { text:"✓", color:P.green, pulse:false } : null }}
                  onClick={() => setModalVasVLIPed(true)} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:9 }}>
                <ActionBtn action={{ label:"Planche à masser", svg:ICONS.planche, accent:P.teal, soft:P.tealSoft, textC:P.tealText }}
                  onClick={() => addEvent("planche","Planche à masser mise en place","🦺")} />
              </div>

              {/* Le bouton "RACS — Surveillance" est désormais en tête de grille — voir plus haut. */}
            </div>
          );
        })()}

        {/* ── Contenu "Situations particulières" — VLI Pédiatrique restreint ── */}
        {mainTabPed === "vli_sit" && isVLI && !vliUnlockedPed && (() => {
          const poidsNum = parseFloat(poids) || 0;
          const isofundineDose = Math.round(poidsNum * 20);
          const cyanokitDoseMg = Math.min(Math.round(poidsNum * 70), 5000);
          const hemorragieCount = events.filter(e => e.id === "vli_hemorragie").length;
          const cyanokitCount = events.filter(e => e.id === "vli_cyanokit").length;
          const vasDone = events.some(e => e.id === "vli_vas");
          return (
            <div style={{ display:"flex", flexDirection:"column", gap:9, marginBottom:10 }}>

              {/* Hémorragie — Isofundine 20mL/kg/10min */}
              <div style={{ background: hemorragieCount>0 ? P.roseSoft : P.surface,
                border:`1.5px solid ${P.rose}`, borderRadius:13, padding:"12px 14px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: hemorragieCount>0 ? 8 : 0 }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>🩸</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:P.roseText }}>Hémorragie</p>
                    <p style={{ margin:0, fontSize:10, color:P.roseText, opacity:0.85 }}>
                      Arrêt du saignement + Isofundine {isofundineDose} mL sur 10 min (20 mL/kg)
                    </p>
                  </div>
                </div>
                {hemorragieCount === 0 && (
                  <button onClick={() => addEvent("vli_hemorragie", `Hémorragie — Isofundine ${isofundineDose} mL sur 10 min (20 mL/kg)`, "🩸")}
                    style={{ width:"100%", marginTop:8, background:P.rose, border:"none", borderRadius:10,
                      color:"#fff", padding:"10px", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                    Démarrer Isofundine {isofundineDose} mL / 10 min
                  </button>
                )}
                {hemorragieCount >= 1 && (
                  <button onClick={() => addEvent("vli_hemorragie", `Isofundine ${isofundineDose} mL en garde veine (relais)`, "🩸")}
                    style={{ width:"100%", marginTop:8, background:P.surface, border:`1.5px solid ${P.rose}`, borderRadius:10,
                      color:P.roseText, padding:"10px", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                    + Isofundine en garde veine (relais)
                  </button>
                )}
              </div>

              {/* Obstruction VAS */}
              <button onClick={() => { if (!vasDone) addEvent("vli_vas", "Désobstruction VAS — Exposition douce au laryngoscope + Pince Magill", "🫁"); }}
                style={{ display:"flex", alignItems:"center", gap:10, background: vasDone ? P.greenSoft : P.surface,
                  border:`1.5px solid ${vasDone ? P.green : P.border}`, borderRadius:13, padding:"12px 14px",
                  cursor: vasDone ? "default" : "pointer", textAlign:"left", fontFamily:sans }}>
                <span style={{ fontSize:20, flexShrink:0 }}>{vasDone ? "✅" : "🫁"}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{ margin:0, fontSize:12.5, fontWeight:800, color: vasDone ? P.greenText : P.text }}>Obstruction VAS</p>
                  <p style={{ margin:0, fontSize:10, color: vasDone ? P.greenText : P.textSoft }}>
                    Exposition douce au laryngoscope + Pince Magill
                  </p>
                </div>
                {!vasDone && <span style={{ fontSize:14, color:P.textSoft }}>›</span>}
              </button>

              {/* Intoxication aux fumées — Cyanokit 70mg/kg */}
              <div style={{ background: cyanokitCount>0 ? "rgba(84,101,124,0.08)" : P.surface,
                border:`1.5px solid ${P.slateText}`, borderRadius:13, padding:"12px 14px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>💨</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:P.text }}>Intoxication aux fumées</p>
                    <p style={{ margin:0, fontSize:10, color:P.textSoft }}>
                      Cyanokit {cyanokitDoseMg} mg sur 15 min (70 mg/kg, max 5 g) · voie dédiée
                    </p>
                  </div>
                </div>
                {cyanokitCount === 0 && (
                  <button onClick={() => addEvent("vli_cyanokit", `Cyanokit ${cyanokitDoseMg} mg sur 15 min (voie dédiée)`, "💨")}
                    style={{ width:"100%", background:P.slateText, border:"none", borderRadius:10,
                      color:"#fff", padding:"10px", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                    Démarrer Cyanokit {cyanokitDoseMg} mg / 15 min
                  </button>
                )}
                {cyanokitCount >= 1 && (
                  <p style={{ margin:0, fontSize:11, color:P.slateText, fontWeight:700 }}>
                    ✓ Dose administrée ({cyanokitDoseMg} mg, dose max protocole {5000} mg)
                  </p>
                )}
              </div>

              <p style={{ margin:"4px 0 0", fontSize:10, color:P.textSoft, textAlign:"center", fontStyle:"italic" }}>
                Pas d'hypothermie ni de femme enceinte — non applicables en pédiatrique
              </p>
            </div>
          );
        })()}

        {/* ── Contenu Actions (grille pédiatrique) ── */}
        {mainTabPed === "actions" && !(isVLI && !vliUnlockedPed) && (() => {
          const adrAlarmActivePed = adrTimerStartPed > 0 && running && !events.find(e => e.id === "rosc")
            && ((Date.now() - adrTimerStartPed) / 1000 >= adrIntervalGlobal * 60);
          const lastRhythmPed = [...events].reverse().find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
          return (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginBottom:10}}>

          {/* ── Récidive d'arrêt + Soins post-RACS — en tête dès que RACS est obtenu ── */}
          {events.some(e => e.id === "rosc") && (
            <>
              <button onClick={() => {
                const roscTime = events.find(e => e.id === "rosc")?.time || "?";
                addEvent("re_arret", `↩ Récidive d'arrêt — RACS précédent à ${roscTime}`, "🔴");
                setEvents(prev => prev.filter(e => e.id !== "rosc"));
                setAdrTimerStartPed(Date.now());
                setCycleOffset(sec);
                prevCpPedRef.current = null;
                setRunning(true);
              }}
                style={{ gridColumn:"1 / -1", width:"100%", background:`linear-gradient(135deg, ${P.rose}, #9B1010)`,
                  border:"none", borderRadius:13, color:"#fff", padding:"12px 14px",
                  cursor:"pointer", fontFamily:sans, display:"flex", alignItems:"center", gap:10,
                  boxShadow:`0 6px 18px color-mix(in srgb, ${P.rose} 35%, transparent)` }}>
                <span style={{ fontSize:20, flexShrink:0 }}>🔴</span>
                <div style={{ textAlign:"left", flex:1, minWidth:0 }}>
                  <p style={{ margin:0, fontSize:13, fontWeight:800 }}>Récidive d'arrêt</p>
                  <p style={{ margin:0, fontSize:10.5, opacity:0.85 }}>Reprendre la réanimation</p>
                </div>
                <span style={{ fontSize:15, flexShrink:0 }}>↩</span>
              </button>

              <button onClick={() => setModalRacsPed(true)}
                style={{ gridColumn:"1 / -1", display:"flex", alignItems:"center", gap:10,
                  background:`color-mix(in srgb, ${P.green} 12%, ${P.surface})`,
                  border:`1.5px solid ${P.green}`, borderRadius:13, padding:"12px 14px",
                  cursor:"pointer", fontFamily:sans, textAlign:"left",
                  boxShadow:`0 2px 8px color-mix(in srgb, ${P.green} 18%, transparent)` }}>
                <span style={{ width:36, height:36, borderRadius:10,
                  background:`color-mix(in srgb, ${P.green} 20%, transparent)`,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:19, flexShrink:0 }}>🫀</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{ margin:0, fontSize:13.5, fontWeight:800, color:P.greenText, fontFamily:disp }}>
                    Soins post-RACS
                  </p>
                  <p style={{ margin:0, fontSize:10.5, color:P.greenText, opacity:0.85 }}>
                    RACS obtenu — renseigner constantes, amines, température
                  </p>
                </div>
                <span style={{ fontSize:16, color:P.greenText, flexShrink:0 }}>›</span>
              </button>
            </>
          )}

          {/* Examen pupillaire initial — disparaît une fois répondu */}
          {!events.some(e => e.id === "pupilles_initial") && (
            <div style={{ gridColumn:"1 / -1", background:P.violetSoft, border:`1.5px solid ${P.violet}`, borderRadius:13, padding:"11px 13px" }}>
              <p style={{ margin:0, fontSize:12, fontWeight:800, color:P.violetText, fontFamily:disp }}>
                🔍 Examen pupillaire initial
              </p>
              <p style={{ margin:"1px 0 8px", fontSize:9.5, color:P.violetText, opacity:0.75, fontStyle:"italic" }}>
                à réaliser avant la 1ère injection d'adrénaline
              </p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                {["Normales","Anormales","Non fait"].map(v => (
                  <button key={v} onClick={() => {
                      if (v === "Anormales") { setPupillesInitExpandedPed(x => !x); return; }
                      addEvent("pupilles_initial", `Examen pupillaire initial : ${v}`, "🔍");
                    }}
                    style={{ padding:"9px 4px", borderRadius:9, fontSize:11, fontWeight:700,
                      border:`1.5px solid ${P.violet}`,
                      background: v==="Anormales" && pupillesInitExpandedPed ? P.violet : P.surface,
                      color: v==="Anormales" && pupillesInitExpandedPed ? "#fff" : P.violetText,
                      cursor:"pointer", fontFamily:sans }}>
                    {v}
                  </button>
                ))}
              </div>
              {pupillesInitExpandedPed && (
                <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                  {PUPILLES_DETAIL.map(({v,left,right}) => (
                    <button key={v} onClick={() => {
                        addEvent("pupilles_initial", `Examen pupillaire initial : Anormales — ${v}`, "🔍");
                        setPupillesInitExpandedPed(false);
                      }}
                      style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                        borderRadius:9, border:`1.5px solid ${P.border}`, background:P.surface,
                        fontSize:11.5, fontWeight:600, color:P.text, cursor:"pointer",
                        fontFamily:sans, textAlign:"left" }}>
                      <PupilIcon left={left} right={right} />{v}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Dilution adrénaline — identique à l'écran de préparation, mais visible ici pendant la réa ── */}
          {pedDiluEnabled && (() => {
            const p = poids;

            // ── PROTOCOLE 2 : dilution simple universelle ──
            if (pedDiluMode === "2") {
              const volInj = (Math.round(p * 0.1 * 100) / 100).toString().replace(".", ",");
              const mgInj  = (Math.round(p * 0.01 * 1000) / 1000).toString().replace(".", ",");
              const Step2 = ({ num, bold, rest }) => (
                <div style={{ display:"flex", gap:8, padding:"5px 0", borderBottom:`1px solid ${P.borderSoft}`, alignItems:"baseline" }}>
                  <span style={{ width:18, height:18, borderRadius:5, background:P.tealText,
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10, fontWeight:800, color:"#fff", flexShrink:0, fontFamily:mono }}>{num}</span>
                  <p style={{ margin:0, fontSize:12, color:P.text, lineHeight:1.4 }}>
                    {bold && <span style={{ fontWeight:700, color:P.tealText }}>{bold}</span>}
                    {rest && <span>{rest}</span>}
                  </p>
                </div>
              );
              return (
                <div style={{ gridColumn:"1 / -1", background:P.tealSoft, borderRadius:10, padding:"10px 12px", marginBottom:2,
                  border:`1px solid ${P.teal}` }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                    <p style={{ margin:0, fontSize:9, fontWeight:800, color:P.tealText, fontFamily:mono,
                      textTransform:"uppercase", letterSpacing:"0.08em" }}>💉 Protocole 2 — Dilution simple universelle</p>
                    <div style={{ display:"flex", gap:6 }}>
                      <div style={{ background:P.roseSoft, border:`1px solid ${P.rose}`, borderRadius:7,
                        padding:"3px 8px", textAlign:"center" }}>
                        <span style={{ fontSize:14, fontWeight:800, color:P.roseText, fontFamily:mono }}>{volInj} mL</span>
                        <span style={{ fontSize:9, color:P.roseText, display:"block" }}>/ 4 min</span>
                      </div>
                      <div style={{ background:P.amberSoft, border:`1px solid ${P.amber}`, borderRadius:7,
                        padding:"3px 8px", textAlign:"center" }}>
                        <span style={{ fontSize:14, fontWeight:800, color:P.amberText, fontFamily:mono }}>{mgInj} mg</span>
                        <span style={{ fontSize:9, color:P.amberText, display:"block" }}>0,01 mg/kg</span>
                      </div>
                    </div>
                  </div>
                  <p style={{ margin:"0 0 6px", fontSize:10, color:P.tealText, fontStyle:"italic" }}>
                    Préparation identique pour tous les poids
                  </p>
                  <Step2 num="1" bold="Prélever 1 mL (1 mg)" rest=" d'adrénaline 1 mg/mL" />
                  <Step2 num="2" bold="Compléter à 10 mL" rest=" (+ 9 mL NaCl 0,9 %)" />
                  <div style={{ marginTop:6, padding:"5px 0" }}>
                    <p style={{ margin:0, fontSize:11.5, color:P.tealText, fontWeight:700 }}>→ Concentration : 0,1 mg/mL</p>
                    <p style={{ margin:"2px 0 0", fontSize:12, fontWeight:800, color:P.roseText }}>
                      → Injecter {volInj} mL = {mgInj} mg = 0,01 mg/kg ✓
                    </p>
                  </div>
                </div>
              );
            }

            // ── PROTOCOLE 1 : double/simple selon le poids ──
            const isInfant = p < 10;
            const vol1Inf  = p;
            const mg1Inf   = Math.round(p * 0.1 * 100) / 100;
            const naclInf  = Math.round((10 - p) * 10) / 10;
            const concInf  = (mg1Inf / 10).toFixed(3);
            const volSup   = Math.round(p / 10 * 100) / 100;
            const naclSup  = Math.round((10 - volSup) * 100) / 100;
            const concSup  = (volSup / 10).toFixed(3);
            const Step1 = ({ num, bold, rest }) => (
              <div style={{ display:"flex", gap:8, padding:"5px 0", borderBottom:`1px solid ${P.borderSoft}`, alignItems:"baseline" }}>
                {num !== undefined && (
                  <span style={{ width:18, height:18, borderRadius:5, background:P.tealText,
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10, fontWeight:800, color:"#fff", flexShrink:0, fontFamily:mono }}>{num}</span>
                )}
                <p style={{ margin:0, fontSize:12, color:P.text, lineHeight:1.4 }}>
                  {bold && <span style={{ fontWeight:700, color:P.tealText }}>{bold}</span>}
                  {rest && <span>{rest}</span>}
                </p>
              </div>
            );
            return (
              <div style={{ gridColumn:"1 / -1", background:P.tealSoft, borderRadius:10, padding:"10px 12px", marginBottom:2,
                border:`1px solid ${P.teal}` }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                  <p style={{ margin:0, fontSize:9, fontWeight:800, color:P.tealText, fontFamily:mono,
                    textTransform:"uppercase", letterSpacing:"0.08em" }}>
                    💉 Protocole 1 — {isInfant ? "< 10 kg (nourrisson)" : "≥ 10 kg (enfant)"}
                  </p>
                  <div style={{ background:P.roseSoft, border:`1px solid ${P.rose}`, borderRadius:7,
                    padding:"3px 8px", display:"flex", alignItems:"center", gap:4 }}>
                    <span style={{ fontSize:13, fontWeight:800, color:P.roseText, fontFamily:mono }}>1 mL</span>
                    <span style={{ fontSize:9, color:P.roseText }}>/ 4 min</span>
                  </div>
                </div>
                {isInfant ? (
                  <>
                    <Step1 num="1" bold="Ampoule 1 mg → diluer à 10 mL" rest=" (+ 9 mL NaCl 0,9 %) = 0,1 mg/mL" />
                    <Step1 num="2" bold={`Prélever ${vol1Inf} mL`} rest={` = ${mg1Inf} mg`} />
                    <Step1 num="3" bold="Compléter à 10 mL" rest={` (+ ${naclInf} mL NaCl 0,9 %)`} />
                    <div style={{ marginTop:6, padding:"5px 0" }}>
                      <p style={{ margin:0, fontSize:11.5, color:P.tealText, fontWeight:700 }}>
                        → {concInf} mg/mL · 1 mL = 10 µg/kg ✓
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <Step1 num="1" bold={`Prélever ${volSup} mL`} rest=" d'adrénaline 1 mg/mL" />
                    <Step1 num="2" bold="Compléter à 10 mL" rest={` (+ ${naclSup} mL NaCl 0,9 %)`} />
                    <div style={{ marginTop:6, padding:"5px 0" }}>
                      <p style={{ margin:0, fontSize:11.5, color:P.tealText, fontWeight:700 }}>
                        → {concSup} mg/mL · 1 mL = 10 µg/kg ✓
                      </p>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          <ActionBtn action={{label:"Adrénaline",dose:`${localMat?.adrenalineMg||""} mg`,vital:true,svg:ICONS.adr,accent:P.rose,soft:P.roseSoft,textC:P.roseText,
              hapticType:"long", badge: adrAlarmActivePed ? { text:"!", color:P.rose, pulse:true } : null}}
            onClick={()=>{ addEvent("adr",`Adrénaline ${localMat?.adrenalineMg||""}mg IV/IO (10μg/kg)`,"💉"); setAdrTimerStartPed(Date.now()); }}/>
          <ActionBtn action={{label:"Défibrillation",dose:"4 J/kg",vital:true,svg:ICONS.choc,accent:P.blue,soft:P.blueSoft,textC:P.blueText,
              hapticType:"double", badge: lastRhythmPed?.id === "rv_fvtv" ? { text:"FV", color:P.blue, pulse:false } : null}}
            onClick={()=>setModalChocPed(true)}/>
          <ActionBtn action={{label:"Analyse de rythme",svg:ICONS.rythme,accent:P.amber,soft:P.amberSoft,textC:P.amberText}}
            onClick={()=>setModalRythme(true)}/>
          <ActionBtn action={{label:"Voie d'abord",svg:ICONS.vvp,accent:P.green,soft:P.greenSoft,textC:P.greenText}}
            onClick={()=>setModalVvpPed(true)}/>
          <ActionBtn action={{label:amioLabel,svg:ICONS.amio,accent:P.amber,soft:P.amberSoft,textC:P.amberText}}
            onClick={()=>addEvent("cord",`Amiodarone ${localMat?.amio||""}mg IV/IO (5mg/kg)`,"💊")}/>
          <ActionBtn action={{label:"Intubation",svg:ICONS.iot,accent:P.violet,soft:P.violetSoft,textC:P.violetText,
              badge: events.some(e => e.id === "iot") ? { text:"✓", color:P.green, pulse:false } : null}}
            onClick={()=>setModalIotPed(true)}/>

          {/* Le bouton "Soins post-RACS" est désormais en tête de grille — voir plus haut. */}

          {/* ── Critères d'arrêt de réanimation (>40 min, sans RACS) — pédiatrique ── */}
          {running && sec >= 2400 && !events.find(e => e.id === "rosc") && !events.find(e => e.id === "deces") && (
            <button onClick={() => setModalCriteresPed(true)}
              style={{ gridColumn:"1 / -1", display:"flex", alignItems:"center", gap:10,
                background:`color-mix(in srgb, ${P.amber} 12%, ${P.surface})`,
                border:`1.5px solid ${P.amber}`, borderRadius:13, padding:"11px 14px",
                cursor:"pointer", fontFamily:sans, textAlign:"left",
                boxShadow:`0 2px 8px color-mix(in srgb, ${P.amber} 15%, transparent)` }}>
              <span style={{ width:32, height:32, borderRadius:10,
                background:`color-mix(in srgb, ${P.amber} 20%, transparent)`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>⏱</span>
              <div style={{ flex:1, minWidth:0 }}>
                <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:P.amberText, fontFamily:disp }}>
                  Critères d'arrêt à évaluer
                </p>
                <p style={{ margin:0, fontSize:10.5, color:P.amberText, opacity:0.8 }}>
                  Réanimation en cours depuis {Math.floor(sec/60)} min · ouvrir la check-list
                </p>
              </div>
              <span style={{ fontSize:16, color:P.amberText, flexShrink:0 }}>›</span>
            </button>
          )}

          {/* ── Bouton + : révèle les actions secondaires ── */}
          <button onClick={() => setShowMoreActionsPed(v => !v)}
            style={{ gridColumn:"1 / -1", background:"transparent", border:`1.5px dashed ${P.border}`,
              borderRadius:13, padding:"10px", cursor:"pointer", fontFamily:sans,
              display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              color:P.textMid, fontSize:12.5, fontWeight:700 }}>
            <span style={{ fontSize:15 }}>{showMoreActionsPed ? "−" : "+"}</span>
            {showMoreActionsPed ? "Moins d'actions" : "Plus d'actions"}
          </button>

          {showMoreActionsPed && (<>
            <ActionBtn action={{label:"Planche à masser",svg:ICONS.planche,accent:P.teal,soft:P.tealSoft,textC:P.tealText}}
              onClick={()=>addEvent("planche","Planche à masser mise en place","🦺")}/>
            <ActionBtn action={{label:"Fast-écho",svg:ICONS.fast,accent:P.blue,soft:P.blueSoft,textC:P.blueText}}
              onClick={()=>setModalFastPed(true)}/>
            {!events.some(e => e.id === "rosc") && (
              <ActionBtn action={{label:"Soins post-RACS",icon:"🫀",accent:P.green,soft:P.greenSoft,textC:P.greenText}}
                onClick={()=>setModalRacsPed(true)}/>
            )}
            <ActionBtn action={{label:"Constat de décès",svg:ICONS.deces,accent:P.slate,soft:P.slateSoft,textC:P.slateText}}
              onClick={()=>setModalDecesPed(true)}/>
          </>)}
        </div>
          );
        })()}

        {/* ── Contenu Étiologie pédiatrique ── */}
        {mainTabPed === "etio" && (
          <>
            <EtiologieTab title="Causes pédiatriques spécifiques" causes={CAUSES_PED}
              suspected={suspectedPed}
              onToggle={(id, label) => {
                if (suspectedPed.includes(id)) {
                  setSuspectedPed(suspectedPed.filter(x => x !== id));
                } else {
                  setSuspectedPed([...suspectedPed, id]);
                  addEvent("etio", `Étiologie suspectée : ${label}`, "🔍");
                }
              }}
              P={P} mono={mono} sans={sans} />
            <EtiologieTab title="5H — Causes métaboliques" causes={CAUSES_5H}
              suspected={suspectedPed}
              onToggle={(id, label) => {
                if (suspectedPed.includes(id)) {
                  setSuspectedPed(suspectedPed.filter(x => x !== id));
                } else {
                  setSuspectedPed([...suspectedPed, id]);
                  addEvent("etio", `Étiologie suspectée : ${label}`, "🔍");
                }
              }}
              P={P} mono={mono} sans={sans} />
            <EtiologieTab title="5T — Causes mécaniques" causes={CAUSES_5T}
              suspected={suspectedPed}
              onToggle={(id, label) => {
                if (suspectedPed.includes(id)) {
                  setSuspectedPed(suspectedPed.filter(x => x !== id));
                } else {
                  setSuspectedPed([...suspectedPed, id]);
                  addEvent("etio", `Étiologie suspectée : ${label}`, "🔍");
                }
              }}
              P={P} mono={mono} sans={sans} />
          </>
        )}

        {/* ── Contenu Thérapeutiques spécifiques pédiatrique (doses au poids) ── */}
        {mainTabPed === "ther" && (
          <TherapeutiquesTab list={THERAPEUTIQUES_ADULTE.filter(t => t.id !== "ddac")} addEvent={addEvent}
            localMat={localMat} onOpenEcmo={() => setModalEcmoPed(true)}
            P={P} mono={mono} sans={sans} />
        )}

        {/* Bandeau Note libre */}
        <div style={{marginBottom:10}}>
          {!showNotePed ? (
            <button onClick={()=>setShowNotePed(true)}
              style={{width:"100%",background:P.tealSoft,border:`1.5px solid #B2DADA`,
                borderRadius:12,padding:"10px 14px",cursor:"pointer",fontFamily:sans,
                display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:22,height:22,color:P.teal,flexShrink:0}}>{ICONS.note}</div>
              <span style={{fontSize:12,fontWeight:500,color:P.tealText}}>Ajouter une note libre</span>
              <span style={{marginLeft:"auto",fontSize:16,color:P.teal,lineHeight:1}}>+</span>
            </button>
          ) : (
            <div style={{background:P.tealSoft,border:`1.5px solid #B2DADA`,borderRadius:12,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <div style={{width:20,height:20,color:P.teal,flexShrink:0}}>{ICONS.note}</div>
                <p style={{margin:0,fontSize:12,fontWeight:600,color:P.tealText}}>Note libre</p>
                <button onClick={()=>{setShowNotePed(false);setNoteTextPed("");}}
                  style={{marginLeft:"auto",background:"transparent",border:"none",
                    color:P.teal,fontSize:18,cursor:"pointer",lineHeight:1}}>×</button>
              </div>
              <textarea value={noteTextPed} onChange={e=>setNoteTextPed(e.target.value)}
                placeholder="Ex : famille contactée, antécédents connus, circonstances..."
                rows={3}
                style={{width:"100%",background:"rgba(255,255,255,0.7)",
                  border:`1.5px solid #B2DADA`,borderRadius:8,padding:"10px 12px",
                  fontSize:13,color:P.text,fontFamily:sans,outline:"none",
                  resize:"none",boxSizing:"border-box",lineHeight:1.6,marginBottom:8}}
                onFocus={e=>e.target.style.borderColor=P.teal}
                onBlur={e=>e.target.style.borderColor="#B2DADA"}/>
              <button onClick={()=>{
                if(noteTextPed.trim()) addEvent("note", noteTextPed.trim(), "📝");
                setNoteTextPed(""); setShowNotePed(false);
              }} style={{width:"100%",background:`linear-gradient(135deg,${P.teal},#1A6A6A)`,
                border:"none",borderRadius:9,color:"#fff",fontSize:13,fontWeight:600,
                padding:"10px",cursor:"pointer",fontFamily:sans}}>
                ✓ Ajouter à la chronologie
              </button>
            </div>
          )}
        </div>

        {/* ── Métronome pédiatrique : bouton sourdine ── */}
        {metronomeEnabled && running && !events.find(e=>e.id==="rosc") && (
          <button onClick={() => setMetronomeMutedPed(v => !v)}
            style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
              background: metronomeMutedPed ? P.surfaceAlt : `color-mix(in srgb, ${P.blue} 10%, ${P.surface})`,
              border:`1px solid ${metronomeMutedPed ? P.border : P.blue}`,
              borderRadius:11, padding:"8px 14px", cursor:"pointer", fontFamily:sans,
              marginBottom:8, textAlign:"left" }}>
            <span style={{ fontSize:18, flexShrink:0 }}>{metronomeMutedPed ? "🔇" : "🎵"}</span>
            <p style={{ margin:0, fontSize:12, fontWeight:700, flex:1,
              color: metronomeMutedPed ? P.textMid : P.blueText }}>
              Métronome 100/min — {metronomeMutedPed ? "Sourdine" : "Actif"}
            </p>
            <span style={{ fontSize:11, fontWeight:600, flexShrink:0,
              color: metronomeMutedPed ? P.textSoft : P.blueText }}>
              {metronomeMutedPed ? "Réactiver ▶" : "Sourdine 🔇"}
            </span>
          </button>
        )}

        {/* Chronologie */}
        <div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:14,overflow:"hidden",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",padding:"0 8px 0 0"}}>
            <button onClick={()=>setShowLog(v=>!v)}
              style={{flex:1,background:"transparent",border:"none",padding:"12px 16px",
                display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",fontFamily:sans}}>
              <span style={{fontSize:13,fontWeight:500,color:P.textMid}}>Chronologie</span>
              <span style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{background:P.blueSoft,color:P.blueText,borderRadius:20,
                  padding:"1px 8px",fontSize:10,fontFamily:mono}}>{events.length}</span>
                <span style={{color:P.textSoft,fontSize:11}}>{showLog?"▲":"▼"}</span>
              </span>
            </button>
            {events.filter(e => e.id !== "start").length > 0 && (
              <button onClick={undoLastPed}
                style={{background:`color-mix(in srgb, ${P.amber} 14%, transparent)`,
                  border:`1px solid ${P.amber}`,borderRadius:9,padding:"6px 10px",
                  cursor:"pointer",fontFamily:sans,fontSize:11,fontWeight:700,
                  color:P.amberText,whiteSpace:"nowrap",flexShrink:0,display:"flex",
                  alignItems:"center",gap:4}}>
                ↩ <span>Annuler</span>
              </button>
            )}
          </div>
          {showLog && (
            <div style={{maxHeight:220,overflowY:"auto",borderTop:`1px solid ${P.borderSoft}`}}>
              {events.length === 0 && (
                <p style={{padding:"14px 16px",margin:0,fontSize:12,color:P.textSoft}}>Aucun événement</p>
              )}
              {[...events].sort((a,b) => {
                const ta = a.time || "00:00", tb = b.time || "00:00";
                return tb.localeCompare(ta); // décroissant (les plus récents en haut)
              }).map((e, i) => {
                const realIdx = events.findIndex(it => it === e);
                return (
                  <div key={realIdx} style={{display:"flex",gap:6,padding:"7px 10px",
                    background:i%2===0?P.surface:P.surfaceAlt,alignItems:"center",
                    overflow:"hidden"}}>
                    <input type="time" value={e.time}
                      onChange={ev => {
                        const newTime = ev.target.value;
                        setEvents(prev => {
                          // Modifier le time
                          const updated = prev.map((item,idx) =>
                            idx===realIdx ? {...item, time:newTime} : item
                          );
                          // Trier par heure croissante (ordre chronologique réel)
                          return updated.sort((a,b) => {
                            const ta = a.time || "00:00", tb = b.time || "00:00";
                            return ta.localeCompare(tb);
                          });
                        });
                      }}
                      style={{background:"transparent",border:"1px solid transparent",
                        borderRadius:6,padding:"2px 2px",fontSize:10,color:P.blue,
                        fontFamily:mono,fontWeight:600,cursor:"pointer",width:48,
                        outline:"none",textAlign:"center",flexShrink:0}}
                      onFocus={ev=>ev.target.style.borderColor=P.blue}
                      onBlur={ev=>ev.target.style.borderColor="transparent"}/>
                    <input type="text"
                      value={e.label}
                      onChange={ev => {
                        const newLabel = ev.target.value;
                        setEvents(prev => prev.map((item,idx) =>
                          idx===realIdx ? {...item, label:newLabel} : item
                        ));
                      }}
                      style={{fontSize:11,color:P.textMid,flex:1,minWidth:0,
                        background:"transparent",border:"1px solid transparent",
                        borderRadius:6,padding:"2px 4px",fontFamily:sans,outline:"none"}}
                      onFocus={ev=>ev.target.style.borderColor=P.teal}
                      onBlur={ev=>ev.target.style.borderColor="transparent"}/>
                    <button
                      onClick={()=>setEvents(prev=>prev.filter((_,idx)=>idx!==realIdx))}
                      style={{background:"transparent",border:`1px solid ${P.border}`,
                        borderRadius:6,padding:"2px 6px",cursor:"pointer",
                        color:P.textSoft,fontSize:11,fontFamily:sans,flexShrink:0,lineHeight:1.4}}
                      onPointerEnter={ev=>{ev.currentTarget.style.background=P.roseSoft;ev.currentTarget.style.color=P.roseText;ev.currentTarget.style.borderColor=P.rose;}}
                      onPointerLeave={ev=>{ev.currentTarget.style.background="transparent";ev.currentTarget.style.color=P.textSoft;ev.currentTarget.style.borderColor=P.border;}}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Contrôles */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:70}}>
          <button onClick={()=>setRunning(v=>!v)}
            style={{background:P.surface,border:`1.5px solid ${running?P.amber:P.green}`,
              borderRadius:11,padding:"10px 6px",color:running?P.amberText:P.greenText,
              fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:sans}}>
            {running?"⏸ Pause":"▶ Reprendre"}
          </button>
          <button onClick={onBack}
            style={{background:P.surface,border:`1.5px solid ${P.border}`,
              borderRadius:11,padding:"10px 6px",color:P.textSoft,
              fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:sans}}>← Retour</button>
        </div>
      </div>

      {/* ── Modal Sécurisation VAS — VLI Pédiatrique (choix supra-glottique / IOT) ── */}
      {modalVasVLIPed && (
        <Modal title="Sécurisation des voies aériennes" icon="🫁" soft={P.violetSoft} onClose={() => setModalVasVLIPed(false)}>
          <button onClick={() => setVasVLIInhalationPed(v => !v)}
            style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
              background: vasVLIInhalationPed ? P.amberSoft : P.surfaceAlt,
              border:`1.5px solid ${vasVLIInhalationPed ? P.amber : P.border}`, borderRadius:11,
              padding:"11px 13px", marginBottom:14, cursor:"pointer", fontFamily:sans, textAlign:"left" }}>
            <span style={{ fontSize:16, flexShrink:0 }}>{vasVLIInhalationPed ? "🟠" : "💧"}</span>
            <span style={{ flex:1, fontSize:12.5, fontWeight:700, color: vasVLIInhalationPed ? P.amberText : P.textMid }}>
              Inhalation objectivée (régurgitation/liquide gastrique)
            </span>
            <span style={{ width:20, height:20, borderRadius:6, flexShrink:0,
              border:`1.5px solid ${vasVLIInhalationPed ? P.amber : P.border}`,
              background: vasVLIInhalationPed ? P.amber : "transparent",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:"#fff" }}>
              {vasVLIInhalationPed && "✓"}
            </span>
          </button>
          <ChoiceBtn label="Dispositif supra-glottique" sub="Geste infirmier — protocole VLI"
            accent="#EA6A12" soft="rgba(234,106,18,0.12)" textC="#B24E0A"
            onClick={() => {
              addEvent("vas_supraglottique", `Dispositif supra-glottique posé${vasVLIInhalationPed ? " (inhalation objectivée)" : ""}`, "🫁");
              setVasVLIInhalationPed(false); setModalVasVLIPed(false);
            }} />
          <ChoiceBtn label="Intubation orotrachéale (IOT)" sub="Réservée à l'IADE"
            accent={P.violet} soft={P.violetSoft} textC={P.violetText}
            onClick={() => {
              addEvent("iot", `Intubation orotrachéale (IADE)${vasVLIInhalationPed ? " (inhalation objectivée)" : ""}`, "🫁");
              setVasVLIInhalationPed(false); setModalVasVLIPed(false);
            }} />
        </Modal>
      )}

      {/* ── Modal Certificat de décès — VLI Pédiatrique (sans OML uniquement + alerte suspicion) ── */}
      {/* Le certificat de décès n'existe pas en VLI pédiatrique — un IDE (ISP) n'a jamais l'autorité
          de constater un décès, avec ou sans OML. Ce cas relève uniquement du VLM après transition,
          ou de la régulation médicale (bouton "Régulation") en cas de doute avant son arrivée. */}
      {/* ── Modal confirmation transition VLM — VLI Pédiatrique ── */}
      {modalVliTransitionPed && (
        <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,0.55)",
          display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
          onClick={e => { if (e.target === e.currentTarget) setModalVliTransitionPed(false); }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:P.surface, borderRadius:18, padding:"22px 20px", maxWidth:340,
              boxShadow:"0 12px 40px rgba(0,0,0,0.3)" }}>
            <p style={{ margin:"0 0 10px", fontSize:16, fontWeight:800, color:P.text, fontFamily:disp }}>
              🚒 Confirmer l'arrivée du VLM
            </p>
            <p style={{ margin:"0 0 18px", fontSize:12.5, color:P.textMid, lineHeight:1.6 }}>
              Ceci débloque la <b>prise en charge médicale complète</b> (gestes et thérapeutiques
              hors du cadre du protocole VLI). Tout ce qui a déjà été saisi (patient, transmission,
              chocs, adrénaline...) reste intact — le médecin reprend exactement là où vous en êtes.
              <br /><br />
              <b>Action irréversible</b> — pas de retour au mode restreint ensuite.
            </p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <button onClick={() => setModalVliTransitionPed(false)}
                style={{ background:P.surfaceAlt, border:`1.5px solid ${P.border}`, borderRadius:11,
                  color:P.textMid, padding:"11px 0", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                Annuler
              </button>
              <button onClick={() => {
                addEvent("vli_transition", "🚒 VLM arrivée — passation de la prise en charge médicale", "🚒");
                setVliUnlockedPed(true);
                setModalVliTransitionPed(false);
              }} style={{ background:"linear-gradient(135deg,#EA6A12,#B24E0A)", border:"none", borderRadius:11,
                color:"#fff", padding:"11px 0", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                ✓ Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Dossier patient pédiatrique ── */}
      {modalPatPed && (
        <Modal title="Dossier patient" icon="🪪" soft={P.surfaceAlt} onClose={() => setModalPatPed(false)}>
          <div style={{ display:"grid", gap:10 }}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div><Lbl>Nom</Lbl><TInput value={patPed.nom} onChange={spf("nom")} placeholder="Dupont" /></div>
              <div><Lbl>Prénom</Lbl><TInput value={patPed.prenom} onChange={spf("prenom")} placeholder="Léa" /></div>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div>
                <Lbl>Date de naissance</Lbl>
                <TInput type="date" value={patPed.ddn} onChange={v => { spf("ddn")(v); spf("age")(calcAge(v)); }} />
                {patPed.ddn && calcAge(patPed.ddn) && (
                  <p style={{ margin:"4px 0 0", fontSize:11, color:P.amber, fontWeight:600 }}>→ {calcAge(patPed.ddn)}</p>
                )}
              </div>
              <div><Lbl>Poids</Lbl><TInput value={patPed.poids} onChange={spf("poids")} placeholder={`${localPoids} kg`} /></div>
            </div>
            <div><Lbl>Température (°C)</Lbl>
              <TInput value={patPed.temp} onChange={spf("temp")} placeholder="Ex : 35,2 — penser hypothermie / ECMO" /></div>
            <div><Lbl>Antécédents</Lbl>
              <TArea value={patPed.atcd} onChange={spf("atcd")} placeholder="Cardiopathie, allergie..." rows={2} /></div>
            <div><Lbl>Histoire de la maladie</Lbl>
              <TArea value={patPed.histoire} onChange={spf("histoire")} placeholder="Circonstances, témoins..." rows={2} /></div>
          </div>
          <button onClick={() => setModalPatPed(false)}
            style={{ width:"100%", background:P.text, border:"none", borderRadius:12,
              color:P.bg, fontSize:14, fontWeight:700, padding:"13px", cursor:"pointer",
              fontFamily:sans, marginTop:14 }}>
            ✓ Enregistrer
          </button>
        </Modal>
      )}

      {/* Modal Constat de décès pédiatrique */}
      {/* ── Modal ECMO pédiatrique ── */}
      <EcmoModal open={modalEcmoPed} onClose={() => setModalEcmoPed(false)}
        onConfirm={({ decision, verdict, note }) => {
          const msg = `ECMO ${decision} (${verdict})${note ? " — " + note : ""}`;
          addEvent("ecmo", msg, "🫀");
        }}
        P={P} mono={mono} sans={sans} Modal={Modal} Lbl={Lbl} TArea={TArea} isPediatrique={true} />

      {/* ── Modal Transmission équipes en place — pédiatrique ── */}
      {modalTransPed && (
        <Modal title="Transmission équipes en place"
          icon={<div style={{width:24,height:24,color:P.amber}}>{ICONS.transmission}</div>}
          soft={P.amberSoft} onClose={() => setModalTransPed(false)}>

          <p style={{margin:"0 0 14px",fontSize:12,color:P.textSoft,lineHeight:1.5}}>
            Recueil de ce qui a été fait avant l'arrivée SMUR (pompiers, témoins).
            <br/>Les heures saisies créeront des entrées horodatées dans la chronologie.
          </p>

          {/* Contexte */}
          <div style={{background:P.surfaceAlt,borderRadius:10,padding:"10px 12px",marginBottom:12}}>
            <p style={{margin:"0 0 8px",fontSize:10,fontWeight:600,color:P.textSoft,
              textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>Contexte</p>
            <Lbl>Lieu de l'intervention</Lbl>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,marginBottom:8}}>
              {LIEUX_INTERVENTION.map(l => (
                <button key={l.id} onClick={()=>stp("lieu")(transPed.lieu===l.id?"":l.id)}
                  style={{display:"flex",alignItems:"center",gap:5,padding:"7px 6px",
                    borderRadius:8,border:`1.5px solid ${transPed.lieu===l.id?P.amber:P.border}`,
                    background:transPed.lieu===l.id?P.amberSoft:P.surface,
                    color:transPed.lieu===l.id?P.amberText:P.textMid,
                    fontSize:11,fontWeight:transPed.lieu===l.id?700:500,
                    cursor:"pointer",fontFamily:sans,textAlign:"left",minWidth:0}}>
                  <span style={{fontSize:13,flexShrink:0}}>{l.icon}</span>
                  <span style={{minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.label}</span>
                </button>
              ))}
            </div>
            <Lbl>Témoin de l'effondrement</Lbl>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,marginBottom:8}}>
              {["Oui","Non","Inconnu"].map(v => (
                <button key={v} onClick={()=>stp("temoin")(v)}
                  style={{padding:"7px 4px",borderRadius:8,fontSize:11,fontWeight:600,
                    border:`1.5px solid ${transPed.temoin===v?P.amber:P.border}`,
                    background:transPed.temoin===v?P.amberSoft:P.surface,
                    color:transPed.temoin===v?P.amberText:P.textMid,
                    cursor:"pointer",fontFamily:sans}}>{v}</button>
              ))}
            </div>
            <Lbl>MCE par témoin / avant pompiers</Lbl>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5}}>
              {["Oui","Non","Inconnu"].map(v => (
                <button key={v} onClick={()=>stp("mceTemoin")(v)}
                  style={{padding:"7px 4px",borderRadius:8,fontSize:11,fontWeight:600,
                    border:`1.5px solid ${transPed.mceTemoin===v?P.amber:P.border}`,
                    background:transPed.mceTemoin===v?P.amberSoft:P.surface,
                    color:transPed.mceTemoin===v?P.amberText:P.textMid,
                    cursor:"pointer",fontFamily:sans}}>{v}</button>
              ))}
            </div>
          </div>

          {/* Prise en charge secouriste */}
          <div style={{background:P.surfaceAlt,borderRadius:10,padding:"10px 12px",marginBottom:12}}>
            <p style={{margin:"0 0 8px",fontSize:10,fontWeight:600,color:P.textSoft,
              textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>Prise en charge secouriste</p>
            <Lbl>Heure de l'ACR</Lbl>
            <input type="time" value={transPed.hEffondrement} onChange={e=>{stp("hEffondrement")(e.target.value);setLocalAcrTime(e.target.value);}}
              style={{width:"100%",background:P.surface,border:`1.5px solid ${P.border}`,
                borderRadius:8,padding:"8px 6px",fontSize:14,fontFamily:mono,
                color:P.text,outline:"none",textAlign:"center",boxSizing:"border-box",marginBottom:8}}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <Lbl>Arrivée pompiers</Lbl>
                <input type="time" value={transPed.hArriveePompiers} onChange={e=>stp("hArriveePompiers")(e.target.value)}
                  style={{width:"100%",background:P.surface,border:`1.5px solid ${P.border}`,
                    borderRadius:8,padding:"8px 6px",fontSize:14,fontFamily:mono,
                    color:P.text,outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
              </div>
              <div>
                <Lbl>Pose DSA</Lbl>
                <input type="time" value={transPed.hPoseDSA} onChange={e=>stp("hPoseDSA")(e.target.value)}
                  style={{width:"100%",background:P.surface,border:`1.5px solid ${P.border}`,
                    borderRadius:8,padding:"8px 6px",fontSize:14,fontFamily:mono,
                    color:P.text,outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
              </div>
            </div>
            <Lbl>Rythme initial DSA</Lbl>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,marginBottom:8}}>
              {[["choquable","Choquable"],["nonChoquable","Non choquable"],["nonAnalyse","Non analysé"]].map(([id,label])=>(
                <button key={id} onClick={()=>stp("rythmeDSA")(id)}
                  style={{padding:"7px 4px",borderRadius:8,fontSize:10,fontWeight:600,
                    border:`1.5px solid ${transPed.rythmeDSA===id?P.amber:P.border}`,
                    background:transPed.rythmeDSA===id?P.amberSoft:P.surface,
                    color:transPed.rythmeDSA===id?P.amberText:P.textMid,
                    cursor:"pointer",fontFamily:sans}}>{label}</button>
              ))}
            </div>
            <Lbl>Chocs délivrés avant le SMUR</Lbl>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:8}}>
              <div>
                <p style={{margin:"0 0 4px",fontSize:9.5,color:P.textSoft,textAlign:"center"}}>Pompiers</p>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  <button onClick={()=>stp("chocsPompiers")(Math.max(0,(parseInt(transPed.chocsPompiers)||0)-1))}
                    style={{background:P.surface,border:`1.5px solid ${P.amber}`,borderRadius:"50%",
                      width:32,height:32,fontSize:15,fontWeight:700,color:P.amberText,
                      cursor:"pointer",fontFamily:sans,flexShrink:0}}>−</button>
                  <span style={{fontSize:24,fontWeight:700,color:P.amberText,fontFamily:mono,minWidth:30,textAlign:"center"}}>
                    {transPed.chocsPompiers || 0}
                  </span>
                  <button onClick={()=>stp("chocsPompiers")((parseInt(transPed.chocsPompiers)||0)+1)}
                    style={{background:P.amber,border:"none",borderRadius:"50%",
                      width:32,height:32,fontSize:15,fontWeight:700,color:"#fff",
                      cursor:"pointer",fontFamily:sans,flexShrink:0}}>+</button>
                </div>
              </div>
              <div>
                <p style={{margin:"0 0 4px",fontSize:9.5,color:P.textSoft,textAlign:"center"}}>DSA public</p>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  <button onClick={()=>stp("chocsPublic")(Math.max(0,(parseInt(transPed.chocsPublic)||0)-1))}
                    style={{background:P.surface,border:`1.5px solid ${P.blue}`,borderRadius:"50%",
                      width:32,height:32,fontSize:15,fontWeight:700,color:P.blueText,
                      cursor:"pointer",fontFamily:sans,flexShrink:0}}>−</button>
                  <span style={{fontSize:24,fontWeight:700,color:P.blueText,fontFamily:mono,minWidth:30,textAlign:"center"}}>
                    {transPed.chocsPublic || 0}
                  </span>
                  <button onClick={()=>stp("chocsPublic")((parseInt(transPed.chocsPublic)||0)+1)}
                    style={{background:P.blue,border:"none",borderRadius:"50%",
                      width:32,height:32,fontSize:15,fontWeight:700,color:"#fff",
                      cursor:"pointer",fontFamily:sans,flexShrink:0}}>+</button>
                </div>
              </div>
            </div>
            <p style={{margin:"0 0 8px",fontSize:9.5,color:P.textSoft,textAlign:"center",fontStyle:"italic"}}>
              Les deux s'ajoutent aux chocs SMUR pour le rappel Amiodarone
            </p>
            <Lbl>Heure du 1er choc</Lbl>
            <input type="time" value={transPed.h1erChoc} onChange={e=>stp("h1erChoc")(e.target.value)}
              style={{width:"100%",background:P.surface,border:`1.5px solid ${P.border}`,
                borderRadius:8,padding:"8px 6px",fontSize:14,fontFamily:mono,
                color:P.text,outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
          </div>

          {/* Note libre */}
          <div style={{background:P.surfaceAlt,borderRadius:10,padding:"10px 12px"}}>
            <p style={{margin:"0 0 8px",fontSize:10,fontWeight:600,color:P.textSoft,
              textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>Note libre</p>
            <TArea value={transPed.note} onChange={stp("note")} rows={2}
              placeholder="Ex : noyade, étouffement, trouvé inconscient..." />
          </div>

          <button onClick={() => {
            const newEvents = [];
            if (transPed.hEffondrement) {
              const detail = [
                transPed.temoin === "Oui" ? "témoigné" : transPed.temoin === "Non" ? "non témoigné" : null,
                transPed.mceTemoin === "Oui" ? "MCE par témoin" : null,
              ].filter(Boolean).join(", ");
              newEvents.push({ id:"effondrement", time:transPed.hEffondrement, sec:0,
                label:`Heure de l'ACR${detail ? ` (${detail})` : ""}`, icon:"⏱️" });
            }
            if (transPed.hArriveePompiers)
              newEvents.push({ id:"pompiers", time:transPed.hArriveePompiers, sec:0,
                label:"Arrivée pompiers · début MCE secouriste", icon:"🚒" });
            if (transPed.hPoseDSA)
              newEvents.push({ id:"dsa", time:transPed.hPoseDSA, sec:0,
                label:`Pose DSA${transPed.rythmeDSA ? ` (${transPed.rythmeDSA === "choquable" ? "rythme choquable" : transPed.rythmeDSA === "nonChoquable" ? "non choquable" : "non analysé"})` : ""}`, icon:"⚡" });
            const nbChocs = parseInt(transPed.chocsPompiers) || 0;
            if (nbChocs > 0) {
              newEvents.push({ id:"chocs_pomp", time:transPed.h1erChoc || getNow(), sec:0,
                label:`${nbChocs} choc(s) DSA délivré(s) par pompiers`, icon:"⚡" });
            }
            const nbChocsPublic = parseInt(transPed.chocsPublic) || 0;
            if (nbChocsPublic > 0) {
              newEvents.push({ id:"chocs_public", time:transPed.h1erChoc || getNow(), sec:0,
                label:`${nbChocsPublic} choc(s) DSA délivré(s) par un DSA public`, icon:"⚡" });
            }
            if (transPed.note.trim())
              newEvents.push({ id:"trans_note", time:getNow(), sec:0,
                label:`Pré-SMUR : ${transPed.note.trim()}`, icon:"📝" });

            const sorted = [...events, ...newEvents].sort((a,b) => {
              const ta = a.time || "00:00", tb = b.time || "00:00";
              return ta.localeCompare(tb);
            });
            setEvents(sorted);
            stp("saved")(true);
            setModalTransPed(false);
          }} style={{width:"100%",background:`linear-gradient(135deg,${P.amber},#D97706)`,
            border:"none",borderRadius:12,color:"#fff",fontSize:14,fontWeight:600,
            padding:"14px",cursor:"pointer",fontFamily:sans,marginTop:14,
            boxShadow:`0 6px 18px color-mix(in srgb, ${P.amber} 20%, transparent)`}}>
            ✓ Enregistrer la transmission
          </button>
        </Modal>
      )}

      {/* ── Modal Constat de décès — pédiatrique ── */}
      {/* ── Modal Critères d'arrêt de réanimation — pédiatrique ── */}
      {modalCriteresPed && (
        <div style={{ position:"fixed", inset:0, zIndex:80, background:"rgba(0,0,0,0.55)",
          display:"flex", alignItems:"flex-end", fontFamily:sans }}
          onClick={e => { if(e.target===e.currentTarget) setModalCriteresPed(false); }}>
          <div style={{ width:"100%", background:P.bg, borderRadius:"20px 20px 0 0",
            padding:"20px 16px 32px", maxHeight:"92vh", overflowY:"auto",
            boxShadow:"0 -16px 50px rgba(0,0,0,0.3)" }}>

            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
              <div style={{ width:42, height:42, borderRadius:13,
                background:`linear-gradient(135deg, ${P.amber}, ${P.amberText})`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:22,
                boxShadow:`0 5px 14px color-mix(in srgb, ${P.amber} 35%, transparent)` }}>⏱</div>
              <div>
                <p style={{ margin:"0 0 1px", fontSize:9.5, fontWeight:700, color:P.amber,
                  textTransform:"uppercase", letterSpacing:"0.14em", fontFamily:mono }}>Évaluation après {Math.floor(sec/60)} min</p>
                <p style={{ margin:0, fontSize:18, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>
                  Critères d'arrêt — Pédiatrique
                </p>
              </div>
              <button onClick={() => setModalCriteresPed(false)}
                style={{ marginLeft:"auto", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:22, cursor:"pointer" }}>×</button>
            </div>

            <div style={{ background:P.blueSoft, borderRadius:10, padding:"10px 12px", marginBottom:14,
              border:`1px solid ${P.blue}` }}>
              <p style={{ margin:0, fontSize:11.5, color:P.blueText, lineHeight:1.5 }}>
                ℹ️ En pédiatrie, la réanimation est généralement poursuivie <b>plus longtemps</b> que chez l'adulte,
                notamment tant qu'une cause réversible n'a pas été formellement écartée.
              </p>
            </div>

            <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:18 }}>
              {[
                { icon:"🔍", text:"Cause réversible recherchée et traitée (hypoglycémie, intoxication, obstruction VAS, noyade, sepsis, mort inexpliquée du nourrisson) ?" },
                { icon:"📈", text:"EtCO₂ persistant très bas malgré MCE de qualité ?" },
                { icon:"⏱", text:"Durée ≥ 40 min sans signe de vie ni RACS ?" },
                { icon:"💊", text:"Tous les traitements administrés (adrénaline, amiodarone si FV/TV) ?" },
                { icon:"🌡️", text:"Hypothermie exclue comme cause réversible (noyade, exposition) ?" },
                { icon:"🤝", text:"Décision collégiale d'équipe ?" },
                { icon:"👨‍👩‍👧", text:"Famille présente / accompagnée ? Annonce préparée avec l'équipe ?" },
              ].map((c, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:10,
                  background:P.surfaceAlt, borderRadius:11, padding:"10px 12px",
                  border:`1px solid ${P.border}` }}>
                  <span style={{ fontSize:18, flexShrink:0 }}>{c.icon}</span>
                  <p style={{ margin:0, fontSize:13, color:P.text, lineHeight:1.4 }}>{c.text}</p>
                </div>
              ))}
            </div>

            <div style={{ background:P.amberSoft, borderRadius:10, padding:"10px 12px", marginBottom:16,
              border:`1px solid ${P.amber}` }}>
              <p style={{ margin:0, fontSize:11.5, color:P.amberText, lineHeight:1.5 }}>
                ℹ️ Cette check-list est un <b>aide-mémoire non bloquant</b>.
                Chaque médecin demeure seul responsable de la décision d'arrêt,
                selon le contexte clinique global. Si mort inattendue du nourrisson suspectée
                (&lt; 2 ans, sans signe de violence), le protocole MIN s'applique — voir le
                constat de décès dédié.
              </p>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <button onClick={() => {
                addEvent("arret_decision", `Décision d'arrêt de réanimation après ${Math.floor(sec/60)} min`, "🕊️");
                setModalCriteresPed(false);
              }} style={{ background:`linear-gradient(135deg, ${P.slateText}, #374151)`,
                border:"none", borderRadius:13, color:"#fff", fontSize:13, fontWeight:800,
                fontFamily:disp, padding:"14px 10px", cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center", gap:7 }}>
                🕊️ Arrêt décidé
              </button>
              <button onClick={() => setModalCriteresPed(false)}
                style={{ background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:13,
                  color:P.textMid, fontSize:13, fontWeight:700, fontFamily:sans,
                  padding:"14px 10px", cursor:"pointer" }}>
                Poursuivre
              </button>
            </div>
          </div>
        </div>
      )}

      {modalDecesPed && (
        <Modal title="Constat de décès" icon="🕊️" soft={P.slateSoft}
          onClose={() => { setModalDecesPed(false); setOmlStepPed(0); setOmlTxtPed(""); setDecesRemisAPed("");
            setMinPositionPed(""); setMinContextePed(""); }}>
          {omlStepPed === 0 ? (
            <>
              <ChoiceBtn label="Mort inattendue du nourrisson (MIN)" sub="< 2 ans, sans signe de violence évident — protocole national dédié"
                accent={P.violet} soft={P.violetSoft} textC={P.violetText}
                onClick={() => setOmlStepPed(3)} />
              <ChoiceBtn label="Avec OML" sub="Obstacle médico-légal — signalement nécessaire"
                accent={P.rose} soft={P.roseSoft} textC={P.roseText}
                onClick={() => setOmlStepPed(1)} />
              <ChoiceBtn label="Sans OML" sub="Pas d'obstacle médico-légal"
                accent={P.slate} soft={P.slateSoft} textC={P.slateText}
                onClick={() => setOmlStepPed(2)} />
            </>
          ) : omlStepPed === 3 ? (
            <>
              <p style={{ margin:"0 0 10px", fontSize:12.5, fontWeight:600, color:P.text }}>
                🕊️ Mort inattendue du nourrisson (MIN)
              </p>
              <div style={{ background:P.violetSoft, border:`1px solid ${P.violet}`, borderRadius:10,
                padding:"11px 13px", marginBottom:14 }}>
                <p style={{ margin:"0 0 6px", fontSize:11.5, color:P.violetText, lineHeight:1.55 }}>
                  📋 <b>Protocole national (HAS/DGOS)</b> — en l'absence de signes de violence
                  évidents (obstacle médico-légal), le corps doit être <b>transporté avec les
                  parents</b> (s'ils sont présents) vers le <b>Centre de Référence MIN (CRMIN)</b>
                  le plus proche : pas d'inhumation ni de constat classique sur place.
                </p>
                <p style={{ margin:0, fontSize:11.5, color:P.violetText, lineHeight:1.55 }}>
                  ☎️ Contacter le CRMIN régional (ou le SAMU pour coordination) avant le transport.
                </p>
              </div>

              <div style={{ background:P.amberSoft, border:`1px solid ${P.amber}`, borderRadius:10,
                padding:"10px 12px", marginBottom:14 }}>
                <p style={{ margin:"0 0 6px", fontSize:11, fontWeight:700, color:P.amberText,
                  textTransform:"uppercase", letterSpacing:"0.06em", fontFamily:mono }}>
                  À préserver pour l'enquête du CRMIN
                </p>
                <p style={{ margin:0, fontSize:11.5, color:P.amberText, lineHeight:1.6 }}>
                  Ne pas laver ni changer l'enfant · ne pas modifier la literie/l'environnement
                  de couchage si possible · noter la position exacte dans laquelle l'enfant a
                  été trouvé.
                </p>
              </div>

              <Lbl>Position et environnement de découverte</Lbl>
              <TArea value={minPositionPed} onChange={setMinPositionPed} rows={2}
                placeholder="Ex : décubitus ventral, dans son lit, literie molle..." />

              <div style={{ marginTop:10 }}>
                <Lbl>Contexte / antécédents</Lbl>
                <TArea value={minContextePed} onChange={setMinContextePed} rows={2}
                  placeholder="Ex : dernier repas, maladie récente, antécédents familiaux..." />
              </div>

              <button onClick={() => {
                const parts = [
                  minPositionPed.trim() && `Position/découverte : ${minPositionPed.trim()}`,
                  minContextePed.trim() && `Contexte : ${minContextePed.trim()}`,
                ].filter(Boolean).join(" — ");
                addEvent("min_nourrisson", `Mort inattendue du nourrisson (MIN) — transport organisé vers CRMIN${parts ? " · " + parts : ""}`, "🕊️");
                setModalDecesPed(false); setOmlStepPed(0); setMinPositionPed(""); setMinContextePed("");
              }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.violet}, #4A2494)`,
                border:"none", borderRadius:11, color:"#fff", fontSize:14, fontWeight:700,
                fontFamily:disp, padding:"13px", cursor:"pointer", marginTop:14, marginBottom:8 }}>
                ✓ Confirmer — transport vers CRMIN
              </button>
              <button onClick={() => setOmlStepPed(0)}
                style={{ width:"100%", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:12, cursor:"pointer", fontFamily:sans, padding:"6px" }}>
                ← Retour
              </button>
            </>
          ) : omlStepPed === 2 ? (
            <>
              <p style={{ margin:"0 0 10px", fontSize:12.5, fontWeight:600, color:P.text }}>
                🕊️ Constat de décès — sans OML
              </p>
              <p style={{ margin:"0 0 8px", fontSize:12, color:P.textSoft }}>Certificat remis à (optionnel) :</p>
              <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                <input value={decesRemisAPed} onChange={e => setDecesRemisAPed(e.target.value)}
                  placeholder="Ex : famille, pompiers, gendarmerie..."
                  style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                    borderRadius:9, padding:"10px 12px", fontSize:14, color:P.text,
                    fontFamily:sans, outline:"none", boxSizing:"border-box" }}
                  onFocus={e => e.target.style.borderColor = P.slate}
                  onBlur={e  => e.target.style.borderColor = P.border} />
              </div>
              <button onClick={() => {
                const remis = decesRemisAPed.trim();
                addEvent("deces", remis
                  ? `Constat de décès — sans OML · Certificat remis à : ${remis}`
                  : "Constat de décès — sans OML", "🕊️");
                setModalDecesPed(false); setOmlStepPed(0); setDecesRemisAPed("");
              }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.slate}, #374151)`,
                border:"none", borderRadius:11, color:"#fff", fontSize:14, fontWeight:700,
                fontFamily:disp, padding:"13px", cursor:"pointer", marginBottom:8 }}>
                ✓ Confirmer le constat
              </button>
              <button onClick={() => setOmlStepPed(0)}
                style={{ width:"100%", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:12, cursor:"pointer", fontFamily:sans, padding:"6px" }}>
                ← Retour
              </button>
            </>
          ) : (
            <>
              <p style={{ margin:"0 0 12px", fontSize:12, color:P.textSoft }}>
                Autorité contactée pour l'OML :
              </p>
              {[
                { label:"Gendarmerie", sub:"Gendarmerie nationale" },
                { label:"Police",      sub:"Police nationale" },
                { label:"OPJ",         sub:"Officier de police judiciaire" },
              ].map(c => (
                <ChoiceBtn key={c.label} label={c.label} sub={c.sub}
                  accent={P.rose} soft={P.roseSoft} textC={P.roseText}
                  onClick={() => {
                    addEvent("deces", `Constat de décès — avec OML, remis à : ${c.label}`, "🕊️");
                    setModalDecesPed(false); setOmlStepPed(0); setOmlTxtPed("");
                  }} />
              ))}
              <div style={{ marginTop:6 }}>
                <Lbl>Autre / préciser</Lbl>
                <div style={{ display:"flex", gap:8 }}>
                  <input value={omlTxtPed} onChange={e => setOmlTxtPed(e.target.value)}
                    placeholder="Ex : parquet contacté..."
                    style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                      borderRadius:9, padding:"10px 12px", fontSize:14, color:P.text,
                      fontFamily:sans, outline:"none", boxSizing:"border-box" }}
                    onFocus={e => e.target.style.borderColor = P.rose}
                    onBlur={e  => e.target.style.borderColor = P.border} />
                  <button onClick={() => {
                    addEvent("deces", `Constat de décès — avec OML, remis à : ${omlTxtPed.trim() || "autre"}`, "🕊️");
                    setModalDecesPed(false); setOmlStepPed(0); setOmlTxtPed("");
                  }} style={{ background:P.rose, border:"none", borderRadius:9,
                    color:"#fff", padding:"10px 14px", fontSize:13, fontWeight:600,
                    cursor:"pointer", fontFamily:sans, flexShrink:0 }}>✓</button>
                </div>
              </div>
              <button onClick={() => setOmlStepPed(0)}
                style={{ width:"100%", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:12, cursor:"pointer", fontFamily:sans,
                  marginTop:12, padding:"6px" }}>← Retour</button>
            </>
          )}
        </Modal>
      )}

      {/* ── Flash Analyse de rythme pédiatrique ── */}
      {showRythmFlashPed && (
        <div style={{ position:"fixed", inset:0, zIndex:95,
          background:"rgba(8,15,35,0.88)", display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center", fontFamily:sans,
          backdropFilter:"blur(8px)" }}>
          <style>{`@keyframes rythmPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.08);opacity:0.85}}`}</style>
          <div style={{ textAlign:"center", marginBottom:28 }}>
            <div style={{ width:68, height:68, borderRadius:20, margin:"0 auto 14px",
              background:"linear-gradient(135deg,#E53E3E,#9B2C2C)",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:34, animation:"rythmPulse 1.2s ease-in-out infinite",
              boxShadow:"0 0 40px rgba(229,62,62,0.5)" }}>⚡</div>
            <p style={{ margin:"0 0 4px", fontSize:10, fontWeight:800, color:"#FC8181",
              textTransform:"uppercase", letterSpacing:"0.2em", fontFamily:mono }}>Fin de cycle — 2 min</p>
            <p style={{ margin:"0 0 6px", fontSize:24, fontWeight:900, color:"#FFF", fontFamily:disp }}>
              Analyse de rythme
            </p>
            <p style={{ margin:0, fontSize:13, color:"rgba(255,255,255,0.6)" }}>
              Pause compressions · Identifier le rythme
            </p>
          </div>
          <div style={{ width:"100%", maxWidth:340, padding:"0 20px", display:"flex", flexDirection:"column", gap:10 }}>
            {[
              { id:"rv_fvtv", label:"FV / TV", sub:"Rythme choquable → Défibrillation", icon:"⚡",
                bg:"linear-gradient(135deg,#E53E3E,#9B2C2C)", shadow:"rgba(229,62,62,0.4)" },
              { id:"rv_aesp", label:"AESP", sub:"Activité électrique sans pouls → Continuer", icon:"💔",
                bg:"rgba(255,255,255,0.08)", shadow:"none" },
              { id:"rv_asy", label:"Asystolie", sub:"Tracé plat → Continuer", icon:"📉",
                bg:"rgba(255,255,255,0.08)", shadow:"none" },
              { id:"rosc", label:"RACS", sub:"Retour à une circulation spontanée", icon:"💚",
                bg:"linear-gradient(135deg,#276749,#1C4532)", shadow:"rgba(39,103,73,0.4)" },
            ].map(r => (
              <button key={r.id} onClick={() => {
                addEvent(r.id, `Rythme : ${r.label}`, r.icon);
                setShowRythmFlashPed(false);
              }} style={{ background:r.bg, border:`1.5px solid rgba(255,255,255,0.15)`,
                borderRadius:14, padding:"14px 16px", cursor:"pointer", fontFamily:disp,
                display:"flex", alignItems:"center", gap:12, color:"#fff",
                boxShadow: r.shadow!=="none" ? `0 6px 18px ${r.shadow}` : "none" }}>
                <span style={{ fontSize:22 }}>{r.icon}</span>
                <div style={{ textAlign:"left" }}>
                  <p style={{ margin:0, fontSize:16, fontWeight:800 }}>{r.label}</p>
                  <p style={{ margin:0, fontSize:10.5, opacity:0.75 }}>{r.sub}</p>
                </div>
              </button>
            ))}
            <button onClick={() => setShowRythmFlashPed(false)}
              style={{ background:"transparent", border:"none", color:"rgba(255,255,255,0.4)",
                fontSize:12, padding:"8px", cursor:"pointer", fontFamily:sans }}>
              ✕ Fermer sans enregistrer
            </button>
          </div>
        </div>
      )}

      {/* ── Débrief post-arrêt pédiatrique ── */}
      {debriefPedRender}

      {/* ── Mode équipe pédiatrique ── */}
      {teamModalPed}

      {/* ── Toast Undo pédiatrique ── */}
      {undoToastPed && (
        <div key={undoToastPed.key}
          style={{ position:"fixed", bottom:80, left:"50%", zIndex:96,
            transform:"translateX(-50%)", maxWidth:"90%",
            background:P.surface, border:`1.5px solid ${P.amber}`, borderRadius:14,
            padding:"10px 12px", display:"flex", alignItems:"center", gap:10,
            boxShadow:`0 8px 26px rgba(0,0,0,0.18)`, fontFamily:sans }}>
          <span style={{ fontSize:17 }}>↩</span>
          <div style={{ minWidth:0, flex:1 }}>
            <p style={{ margin:0, fontSize:10, fontWeight:700, color:P.amberText,
              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Annulé</p>
            <p style={{ margin:0, fontSize:12, fontWeight:600, color:P.text,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{undoToastPed.label}</p>
          </div>
          <button onClick={restoreEventPed}
            style={{ background:P.amber, border:"none", borderRadius:9,
              padding:"7px 12px", cursor:"pointer", fontSize:12, fontWeight:700,
              color:"#fff", fontFamily:sans, whiteSpace:"nowrap", flexShrink:0 }}>
            Restaurer
          </button>
          <button onClick={() => setUndoToastPed(null)}
            style={{ background:"transparent", border:"none", color:P.textSoft,
              fontSize:18, cursor:"pointer", lineHeight:1, padding:"0 2px" }}>×</button>
        </div>
      )}

      {/* ── Toast de confirmation d'ajout à la chronologie ── */}
      {confirmAdd && (
        <div key={confirmAdd.key}
          style={{ position:"fixed", bottom:70, left:"50%", zIndex:95,
            transform:"translateX(-50%)", maxWidth:"86%",
            background:`linear-gradient(135deg, ${P.green}, ${P.greenText})`,
            color:"#fff", borderRadius:13, padding:"11px 16px",
            display:"flex", alignItems:"center", gap:10, pointerEvents:"none",
            boxShadow:`0 8px 26px color-mix(in srgb, ${P.green} 50%, transparent)`,
            animation:"acrConfirmIn 1.5s ease forwards", fontFamily:sans }}>
          <span style={{ width:24, height:24, borderRadius:"50%", background:"rgba(255,255,255,0.25)",
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:900, flexShrink:0 }}>✓</span>
          <div style={{ minWidth:0 }}>
            <p style={{ margin:0, fontSize:10, fontWeight:700, opacity:0.85, letterSpacing:"0.05em", textTransform:"uppercase", fontFamily:mono }}>Ajouté à la chronologie</p>
            <p style={{ margin:0, fontSize:13, fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{confirmAdd.label}</p>
          </div>
        </div>
      )}

      {/* Le bouton micro et son retour visuel vivent maintenant dans le header (compact) et
          le bandeau fixe en haut de l'écran — voir plus haut, avant "Header". */}

      {/* Bandeau fixe compte-rendu */}
      <div style={{position:"fixed",bottom:0,left:0,right:0,zIndex:30,
        background:P.surface,borderTop:`1px solid ${P.border}`,
        padding:"7px 14px 10px",boxShadow:"0 -4px 16px rgba(0,0,0,0.08)"}}>
        {metronomeEnabled && (
          <button onClick={() => setMetronomeMutedPed(v => !v)}
            style={{ width:"100%", marginBottom:8,
              background: metronomeMutedPed ? P.surfaceAlt : `color-mix(in srgb, ${P.blue} 12%, ${P.surface})`,
              border:`1px solid ${metronomeMutedPed ? P.border : P.blue}`, borderRadius:11,
              padding:"8px", cursor:"pointer", fontFamily:sans, fontSize:11, fontWeight:600,
              color: metronomeMutedPed ? P.textSoft : P.blueText,
              display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
            {metronomeMutedPed ? "🔇 Métronome silencieux — Activer" : "🎵 Métronome 100/min — Couper le son"}
          </button>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8}}>
          <button onClick={() => setShowPdf(true)}
            style={{width:"100%",background:"linear-gradient(135deg,#3B82C4,#2563A8)",border:"none",
              borderRadius:11,color:"#fff",fontSize:13,fontWeight:600,padding:"11px",
              cursor:"pointer",fontFamily:sans,display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
            📄 Compte-rendu
          </button>
          <button onClick={cloturerEtArchiver}
            style={{background:P.surfaceAlt,border:`1px solid ${P.border}`,
              borderRadius:11,color:P.textMid,fontSize:12,fontWeight:600,padding:"11px 14px",
              cursor:"pointer",fontFamily:sans,whiteSpace:"nowrap"}}>
            ✓ Clôturer
          </button>
        </div>
      </div>

      {/* PDF pédiatrique */}
      {showPdf && (
        <PdfView
          patient={{
            nom:     patPed.nom,
            prenom:  patPed.prenom,
            ddn:     patPed.ddn,
            age:     patPed.age || calcAge(patPed.ddn) || localRow?.age || "",
            sexe:    "",
            temp:    patPed.temp,
            atcd:    patPed.atcd,
            histoire:patPed.histoire,
          }}
          noFlow={noFlowMin}
          lowFlow={lowFlowMin}
          acrTime={localAcrTime}
          iot={{ cormack:"", sonde:localMat?.sondeAvecBallonnet||"", repere:localMat?.repereLab||"", capno:"" }}
          events={events}
          totalSec={sec}
          trans={transPed}
          hemocue={[]}
          hemo={hemoListPed} amines={amineListPed}
          etco2={etco2ListPed}
          onClose={() => setShowPdf(false)}
        />
      )}
    </div>
  );
}

function ModulePediatrique({ onBack, theme, setTheme, isVLI = false }) {
  const [acrTime,  setAcrTime]  = useState("");
  const [mode,     setMode]     = useState("poids"); // "poids" | "age"
  const [idx,      setIdx]      = useState(0);
  const [showRcp,  setShowRcp]  = useState(false);
  const [pedDiluEnabled] = useLocalState("acr_ped_dilu_enabled", false);
  const [pedDiluMode]    = useLocalState("acr_ped_dilu_mode", "2");

  // Mode équipe — préparation AVANT le début de la réanimation (connecter les
  // téléphones pendant que l'équipe s'installe). Session "à vide" côté données
  // (rien à synchroniser tant que la réa n'a pas commencé) ; le code de session
  // est transmis à RcpPediatrique au démarrage pour poursuivre la MÊME session
  // sans que l'équipe ait à se reconnecter.
  const [prepEvents, setPrepEvents] = useState([]);
  const [prepTrans,  setPrepTrans]  = useState({});
  const teamPrep = useTeamSync({ events: prepEvents, setEvents: setPrepEvents,
    acrTime, setAcrTime, noFlowMin: "", setNoFlowMin: () => {},
    lowFlowMin: "", setLowFlowMin: () => {}, trans: prepTrans, setTrans: setPrepTrans });
  const [modalTeamPrep, setModalTeamPrep] = useState(false);
  const [teamJoinCodePrep, setTeamJoinCodePrep] = useState("");
  const [teamJoinErrorPrep, setTeamJoinErrorPrep] = useState("");

  const row   = PED_TABLE[idx];
  const poids = row.p;
  const mat   = calcMateriel(poids);
  const liste = mode === "poids" ? POIDS_LISTE : AGE_LISTE;
  const label = mode === "poids" ? `${poids} kg` : row.age;
  const sub   = mode === "poids" ? `≈ ${row.age}` : `≈ ${poids} kg`;

  if (showRcp) return (
    <RcpPediatrique onBack={() => setShowRcp(false)} onHome={onBack} acrTime={acrTime} poids={poids} mat={mat} theme={theme} setTheme={setTheme}
      initialTeamCode={teamPrep.teamConnected ? teamPrep.teamCode : ""} isVLI={isVLI} />
  );

  const MatRow = ({ label, value, color }) => (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
      padding:"8px 0", borderBottom:`1px solid ${P.borderSoft}`, gap:8 }}>
      <p style={{ margin:0, fontSize:12, color:P.textMid, flex:1, minWidth:0 }}>{label}</p>
      <span style={{ fontSize:15, fontWeight:700, color: color||P.text, fontFamily:mono, flexShrink:0 }}>{value}</span>
    </div>
  );

  return (
    <div style={{ background:P.bg, minHeight:"100vh", fontFamily:sans,
      paddingBottom:40, overflowX:"hidden", boxSizing:"border-box" }}>

      {/* Header */}
      <div style={{ background:P.surface, borderBottom:`1px solid ${P.border}`, padding:"14px 14px",
        display:"flex", alignItems:"center", gap:10, boxShadow:"0 2px 10px rgba(0,0,0,0.04)",
        position:"sticky", top:0, zIndex:10 }}>
        <button onClick={onBack}
          style={{ background:"transparent", border:"none", color:P.textMid,
            fontSize:22, cursor:"pointer", padding:"0 4px", lineHeight:1, flexShrink:0 }}>‹</button>
        <div style={{ width:38, height:38, borderRadius:11, background:P.amberSoft, flexShrink:0,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>👶</div>
        <div style={{ minWidth:0 }}>
          <p style={{ margin:0, fontSize:15, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>ACR Pédiatrique</p>
          <p style={{ margin:0, fontSize:9.5, color:P.textSoft, textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Nourrisson · Enfant · Adolescent</p>
        </div>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8 }}>
          <button onClick={() => setModalTeamPrep(true)}
            style={{ background: teamPrep.teamConnected ? P.greenSoft : P.surfaceAlt,
              border:`1px solid ${teamPrep.teamConnected ? P.green : P.border}`, borderRadius:10,
              padding:"6px 9px", cursor:"pointer", fontFamily:sans, display:"flex",
              alignItems:"center", gap:5, flexShrink:0 }}>
            <span style={{ fontSize:13 }}>{teamPrep.syncStatus === "error" ? "🔴" : teamPrep.syncStatus === "syncing" ? "🟡" : teamPrep.teamConnected ? "🟢" : "👥"}</span>
            <span style={{ fontSize:10.5, fontWeight:700, color: teamPrep.teamConnected ? P.greenText : P.textMid }}>
              {teamPrep.teamConnected ? `${teamPrep.teamCode} · ${teamPrep.teamDeviceCount}` : "Équipe"}
            </span>
          </button>
          <ThemeToggle theme={theme} setTheme={setTheme} compact />
        </div>
      </div>

      {modalTeamPrep && (
        <Modal title="Mode équipe" icon="👥" soft={P.surfaceAlt} onClose={() => setModalTeamPrep(false)}>
          <p style={{ margin:"0 0 16px", fontSize:12, color:P.textSoft, lineHeight:1.5 }}>
            Connectez les téléphones de l'équipe maintenant — la session se poursuivra
            automatiquement dès le début de la réanimation médicalisée.
          </p>
          {!teamPrep.teamConnected ? (
            <>
              <button onClick={async () => {
                  if (!navigator.onLine) { setTeamJoinErrorPrep("🚫 Pas de connexion internet — le mode équipe nécessite un réseau"); return; }
                  setTeamJoinErrorPrep("");
                  try { await teamPrep.startSession(); }
                  catch { setTeamJoinErrorPrep("Impossible de créer la session — vérifiez la connexion"); }
                }}
                style={{ width:"100%", background:`linear-gradient(135deg,${P.blue},${P.blueText})`,
                  border:"none", borderRadius:13, color:"#fff", fontSize:14, fontWeight:700,
                  padding:"14px", cursor:"pointer", fontFamily:sans, marginBottom:16,
                  boxShadow:`0 5px 16px color-mix(in srgb, ${P.blue} 30%, transparent)` }}>
                + Créer une session d'équipe
              </button>
              {teamJoinErrorPrep && (
                <p style={{ margin:"-10px 0 16px", fontSize:11.5, color:P.roseText, textAlign:"center" }}>{teamJoinErrorPrep}</p>
              )}
              <div style={{ borderTop:`1px solid ${P.borderSoft}`, margin:"4px 0 16px" }} />
              <Lbl>Rejoindre avec un code (6 caractères)</Lbl>
              <div style={{ display:"flex", gap:8 }}>
                <input value={teamJoinCodePrep}
                  onChange={e => { setTeamJoinCodePrep(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6)); setTeamJoinErrorPrep(""); }}
                  placeholder="X7K4M2"
                  style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                    borderRadius:10, padding:"12px", fontSize:20, color:P.text, fontFamily:mono,
                    textAlign:"center", fontWeight:700, letterSpacing:"0.1em", outline:"none",
                    textTransform:"uppercase" }}
                  onFocus={e => e.target.style.borderColor = P.blue}
                  onBlur={e  => e.target.style.borderColor = P.border} />
                <button onClick={async () => {
                  if (teamJoinCodePrep.length !== 6) { setTeamJoinErrorPrep("Code à 6 caractères"); return; }
                  const r = await teamPrep.joinSession(teamJoinCodePrep);
                  if (!r.ok) setTeamJoinErrorPrep(r.error); else setModalTeamPrep(false);
                }} style={{ background:P.blue, border:"none", borderRadius:10, color:"#fff",
                  padding:"0 18px", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                  Rejoindre
                </button>
              </div>
              {teamJoinErrorPrep && <p style={{ margin:"8px 0 0", fontSize:12, color:P.roseText }}>{teamJoinErrorPrep}</p>}
            </>
          ) : (
            <>
              <div style={{ textAlign:"center", marginBottom:16 }}>
                <p style={{ margin:"0 0 6px", fontSize:10, fontWeight:700, color:P.textSoft,
                  textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Code de session</p>
                <p style={{ margin:"0 0 14px", fontSize:38, fontWeight:900, color:P.text,
                  fontFamily:mono, letterSpacing:"0.1em" }}>{teamPrep.teamCode}</p>
                <img src={qrUrl(teamPrep.teamCode)} alt="QR code session"
                  style={{ width:180, height:180, borderRadius:12, border:`1px solid ${P.border}` }} />
                <p style={{ margin:"10px 0 0", fontSize:12, color:P.greenText, fontWeight:700 }}>
                  🟢 {teamPrep.teamDeviceCount} appareil(s) connecté(s)
                </p>
                <p style={{ margin:"4px 0 0", fontSize:10.5,
                  color: teamPrep.syncStatus === "error" ? P.roseText : P.textSoft }}>
                  {teamPrep.syncStatus === "error" ? "⚠️ Échec de synchronisation — nouvelle tentative au prochain geste"
                    : teamPrep.syncStatus === "syncing" ? "🟡 Synchronisation en cours…"
                    : teamPrep.lastSyncedAt ? `Synchronisé ${fmtSyncAge(teamPrep.lastSyncedAt)}` : "En attente de données…"}
                </p>
              </div>
              <button onClick={() => { teamPrep.disconnect(); setModalTeamPrep(false); }}
                style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                  borderRadius:12, color:P.textMid, fontSize:13, fontWeight:600,
                  padding:"12px", cursor:"pointer", fontFamily:sans }}>
                Quitter la session
              </button>
            </>
          )}
        </Modal>
      )}

      <div style={{ padding:"12px 12px 0", boxSizing:"border-box", width:"100%" }}>

        {/* Heure ACR */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:12,
          padding:"12px 14px", marginBottom:10 }}>
          <p style={{ margin:"0 0 8px", fontSize:9, fontWeight:500, color:P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:mono, textAlign:"center" }}>
            Heure de l'arrêt cardiaque
          </p>
          <div style={{ display:"flex", justifyContent:"center" }}>
            <input type="time" value={acrTime} onChange={e => setAcrTime(e.target.value)}
              style={{ background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:10, color:P.text, fontSize:24, padding:"8px 16px",
                fontFamily:mono, textAlign:"center", fontWeight:700, outline:"none", boxSizing:"border-box" }}
              onFocus={e => e.target.style.borderColor = P.amber}
              onBlur={e  => e.target.style.borderColor = P.border} />
          </div>
          <p style={{ margin:"4px 0 0", fontSize:10, color:P.textSoft, textAlign:"center" }}>Laisser vide si inconnue</p>
        </div>

        {/* Sélecteur âge / poids */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:12,
          padding:"12px 14px", marginBottom:10 }}>

          {/* Toggle mode */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5,
            background:P.surfaceAlt, borderRadius:10, padding:4, marginBottom:14 }}>
            {["poids","age"].map(m => (
              <button key={m} onClick={() => setMode(m)}
                style={{ padding:"8px 4px", borderRadius:8, border:"none",
                  background: mode===m ? P.amber : "transparent",
                  color: mode===m ? "#fff" : P.textMid,
                  fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:sans,
                  boxShadow: mode===m ? "0 2px 6px rgba(200,148,53,0.3)" : "none",
                  transition:"all 0.15s" }}>
                {m === "poids" ? "⚖️ Par poids" : "🎂 Par âge"}
              </button>
            ))}
          </div>

          {/* Valeur affichée */}
          <div style={{ textAlign:"center", marginBottom:14 }}>
            <span style={{ fontSize:44, fontWeight:700, color:P.amber, fontFamily:mono, lineHeight:1 }}>
              {label}
            </span>
            <p style={{ margin:"4px 0 0", fontSize:13, color:P.textSoft }}>{sub}</p>
          </div>

          {/* Boutons − + et chips */}
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <button onClick={() => setIdx(i => Math.max(0, i-1))} disabled={idx===0}
              style={{ width:52, height:52, borderRadius:12, fontSize:24, fontWeight:700,
                border:`1.5px solid ${P.border}`, background: idx===0 ? P.surfaceAlt : P.surface,
                color: idx===0 ? P.textSoft : P.text, cursor: idx===0?"not-allowed":"pointer",
                flexShrink:0, fontFamily:mono }}>−</button>

            <div style={{ flex:1, background:P.amberSoft, borderRadius:10, padding:"8px",
              minWidth:0 }}>
              <p style={{ margin:"0 0 5px", fontSize:8, color:P.amberText, fontFamily:mono,
                textTransform:"uppercase", letterSpacing:"0.08em", textAlign:"center" }}>
                {mode === "poids" ? "Poids (kg)" : "Âge"}
              </p>
              <div style={{ display:"flex", flexWrap:"wrap", gap:3, justifyContent:"center" }}>
                {liste.map((v, i) => (
                  <button key={i} onClick={() => setIdx(i)}
                    style={{ padding:"3px 7px", borderRadius:7, fontSize:10, fontWeight:600,
                      border:`1.5px solid ${i===idx ? P.amber : "transparent"}`,
                      background: i===idx ? P.amber : "transparent",
                      color: i===idx ? "#fff" : P.amberText,
                      cursor:"pointer", fontFamily:mono, lineHeight:1.4 }}>
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={() => setIdx(i => Math.min(PED_TABLE.length-1, i+1))}
              disabled={idx===PED_TABLE.length-1}
              style={{ width:52, height:52, borderRadius:12, fontSize:24, fontWeight:700,
                border:`1.5px solid ${P.border}`,
                background: idx===PED_TABLE.length-1 ? P.surfaceAlt : P.surface,
                color: idx===PED_TABLE.length-1 ? P.textSoft : P.text,
                cursor: idx===PED_TABLE.length-1?"not-allowed":"pointer",
                flexShrink:0, fontFamily:mono }}>+</button>
          </div>
        </div>

        {/* Résultats matériel */}
        {mat && (<>

          {/* ── DISCLAIMER RENFORCÉ — doses pédiatriques ── */}
          <div style={{ background:P.roseSoft, border:`1.5px solid ${P.rose}`, borderRadius:12,
            padding:"11px 13px", marginBottom:12, display:"flex", gap:9, alignItems:"flex-start" }}>
            <span style={{ fontSize:18, flexShrink:0, lineHeight:1.2 }}>⚠️</span>
            <div>
              <p style={{ margin:"0 0 3px", fontSize:11.5, fontWeight:700, color:P.roseText, lineHeight:1.4 }}>
                Doses et tailles à vérifier systématiquement
              </p>
              <p style={{ margin:0, fontSize:10.5, color:P.roseText, lineHeight:1.5 }}>
                Outil d'aide cognitive — il ne remplace pas le contrôle indépendant.
                Toute posologie et tout matériel doivent être recalculés et confirmés
                par le praticien avant administration. En cas de doute, se référer au
                protocole de service. Le professionnel de santé demeure seul responsable.
              </p>
            </div>
          </div>

          {/* ── Guide de dilution adrénaline — juste après le disclaimer, bien visible dès la sélection du poids ── */}
          {pedDiluEnabled && (() => {
            const p = poids;

            // ── PROTOCOLE 2 : dilution simple universelle ──
            if (pedDiluMode === "2") {
              const volInj = (Math.round(p * 0.1 * 100) / 100).toString().replace(".", ",");
              const mgInj  = (Math.round(p * 0.01 * 1000) / 1000).toString().replace(".", ",");
              const Step2 = ({ num, bold, rest }) => (
                <div style={{ display:"flex", gap:8, padding:"5px 0", borderBottom:`1px solid ${P.borderSoft}`, alignItems:"baseline" }}>
                  <span style={{ width:18, height:18, borderRadius:5, background:P.tealText,
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10, fontWeight:800, color:"#fff", flexShrink:0, fontFamily:mono }}>{num}</span>
                  <p style={{ margin:0, fontSize:12, color:P.text, lineHeight:1.4 }}>
                    {bold && <span style={{ fontWeight:700, color:P.tealText }}>{bold}</span>}
                    {rest && <span>{rest}</span>}
                  </p>
                </div>
              );
              return (
                <div style={{ background:P.tealSoft, borderRadius:12, padding:"12px 14px", marginBottom:12,
                  border:`1.5px solid ${P.teal}`, boxShadow:`0 2px 8px color-mix(in srgb, ${P.teal} 15%, transparent)` }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                    <p style={{ margin:0, fontSize:9, fontWeight:800, color:P.tealText, fontFamily:mono,
                      textTransform:"uppercase", letterSpacing:"0.08em" }}>💉 Protocole 2 — Dilution simple universelle</p>
                    <div style={{ display:"flex", gap:6 }}>
                      <div style={{ background:P.roseSoft, border:`1px solid ${P.rose}`, borderRadius:7,
                        padding:"3px 8px", textAlign:"center" }}>
                        <span style={{ fontSize:14, fontWeight:800, color:P.roseText, fontFamily:mono }}>{volInj} mL</span>
                        <span style={{ fontSize:9, color:P.roseText, display:"block" }}>/ 4 min</span>
                      </div>
                      <div style={{ background:P.amberSoft, border:`1px solid ${P.amber}`, borderRadius:7,
                        padding:"3px 8px", textAlign:"center" }}>
                        <span style={{ fontSize:14, fontWeight:800, color:P.amberText, fontFamily:mono }}>{mgInj} mg</span>
                        <span style={{ fontSize:9, color:P.amberText, display:"block" }}>0,01 mg/kg</span>
                      </div>
                    </div>
                  </div>
                  <p style={{ margin:"0 0 6px", fontSize:10, color:P.tealText, fontStyle:"italic" }}>
                    Préparation identique pour tous les poids
                  </p>
                  <Step2 num="1" bold="Prélever 1 mL (1 mg)" rest=" d'adrénaline 1 mg/mL" />
                  <Step2 num="2" bold="Compléter à 10 mL" rest=" (+ 9 mL NaCl 0,9 %)" />
                  <div style={{ marginTop:6, padding:"5px 0" }}>
                    <p style={{ margin:0, fontSize:11.5, color:P.tealText, fontWeight:700 }}>→ Concentration : 0,1 mg/mL</p>
                    <p style={{ margin:"2px 0 0", fontSize:12, fontWeight:800, color:P.roseText }}>
                      → Injecter {volInj} mL = {mgInj} mg = 0,01 mg/kg ✓
                    </p>
                  </div>
                </div>
              );
            }

            // ── PROTOCOLE 1 : double/simple selon le poids ──
            const isInfant = p < 10;
            const vol1Inf  = p;
            const mg1Inf   = Math.round(p * 0.1 * 100) / 100;
            const naclInf  = Math.round((10 - p) * 10) / 10;
            const concInf  = (mg1Inf / 10).toFixed(3);
            const volSup   = Math.round(p / 10 * 100) / 100;
            const naclSup  = Math.round((10 - volSup) * 100) / 100;
            const concSup  = (volSup / 10).toFixed(3);
            const Step1 = ({ num, bold, rest }) => (
              <div style={{ display:"flex", gap:8, padding:"5px 0", borderBottom:`1px solid ${P.borderSoft}`, alignItems:"baseline" }}>
                {num !== undefined && (
                  <span style={{ width:18, height:18, borderRadius:5, background:P.tealText,
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:10, fontWeight:800, color:"#fff", flexShrink:0, fontFamily:mono }}>{num}</span>
                )}
                <p style={{ margin:0, fontSize:12, color:P.text, lineHeight:1.4 }}>
                  {bold && <span style={{ fontWeight:700, color:P.tealText }}>{bold}</span>}
                  {rest && <span>{rest}</span>}
                </p>
              </div>
            );
            return (
              <div style={{ background:P.tealSoft, borderRadius:12, padding:"12px 14px", marginBottom:12,
                border:`1.5px solid ${P.teal}`, boxShadow:`0 2px 8px color-mix(in srgb, ${P.teal} 15%, transparent)` }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                  <p style={{ margin:0, fontSize:9, fontWeight:800, color:P.tealText, fontFamily:mono,
                    textTransform:"uppercase", letterSpacing:"0.08em" }}>
                    💉 Protocole 1 — {isInfant ? "< 10 kg (nourrisson)" : "≥ 10 kg (enfant)"}
                  </p>
                  <div style={{ background:P.roseSoft, border:`1px solid ${P.rose}`, borderRadius:7,
                    padding:"3px 8px", display:"flex", alignItems:"center", gap:4 }}>
                    <span style={{ fontSize:13, fontWeight:800, color:P.roseText, fontFamily:mono }}>1 mL</span>
                    <span style={{ fontSize:9, color:P.roseText }}>/ 4 min</span>
                  </div>
                </div>
                {isInfant ? (
                  <>
                    <Step1 num="1" bold="Ampoule 1 mg → diluer à 10 mL" rest=" (+ 9 mL NaCl 0,9 %) = 0,1 mg/mL" />
                    <Step1 num="2" bold={`Prélever ${vol1Inf} mL`} rest={` = ${mg1Inf} mg`} />
                    <Step1 num="3" bold="Compléter à 10 mL" rest={` (+ ${naclInf} mL NaCl 0,9 %)`} />
                    <div style={{ marginTop:6, padding:"5px 0" }}>
                      <p style={{ margin:0, fontSize:11.5, color:P.tealText, fontWeight:700 }}>
                        → {concInf} mg/mL · 1 mL = 10 µg/kg ✓
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <Step1 num="1" bold={`Prélever ${volSup} mL`} rest=" d'adrénaline 1 mg/mL" />
                    <Step1 num="2" bold="Compléter à 10 mL" rest={` (+ ${naclSup} mL NaCl 0,9 %)`} />
                    <div style={{ marginTop:6, padding:"5px 0" }}>
                      <p style={{ margin:0, fontSize:11.5, color:P.tealText, fontWeight:700 }}>
                        → {concSup} mg/mL · 1 mL = 10 µg/kg ✓
                      </p>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {/* Voies aériennes */}
          <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:12,
            padding:"12px 14px", marginBottom:10 }}>
            <p style={{ margin:"0 0 8px", fontSize:12, fontWeight:600, color:P.text }}>
              🫁 Voies aériennes
              <span style={{ fontSize:9, color:P.textSoft, fontWeight:400, marginLeft:6, fontStyle:"italic" }}>
                Tableau de référence SMUR
              </span>
            </p>
            <MatRow label="Masque facial"              value={mat.masque}             color={P.tealText} />
            <MatRow label="Sonde aspiration trachéale" value={mat.sondeAspi}          color={P.slateText} />
            <MatRow label="Lame laryngoscope"          value={mat.lame}               color={P.tealText} />
            <MatRow label="Mandrin béquillé"           value={mat.mandrin}            color={P.blueText} />
            <MatRow label="Sonde IOT"                  value={`${mat.sondeAvecBallonnet} mm`} color={P.violetText} />
            <MatRow label="Repère oral intubation"     value={`${mat.repereLab} cm`}  color={P.violetText} />
            <MatRow label="Canule de Guedel"           value={mat.guedel}             color={P.tealText} />
          </div>

          {/* Ventilation */}
          <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:12,
            padding:"12px 14px", marginBottom:10 }}>
            <p style={{ margin:"0 0 8px", fontSize:12, fontWeight:600, color:P.text }}>🌬️ Ventilation</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div style={{ background:P.blueSoft, borderRadius:8, padding:"8px 10px" }}>
                <p style={{ margin:"0 0 2px", fontSize:9, color:P.textSoft, textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:mono }}>FR</p>
                <p style={{ margin:0, fontSize:18, fontWeight:700, color:P.blueText, fontFamily:mono }}>{mat.fr} /min</p>
              </div>
              <div style={{ background:P.blueSoft, borderRadius:8, padding:"8px 10px" }}>
                <p style={{ margin:"0 0 2px", fontSize:9, color:P.textSoft, textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:mono }}>Vt</p>
                <p style={{ margin:0, fontSize:18, fontWeight:700, color:P.blueText, fontFamily:mono }}>{typeof mat.vt === "number" ? `${mat.vt} mL` : mat.vt}</p>
              </div>
            </div>
          </div>

          {/* Thérapeutiques */}
          <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:12,
            padding:"12px 14px", marginBottom:10 }}>
            <p style={{ margin:"0 0 10px", fontSize:12, fontWeight:600, color:P.text }}>
              💉 Thérapeutiques
              <span style={{ fontSize:9, color:P.textSoft, fontWeight:400, marginLeft:6, fontStyle:"italic" }}>ERC 2021 · tableau de référence</span>
            </p>

            {/* Voie IO */}
            <div style={{ background:P.tealSoft, borderRadius:8, padding:"8px 12px", marginBottom:8,
              border:`1px solid #B2DADA` }}>
              <p style={{ margin:"0 0 6px", fontSize:9, color:P.tealText, textTransform:"uppercase",
                letterSpacing:"0.07em", fontFamily:mono }}>Voie intra-osseuse</p>
              <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                {mat.ezio.split(" ou ").map(e => {
                  const is15 = e.includes("15");
                  const is45 = e.includes("45");
                  const dot  = is15 ? "#F472B6" : is45 ? "#FCD34D" : "#3B82F6";
                  const name = is15 ? "Rose" : is45 ? "Jaune" : "Bleu";
                  return (
                    <div key={e} style={{ display:"flex", alignItems:"center", gap:6,
                      background:"rgba(255,255,255,0.6)", borderRadius:20, padding:"4px 10px 4px 6px" }}>
                      <div style={{ width:16, height:16, borderRadius:"50%", background:dot,
                        flexShrink:0, boxShadow:`0 0 0 2px rgba(255,255,255,0.8), 0 0 0 3px ${dot}66` }} />
                      <span style={{ fontSize:13, fontWeight:700, color:P.tealText }}>{e.trim()}</span>
                      <span style={{ fontSize:9, color:P.tealText, opacity:0.7 }}>({name})</span>
                    </div>
                  );
                })}
              </div>
              <p style={{ margin:"5px 0 0", fontSize:8, color:P.tealText, fontStyle:"italic" }}>IVD + flush 5 mL NaCl 0,9%</p>
            </div>

            {/* Adrénaline */}
            <div style={{ background:P.roseSoft, borderRadius:8, padding:"8px 12px", marginBottom:8,
              border:`1px solid color-mix(in srgb, ${P.rose} 27%, transparent)` }}>
              <p style={{ margin:"0 0 4px", fontSize:9, color:P.roseText, textTransform:"uppercase",
                letterSpacing:"0.07em", fontFamily:mono }}>Adrénaline — 10 μg/kg/4 min (0,1 mg/mL)</p>
              <div style={{ display:"flex", gap:16 }}>
                <div>
                  <p style={{ margin:0, fontSize:18, fontWeight:700, color:P.roseText, fontFamily:mono }}>{mat.adrenalineMg} mg</p>
                  <p style={{ margin:0, fontSize:9, color:P.roseText }}>posologie</p>
                </div>
                <div>
                  <p style={{ margin:0, fontSize:18, fontWeight:700, color:P.roseText, fontFamily:mono }}>{mat.adrenalineMl} mL</p>
                  <p style={{ margin:0, fontSize:9, color:P.roseText }}>volume à injecter</p>
                </div>
              </div>
            </div>

            {/* Amiodarone */}
            <div style={{ background:P.amberSoft, borderRadius:8, padding:"8px 12px", marginBottom:8,
              border:`1px solid color-mix(in srgb, ${P.amber} 27%, transparent)` }}>
              <p style={{ margin:"0 0 4px", fontSize:9, color:P.amberText, textTransform:"uppercase",
                letterSpacing:"0.07em", fontFamily:mono }}>Amiodarone — 5 mg/kg (PURE 50 mg/mL)</p>
              <div style={{ display:"flex", gap:16 }}>
                <div>
                  <p style={{ margin:0, fontSize:18, fontWeight:700, color:P.amberText, fontFamily:mono }}>{mat.amioMg} mg</p>
                  <p style={{ margin:0, fontSize:9, color:P.amberText }}>après 3e et 5e CEE</p>
                </div>
                <div>
                  <p style={{ margin:0, fontSize:18, fontWeight:700, color:P.amberText, fontFamily:mono }}>{mat.amioMl} mL</p>
                  <p style={{ margin:0, fontSize:9, color:P.amberText }}>+ flush 5 mL NaCl 0,9%</p>
                </div>
              </div>
            </div>

            {/* Défibrillation — 3 niveaux */}
            <div style={{ background:P.blueSoft, borderRadius:8, padding:"8px 12px",
              border:`1px solid color-mix(in srgb, ${P.blue} 27%, transparent)` }}>
              <p style={{ margin:"0 0 6px", fontSize:9, color:P.blueText, textTransform:"uppercase",
                letterSpacing:"0.07em", fontFamily:mono }}>CEE — Patchs antéro-postérieurs pédiatriques</p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                <div style={{ background:P.surface, borderRadius:7, padding:"6px 8px", textAlign:"center" }}>
                  <p style={{ margin:"0 0 2px", fontSize:8, color:P.textSoft }}>4 J/kg</p>
                  <p style={{ margin:0, fontSize:17, fontWeight:700, color:P.blueText, fontFamily:mono }}>{mat.defib4} J</p>
                  <p style={{ margin:"2px 0 0", fontSize:8, color:P.textSoft }}>Débuter</p>
                </div>
                <div style={{ background:P.surface, borderRadius:7, padding:"6px 8px", textAlign:"center" }}>
                  <p style={{ margin:"0 0 2px", fontSize:8, color:P.textSoft }}>6 J/kg</p>
                  <p style={{ margin:0, fontSize:17, fontWeight:700, color:P.blueText, fontFamily:mono }}>{mat.defib6} J</p>
                  <p style={{ margin:"2px 0 0", fontSize:8, color:P.textSoft }}>6e CEE</p>
                </div>
                <div style={{ background:P.surface, borderRadius:7, padding:"6px 8px", textAlign:"center" }}>
                  <p style={{ margin:"0 0 2px", fontSize:8, color:P.textSoft }}>8 J/kg</p>
                  <p style={{ margin:0, fontSize:17, fontWeight:700, color:P.blueText, fontFamily:mono }}>{mat.defib8} J</p>
                  <p style={{ margin:"2px 0 0", fontSize:8, color:P.textSoft }}>7e CEE</p>
                </div>
              </div>
            </div>
          </div>

          {/* Compressions */}
          <div style={{ background:P.amberSoft, border:`1px solid color-mix(in srgb, ${P.amber} 27%, transparent)`, borderRadius:12,
            padding:"10px 14px", marginBottom:12 }}>
            <p style={{ margin:"0 0 4px", fontSize:11, fontWeight:600, color:P.amberText }}>🫀 Compressions</p>
            <p style={{ margin:0, fontSize:11, color:P.amberText, lineHeight:1.6 }}>
              {poids <= 8
                ? "Nourrisson : 2 doigts · 4 cm · 15:2"
                : "Enfant : 1 main · 5 cm · 15:2"
              } · 100–120/min
            </p>
          </div>
        </>)}

        {/* Bouton démarrer */}
        <button onClick={() => setShowRcp(true)}
          style={{ width:"100%", boxSizing:"border-box",
            background:`linear-gradient(135deg, ${P.rose}, ${P.roseText})`,
            border:"none", borderRadius:16, color:"#fff",
            fontSize:17, fontWeight:800, fontFamily:disp, letterSpacing:"-0.01em", padding:"19px",
            cursor:"pointer",
            display:"flex", alignItems:"center", justifyContent:"center", gap:11,
            boxShadow:`0 10px 28px color-mix(in srgb, ${P.rose} 38%, transparent)`, marginBottom:20 }}>
          <span style={{ fontSize:23 }}>🫀</span>
          Début RCP médicalisée — {poids} kg
        </button>

      </div>
    </div>
  );
}

  const MatRow = ({ label, value, color }) => (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
      padding:"8px 0", borderBottom:`1px solid ${P.borderSoft}`, gap:8 }}>
      <p style={{ margin:0, fontSize:12, color:P.textMid, flex:1, minWidth:0 }}>{label}</p>
      <span style={{ fontSize:15, fontWeight:700, color: color||P.text, fontFamily:mono, flexShrink:0 }}>{value}</span>
    </div>
  );

// ── ONGLET ÉTIOLOGIE ──────────────────────────────────────────────────────────

function EtiologieTab({ causes, suspected, onToggle, P, mono, sans, title }) {
  return (
    <div style={{ marginBottom:10 }}>
      <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:500, color:P.textSoft,
        textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:mono }}>{title}</p>
      <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:6 }}>
        {causes.map(c => {
          const isSuspected = suspected.includes(c.id);
          return (
            <button key={c.id} onClick={() => onToggle(c.id, c.label)}
              style={{
                background: isSuspected ? P.amberSoft : P.surface,
                border: `1.5px solid ${isSuspected ? P.amber : P.border}`,
                borderRadius:11, padding:"10px 12px", cursor:"pointer", fontFamily:sans,
                display:"flex", alignItems:"center", gap:10, textAlign:"left",
                transition:"all 0.15s"
              }}>
              <span style={{ fontSize:20, flexShrink:0 }}>{c.icon}</span>
              <div style={{ flex:1, minWidth:0 }}>
                <p style={{ margin:0, fontSize:13, fontWeight:600,
                  color: isSuspected ? P.amberText : P.text }}>{c.label}</p>
                <p style={{ margin:"1px 0 0", fontSize:10,
                  color: isSuspected ? P.amberText : P.textSoft, opacity:0.85 }}>{c.sub}</p>
              </div>
              <span style={{ fontSize:11, fontWeight:600, color: isSuspected ? P.amberText : P.textSoft,
                fontFamily:mono, flexShrink:0 }}>
                {isSuspected ? "✓ Suspectée" : "+"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── ONGLET THÉRAPEUTIQUES SPÉCIFIQUES ─────────────────────────────────────────

function TherapeutiqueCard({ t, doseCalc, onAdminister, P, mono, sans }) {
  const [open, setOpen] = useState(false);
  const accentMap = { amber:P.amber, rose:P.rose, violet:P.violet, blue:P.blue, green:P.green, teal:P.teal };
  const textMap   = { amber:P.amberText, rose:P.roseText, violet:P.violetText, blue:P.blueText, green:P.greenText, teal:P.tealText };
  const softMap   = { amber:P.amberSoft, rose:P.roseSoft, violet:P.violetSoft, blue:P.blueSoft, green:P.greenSoft, teal:P.tealSoft };
  const ac  = accentMap[t.color] || P.amber;
  const txt = textMap[t.color]   || P.amberText;
  const sft = softMap[t.color]   || P.amberSoft;

  return (
    <div style={{ background:P.surface, border:`1.5px solid ${open ? ac : P.border}`,
      borderRadius:11, marginBottom:8, overflow:"hidden", transition:"border 0.15s" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width:"100%", background:"transparent", border:"none",
          padding:"10px 12px", cursor:"pointer", fontFamily:sans, textAlign:"left",
          display:"flex", alignItems:"center", gap:10 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ margin:0, fontSize:13, fontWeight:600, color:P.text }}>{t.label}</p>
          <p style={{ margin:"1px 0 0", fontSize:10, color:P.textSoft, lineHeight:1.4 }}>{t.indic}</p>
        </div>
        <span style={{ fontSize:12, color:P.textSoft, flexShrink:0 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ padding:"0 12px 12px", borderTop:`1px solid ${P.borderSoft}` }}>
          <p style={{ margin:"10px 0 4px", fontSize:9, fontWeight:600, color:P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Dose / Geste</p>
          <p style={{ margin:"0 0 10px", fontSize:13, color:P.text, fontFamily:mono, lineHeight:1.5,
            background:sft, padding:"8px 10px", borderRadius:8 }}>
            {doseCalc || t.dose}
          </p>
          <button onClick={() => onAdminister(t, doseCalc)}
            style={{ width:"100%", background:`linear-gradient(135deg,${ac},${txt})`,
              border:"none", borderRadius:9, color:"#fff",
              fontSize:13, fontWeight:600, padding:"10px", cursor:"pointer",
              fontFamily:sans, boxShadow:`0 3px 10px ${ac}33` }}>
            {t.geste ? "✓ Marquer comme réalisé" : "✓ Administrer"}
          </button>
        </div>
      )}
    </div>
  );
}

function TherapeutiquesTab({ list, addEvent, localMat, onOpenEcmo, onOpenDdac, onOpenModal, P, mono, sans }) {
  // Pour pédiatrique : remplace les doses par les calculs au poids
  const therapWithDoses = list.map(t => {
    let calc = null;
    if (localMat) {
      if (t.id === "bicar")        calc = `${localMat.bicarMl} mL IV (8,4 %) — 1 mEq/kg`;
      else if (t.id === "calcium") calc = `${localMat.calciumMl} mL IV (10 %) — 0,5 mL/kg`;
      else if (t.id === "magnesium") calc = `${localMat.magnesiumMg} mg IV — 50 mg/kg (max 2 g)`;
      else if (t.id === "naloxone") calc = `${localMat.naloxoneMg} mg IV — 0,1 mg/kg`;
      else if (t.id === "intralipide") calc = `${localMat.intralipMl} mL IV bolus — 1,5 mL/kg`;
      else if (t.id === "thrombolyse") calc = `${localMat.alteplaseMg} mg IVD — 0,6 mg/kg (max 50 mg)`;
    }
    return { ...t, calcDose: calc };
  });

  return (
    <div style={{ marginBottom:10 }}>
      <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:500, color:P.textSoft,
        textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:mono }}>
        Thérapeutiques spécifiques
      </p>
      {therapWithDoses.map(t => (
        <TherapeutiqueCard key={t.id} t={t} doseCalc={t.calcDose}
          onAdminister={(t, dose) => {
            if (t.modal === "ecmo" && onOpenEcmo) { onOpenEcmo(); return; }
            if (t.modal === "ddac" && onOpenDdac) { onOpenDdac(); return; }
            if (t.modal && onOpenModal && ["fast_trauma","thoraco_d","thoraco_g","hemocue","transfusion","exacyl","hemo_ext","octaplas"].includes(t.modal)) {
              onOpenModal(t.modal); return;
            }
            const log = dose || t.logDose;
            addEvent("therap", `${t.label} — ${log}`, t.geste ? "✚" : "💉");
          }}
          P={P} mono={mono} sans={sans} />
      ))}
    </div>
  );
}

// ── MODAL ECMO (checklist éligibilité) ────────────────────────────────────────

function EcmoModal({ open, onClose, onConfirm, P, mono, sans, Modal, Lbl, TArea, isPediatrique = false }) {
  const [criteres, setCriteres] = useState({
    age: null,       // bool
    lowFlow: null,   // < 60 min
    noFlow: null,    // < 5 min
    cause: null,     // réversible
    comorb: null,    // pas de comorbidité majeure
    note: "",
  });
  const [confirmed, setConfirmed] = useState(false);

  if (!open) return null;

  const Yes = ({k}) => (
    <button onClick={() => setCriteres(p => ({...p, [k]: true}))}
      style={{
        flex:1, padding:"7px 4px", borderRadius:8, fontSize:11, fontWeight:600,
        border:`1.5px solid ${criteres[k]===true ? P.green : P.border}`,
        background: criteres[k]===true ? P.greenSoft : P.surface,
        color: criteres[k]===true ? P.greenText : P.textMid,
        cursor:"pointer", fontFamily:sans
      }}>Oui</button>
  );
  const No = ({k}) => (
    <button onClick={() => setCriteres(p => ({...p, [k]: false}))}
      style={{
        flex:1, padding:"7px 4px", borderRadius:8, fontSize:11, fontWeight:600,
        border:`1.5px solid ${criteres[k]===false ? P.rose : P.border}`,
        background: criteres[k]===false ? P.roseSoft : P.surface,
        color: criteres[k]===false ? P.roseText : P.textMid,
        cursor:"pointer", fontFamily:sans
      }}>Non</button>
  );

  const items = isPediatrique ? [
    { k:"age",     label:"Âge éligible",            sub:"En général ≥ 1 mois, à discuter" },
    { k:"lowFlow", label:"Low-flow < 60 min",        sub:"Délai RCP de qualité depuis effondrement" },
    { k:"noFlow",  label:"No-flow < 5 min",          sub:"ACR témoigné avec MCE rapide" },
    { k:"cause",   label:"Cause réversible suspectée", sub:"Cardiaque · pulmonaire · toxique · hypothermie" },
    { k:"comorb",  label:"Pas de comorbidité majeure", sub:"Pronostic neurologique acceptable" },
  ] : [
    { k:"age",     label:"Âge < 70-75 ans",          sub:"À ajuster selon le terrain" },
    { k:"lowFlow", label:"Low-flow < 60 min",        sub:"Délai RCP de qualité depuis effondrement" },
    { k:"noFlow",  label:"No-flow < 5 min",          sub:"ACR témoigné avec MCE rapide" },
    { k:"cause",   label:"Cause potentiellement réversible", sub:"Choc cardiogénique · EP · intox · hypothermie" },
    { k:"comorb",  label:"Pas de comorbidité majeure", sub:"Autonomie préservée · espérance de vie satisfaisante" },
  ];

  const greenCount  = items.filter(i => criteres[i.k] === true).length;
  const redCount    = items.filter(i => criteres[i.k] === false).length;
  const total       = items.length;
  const eligible    = greenCount === total;
  const nonEligible = redCount > 0;

  return (
    <Modal title="Décision ECMO (E-CPR)" icon="🫀" soft={P.violetSoft} onClose={onClose}>
      <p style={{ margin:"0 0 14px", fontSize:12, color:P.textSoft, lineHeight:1.5 }}>
        Checklist d'éligibilité — à discuter en équipe et avec le centre receveur.
      </p>

      {items.map(item => (
        <div key={item.k} style={{ marginBottom:11 }}>
          <p style={{ margin:"0 0 4px", fontSize:12, fontWeight:600, color:P.text }}>{item.label}</p>
          <p style={{ margin:"0 0 6px", fontSize:10, color:P.textSoft, fontStyle:"italic" }}>{item.sub}</p>
          <div style={{ display:"flex", gap:6 }}>
            <Yes k={item.k} />
            <No k={item.k} />
          </div>
        </div>
      ))}

      {/* Verdict */}
      {(greenCount > 0 || redCount > 0) && (
        <div style={{
          background: eligible ? P.greenSoft : nonEligible ? P.roseSoft : P.amberSoft,
          border:`1.5px solid ${eligible ? P.green : nonEligible ? P.rose : P.amber}`,
          borderRadius:10, padding:"10px 12px", marginBottom:10,
          display:"flex", alignItems:"center", gap:10
        }}>
          <span style={{ fontSize:22 }}>{eligible ? "✅" : nonEligible ? "⚠️" : "❓"}</span>
          <div>
            <p style={{ margin:0, fontSize:12, fontWeight:700,
              color: eligible ? P.greenText : nonEligible ? P.roseText : P.amberText }}>
              {eligible ? "Critères favorables" : nonEligible ? "Critère(s) défavorable(s)" : "Évaluation en cours"}
            </p>
            <p style={{ margin:"1px 0 0", fontSize:10,
              color: eligible ? P.greenText : nonEligible ? P.roseText : P.amberText, opacity:0.85 }}>
              {greenCount}/{total} favorables · {redCount}/{total} défavorables
            </p>
          </div>
        </div>
      )}

      <Lbl>Note</Lbl>
      <TArea value={criteres.note} onChange={v => setCriteres(p => ({...p, note:v}))}
        placeholder="Centre receveur contacté, délai estimé..." rows={2} />

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:14 }}>
        <button onClick={() => {
          onConfirm({ decision:"non-éligible", verdict:`${greenCount}/${total} favorables`, note:criteres.note });
          onClose();
        }} style={{
          background:P.surfaceAlt, border:`1.5px solid ${P.border}`, borderRadius:11,
          color:P.textMid, fontSize:12, fontWeight:600, padding:"11px",
          cursor:"pointer", fontFamily:sans
        }}>
          Non éligible
        </button>
        <button onClick={() => {
          onConfirm({ decision:"envisagée", verdict:`${greenCount}/${total} favorables`, note:criteres.note });
          onClose();
        }} style={{
          background:`linear-gradient(135deg,${P.violet},#5A4E8A)`,
          border:"none", borderRadius:11, color:"#fff",
          fontSize:12, fontWeight:600, padding:"11px",
          cursor:"pointer", fontFamily:sans,
          boxShadow:`0 4px 12px color-mix(in srgb, ${P.violet} 20%, transparent)`
        }}>
          ECMO envisagée
        </button>
      </div>
    </Modal>
  );
}

// ── MODAL DON D'ORGANES (DDAC Maastricht II) ──────────────────────────────────

function DdacModal({ open, onClose, onConfirm, P, mono, sans, Modal, Lbl, TArea }) {
  const [crit, setCrit] = useState({ age:null, ci:null, noflow:null, delai:null, note:"" });
  if (!open) return null;

  const items = [
    { k:"age",    label:"Âge < 55 ans",            sub:"Critère d'inclusion" },
    { k:"ci",     label:"Absence de contre-indication", sub:"HTA, diabète, path. rénale/coronaire, cancer, toxicomanie IV" },
    { k:"noflow", label:"No-flow < 15 min",        sub:"Délai effondrement → début RCP" },
    { k:"delai",  label:"Arrivée CH < 120 min",    sub:"Depuis l'effondrement (< 90 min si pas de planche à masser)" },
  ];

  const Yes = ({k}) => (
    <button onClick={() => setCrit(p => ({...p, [k]: true}))}
      style={{ flex:1, padding:"7px 4px", borderRadius:8, fontSize:11, fontWeight:600,
        border:`1.5px solid ${crit[k]===true ? P.green : P.border}`,
        background: crit[k]===true ? P.greenSoft : P.surface,
        color: crit[k]===true ? P.greenText : P.textMid,
        cursor:"pointer", fontFamily:sans }}>Oui</button>
  );
  const No = ({k}) => (
    <button onClick={() => setCrit(p => ({...p, [k]: false}))}
      style={{ flex:1, padding:"7px 4px", borderRadius:8, fontSize:11, fontWeight:600,
        border:`1.5px solid ${crit[k]===false ? P.rose : P.border}`,
        background: crit[k]===false ? P.roseSoft : P.surface,
        color: crit[k]===false ? P.roseText : P.textMid,
        cursor:"pointer", fontFamily:sans }}>Non</button>
  );

  const green = items.filter(i => crit[i.k] === true).length;
  const red   = items.filter(i => crit[i.k] === false).length;
  const total = items.length;
  const eligible = green === total;
  const nonEligible = red > 0;

  return (
    <Modal title="Don d'organes — DDAC Maastricht II" icon="🤝" soft={P.tealSoft} onClose={onClose}>
      <p style={{ margin:"0 0 12px", fontSize:12, color:P.textSoft, lineHeight:1.5 }}>
        ACR réfractaire sans recours ECMO et après échec de la réanimation spécialisée :
        penser au don d'organes. Évaluation indicative — la décision relève du protocole et
        de la coordination.
      </p>

      {items.map(item => (
        <div key={item.k} style={{ marginBottom:11 }}>
          <p style={{ margin:"0 0 4px", fontSize:12, fontWeight:600, color:P.text }}>{item.label}</p>
          <p style={{ margin:"0 0 6px", fontSize:10, color:P.textSoft, fontStyle:"italic" }}>{item.sub}</p>
          <div style={{ display:"flex", gap:6 }}>
            <Yes k={item.k} /><No k={item.k} />
          </div>
        </div>
      ))}

      {(green > 0 || red > 0) && (
        <div style={{
          background: eligible ? P.greenSoft : nonEligible ? P.roseSoft : P.amberSoft,
          border:`1.5px solid ${eligible ? P.green : nonEligible ? P.rose : P.amber}`,
          borderRadius:10, padding:"10px 12px", marginBottom:10,
          display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:22 }}>{eligible ? "✅" : nonEligible ? "⚠️" : "❓"}</span>
          <div>
            <p style={{ margin:0, fontSize:12, fontWeight:700,
              color: eligible ? P.greenText : nonEligible ? P.roseText : P.amberText }}>
              {eligible ? "Donneur potentiel — contacter la régulation SAMU" :
               nonEligible ? "Critère(s) défavorable(s)" : "Évaluation en cours"}
            </p>
            <p style={{ margin:"1px 0 0", fontSize:10,
              color: eligible ? P.greenText : nonEligible ? P.roseText : P.amberText, opacity:0.85 }}>
              {green}/{total} favorables · {red}/{total} défavorables
            </p>
          </div>
        </div>
      )}

      {/* Rappel contact */}
      <div style={{ background:P.tealSoft, border:`1px solid #B2DADA`, borderRadius:10,
        padding:"9px 12px", marginBottom:10, display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:16 }}>📞</span>
        <p style={{ margin:0, fontSize:11, color:P.tealText, fontWeight:600 }}>
          Contact : régulation du SAMU
        </p>
      </div>

      <Lbl>Note</Lbl>
      <TArea value={crit.note} onChange={v => setCrit(p => ({...p, note:v}))}
        placeholder="Coordination contactée, heure, précisions..." rows={2} />

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:14 }}>
        <button onClick={() => {
          onConfirm({ decision:"non retenu", verdict:`${green}/${total} favorables`, note:crit.note });
          onClose();
        }} style={{ background:P.surfaceAlt, border:`1.5px solid ${P.border}`, borderRadius:11,
          color:P.textMid, fontSize:12, fontWeight:600, padding:"11px", cursor:"pointer", fontFamily:sans }}>
          Non retenu
        </button>
        <button onClick={() => {
          onConfirm({ decision:"envisagé — régulation SAMU contactée", verdict:`${green}/${total} favorables`, note:crit.note });
          onClose();
        }} style={{ background:`linear-gradient(135deg,${P.teal},#1A6A6A)`,
          border:"none", borderRadius:11, color:"#fff", fontSize:12, fontWeight:600,
          padding:"11px", cursor:"pointer", fontFamily:sans, boxShadow:`0 4px 12px color-mix(in srgb, ${P.teal} 20%, transparent)` }}>
          Don envisagé
        </button>
      </div>

      <p style={{ margin:"12px 0 0", fontSize:9, color:P.textSoft, fontStyle:"italic", textAlign:"center", lineHeight:1.4 }}>
        Aide à la décision — ne remplace pas le protocole local ni l'avis de la coordination hospitalière de don d'organes.
      </p>
    </Modal>
  );
}

// ── ÉTIOLOGIES & THÉRAPEUTIQUES ────────────────────────────────────────────────

const CAUSES_5H = [
  { id:"hypoxie",      label:"Hypoxie",          icon:"💨", sub:"SpO₂ basse · cyanose · VA compromise" },
  { id:"hypovolemie",  label:"Hypovolémie",      icon:"🩸", sub:"Hémorragie · déshydratation · choc" },
  { id:"hydrogene",    label:"Acidose (H⁺)",     icon:"⚗️", sub:"pH < 7,1 · sepsis · IRC · intox" },
  { id:"hypok",        label:"Hypokaliémie",     icon:"⚡", sub:"ECG : onde U · troubles du rythme" },
  { id:"hyperk",       label:"Hyperkaliémie",    icon:"⚡", sub:"ECG : QRS large · onde T ample · IRC" },
  { id:"hypothermie",  label:"Hypothermie",      icon:"🧊", sub:"Tc < 30 °C · noyade · exposition" },
];

const CAUSES_5T = [
  { id:"thrombose_c",  label:"Thrombose coronaire", icon:"❤️", sub:"SCA · douleur thoracique précédente" },
  { id:"thrombose_p",  label:"Embolie pulmonaire",  icon:"🫁", sub:"TVP · alitement · post-op · chirurgie" },
  { id:"tamponnade",   label:"Tamponnade",          icon:"🫀", sub:"FAST · turgescence jugulaire" },
  { id:"tension_pno",  label:"Pneumothorax suffocant", icon:"💨", sub:"Asymétrie auscultation · trauma" },
  { id:"toxiques",     label:"Toxiques",            icon:"☠️", sub:"Médic · drogues · CO · cyanure" },
  { id:"trauma",       label:"Traumatisme",         icon:"🚑", sub:"AVP · hémorragie · TC" },
];

// Causes pédiatriques spécifiques (en plus des 5H/5T)
const CAUSES_PED = [
  { id:"hypoglycemie", label:"Hypoglycémie",    icon:"🍬", sub:"NN · diabétique · jeûne prolongé" },
  { id:"sepsis",       label:"Sepsis sévère",   icon:"🦠", sub:"Fièvre · choc · purpura" },
  { id:"intox",        label:"Intoxication",    icon:"💊", sub:"Médicaments parents · ingestion accidentelle" },
  { id:"mim",          label:"Mort inexpliquée nourrisson", icon:"👶", sub:"MIN · MSIN · < 2 ans" },
  { id:"obstruction",  label:"Obstruction VAS", icon:"🫁", sub:"Corps étranger · fausse route" },
  { id:"noyade",       label:"Noyade",          icon:"💧", sub:"Hypoxie + hypothermie" },
];

// Thérapeutiques spécifiques adulte
const THERAPEUTIQUES_ADULTE = [
  { id:"bicar",       label:"Bicarbonate de sodium 8,4 %",
    indic:"Hyperkaliémie sévère · intox tricycliques · acidose métabolique sévère",
    dose:"1 mEq/kg IV (≈ 1 mL/kg de 8,4 %)", logDose:"1 mEq/kg IV", color:"amber" },
  { id:"calcium",     label:"Gluconate de calcium 10 %",
    indic:"Hyperkaliémie · intox inhibiteurs calciques · hypocalcémie",
    dose:"1 g IV (10 mL de 10 %)", logDose:"1 g IV", color:"amber" },
  { id:"magnesium",   label:"Sulfate de magnésium 15 %",
    indic:"Torsade de pointes · hypomagnésémie · asthme aigu grave",
    dose:"2 g IV (1,5 g/10 mL → 14 mL)", logDose:"2 g IV", color:"amber" },
  { id:"insuline_g30",label:"Insuline + G30 %",
    indic:"Hyperkaliémie sévère",
    dose:"10 UI insuline rapide IV + 250 mL G30 %", logDose:"Insuline 10 UI + G30 % 250 mL", color:"violet" },
  { id:"thrombolyse", label:"Altéplase (Actilyse®)",
    indic:"Embolie pulmonaire massive · SCA thrombotique",
    dose:"50 mg IVD, renouveler à 15 min si pas de RACS. Poursuivre RCP 1 h après",
    logDose:"Bolus 50 mg IVD", color:"rose" },
  { id:"naloxone",    label:"Naloxone (Narcan®)",
    indic:"Intoxication opioïdes (jeune · ACR brutal hypoxique)",
    dose:"0,4 mg IV (à répéter)", logDose:"0,4 mg IV", color:"green" },
  { id:"intralipide", label:"Émulsion lipidique 20 %",
    indic:"Intoxication anesthésiques locaux · bêta-bloquants",
    dose:"1,5 mL/kg IV bolus puis 0,25 mL/kg/min", logDose:"Bolus 1,5 mL/kg", color:"violet" },
  { id:"glucagon",    label:"Glucagon",
    indic:"Intoxication β-bloquants · inhibiteurs calciques",
    dose:"5-10 mg IV bolus puis 5 mg/h", logDose:"Bolus 5-10 mg IV", color:"violet" },
  { id:"cyanokit",    label:"Cyanokit® (Hydroxocobalamine)",
    indic:"Intoxication cyanure · fumées d'incendie",
    dose:"5 g IV sur 15 min (renouvelable à 5 g)", logDose:"5 g IV / 15 min", color:"rose" },
  { id:"exsuf",       label:"Exsufflation pneumothorax",
    indic:"Pneumothorax suffocant",
    dose:"Aiguille 14 G · 2ᵉ EIC LMC ou 4ᵉ-5ᵉ EIC ligne axillaire ant.",
    logDose:"Exsufflation à l'aiguille", color:"blue", geste:true },
  { id:"drainage",    label:"Drainage péricardique",
    indic:"Tamponnade péricardique",
    dose:"Sous écho · voie sous-xiphoïdienne",
    logDose:"Drainage péricardique", color:"blue", geste:true },
  { id:"ecmo",        label:"ECMO (E-CPR)",
    indic:"ACR réfractaire · low-flow < 60 min · cause potentiellement réversible",
    dose:"Décision pluridisciplinaire — voir checklist",
    logDose:"Décision ECMO envisagée", color:"violet", geste:true, modal:"ecmo" },
  { id:"ddac",        label:"Don d'organes (Maastricht II)",
    indic:"ACR réfractaire · pas de recours ECMO · échec de la réanimation spécialisée",
    dose:"Évaluer l'éligibilité — voir checklist · contacter la régulation SAMU",
    logDose:"Éligibilité don d'organes évaluée", color:"teal", geste:true, modal:"ddac" },
];

// ── ACR TRAUMATIQUE (TCA) ──────────────────────────────────────────────────────

// Causes réversibles traumatiques — algorithme HOTT
// Mécanismes lésionnels structurés (trauma) — chaque mécanisme porte les flags
// "pénétrant" et "haute cinétique" utilisés pour préremplir automatiquement
// le score BATT, au lieu de les cocher à la main à chaque fois.
const MECANISMES_TRAUMA = [
  { id:"avp_pieton",     label:"AVP piéton",          icon:"🚶", penetrant:false, hcin:true  },
  { id:"avp_2roues",     label:"AVP 2-roues",         icon:"🏍️", penetrant:false, hcin:true  },
  { id:"avp_vl",         label:"AVP véhicule léger",  icon:"🚗", penetrant:false, hcin:true  },
  { id:"chute_hauteur",  label:"Chute de hauteur",    icon:"🪜", penetrant:false, hcin:true  },
  { id:"chute_simple",   label:"Chute simple",        icon:"⬇️", penetrant:false, hcin:false },
  { id:"arme_blanche",   label:"Arme blanche",        icon:"🔪", penetrant:true,  hcin:false },
  { id:"arme_feu",       label:"Arme à feu",          icon:"🔫", penetrant:true,  hcin:false },
  { id:"ecrasement",     label:"Écrasement",          icon:"🏗️", penetrant:false, hcin:true  },
  { id:"blast",          label:"Blast / explosion",   icon:"💥", penetrant:false, hcin:true  },
  { id:"autre",          label:"Autre",               icon:"❓", penetrant:false, hcin:false },
];

const CAUSES_HOTT = [
  { id:"hypovolemie", label:"Hypovolémie (hémorragie)", icon:"🩸", sub:"Contrôle hémorragie + produits sanguins · hypotension permissive" },
  { id:"hypoxie",     label:"Hypoxie (oxygénation)",    icon:"💨", sub:"Contrôle des voies aériennes · ventilation" },
  { id:"pno",         label:"Pneumothorax suffocant",    icon:"🫁", sub:"Thoracostomies bilatérales (geste salvateur)" },
  { id:"tamponnade",  label:"Tamponnade",                icon:"🫀", sub:"FAST · thoracotomie / drainage péricardique" },
];

// Thérapeutiques spécifiques du TCA
const THERAPEUTIQUES_TRAUMA = [
  { id:"thoraco_d",   label:"Thoracostomie droite",
    indic:"Pneumothorax suffocant droit",
    dose:"Résultat : rien / air / sang",
    logDose:"Thoracostomie droite", color:"blue", geste:true, modal:"thoraco_d" },
  { id:"thoraco_g",   label:"Thoracostomie gauche",
    indic:"Pneumothorax suffocant gauche",
    dose:"Résultat : rien / air / sang",
    logDose:"Thoracostomie gauche", color:"blue", geste:true, modal:"thoraco_g" },
  { id:"hemo_ext",    label:"Contrôle hémorragies externes",
    indic:"Hémorragie compressible",
    dose:"Garrot · packing · QuickClot · Celox · pansement compressif · agrafes · Bivona...",
    logDose:"Contrôle hémorragie externe", color:"rose", geste:true, modal:"hemo_ext" },
  { id:"ceinture",    label:"Ceinture pelvienne",
    indic:"Suspicion fracture du bassin · hémorragie rétropéritonéale",
    dose:"Pose au niveau des grands trochanters",
    logDose:"Ceinture pelvienne posée", color:"amber", geste:true },
  { id:"exacyl",      label:"Acide tranexamique (Exacyl®)",
    indic:"Hémorragie traumatique — dans les 3 h",
    dose:"1 g IVL sur 10 min, puis 1 g sur 8 h. ⚠️ Inutile/délétère après 3 h",
    logDose:"Exacyl", color:"green", geste:true, modal:"exacyl" },
  { id:"hemocue",     label:"Hemocue (Hb)",
    indic:"Évaluation rapide de l'hémoglobine",
    dose:"Mesure capillaire — noter la valeur",
    logDose:"Hemocue réalisé", color:"violet", geste:true, modal:"hemocue" },
  { id:"transfusion", label:"Transfusion préhospitalière",
    indic:"Choc hémorragique",
    dose:"CGR · PFC · ratio 1:1:1 en transfusion massive",
    logDose:"Transfusion préhospitalière", color:"rose", geste:true, modal:"transfusion" },
  { id:"octaplas",    label:"OctaplasLG",
    indic:"Transport > 20 min + 1 critère : BATT ≥ 8 · FAST+ abdo + SI ≥ 0,9 · Fracture bassin instable + SI ≥ 0,9 · Trauma pénétrant tronc + SI ≥ 0,9 · ACR traumatique récupéré",
    dose:"2 unités en préhospitalier · Plasma thérapeutique (solvant/détergent)",
    logDose:"OctaplasLG administré", color:"rose", geste:true, modal:"octaplas" },
  { id:"calcium_tr",  label:"Gluconate de calcium 10 %",
    indic:"Transfusion massive (hypocalcémie du citrate) · hyperkaliémie",
    dose:"1 g IV (10 mL de 10 %) — contrôler la calcémie",
    logDose:"Calcium 1 g IV", color:"amber" },
  { id:"cristalloides", label:"⚠️ Restriction cristalloïdes",
    indic:"Damage control resuscitation",
    dose:"Limiter les cristalloïdes — privilégier les produits sanguins · hypotension permissive (PAS ~80-90) tant que l'hémorragie n'est pas contrôlée",
    logDose:"Restriction cristalloïdes — produits sanguins privilégiés", color:"amber" },
  { id:"thoracotomie", label:"Thoracotomie de sauvetage",
    indic:"Plaie pénétrante thoracique avec tamponnade · centre équipé",
    dose:"Geste de dernier recours — équipe entraînée",
    logDose:"Thoracotomie de sauvetage", color:"rose", geste:true },
  { id:"reboa",       label:"REBOA",
    indic:"Hémorragie sous-diaphragmatique non contrôlable · si disponible",
    dose:"Ballon d'occlusion aortique endovasculaire",
    logDose:"REBOA envisagé", color:"violet", geste:true },
];

// ── BASCULE JOUR / NUIT ────────────────────────────────────────────────────────
function ThemeToggle({ theme, setTheme, compact = false }) {
  const opts = [
    { id:"night", label:"Nuit", icon:"🌙" },
    { id:"day",   label:"Jour", icon:"☀️" },
  ];
  return (
    <div style={{ display:"inline-flex", background:P.surfaceAlt, border:`1px solid ${P.border}`,
      borderRadius:10, padding:3, gap:3 }}>
      {opts.map(o => {
        const on = theme === o.id;
        return (
          <button key={o.id} onClick={() => setTheme(o.id)}
            style={{ border:"none", cursor:"pointer", fontFamily:sans, fontWeight:700,
              fontSize:compact ? 10 : 11, letterSpacing:"0.02em",
              padding: compact ? "5px 9px" : "6px 12px", borderRadius:7,
              background: on ? (o.id==="night" ? "#1F2A3A" : "#FFFFFF") : "transparent",
              color: on ? (o.id==="night" ? "#FFFFFF" : "#0A111B") : P.textSoft,
              boxShadow: on ? "0 1px 4px rgba(0,0,0,0.25)" : "none",
              display:"flex", alignItems:"center", gap:5, transition:"all .15s" }}>
            <span style={{ fontSize: compact ? 11 : 12 }}>{o.icon}</span>
            {!compact && o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── COURBE EtCO₂ (SVG maison, sans dépendance) ─────────────────────────────────
function Etco2Curve({ data, P, mono, refSec = 0 }) {
  // data = [{ val:Number, sec:Number, time:String }]
  // refSec = seconde de référence pour l'axe X (0 = heure de l'arrêt)
  const pts = (data || [])
    .map(d => ({ v: parseFloat(String(d.val).replace(",", ".")), sec: d.sec || 0, time: d.time }))
    .filter(d => !isNaN(d.v));
  if (pts.length === 0) {
    return (
      <p style={{ margin:0, fontSize:11, color:P.textSoft, textAlign:"center", padding:"8px 0", fontFamily:mono }}>
        Aucune valeur — appuyer sur « + Valeur »
      </p>
    );
  }
  const W = 300, H = 76, padL = 24, padR = 6, padT = 8, padB = 17;
  const vMax = Math.max(50, Math.ceil(Math.max(...pts.map(p => p.v)) / 10) * 10);
  const sMin = pts[0].sec, sMax = pts[pts.length - 1].sec;
  const spanS = Math.max(1, sMax - sMin);
  const x = s => padL + ((s - sMin) / spanS) * (W - padL - padR);
  const y = v => padT + (1 - v / vMax) * (H - padT - padB);
  const xPos = pts.length === 1 ? [(W - padL - padR) / 2 + padL] : pts.map(p => x(p.sec));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xPos[i].toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const yRef = y(10);
  const last = pts[pts.length - 1];
  const gridVals = [0, vMax / 2, vMax];

  // Étiquettes axe X (temps relatif à refSec, en minutes)
  const xLabels = (() => {
    if (pts.length === 1) {
      const m = Math.round((pts[0].sec - refSec) / 60);
      return [{ px: xPos[0], label: m === 0 ? "0 min" : `+${m} min` }];
    }
    // Sélectionner 2-3 points bien espacés
    const idxs = pts.length <= 3
      ? pts.map((_, i) => i)
      : [0, Math.round((pts.length - 1) / 2), pts.length - 1];
    const seen = new Set();
    return idxs.filter(i => { if (seen.has(i)) return false; seen.add(i); return true; })
      .map(i => {
        const m = Math.round((pts[i].sec - refSec) / 60);
        const px = Math.max(padL + 6, Math.min(xPos[i], W - padR - 10));
        return { px, label: m === 0 ? "0 min" : (m > 0 ? `+${m} min` : `${m} min`) };
      });
  })();

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" style={{ display:"block" }}>
      {/* grilles Y */}
      {gridVals.map((gv, i) => (
        <g key={i}>
          <line x1={padL} y1={y(gv)} x2={W - padR} y2={y(gv)}
            stroke={P.border} strokeWidth="0.5" />
          <text x={padL - 4} y={y(gv) + 3} textAnchor="end"
            fontSize="8" fill={P.textSoft} fontFamily={mono}>{gv}</text>
        </g>
      ))}
      {/* axe X (bas du graphe) */}
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB}
        stroke={P.border} strokeWidth="0.5" />
      {/* seuil 10 mmHg */}
      <line x1={padL} y1={yRef} x2={W - padR} y2={yRef}
        stroke={P.amber} strokeWidth="1" strokeDasharray="3 3" opacity="0.8" />
      {/* courbe */}
      {pts.length > 1 && <path d={line} fill="none" stroke={P.teal} strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" />}
      {/* points */}
      {pts.map((p, i) => (
        <circle key={i} cx={xPos[i]} cy={y(p.v)} r={i === pts.length - 1 ? 3.5 : 2.5}
          fill={i === pts.length - 1 ? P.teal : P.surface} stroke={P.teal} strokeWidth="1.5" />
      ))}
      {/* dernière valeur */}
      <text x={Math.min(xPos[xPos.length - 1] + 5, W - padR - 14)} y={Math.max(y(last.v) - 6, 10)}
        fontSize="10" fontWeight="700" fill={P.tealText} fontFamily={mono}>{last.v}</text>
      {/* étiquettes axe X (temps relatif à l'arrêt) */}
      {xLabels.map((l, i) => (
        <g key={`xl${i}`}>
          <line x1={l.px} y1={H - padB} x2={l.px} y2={H - padB + 3} stroke={P.border} strokeWidth="0.8" />
          <text x={l.px} y={H - 2} textAnchor="middle" fontSize="7" fill={P.textSoft} fontFamily={mono}>{l.label}</text>
        </g>
      ))}
    </svg>
  );
}

// ── COURBE HEMOCUE Hb (SVG maison) ────────────────────────────────────────────
function HemocueCurve({ data, P, mono, refSec = 0 }) {
  // data = [{ val, time, sec }]
  const pts = (data || [])
    .map(d => ({ v: parseFloat(String(d.val).replace(",", ".")), sec: d.sec || 0, time: d.time }))
    .filter(d => !isNaN(d.v));
  if (pts.length === 0) return null;
  const W = 300, H = 76, padL = 24, padR = 8, padT = 8, padB = 17;
  const vMin = 0, vMax = Math.max(16, Math.ceil(Math.max(...pts.map(p => p.v)) / 2) * 2);
  const sMin = pts[0].sec, sMax = pts[pts.length - 1].sec;
  const spanS = Math.max(1, sMax - sMin);
  const xPos = pts.length === 1
    ? [(W - padL - padR) / 2 + padL]
    : pts.map(p => padL + ((p.sec - sMin) / spanS) * (W - padL - padR));
  const y = v => padT + (1 - (v - vMin) / (vMax - vMin)) * (H - padT - padB);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xPos[i].toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  // Seuils : 7 g/dL (transfusion), 12 g/dL (normale basse)
  const refs = [{ v: 7, label: "7", c: P.rose }, { v: 12, label: "12", c: P.green }];
  // Étiquettes axe X
  const xLabels = (() => {
    if (pts.length === 1) {
      const m = Math.round((pts[0].sec - refSec) / 60);
      return [{ px: xPos[0], label: m === 0 ? "0 min" : `+${m} min` }];
    }
    const idxs = pts.length <= 3 ? pts.map((_, i) => i) : [0, Math.round((pts.length-1)/2), pts.length-1];
    return [...new Set(idxs)].map(i => {
      const m = Math.round((pts[i].sec - refSec) / 60);
      return { px: Math.max(padL+6, Math.min(xPos[i], W-padR-10)), label: m===0?"0 min":`+${m} min` };
    });
  })();
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" style={{ display:"block" }}>
      {/* Seuils */}
      {refs.filter(r => r.v <= vMax).map(r => (
        <g key={r.v}>
          <line x1={padL} y1={y(r.v)} x2={W-padR} y2={y(r.v)}
            stroke={r.c} strokeWidth="0.8" strokeDasharray="3 3" opacity="0.7" />
          <text x={padL-3} y={y(r.v)+3} textAnchor="end" fontSize="7" fill={r.c} fontFamily={mono}>{r.label}</text>
        </g>
      ))}
      {/* Axe X */}
      <line x1={padL} y1={H-padB} x2={W-padR} y2={H-padB} stroke={P.border} strokeWidth="0.5" />
      {/* Grille Y haut */}
      <line x1={padL} y1={y(vMax)} x2={W-padR} y2={y(vMax)} stroke={P.border} strokeWidth="0.5" />
      <text x={padL-3} y={y(vMax)+3} textAnchor="end" fontSize="7" fill={P.textSoft} fontFamily={mono}>{vMax}</text>
      {/* Courbe */}
      {pts.length > 1 && <path d={line} fill="none" stroke={P.rose} strokeWidth="2.5"
        strokeLinejoin="round" strokeLinecap="round" />}
      {/* Points */}
      {pts.map((p, i) => (
        <circle key={i} cx={xPos[i]} cy={y(p.v)} r={i === pts.length-1 ? 4 : 3}
          fill={i === pts.length-1 ? P.rose : P.surface} stroke={P.rose} strokeWidth="1.5" />
      ))}
      {/* Valeur terminale */}
      <text x={Math.min(xPos[xPos.length-1]+5, W-padR-18)} y={Math.max(y(last.v)-7, padT+8)}
        fontSize="10" fontWeight="700" fill={P.roseText} fontFamily={mono}>{last.v} g/dL</text>
      {/* Axe X labels */}
      {xLabels.map((l, i) => (
        <g key={`xl${i}`}>
          <line x1={l.px} y1={H-padB} x2={l.px} y2={H-padB+3} stroke={P.border} strokeWidth="0.8" />
          <text x={l.px} y={H-2} textAnchor="middle" fontSize="7" fill={P.textSoft} fontFamily={mono}>{l.label}</text>
        </g>
      ))}
    </svg>
  );
}

// ── COURBE HÉMODYNAMIQUE POST-RACS (SVG maison) ────────────────────────────────
function HemoCurve({ hemoList, amineList, P, mono, refSec = 0 }) {
  // refSec = sec de l'événement RACS (0 = heure du RACS)
  const pts = (hemoList || []).filter(d => d.pas || d.pad || d.fc)
    .map(d => ({
      sec: d.sec || 0, time: d.time,
      pas: parseFloat(String(d.pas || "").replace(",", ".")) || null,
      pad: parseFloat(String(d.pad || "").replace(",", ".")) || null,
      fc:  parseFloat(String(d.fc  || "").replace(",", ".")) || null,
    }));
  const pamPts = pts.filter(p => p.pas && p.pad).map(p => ({
    ...p, pam: Math.round(p.pad + (p.pas - p.pad) / 3)
  }));
  if (pts.length === 0) return (
    <p style={{ margin:0, fontSize:11, color:P.textSoft, textAlign:"center", padding:"8px 0", fontFamily:mono }}>
      Aucune mesure — appuyer sur « + Mesure »
    </p>
  );
  const W = 300, H = 95, padL = 26, padR = 8, padT = 8, padB = 20;
  const yMax = 220, yMin = 0;
  const t0   = pts[0].sec;
  const tMax = Math.max(pts[pts.length - 1].sec, ...((amineList||[]).map(a => a.sec)));
  const spanT = Math.max(60, tMax - t0);
  const xf = s => padL + ((s - t0) / spanT) * (W - padL - padR);
  const yf = v => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);
  const path = (arr, key) => arr.filter(p => p[key] != null)
    .map((p, i) => `${i===0?"M":"L"} ${xf(p.sec).toFixed(1)} ${yf(p[key]).toFixed(1)}`).join(" ");
  const pamPath = pamPts.map((p, i) => `${i===0?"M":"L"} ${xf(p.sec).toFixed(1)} ${yf(p.pam).toFixed(1)}`).join(" ");
  const lastOf = (arr, key) => { const f = arr.filter(p=>p[key]!=null); return f.length ? f[f.length-1] : null; };
  const lPas = lastOf(pts,"pas"), lPad = lastOf(pts,"pad"), lFc = lastOf(pts,"fc"), lPam = pamPts[pamPts.length-1];
  const gridVals = [100, 200];

  // Étiquettes axe X (temps relatif au RACS, en minutes)
  const xLabels = (() => {
    if (pts.length === 1) {
      const m = Math.round((pts[0].sec - refSec) / 60);
      return [{ px: xf(pts[0].sec), label: m === 0 ? "0 min" : (m > 0 ? `+${m} min` : `${m} min`) }];
    }
    const idxs = pts.length <= 3
      ? pts.map((_, i) => i)
      : [0, Math.round((pts.length - 1) / 2), pts.length - 1];
    const seen = new Set();
    return idxs.filter(i => { if (seen.has(i)) return false; seen.add(i); return true; })
      .map(i => {
        const m = Math.round((pts[i].sec - refSec) / 60);
        const px = Math.max(padL + 8, Math.min(xf(pts[i].sec), W - padR - 10));
        return { px, label: m === 0 ? "0 min" : (m > 0 ? `+${m} min` : `${m} min`) };
      });
  })();

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" style={{ display:"block" }}>
      {/* grilles */}
      {gridVals.map(v => (
        <g key={v}>
          <line x1={padL} y1={yf(v)} x2={W-padR} y2={yf(v)} stroke={P.border} strokeWidth="0.5" />
          <text x={padL-3} y={yf(v)+3} textAnchor="end" fontSize="7" fill={P.textSoft} fontFamily={mono}>{v}</text>
        </g>
      ))}
      {/* axe X */}
      <line x1={padL} y1={H-padB} x2={W-padR} y2={H-padB} stroke={P.border} strokeWidth="0.5" />
      {/* PAM 65 ref */}
      <line x1={padL} y1={yf(65)} x2={W-padR} y2={yf(65)} stroke={P.amber} strokeWidth="0.8" strokeDasharray="3 3" opacity="0.75" />
      <text x={padL-3} y={yf(65)+3} textAnchor="end" fontSize="7" fill={P.amber} fontFamily={mono}>65</text>
      {/* marqueurs amines */}
      {(amineList||[]).map((a, i) => {
        const ax = Math.min(Math.max(xf(a.sec), padL), W-padR);
        return (
          <g key={i}>
            <line x1={ax} y1={padT} x2={ax} y2={H-padB} stroke={P.green} strokeWidth="1" strokeDasharray="2 2" opacity="0.9" />
            <text x={ax+2} y={padT+8} fontSize="7" fill={P.greenText} fontFamily={mono}>{a.type.slice(0,5)}</text>
          </g>
        );
      })}
      {/* courbes */}
      {pts.filter(p=>p.pas).length>1 && <path d={path(pts,"pas")} fill="none" stroke={P.rose}   strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />}
      {pts.filter(p=>p.pad).length>1 && <path d={path(pts,"pad")} fill="none" stroke={P.blue}   strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />}
      {pamPts.length>1               && <path d={pamPath}         fill="none" stroke={P.amber}  strokeWidth="1.5" strokeLinejoin="round" strokeDasharray="5 3" />}
      {pts.filter(p=>p.fc ).length>1 && <path d={path(pts,"fc")}  fill="none" stroke={P.violet} strokeWidth="1.5" strokeLinejoin="round" strokeDasharray="2 4" />}
      {/* points terminaux */}
      {lPas && <circle cx={xf(lPas.sec)} cy={yf(lPas.pas)} r="3" fill={P.rose}   stroke="none" />}
      {lPad && <circle cx={xf(lPad.sec)} cy={yf(lPad.pad)} r="3" fill={P.blue}   stroke="none" />}
      {lPam && <circle cx={xf(lPam.sec)} cy={yf(lPam.pam)} r="3" fill={P.amber}  stroke="none" />}
      {lFc  && <circle cx={xf(lFc.sec)}  cy={yf(lFc.fc)}   r="3" fill={P.violet} stroke="none" />}
      {/* valeur PAM terminale */}
      {lPam && <text x={Math.min(xf(lPam.sec)+5,W-padR-18)} y={Math.max(yf(lPam.pam)-5,10)} fontSize="9" fontWeight="700" fill={P.amber} fontFamily={mono}>PAM {lPam.pam}</text>}
      {/* étiquettes axe X (temps relatif au RACS) */}
      {xLabels.map((l, i) => (
        <g key={`xl${i}`}>
          <line x1={l.px} y1={H-padB} x2={l.px} y2={H-padB+3} stroke={P.border} strokeWidth="0.8" />
          <text x={l.px} y={H-2} textAnchor="middle" fontSize="7" fill={P.textSoft} fontFamily={mono}>{l.label}</text>
        </g>
      ))}
    </svg>
  );
}

// ── DÉBRIEF POST-ARRÊT ────────────────────────────────────────────────────────
function DebriefModal({ events, totalSec, noFlow, lowFlow, etco2List, ccfEnabled, ccfPct,
  onClose, P, mono, sans, disp, fmtSec }) {
  const rosc   = events.find(e => e.id === "rosc");
  const deces  = events.find(e => e.id === "deces");
  const chocs  = events.filter(e => e.id === "choc");
  const adrs   = events.filter(e => e.id === "adr");
  const cords  = events.filter(e => e.id === "cord300" || e.id === "cord150");
  const rv     = events.find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
  const firstChoc = chocs[0];
  const firstAdr  = adrs[0];

  const delai = sec => {
    if (!sec && sec !== 0) return "—";
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `+${m} min ${s > 0 ? s + " s" : ""}` : `+${s} s`;
  };

  const issue = rosc ? { label:`RACS à ${rosc.time}`, c:P.green, icon:"✅" }
              : deces ? { label: deces.label, c:P.textSoft, icon:"⬛" }
              : { label:"Non renseignée", c:P.amber, icon:"❓" };

  const etcoFirst = etco2List?.[0];
  const etcoLast  = etco2List?.[etco2List.length - 1];
  const etcoTrend = (etcoFirst && etcoLast && etco2List.length >= 2)
    ? (parseFloat(String(etcoLast.val).replace(",","."))-parseFloat(String(etcoFirst.val).replace(",",".")))
    : null;

  const Section = ({ icon, title, children, c }) => (
    <div style={{ background:P.surfaceAlt, borderRadius:12, padding:"12px 14px",
      border:`1px solid ${P.border}`, borderLeft:`3px solid ${c||P.border}` }}>
      <p style={{ margin:"0 0 8px", fontSize:10.5, fontWeight:700, color:c||P.textSoft,
        textTransform:"uppercase", letterSpacing:"0.12em", fontFamily:mono }}>{icon} {title}</p>
      {children}
    </div>
  );

  const Row = ({ label, value, sub, c }) => (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline",
      padding:"3px 0", borderBottom:`1px solid ${P.border}` }}>
      <span style={{ fontSize:12, color:P.textSoft }}>{label}</span>
      <div style={{ textAlign:"right" }}>
        <span style={{ fontSize:13, fontWeight:700, color:c||P.text, fontFamily:mono }}>{value}</span>
        {sub && <span style={{ fontSize:10, color:P.textSoft, marginLeft:4 }}>{sub}</span>}
      </div>
    </div>
  );

  return (
    <div style={{ position:"fixed", inset:0, zIndex:80, background:"rgba(0,0,0,0.55)",
      display:"flex", alignItems:"flex-end", fontFamily:sans }}>
      <div style={{ width:"100%", background:P.bg, borderRadius:"20px 20px 0 0",
        padding:"20px 16px 32px", maxHeight:"92vh", overflowY:"auto",
        boxShadow:"0 -16px 50px rgba(0,0,0,0.3)" }}>

        {/* En-tête */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
          <div style={{ width:42, height:42, borderRadius:13,
            background:`linear-gradient(135deg, ${P.violet}, ${P.violetText})`,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>📊</div>
          <div>
            <p style={{ margin:"0 0 1px", fontSize:9.5, fontWeight:700, color:P.violet,
              textTransform:"uppercase", letterSpacing:"0.14em", fontFamily:mono }}>Débrief d'équipe</p>
            <p style={{ margin:0, fontSize:18, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>
              Bilan de réanimation
            </p>
          </div>
        </div>

        {/* Issue */}
        <div style={{ background: rosc ? P.greenSoft : P.surfaceAlt,
          border:`1.5px solid ${rosc ? P.green : P.border}`, borderRadius:13, padding:"12px 16px", marginBottom:12,
          display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:22 }}>{issue.icon}</span>
          <div>
            <p style={{ margin:0, fontSize:9.5, fontWeight:700, color:issue.c, fontFamily:mono,
              textTransform:"uppercase", letterSpacing:"0.1em" }}>Issue</p>
            <p style={{ margin:0, fontSize:15, fontWeight:800, color:issue.c, fontFamily:disp }}>{issue.label}</p>
          </div>
          <div style={{ marginLeft:"auto", textAlign:"right" }}>
            <p style={{ margin:0, fontSize:9, color:P.textSoft, fontFamily:mono }}>Durée RCP</p>
            <p style={{ margin:0, fontSize:18, fontWeight:800, color:P.text, fontFamily:mono,
              fontVariantNumeric:"tabular-nums" }}>{fmtSec(totalSec)}</p>
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {/* Timing */}
          <Section icon="⏱" title="Timing" c={P.blue}>
            <Row label="No-flow" value={noFlow ? `${noFlow} min` : "Inconnu"} />
            <Row label="Low-flow" value={lowFlow ? `${lowFlow} min` : "—"} />
            {firstChoc && <Row label="1er choc" value={delai(firstChoc.sec)} c={P.blue} />}
            {firstAdr  && <Row label="1ère adrénaline" value={delai(firstAdr.sec)} c={P.blue} />}
            {rv && <Row label="Rythme initial SMUR" value={rv.id === "rv_fvtv" ? "FV/TV choquable" : rv.id === "rv_aesp" ? "AESP" : "Asystolie"} />}
          </Section>

          {/* Thérapeutiques */}
          <Section icon="💊" title="Thérapeutiques" c={P.rose}>
            <Row label="Chocs électriques" value={chocs.length || "Aucun"}
              sub={firstChoc ? `1er à ${delai(firstChoc.sec)}` : undefined} c={chocs.length > 0 ? P.rose : undefined} />
            <Row label="Adrénaline" value={adrs.length > 0 ? `${adrs.length} × 1 mg = ${adrs.length} mg` : "Non administrée"}
              c={adrs.length > 0 ? P.rose : undefined} />
            {cords.length > 0 && <Row label="Amiodarone" value={cords.map(e=>e.label).join(" + ")} c={P.amber} />}
          </Section>

          {/* Qualité MCE */}
          {(ccfEnabled || (etco2List && etco2List.length > 0)) && (
            <Section icon="❤️" title="Qualité MCE" c={P.green}>
              {ccfEnabled && (
                <Row label="Fraction de compression (CCF)"
                  value={`${ccfPct}%`}
                  sub={ccfPct >= 60 ? "✅ objectif atteint" : "⚠️ objectif > 60%"}
                  c={ccfPct >= 60 ? P.greenText : P.amberText} />
              )}
              {etco2List && etco2List.length > 0 && (
                <>
                  <Row label="EtCO₂ initial" value={`${etcoFirst?.val} mmHg`} />
                  <Row label="EtCO₂ final" value={`${etcoLast?.val} mmHg`}
                    sub={etcoTrend !== null ? (etcoTrend > 0 ? `↑ +${etcoTrend.toFixed(1)}` : `↓ ${etcoTrend.toFixed(1)}`) : undefined}
                    c={etcoTrend !== null && etcoTrend > 0 ? P.greenText : P.roseText} />
                </>
              )}
            </Section>
          )}
        </div>

        {/* Bouton clôturer */}
        <button onClick={onClose}
          style={{ width:"100%", background:`linear-gradient(135deg, ${P.violet}, ${P.violetText})`,
            border:"none", borderRadius:14, color:"#fff", fontSize:16, fontWeight:800, fontFamily:disp,
            padding:"18px", cursor:"pointer", marginTop:18,
            boxShadow:`0 8px 22px color-mix(in srgb, ${P.violet} 35%, transparent)` }}>
          ✓ Clôturer la réanimation
        </button>
      </div>
    </div>
  );
}

// ── APP ────────────────────────────────────────────────────────────────────────
// ── Algorithme ALS interactif ────────────────────────────────────────────────
// ── Dashboard Analytics ──────────────────────────────────────────────────────
function DashboardView({ archives, onClose, P, mono, sans, disp, fmtSec }) {
  const [filterType, setFilterType] = useState("all"); // all | Adulte | Traumatique | Pédiatrique
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");

  const filteredArchives = archives.filter(a => {
    const type = a.type || "Adulte";
    if (filterType !== "all" && type !== filterType) return false;
    if (dateFrom && a.archivedAt && new Date(a.archivedAt) < new Date(dateFrom)) return false;
    if (dateTo && a.archivedAt && new Date(a.archivedAt) > new Date(dateTo + "T23:59:59")) return false;
    return true;
  });
  const hasActiveFilter = filterType !== "all" || dateFrom || dateTo;

  const stats = filteredArchives.map(a => {
    const evts = a.props?.events || [];
    const start = evts.find(e => e.id === "start")?.sec || 0;
    const firstChoc = evts.find(e => e.id === "choc");
    const firstAdr  = evts.find(e => e.id === "adr");
    const rosc      = evts.find(e => e.id === "rosc");
    // Rythme initial : priorité au DSA pré-SMUR (Transmission), sinon 1ère analyse SMUR
    const dsaRythme = a.props?.trans?.rythmeDSA;
    let initialRhythm = null;
    if (dsaRythme === "choquable") initialRhythm = "choquable";
    else if (dsaRythme === "nonChoquable") initialRhythm = "nonChoquable";
    else {
      const firstRv = evts.find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
      if (firstRv?.id === "rv_fvtv") initialRhythm = "choquable";
      else if (firstRv?.id === "rv_aesp" || firstRv?.id === "rv_asy") initialRhythm = "nonChoquable";
    }
    const patInitials = initials(a.props?.patient?.nom, a.props?.patient?.prenom);
    return {
      outcome:    a.outcome,
      durationSec: a.durationSec || 0,
      type:       a.type || "Adulte",
      label:      patInitials || a.label || "Sans nom",
      date:       a.archivedAt,
      delaiChoc:  firstChoc ? firstChoc.sec - start : null,
      delaiAdr:   firstAdr  ? firstAdr.sec  - start : null,
      noFlowMin:  a.props?.noFlow ? parseFloat(String(a.props.noFlow).replace(",",".")) : null,
      lowFlowMin: a.props?.lowFlow ? parseFloat(String(a.props.lowFlow).replace(",",".")) : null,
      initialRhythm,
      mceTemoin:  a.props?.trans?.mceTemoin || null,
      nbChocs:    evts.filter(e => e.id === "choc").length,
      nbAdrs:     evts.filter(e => e.id === "adr").length,
      roscSec:    rosc ? rosc.sec - start : null,
      // Rétro-compatible : les archives antérieures à ce champ n'ont pas
      // `recidive` enregistré, mais l'info est déjà présente dans leur chronologie
      recidive:   a.recidive ?? evts.some(e => e.id === "re_arret"),
      lieu:       LIEUX_INTERVENTION.find(l => l.id === (a.props?.trans?.lieu || a.props?.patient?.lieu))?.label || null,
    };
  });

  // Export CSV — toujours basé sur les cas filtrés actuellement affichés
  // Données communes aux deux exports (CSV et Excel)
  const buildExportRows = () => {
    const headers = ["Date","Type","Libellé","Issue","Récidive","Durée (s)","Délai 1er choc (s)","Délai 1ère adré (s)","Nb chocs","Nb doses adré","RACS à (s)","No-flow (min)","Low-flow (min)","Rythme initial","RCP témoin","Lieu"];
    const rows = stats.map(s => [
      s.date ? new Date(s.date).toLocaleString("fr-FR") : "",
      s.type, s.label, s.outcome, s.recidive ? "Oui" : "Non", s.durationSec,
      s.delaiChoc ?? "", s.delaiAdr ?? "", s.nbChocs, s.nbAdrs, s.roscSec ?? "",
      s.noFlowMin ?? "", s.lowFlowMin ?? "",
      s.initialRhythm === "choquable" ? "Choquable" : s.initialRhythm === "nonChoquable" ? "Non choquable" : "",
      s.mceTemoin || "",
      s.lieu || "",
    ]);
    return { headers, rows };
  };

  const exportCsv = () => {
    const { headers, rows } = buildExportRows();
    const csv = [headers, ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(";"))
      .join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type:"text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `copilote-acr-stats-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const [exportingXlsx, setExportingXlsx] = useState(false);
  const exportExcel = async () => {
    setExportingXlsx(true);
    try {
      const XLSX = await import("xlsx");
      const { headers, rows } = buildExportRows();
      // Colonnes numériques converties en vrais nombres (pas du texte) — pour trier/filtrer/
      // calculer directement dans Excel sans reformater à la main.
      const numericCols = new Set([5,6,7,8,9,10,11,12]); // Durée, délais, nb chocs/doses, RACS à, no-flow, low-flow
      const aoa = [headers, ...rows.map(r => r.map((v, i) => {
        if (numericCols.has(i) && v !== "" && !isNaN(v)) return Number(v);
        return v;
      }))];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = headers.map((h, i) => ({ wch: Math.max(h.length, i === 2 ? 14 : 10) }));
      ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:aoa.length-1, c:headers.length-1} }) };

      // ── Onglet "Résumé" — statistiques déjà agrégées, prêtes pour un graphique
      // Excel en 2 clics (sélectionner un tableau → Insertion → Graphique recommandé) ──
      const monthlyMap = {};
      stats.forEach(s => {
        if (!s.date) return;
        const month = s.date.slice(0, 7); // YYYY-MM
        if (!monthlyMap[month]) monthlyMap[month] = { total:0, racs:0 };
        monthlyMap[month].total++;
        if (s.outcome === "RACS") monthlyMap[month].racs++;
      });
      const monthlyRows = Object.keys(monthlyMap).sort().map(m => [
        m, monthlyMap[m].total, monthlyMap[m].racs,
        monthlyMap[m].total ? Math.round(monthlyMap[m].racs / monthlyMap[m].total * 100) : 0,
      ]);

      const resumeAoa = [
        ["Copilote ACR — Résumé statistique"],
        ["Généré le", new Date().toLocaleString("fr-FR")],
        ["Période", hasActiveFilter ? `${dateFrom || "…"} → ${dateTo || "…"} · ${filterType === "all" ? "Tous types" : filterType}` : "Toutes périodes, tous types"],
        [],
        ["VUE D'ENSEMBLE"],
        ["Nombre de cas", n],
        ["Taux de RACS global (%)", roscRate],
        ["Durée moyenne RCP (min)", n > 0 ? Math.round(avgDur / 60 * 10) / 10 : ""],
        ["Délai moyen 1er choc (min)", avgDelaiChoc !== null ? Math.round(avgDelaiChoc / 60 * 10) / 10 : ""],
        ["Délai moyen 1ère adrénaline (min)", avgDelaiAdr !== null ? Math.round(avgDelaiAdr / 60 * 10) / 10 : ""],
        ["No-flow moyen (min)", avgNoFlow !== null ? Math.round(avgNoFlow * 10) / 10 : ""],
        ["Low-flow moyen (min)", avgLowFlow !== null ? Math.round(avgLowFlow * 10) / 10 : ""],
        ["Taux de récidive après RACS (%)", recidiveRate ?? ""],
        [],
        ["RÉPARTITION PAR TYPE", "Nb cas"],
        ["Adulte", stats.filter(s => s.type === "Adulte").length],
        ["Traumatique", stats.filter(s => s.type === "Traumatique").length],
        ["Pédiatrique", stats.filter(s => s.type === "Pédiatrique").length],
        [],
        ["RACS SELON RYTHME INITIAL", "Taux (%)", "Nb cas"],
        ["Choquable (FV/TV)", rhythmChocable?.rate ?? "", rhythmChocable?.count ?? 0],
        ["Non choquable (AESP/Asystolie)", rhythmNonChocable?.rate ?? "", rhythmNonChocable?.count ?? 0],
        [],
        ["RACS SELON RCP TÉMOIN", "Taux (%)", "Nb cas"],
        ["Avec RCP témoin", rcpTemoinOui?.rate ?? "", rcpTemoinOui?.count ?? 0],
        ["Sans RCP témoin", rcpTemoinNon?.rate ?? "", rcpTemoinNon?.count ?? 0],
        [],
        ["ÉVOLUTION MENSUELLE", "Nb cas", "Nb RACS", "Taux RACS (%)"],
        ...(monthlyRows.length ? monthlyRows : [["Aucune donnée datée", 0, 0, 0]]),
      ];
      const wsResume = XLSX.utils.aoa_to_sheet(resumeAoa);
      wsResume["!cols"] = [{ wch: 32 }, { wch: 14 }, { wch: 12 }, { wch: 14 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsResume, "Résumé");
      XLSX.utils.book_append_sheet(wb, ws, "Cas archivés");
      XLSX.writeFile(wb, `copilote-acr-stats-${new Date().toISOString().slice(0,10)}.xlsx`);
    } catch (e) {
      alert("Export Excel indisponible — le module xlsx n'est peut-être pas installé sur cette version de l'app.");
    } finally {
      setExportingXlsx(false);
    }
  };

  const n = stats.length;
  if (archives.length === 0) return (
    <div style={{ position:"fixed", inset:0, zIndex:90, background:P.bg,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      fontFamily:sans, padding:20 }}>
      <p style={{ fontSize:40, margin:"0 0 16px" }}>📊</p>
      <p style={{ fontSize:18, fontWeight:700, color:P.text, margin:"0 0 8px" }}>Aucune donnée</p>
      <p style={{ fontSize:13, color:P.textSoft, textAlign:"center" }}>
        Les statistiques apparaissent après votre premier cas archivé.
      </p>
      <button onClick={onClose} style={{ marginTop:24, background:P.rose, border:"none",
        borderRadius:12, color:"#fff", padding:"12px 28px", fontSize:14, fontWeight:700,
        cursor:"pointer", fontFamily:sans }}>Fermer</button>
    </div>
  );

  const roscCases   = stats.filter(s => s.outcome === "RACS");
  const deathCases  = stats.filter(s => s.outcome === "Décès");
  const roscRate    = n > 0 ? Math.round(roscCases.length / n * 100) : 0;
  const recidiveCases = stats.filter(s => s.recidive);
  // Dénominateur : cas ayant obtenu au moins un RACS à un moment (RACS final,
  // OU récidive constatée — puisqu'une récidive implique un RACS antérieur,
  // même si l'événement a ensuite été retiré de la chronologie par le bouton dédié)
  const everHadRosc = stats.filter(s => s.outcome === "RACS" || s.recidive);
  const recidiveRate = everHadRosc.length ? Math.round(recidiveCases.length / everHadRosc.length * 100) : null;
  const avgDur      = n > 0 ? stats.reduce((a,s) => a + s.durationSec, 0) / n : 0;
  const chocStats   = stats.filter(s => s.delaiChoc !== null);
  const avgDelaiChoc= chocStats.length ? chocStats.reduce((a,s) => a + s.delaiChoc, 0) / chocStats.length : null;
  const adrStats    = stats.filter(s => s.delaiAdr !== null);
  const avgDelaiAdr = adrStats.length ? adrStats.reduce((a,s) => a + s.delaiAdr, 0) / adrStats.length : null;
  const avgChocs    = n > 0 ? stats.reduce((a,s) => a + s.nbChocs, 0) / n : 0;
  const avgAdrs     = n > 0 ? stats.reduce((a,s) => a + s.nbAdrs, 0) / n : 0;

  // No-flow / Low-flow moyens
  const noFlowVals = stats.map(s => s.noFlowMin).filter(v => v !== null && !isNaN(v));
  const lowFlowVals = stats.map(s => s.lowFlowMin).filter(v => v !== null && !isNaN(v));
  const avgNoFlow  = noFlowVals.length  ? noFlowVals.reduce((a,b)=>a+b,0)  / noFlowVals.length  : null;
  const avgLowFlow = lowFlowVals.length ? lowFlowVals.reduce((a,b)=>a+b,0) / lowFlowVals.length : null;

  // Taux de RACS selon le rythme initial (choquable vs non choquable)
  const rateFor = (predicate) => {
    const grp = stats.filter(predicate);
    if (grp.length === 0) return null;
    return { rate: Math.round(grp.filter(s => s.outcome === "RACS").length / grp.length * 100), count: grp.length };
  };
  const rhythmChocable    = rateFor(s => s.initialRhythm === "choquable");
  const rhythmNonChocable = rateFor(s => s.initialRhythm === "nonChoquable");

  // Taux de RACS selon RCP par témoin avant l'arrivée du SMUR
  const rcpTemoinOui = rateFor(s => s.mceTemoin === "Oui");
  const rcpTemoinNon = rateFor(s => s.mceTemoin === "Non");

  const Kard = ({ icon, label, value, sub, color }) => (
    <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14,
      padding:"14px 14px 12px", display:"flex", flexDirection:"column", gap:4 }}>
      <p style={{ margin:0, fontSize:11, color:color || P.textSoft, fontWeight:700,
        textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>{icon} {label}</p>
      <p style={{ margin:0, fontSize:24, fontWeight:900, color:color || P.text,
        fontFamily:mono, letterSpacing:"-0.02em", lineHeight:1 }}>{value}</p>
      {sub && <p style={{ margin:0, fontSize:10.5, color:P.textSoft }}>{sub}</p>}
    </div>
  );

  return (
    <div style={{ position:"fixed", inset:0, zIndex:90, background:P.bg,
      display:"flex", flexDirection:"column", fontFamily:sans, overflowY:"auto", overflowX:"hidden" }}>
      {/* Header */}
      <div style={{ position:"sticky", top:0, background:P.bg, zIndex:1,
        borderBottom:`1px solid ${P.border}`, padding:"14px 16px",
        display:"flex", alignItems:"center", gap:12 }}>
        <div style={{ width:38, height:38, borderRadius:11,
          background:`linear-gradient(135deg, ${P.blue}, ${P.blueText})`,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>📊</div>
        <div style={{ flex:1 }}>
          <p style={{ margin:0, fontSize:9, fontWeight:700, color:P.blue, fontFamily:mono,
            textTransform:"uppercase", letterSpacing:"0.12em" }}>Copilote ACR</p>
          <p style={{ margin:0, fontSize:17, fontWeight:800, color:P.text, fontFamily:disp }}>
            Dashboard — {n} cas{hasActiveFilter ? ` sur ${archives.length}` : " archivés"}
          </p>
        </div>
        <button onClick={onClose} style={{ background:"transparent", border:"none",
          color:P.textSoft, fontSize:22, cursor:"pointer" }}>×</button>
      </div>

      {/* Alerte proactive : approche du plafond de stockage local */}
      {archives.length >= ARCHIVE_CAP * 0.9 && (
        <div style={{ margin:"12px 14px 0", background:`color-mix(in srgb, ${P.amber} 12%, ${P.surface})`,
          border:`1.5px solid ${P.amber}`, borderRadius:13, padding:"11px 13px",
          display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:18, flexShrink:0 }}>⚠️</span>
          <div style={{ flex:1, minWidth:0 }}>
            <p style={{ margin:0, fontSize:12, fontWeight:700, color:P.amberText }}>
              {archives.length}/{ARCHIVE_CAP} cas archivés — proche de la limite de stockage local
            </p>
            <p style={{ margin:"2px 0 0", fontSize:10.5, color:P.amberText, opacity:0.85 }}>
              Au-delà, les cas les plus anciens seront supprimés automatiquement. Exportez une sauvegarde pour ne rien perdre.
            </p>
          </div>
          <button onClick={exportBackup}
            style={{ flexShrink:0, background:P.amber, border:"none", borderRadius:9, color:"#fff",
              padding:"8px 11px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
            Exporter
          </button>
        </div>
      )}

      {/* Barre de filtres */}
      <div style={{ padding:"12px 14px 0", display:"flex", flexDirection:"column", gap:8 }}>
        <div style={{ display:"flex", gap:6, overflowX:"auto" }}>
          {[["all","Tous"],["Adulte","Adulte"],["Traumatique","Trauma"],["Pédiatrique","Pédia"]].map(([id,label]) => (
            <button key={id} onClick={() => setFilterType(id)}
              style={{ flexShrink:0, padding:"7px 13px", borderRadius:10, fontSize:12, fontWeight:700,
                border:`1.5px solid ${filterType===id ? P.blue : P.border}`,
                background: filterType===id ? P.blue : P.surface,
                color: filterType===id ? "#fff" : P.textMid,
                cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ flex:1, minWidth:0, background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:9,
              padding:"7px 8px", fontSize:12, fontFamily:mono, color:P.text, outline:"none", boxSizing:"border-box" }} />
          <span style={{ fontSize:11, color:P.textSoft, flexShrink:0 }}>→</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ flex:1, minWidth:0, background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:9,
              padding:"7px 8px", fontSize:12, fontFamily:mono, color:P.text, outline:"none", boxSizing:"border-box" }} />
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          {hasActiveFilter && (
            <button onClick={() => { setFilterType("all"); setDateFrom(""); setDateTo(""); }}
              style={{ flexShrink:0, background:"transparent", border:"none", color:P.roseText,
                fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:sans, padding:"7px 4px" }}>
              ✕ Réinitialiser
            </button>
          )}
          <div style={{ flex:1 }} />
          <button onClick={exportCsv} disabled={n===0}
            style={{ flexShrink:0, background: n===0 ? P.surfaceAlt : P.surface, border:`1.5px solid ${n===0?P.border:P.green}`,
              borderRadius:9, color: n===0 ? P.textSoft : P.greenText, padding:"8px 10px", fontSize:12,
              fontWeight:700, cursor: n===0 ? "default" : "pointer", fontFamily:sans,
              display:"flex", alignItems:"center", gap:5, whiteSpace:"nowrap" }}>
            ⬇ CSV
          </button>
          <button onClick={exportExcel} disabled={n===0 || exportingXlsx}
            style={{ flexShrink:0, background: n===0 ? P.surfaceAlt : P.green, border:"none",
              borderRadius:9, color: n===0 ? P.textSoft : "#fff", padding:"8px 12px", fontSize:12,
              fontWeight:700, cursor: n===0 ? "default" : "pointer", fontFamily:sans,
              display:"flex", alignItems:"center", gap:5, whiteSpace:"nowrap" }}>
            {exportingXlsx ? "…" : "⬇ Excel"}
          </button>
        </div>
      </div>

      {n === 0 ? (
        <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center",
          justifyContent:"center", padding:40, textAlign:"center" }}>
          <p style={{ fontSize:32, margin:"0 0 12px" }}>🔍</p>
          <p style={{ fontSize:15, fontWeight:700, color:P.text, margin:"0 0 6px" }}>Aucun cas ne correspond</p>
          <p style={{ fontSize:12.5, color:P.textSoft }}>Essayez d'élargir la période ou le type sélectionné.</p>
        </div>
      ) : (
      <div style={{ padding:"16px 14px 40px", display:"flex", flexDirection:"column", gap:14 }}>

        {/* Taux RACS — grand indicateur */}
        <div style={{ background:`linear-gradient(135deg, ${P.greenSoft}, ${P.surface})`,
          border:`1.5px solid ${P.green}`, borderRadius:18, padding:"18px 18px 16px" }}>
          <p style={{ margin:"0 0 4px", fontSize:10, fontWeight:700, color:P.greenText,
            textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>
            💚 Taux de RACS global
          </p>
          <div style={{ display:"flex", alignItems:"flex-end", gap:10 }}>
            <p style={{ margin:0, fontSize:52, fontWeight:900, color:P.greenText,
              fontFamily:mono, lineHeight:1 }}>{roscRate}%</p>
            <div style={{ paddingBottom:6 }}>
              <p style={{ margin:0, fontSize:13, color:P.greenText }}>
                {roscCases.length} RACS · {deathCases.length} Décès · {n - roscCases.length - deathCases.length} N/R
              </p>
              <p style={{ margin:0, fontSize:11, color:P.greenText, opacity:0.7 }}>
                sur {n} arrêts archivés
              </p>
            </div>
          </div>
          {/* Barre */}
          <div style={{ marginTop:12, height:8, background:`${P.green}30`, borderRadius:4, overflow:"hidden" }}>
            <div style={{ width:`${roscRate}%`, height:"100%",
              background:P.green, borderRadius:4, transition:"width 0.5s" }} />
          </div>
        </div>

        {/* Taux de récidive après RACS */}
        {recidiveRate !== null && (
          <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14, padding:"12px 14px",
            display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:22 }}>↩️</span>
            <div style={{ flex:1 }}>
              <p style={{ margin:0, fontSize:11.5, fontWeight:700, color:P.text }}>
                {recidiveRate}% de récidive d'arrêt après RACS
              </p>
              <p style={{ margin:0, fontSize:10.5, color:P.textSoft }}>
                {recidiveCases.length} cas sur {everHadRosc.length} ayant obtenu un RACS
              </p>
            </div>
          </div>
        )}

        {/* Grid stats */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <Kard icon="⏱" label="Durée moy. RCP" value={fmtSec(Math.round(avgDur))} />
          <Kard icon="⚡" label="Délai 1er choc"
            value={avgDelaiChoc ? fmtSec(Math.round(avgDelaiChoc)) : "—"}
            sub={chocStats.length + " cas avec choc"} color={P.blueText} />
          <Kard icon="💉" label="Délai 1ère adré"
            value={avgDelaiAdr ? fmtSec(Math.round(avgDelaiAdr)) : "—"}
            sub={adrStats.length + " cas"} color={P.roseText} />
          <Kard icon="💊" label="Adrénaline/cas moy."
            value={`${avgAdrs.toFixed(1)} dose${avgAdrs >= 1.5 ? "s" : ""}`}
            sub={`${avgChocs.toFixed(1)} choc(s)`} />
        </div>
        <p style={{ margin:"-4px 0 0", fontSize:10, color:P.textSoft, textAlign:"center", lineHeight:1.4 }}>
          Nombre de doses, pas de mg — les cas adulte et pédiatrique (dosés au poids) sont mélangés dans cette moyenne
        </p>

        {/* No-flow / Low-flow */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <Kard icon="⏳" label="No-flow moyen"
            value={avgNoFlow !== null ? `${avgNoFlow.toFixed(1)} min` : "—"}
            sub={`${noFlowVals.length} cas renseignés`} color={P.amberText} />
          <Kard icon="🔄" label="Low-flow moyen"
            value={avgLowFlow !== null ? `${avgLowFlow.toFixed(1)} min` : "—"}
            sub={`${lowFlowVals.length} cas renseignés`} color={P.tealText} />
        </div>

        {/* Taux de RACS selon le rythme initial */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14, padding:"14px" }}>
          <p style={{ margin:"0 0 10px", fontSize:10, fontWeight:700, color:P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>
            Taux de RACS selon le rythme initial
          </p>
          {!rhythmChocable && !rhythmNonChocable ? (
            <p style={{ margin:0, fontSize:12, color:P.textSoft }}>Aucun rythme initial renseigné sur cette période.</p>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {[["Choquable (FV/TV)", rhythmChocable, P.rose],["Non choquable (AESP/Asystolie)", rhythmNonChocable, P.slate]].map(([label, g, c]) => (
                <div key={label}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                    <span style={{ fontSize:11.5, color:P.text }}>{label}</span>
                    <span style={{ fontSize:11.5, fontWeight:700, color:c, fontFamily:mono }}>
                      {g ? `${g.rate}% (${g.count} cas)` : "—"}
                    </span>
                  </div>
                  <div style={{ height:6, background:`${c}25`, borderRadius:3, overflow:"hidden" }}>
                    <div style={{ width:`${g?.rate||0}%`, height:"100%", background:c, borderRadius:3, transition:"width 0.5s" }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Taux de RACS selon RCP par témoin */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14, padding:"14px" }}>
          <p style={{ margin:"0 0 10px", fontSize:10, fontWeight:700, color:P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>
            Taux de RACS selon RCP par témoin
          </p>
          {!rcpTemoinOui && !rcpTemoinNon ? (
            <p style={{ margin:0, fontSize:12, color:P.textSoft }}>Aucun contexte témoin renseigné sur cette période.</p>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {[["RCP réalisée par témoin", rcpTemoinOui, P.green],["Pas de RCP témoin", rcpTemoinNon, P.slate]].map(([label, g, c]) => (
                <div key={label}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                    <span style={{ fontSize:11.5, color:P.text }}>{label}</span>
                    <span style={{ fontSize:11.5, fontWeight:700, color:c, fontFamily:mono }}>
                      {g ? `${g.rate}% (${g.count} cas)` : "—"}
                    </span>
                  </div>
                  <div style={{ height:6, background:`${c}25`, borderRadius:3, overflow:"hidden" }}>
                    <div style={{ width:`${g?.rate||0}%`, height:"100%", background:c, borderRadius:3, transition:"width 0.5s" }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <p style={{ margin:"10px 0 0", fontSize:9.5, color:P.textSoft, fontStyle:"italic" }}>
            Taux de RACS dans chaque groupe — reflète la valeur de la RCP précoce, pas une garantie individuelle.
          </p>
        </div>

        {/* Répartition par lieu d'intervention */}
        {(() => {
          const lieuStats = LIEUX_INTERVENTION
            .map(l => ({ label: l.label, icon: l.icon, count: stats.filter(s => s.lieu === l.label).length }))
            .filter(l => l.count > 0)
            .sort((a, b) => b.count - a.count);
          if (lieuStats.length === 0) return null;
          const maxCount = Math.max(...lieuStats.map(l => l.count));
          return (
            <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14, padding:"14px" }}>
              <p style={{ margin:"0 0 10px", fontSize:10, fontWeight:700, color:P.textSoft,
                textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>
                Répartition par lieu d'intervention
              </p>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {lieuStats.map(l => (
                  <div key={l.label}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                      <span style={{ fontSize:11.5, color:P.text }}>{l.icon} {l.label}</span>
                      <span style={{ fontSize:11.5, fontWeight:700, color:P.blueText, fontFamily:mono }}>
                        {l.count} cas
                      </span>
                    </div>
                    <div style={{ height:6, background:`${P.blue}25`, borderRadius:3, overflow:"hidden" }}>
                      <div style={{ width:`${(l.count/maxCount)*100}%`, height:"100%", background:P.blue, borderRadius:3, transition:"width 0.5s" }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Répartition types */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14, padding:"14px" }}>
          <p style={{ margin:"0 0 10px", fontSize:10, fontWeight:700, color:P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>
            Répartition des cas
          </p>
          {[
            { label:"Adulte extra-hospitalier", count:stats.filter(s=>s.type==="Adulte").length, c:P.blue },
            { label:"ACR Traumatique",           count:stats.filter(s=>s.type==="Traumatique").length, c:P.amber },
            { label:"Pédiatrie",                 count:stats.filter(s=>s.type==="Pédiatrique").length, c:P.violet },
          ].filter(r => r.count > 0).map(r => (
            <div key={r.label} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
              <div style={{ width:8, height:8, borderRadius:2, background:r.c, flexShrink:0 }} />
              <p style={{ margin:0, fontSize:12, color:P.text, flex:1 }}>{r.label}</p>
              <p style={{ margin:0, fontSize:12, fontWeight:700, color:r.c, fontFamily:mono }}>
                {r.count} ({Math.round(r.count/n*100)}%)
              </p>
            </div>
          ))}
        </div>

        {/* Liste des cas récents */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14, overflow:"hidden" }}>
          <p style={{ margin:0, padding:"12px 14px 10px", fontSize:10, fontWeight:700,
            color:P.textSoft, textTransform:"uppercase", letterSpacing:"0.1em",
            fontFamily:mono, borderBottom:`1px solid ${P.borderSoft}` }}>
            Derniers cas
          </p>
          {stats.slice(0, 15).map((s, i) => {
            const isRasc = s.outcome === "RACS";
            const isDeath = s.outcome === "Décès";
            const dateStr = s.date ? new Date(s.date).toLocaleDateString("fr-FR", { day:"2-digit", month:"short", year:"2-digit" }) : "—";
            return (
              <div key={i} style={{ display:"flex", gap:10, alignItems:"center",
                padding:"10px 14px", borderBottom: i<14 ? `1px solid ${P.borderSoft}` : "none",
                background: i%2===0 ? P.surface : P.surfaceAlt }}>
                <span style={{ fontSize:16 }}>{isRasc ? "💚" : isDeath ? "🕊️" : "—"}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{ margin:0, fontSize:12.5, fontWeight:600, color:P.text,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {s.label}
                  </p>
                  <p style={{ margin:0, fontSize:10.5, color:P.textSoft }}>
                    {s.type} · {dateStr}
                  </p>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  <p style={{ margin:0, fontSize:11.5, fontWeight:700, fontFamily:mono,
                    color: isRasc ? P.greenText : isDeath ? P.textSoft : P.amberText }}>
                    {s.outcome}
                  </p>
                  <p style={{ margin:0, fontSize:10.5, color:P.textSoft }}>
                    {fmtSec(s.durationSec)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <p style={{ margin:0, textAlign:"center", fontSize:10.5, color:P.textSoft, lineHeight:1.5 }}>
          Données anonymisées · Stockées localement sur cet appareil
        </p>
      </div>
      )}
    </div>
  );
}

function App() {
  const [pat, setPat] = useLocalState("acr_adulte_pat", { nom:"", prenom:"", ddn:"", age:"", sexe:"", temp:"", atcd:"", traitement:"", histoire:"", mecanisme:"", lieu:"" });
  const sf = k => v => setPat(p => ({ ...p, [k]: v }));

  // Durées manuelles no-flow / low-flow (en minutes)
  const [acrTime,    setAcrTime]    = useLocalState("acr_adulte_acrTime", "");
  const [noFlowMin,  setNoFlowMin]  = useLocalState("acr_adulte_noFlow", "");
  const [lowFlowMin, setLowFlowMin] = useLocalState("acr_adulte_lowFlow", "");
  const [lowFlowStart, setLowFlowStart] = useLocalState("acr_adulte_lowFlowStart", "");

  // IOT data
  const [iot, setIot] = useLocalState("acr_adulte_iot", { cormack:"", sonde:"", repere:"", capno:"", difficile:false, techniquesDifficiles:[], nbTentatives:"", inhalation:false });
  const [etco2List, setEtco2List] = useLocalState("acr_adulte_etco2", []);
  const [modalEtco2, setModalEtco2] = useState(false);
  const [etco2Val, setEtco2Val] = useState("");
  const [etco2Open, setEtco2Open] = useState(true);
  // Métronome + undo
  const [metronomeMuted, setMetronomeMuted] = useState(false);
  const [showRythmFlash, setShowRythmFlash] = useState(false);
  // Undo (annuler le dernier événement)
  const [undoToast, setUndoToast] = useState(null); // { event, label, key }
  const undoLast = () => {
    const undoable = events.filter(e => e.id !== "start");
    if (undoable.length === 0) return;
    const last = undoable[undoable.length - 1];
    setEvents(prev => prev.filter(e => e !== last));
    setUndoToast({ event: last, label: last.label, key: Date.now() });
    try { if (navigator.vibrate) navigator.vibrate(20); } catch(e) {}
  };
  const restoreEvent = () => {
    if (!undoToast) return;
    setEvents(prev => [...prev, undoToast.event]);
    setUndoToast(null);
  };
  useEffect(() => {
    if (!undoToast) return;
    const t = setTimeout(() => setUndoToast(null), 5000);
    return () => clearTimeout(t);
  }, [undoToast]);
  // Hémodynamique post-RACS
  // Hémodynamique post-RACS
  const [hemoList, setHemoList] = useLocalState("acr_adulte_hemo", []);
  const [amineList, setAmineList] = useLocalState("acr_adulte_amines", []);
  // Débrief post-arrêt
  const [showDebrief, setShowDebrief] = useState(false);
  const [modalCriteres, setModalCriteres] = useState(false);
  const [modalOctaplas, setModalOctaplas] = useState(false);
  const [battForm, setBattForm] = useState({ age:"", pas:"", glasgow:"", fr:"", spo2:"", fc:"", penetrant:false, hcin:false });
  const [modalHemo, setModalHemo] = useState(false);
  const [modalAmine, setModalAmine] = useState(false);
  const [hemoOpen, setHemoOpen] = useState(true);
  const [hemoForm, setHemoForm] = useState({ pas:"", pad:"", fc:"" });
  const [amineForm, setAmineForm] = useState({ type:"Noradrénaline", dose:"", unit:"mg/h" });
  // CCF (fraction de compression) — actif seulement si réglage activé
  const [ccfPausedTotal, setCcfPausedTotal] = useLocalState("acr_adulte_ccfPaused", 0);
  const [ccfPausedSince, setCcfPausedSince] = useLocalState("acr_adulte_ccfSince", null);
  const si = k => v => setIot(p => ({ ...p, [k]: v }));

  const [started,     setStarted]     = useLocalState("acr_adulte_started", false);
  const [running,     setRunning]     = useState(false); // pas persisté : repart en pause
  const [secStored,   setSecStored]   = useLocalState("acr_adulte_sec", 0);
  const [sec,         setSec]         = useTimer(running);
  // Restaurer le chrono au premier rendu
  useEffect(() => { if (secStored > 0 && sec === 0) setSec(secStored); }, []);
  useEffect(() => { setSecStored(sec); }, [sec]);

  const [cycleOffset, setCycleOffset] = useLocalState("acr_adulte_cycleOffset", 0);
  const [events,      setEvents]      = useLocalState("acr_adulte_events", []);
  const [alert,       setAlert]       = useState(null);
  const [showPdf,     setShowPdf]     = useState(false);
  const [showLog,     setShowLog]     = useState(false);

  const [modalCord,   setModalCord]   = useState(false);
  const [modalDeces,  setModalDeces]  = useState(false);
  const [omlStep,     setOmlStep]     = useState(0); // 0=choix, 1=oml
  const [decesRemisA, setDecesRemisA] = useState(""); // champ libre sans OML

  // Wake Lock — empêche le verrouillage écran pendant la réa
  useWakeLock(started);
  const [omlTxt,      setOmlTxt]      = useState("");
  const [modalIot,    setModalIot]    = useState(false);
  const [modalFast,   setModalFast]   = useState(false);
  const [modalNote,   setModalNote]   = useState(false);
  const [noteText,    setNoteText]    = useState("");
  const [showNote,    setShowNote]    = useState(false);
  // Transmission équipes pré-SMUR
  const [modalTrans,  setModalTrans]  = useState(false);
  const [trans, setTrans] = useLocalState("acr_adulte_trans", {
    hEffondrement:"", temoin:"", mceTemoin:"", lieu:"",
    hArriveePompiers:"", hPoseDSA:"", h1erChoc:"",
    chocsPompiers:0, chocsPublic:0, rythmeDSA:"", gestesSecouristes:"",
    note:"", saved:false,
  });
  const st = k => v => setTrans(p => ({ ...p, [k]: v }));

  // ── Mode équipe multi-device ──
  const [modalTeam, setModalTeam] = useState(false);
  const [teamJoinCode, setTeamJoinCode] = useState("");
  const [teamJoinError, setTeamJoinError] = useState("");
  const team = useTeamSync({ events, setEvents, acrTime, setAcrTime, noFlowMin, setNoFlowMin,
    lowFlowMin, setLowFlowMin, trans, setTrans });

  // Minuteur Adrénaline (timestamp absolu pour survivre aux navigations)
  const [adrTimerStart, setAdrTimerStart] = useLocalState("acr_adulte_adrStart", 0);
  // Réglages globaux lus ici pour être disponibles dans les effets ci-dessous
  const [adrIntervalGlobal, setAdrIntervalGlobal] = useLocalState("acr_adr_interval", 4);
  const [voiceWakeWord, setVoiceWakeWord] = useLocalState("acr_voice_wakeword", "Alpha");
  const [metronomeEnabled, setMetronomeEnabled] = useLocalState("acr_metronome_enabled", false);

  // Onglets : "actions" | "etiologie" | "therap"
  const [mainTab,        setMainTab]        = useLocalState("acr_adulte_mainTab", "actions");
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [suspectedAd,    setSuspectedAd]    = useLocalState("acr_adulte_suspected", []);
  const [modalEcmo,      setModalEcmo]      = useState(false);
  const [modalDdac,      setModalDdac]      = useState(false);

  const [fastResult,  setFastResult]  = useState("");
  const [modalRythme, setModalRythme] = useState(false);
  const [modalVvp,    setModalVvp]    = useState(false);
  const [modalElectrodes, setModalElectrodes] = useState(false);
  const [modalRacs,   setModalRacs]   = useState(false);
  const [modalChoc,   setModalChoc]   = useState(false);
  const [modalEcg,    setModalEcg]    = useState(false);
  const [modalRegul,  setModalRegul]  = useState(false);
  const [modalReset,  setModalReset]  = useState(false);
  const [modalPat,    setModalPat]    = useState(false);
  const [regulText,   setRegulText]   = useState("");
  const [regulDest,   setRegulDest]   = useState("");
  const [ecgText,     setEcgText]     = useState("");
  const [joules,      setJoules]      = useState("200");
  const [racsTab,     setRacsTab]     = useState("ventil");
  const [racs, setRacs] = useState({
    fr:"", volume:"", pep:"", sat:"", fio2:"", capno:"",
    hypnovelV:"", sufentaV:"", curare:"", autresDrogues:"",
    tas:"", tad:"", fc:"", tempRacs:"", glycemie:"", glasgow:"", pupilles:"", noradrV:"", dobut:"", autresHemo:"",
    remplissages:[]
  });
  const sr = k => v => setRacs(p => ({ ...p, [k]: v }));
  const [activeTab,   setActiveTab]   = useState("actions"); // actions | etiologie | therapeutiques

  const alertRef = useRef(null);

  useEffect(() => {
    if (!running || sec === 0 || sec % 120 !== 0) return;
    setAlert("Analyser le rythme · Changer le masseur");
    clearTimeout(alertRef.current);
    alertRef.current = setTimeout(() => setAlert(null), 7000);
  }, [sec, running]);

  const [confirmAdd, setConfirmAdd] = useState(null); // { label, key }
  const addEvent = (id, label, icon, customTime) => {
    setEvents(p => [...p, { id, label, icon, time: customTime || getNow(), sec }]);
    setConfirmAdd({ label, key: Date.now() });
    try { if (navigator.vibrate) navigator.vibrate(28); } catch(e){}
  };
  useEffect(() => {
    if (!confirmAdd) return;
    const t = setTimeout(() => setConfirmAdd(null), 1500);
    return () => clearTimeout(t);
  }, [confirmAdd]);

  const start = () => {
    const lf = getNow();
    setLowFlowStart(lf);
    setRunning(true);
    setStarted(true);
    setEvents([{ id:"start", label:"Début RCP médicalisée", icon:"🫀", time:lf, sec:0 }]);
    setModalElectrodes(true);
  };

  // Alarme sonore quand un rappel Cordarone apparaît (après 3ᵉ / 5ᵉ choc cumulé)
  const _chocsTot   = events.filter(e => e.id === "choc").length + (parseInt(trans.chocsPompiers) || 0) + (parseInt(trans.chocsPublic) || 0);
  const _cordDone   = events.filter(e => e.id === "cord300" || e.id === "cord150").length;
  const cordReminderActive = started && !events.find(e => e.id === "rosc") &&
    ((_chocsTot >= 3 && _cordDone === 0) || (_chocsTot >= 5 && _cordDone === 1));
  const cordAlarmedRef = useRef(false);

  // Reconnaissance vocale (déclaré ici, avant les effets qui l'utilisent, pour éviter le TDZ)
  const [voiceActive,    setVoiceActive]    = useState(false);
  const [voiceTranscript,setVoiceTranscript] = useState("");
  const [voiceToast,     setVoiceToast]     = useState(null); // { label, icon, confirm, cancel }
  const [voiceAnswer,    setVoiceAnswer]    = useState(null); // { label, icon, speak, key }
  const [voiceWakeFlash, setVoiceWakeFlash] = useState(false);
  const voiceRecRef = useRef(null);
  const voiceToastRef = useRef(null);
  const voiceAnswerRef = useRef(null);
  const lastWakeWordTimeRef = useRef(0);
  const matchVoiceCommandRef = useRef(null);
  const voiceWakeWordRef = useRef(voiceWakeWord);
  useEffect(() => { voiceWakeWordRef.current = voiceWakeWord; }, [voiceWakeWord]);

  // ── Questions vocales — réponse immédiate parlée, ne modifie jamais rien ──
  const answerVoiceQuestion = React.useCallback((raw, n) => {
    const lastAdr = [...events].reverse().find(e => e.id === "adr");
    const lastHemo = hemoList.length > 0 ? hemoList[hemoList.length - 1] : null;
    const lastEtco2 = etco2List.length > 0 ? etco2List[etco2List.length - 1] : null;
    const lastEvt = events.length > 0 ? events[events.length - 1] : null;

    // Depuis quand pas d'adrénaline (avant le comptage général, plus spécifique)
    if (n.includes("depuis") && (n.includes("adrenaline") || n.includes("adre"))) {
      return lastAdr
        ? { label:"💉 Délai adrénaline", icon:"💉", speak:`Dernière adrénaline il y a ${speakDuration(sec - lastAdr.sec)}.` }
        : { label:"💉 Adrénaline", icon:"💉", speak:"Aucune adrénaline n'a encore été administrée." };
    }
    // Combien de mg / doses d'adrénaline
    if (n.includes("adrenaline") || n.includes("adre") || n.includes("epinephrine")) {
      const count = events.filter(e => e.id === "adr").length;
      return { label:"💉 Adrénaline", icon:"💉",
        speak: count === 0 ? "Aucune adrénaline administrée pour l'instant."
          : `${count} dose${count>1?"s":""} d'adrénaline administrée${count>1?"s":""}, soit ${count} milligramme${count>1?"s":""} au total.` };
    }
    // Délai avant le 1er choc (avant le comptage général, plus spécifique)
    if (n.includes("choc") && (n.includes("premier") || n.includes("1er") || n.includes("delai"))) {
      const firstChoc = events.find(e => e.id === "choc" || e.id === "doublechoc");
      return firstChoc
        ? { label:"⚡ Délai 1er choc", icon:"⚡", speak:`Premier choc délivré à ${speakDuration(firstChoc.sec)} après le début.` }
        : { label:"⚡ Chocs", icon:"⚡", speak:"Aucun choc délivré pour l'instant." };
    }
    // Combien de chocs
    if (n.includes("choc") || n.includes("defibrillation") || n.includes("defib")) {
      const simple = events.filter(e => e.id === "choc").length;
      const double = events.filter(e => e.id === "doublechoc").length;
      const total = simple + double * 2;
      return { label:"⚡ Chocs", icon:"⚡",
        speak: total === 0 ? "Aucun choc délivré pour l'instant."
          : `${total} choc${total>1?"s":""} délivré${total>1?"s":""}${double>0?`, dont ${double} double défibrillation${double>1?"s":""}`:""}.` };
    }
    // Dernière EtCO2
    if (n.match(/etco|capno|\bco2\b/)) {
      return lastEtco2
        ? { label:"📈 EtCO₂", icon:"📈", speak:`Dernière EtCO₂ : ${lastEtco2.val} millimètres de mercure, à ${lastEtco2.time}.` }
        : { label:"📈 EtCO₂", icon:"📈", speak:"Aucune EtCO₂ enregistrée pour l'instant." };
    }
    // Cordarone
    if (n.includes("cordarone") || n.includes("amiodarone") || n.includes("amio")) {
      const c300 = events.filter(e => e.id === "cord300").length;
      const c150 = events.filter(e => e.id === "cord150").length;
      const parts = [];
      if (c300) parts.push(`${c300} dose${c300>1?"s":""} de 300 milligrammes`);
      if (c150) parts.push(`${c150} dose${c150>1?"s":""} de 150 milligrammes`);
      return { label:"💊 Cordarone", icon:"💊",
        speak: parts.length ? `Cordarone : ${parts.join(" et ")}.` : "Pas de cordarone administrée pour l'instant." };
    }
    // Tension artérielle
    if (n.includes("tension") || n.includes("arterielle") || n.includes("pression arterielle") || /\bta\b/.test(n)) {
      if (!lastHemo || (!lastHemo.pas && !lastHemo.pad)) return { label:"🩺 Tension", icon:"🩺", speak:"Aucune tension artérielle enregistrée pour l'instant." };
      const pam = (lastHemo.pas && lastHemo.pad)
        ? Math.round(parseFloat(lastHemo.pad) + (parseFloat(lastHemo.pas) - parseFloat(lastHemo.pad)) / 3) : null;
      return { label:"🩺 Tension", icon:"🩺",
        speak:`Dernière tension : ${lastHemo.pas||"—"} sur ${lastHemo.pad||"—"}${pam?`, PAM ${pam}`:""}, à ${lastHemo.time}.` };
    }
    // Fréquence cardiaque
    if (n.includes("frequence cardiaque") || n.includes("frequence") || /\bfc\b/.test(n)) {
      return (lastHemo && lastHemo.fc)
        ? { label:"❤️ FC", icon:"❤️", speak:`Dernière fréquence cardiaque : ${lastHemo.fc} battements par minute, à ${lastHemo.time}.` }
        : { label:"❤️ FC", icon:"❤️", speak:"Aucune fréquence cardiaque enregistrée pour l'instant." };
    }
    // Shock Index (phrase complète requise pour éviter tout faux positif sur "si")
    if (n.includes("shock index") || n.includes("index de choc")) {
      if (!lastHemo || !lastHemo.fc || !lastHemo.pas || parseFloat(lastHemo.pas) === 0) {
        return { label:"📊 Shock Index", icon:"📊", speak:"Impossible de calculer le Shock Index, pas assez de données." };
      }
      const si = parseFloat(lastHemo.fc) / parseFloat(lastHemo.pas);
      return { label:"📊 Shock Index", icon:"📊",
        speak:`Shock index : ${si.toFixed(2)}, ${si<0.9?"normal":si<=1.4?"inquiétant":"critique"}.` };
    }
    // No-flow
    if (n.includes("no flow") || n.includes("noflow")) {
      return { label:"⏱ No-flow", icon:"⏱",
        speak: noFlowMin ? `No-flow renseigné : ${noFlowMin} minutes.` : "No-flow non renseigné." };
    }
    // Amines en cours
    if (n.includes("amine")) {
      const byType = {};
      amineList.forEach(a => { byType[a.type] = a; });
      const active = Object.values(byType);
      return { label:"💧 Amines", icon:"💧",
        speak: active.length ? `Amines en cours : ${active.map(a=>a.label).join(", ")}.` : "Aucune amine en cours." };
    }
    // Remplissage
    if (n.includes("remplissage")) {
      const total = (racs.remplissages || []).reduce((s,r) => s + r.vol, 0);
      return { label:"💧 Remplissage", icon:"💧",
        speak: total > 0 ? `Remplissage total : ${total} millilitres.` : "Aucun remplissage enregistré pour l'instant." };
    }
    // Température
    if (n.includes("temperature") || n.includes("temp")) {
      return { label:"🌡 Température", icon:"🌡",
        speak: racs.tempRacs ? `Dernière température : ${racs.tempRacs} degrés.` : "Température non renseignée." };
    }
    // Dernier geste / dernière action
    if ((n.includes("dernier") || n.includes("derniere")) && (n.includes("geste") || n.includes("action") || n.includes("fait"))) {
      return { label:"📋 Dernier geste", icon:"📋",
        speak: lastEvt ? `Dernier geste : ${lastEvt.label}, à ${lastEvt.time}.` : "Aucun geste enregistré pour l'instant." };
    }
    // Dernier rythme analysé
    if (n.includes("rythme")) {
      const rv = [...events].reverse().find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
      return { label:"⚡ Dernier rythme", icon:"⚡",
        speak: rv ? `Dernier rythme analysé : ${rv.label.replace("Rythme : ","")}, à ${rv.time}.` : "Aucune analyse de rythme enregistrée pour l'instant." };
    }
    // RACS obtenu ?
    if (n.includes("racs")) {
      const rosc = events.find(e => e.id === "rosc");
      return { label:"💚 RACS", icon:"💚",
        speak: rosc ? `Oui, RACS obtenu à ${rosc.time}.` : "Non, pas de RACS obtenu pour l'instant." };
    }
    // Mode équipe
    if (n.includes("equipe")) {
      return { label:"👥 Équipe", icon:"👥",
        speak: team.teamConnected ? `Mode équipe actif, ${team.teamDeviceCount} appareils connectés.` : "Mode équipe non activé." };
    }
    // Durée de réanimation en cours
    if (n.includes("depuis combien de temps") || (n.includes("depuis") && (n.includes("debut") || n.includes("dessus")))) {
      return { label:"⏱ Durée", icon:"⏱", speak:`Réanimation en cours depuis ${speakDuration(sec)}.` };
    }
    // Question reconnue mais sans réponse mappée : feedback explicite plutôt que silence
    return { label:"❓ Question", icon:"❓", speak:"Je n'ai pas cette information pour l'instant." };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sec, events, hemoList, etco2List, amineList, noFlowMin, racs, team]);

  // ── Commandes vocales — matching ──────────────────────────────────────────
  const matchVoiceCommand = React.useCallback((raw, wakeWordActive) => {
    const n = normalizeVoice(raw);

    // Mot-code : une commande n'est prise en compte que si le mot-code configuré
    // (voir buildWakeWordRegex — "Alpha" par défaut, personnalisable dans Réglages)
    // a été entendu dans cette phrase OU dans les ~4 dernières secondes. Une pause
    // naturelle après le mot-code coupe parfois la phrase en deux segments distincts
    // côté reconnaissance vocale — sans cette tolérance de 4s, dire "Alpha... adrénaline"
    // avec une pause ne déclencherait rien.
    if (!wakeWordActive) return null;

    // Question ? Toujours testé AVANT la liste de commandes, pour qu'une phrase
    // comme "combien de mg d'adrénaline" ne puisse jamais être interprétée comme
    // l'ordre "adrénaline" (qui loguerait une nouvelle dose).
    if (isVoiceQuestion(n)) {
      return { ...answerVoiceQuestion(raw, n), isQuestion: true };
    }

    // EtCO2 avec valeur : "copilote etco2 vingt-cinq" / "copilote capno trente"
    if (n.match(/etco|capno|co2/)) {
      const val = parseFrNumber(raw);
      if (val !== null && val >= 0 && val <= 100) {
        return {
          label: `EtCO₂ ${val} mmHg`, icon: "📈",
          confirm: () => {
            setEtco2List(prev => [...prev, { val: String(val), sec, time: getNow() }]);
            addEvent("etco2_voice", `EtCO₂ ${val} mmHg`, "📈");
          }
        };
      }
    }
    const cmds = [
      { kw:["adrenaline","adre","epinephrine"], label:"Adrénaline 1 mg IV", icon:"💉",
        confirm:()=>{ addEvent("adr","Adrénaline 1 mg IV/IO","💉"); setAdrTimerStart(Date.now()); }},
      { kw:["choc","defibrillation","defib","cardioversion","fibrillation"], label:"Défibrillation 200 J", icon:"⚡",
        confirm:()=> addEvent("choc","Défibrillation 200 J délivrée","⚡") },
      { kw:["racs","pouls","circulation","retour","spontane"], label:"RACS", icon:"💚",
        confirm:()=> addEvent("rosc","RACS","💚") },
      { kw:["cordarone","amiodarone","amio"], label:"Cordarone 300 mg", icon:"💊",
        confirm:()=> addEvent("cord300","Cordarone 300 mg IV","💊") },
      { kw:["intubation","intuber","sonde"], label: (isVLI && !vliUnlocked) ? "Sécurisation VAS" : "Intubation", icon:"🫁",
        confirm:()=> (isVLI && !vliUnlocked) ? setModalVasVLI(true) : setModalIot(true) },
      { kw:["pause","stoppe","stop compressions"], label:"Pause compressions", icon:"⏸",
        confirm:()=> setRunning(false) },
      { kw:["reprendre","continuer","resume","relancer"], label:"Reprendre compressions", icon:"▶",
        confirm:()=> setRunning(true) },
      { kw:["annule","annuler","supprime","efface"], label:"Annuler le dernier geste", icon:"↩️",
        confirm:()=> undoLast() },
      // "Constat de décès" — jamais disponible en VLI restreint : un IDE n'a pas
      // l'autorité de constater un décès, avec ou sans OML (cohérent avec le retrait
      // du bouton visuel équivalent). Le filtre ci-dessous exclut cette commande.
      ...((!(isVLI && !vliUnlocked)) ? [
        { kw:["deces","constat","mort","decede"], label:"Constat de décès", icon:"🕊️",
          confirm:()=> setModalDeces(true) },
      ] : []),
      { kw:["analyse","rythme","check","verification"], label:"Analyse de rythme", icon:"⚡",
        confirm:()=> setShowRythmFlash(true) },
    ];
    for (const cmd of cmds) {
      if (cmd.kw.some(k => n.includes(k))) return cmd;
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sec, events]);

  // La fonction de matching change à chaque seconde (elle dépend de `sec`) — on la
  // range dans une ref à jour en continu, SANS jamais redéclencher le useEffect
  // ci-dessous qui crée la session micro (sinon celle-ci serait détruite et
  // relancée toutes les secondes, rendant la reconnaissance vocale inutilisable).
  useEffect(() => { matchVoiceCommandRef.current = matchVoiceCommand; }, [matchVoiceCommand]);

  // ── Démarrage / arrêt de la session de reconnaissance ─────────────────────
  useEffect(() => {
    if (!voiceActive || !SpeechRecognitionAPI) return;

    const rec = new SpeechRecognitionAPI();
    rec.lang = "fr-FR";
    rec.continuous = false;        // une phrase = une session ; évite l'accumulation instable du mode continu
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    voiceRecRef.current = rec;

    rec.onresult = (e) => {
      const results = Array.from(e.results);
      const interim = results.map(r => r[0].transcript).join(" ");
      setVoiceTranscript(interim);
      // Détection précoce du mot-code, même avant que le résultat soit "final"
      if (buildWakeWordRegex(voiceWakeWordRef.current).test(normalizeVoice(interim))) {
        lastWakeWordTimeRef.current = Date.now();
      }

      const finalResult = results.find(r => r.isFinal);
      if (finalResult) {
        const text = Array.from(e.results).map(r => r[0].transcript).join(" ");
        const hasWakeWordNow = buildWakeWordRegex(voiceWakeWordRef.current).test(normalizeVoice(text));
        if (hasWakeWordNow) {
          lastWakeWordTimeRef.current = Date.now();
          setVoiceWakeFlash(true);
          setTimeout(() => setVoiceWakeFlash(false), 700);
        }
        const wakeWordActive = hasWakeWordNow || (Date.now() - lastWakeWordTimeRef.current < 4000);
        const cmd = matchVoiceCommandRef.current(text, wakeWordActive);
        setVoiceTranscript("");
        if (cmd) {
          if (cmd.isQuestion) {
            // Question : réponse immédiate, parlée à voix haute — ne modifie jamais rien,
            // donc pas de délai de confirmation ni de possibilité d'annulation.
            clearTimeout(voiceAnswerRef.current);
            setVoiceAnswer({ ...cmd, key: Date.now() });
            speakFr(cmd.speak);
            voiceAnswerRef.current = setTimeout(() => setVoiceAnswer(null), 6000);
          } else {
            clearTimeout(voiceToastRef.current);
            setVoiceToast({ ...cmd, cancel: () => { setVoiceToast(null); clearTimeout(voiceToastRef.current); } });
            voiceToastRef.current = setTimeout(() => {
              cmd.confirm();
              setVoiceToast(null);
            }, 2500);
          }
        }
      }
    };

    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      const messages = {
        "not-allowed": "🚫 Micro refusé — autorisez l'accès dans les réglages du navigateur",
        "service-not-allowed": "🚫 Micro refusé — autorisez l'accès dans les réglages du navigateur",
        "audio-capture": "🚫 Aucun micro détecté sur cet appareil",
        "network": "🚫 Reconnaissance vocale indisponible hors connexion",
      };
      setVoiceTranscript(messages[e.error] || ("Erreur micro : " + e.error));
      setTimeout(() => setVoiceTranscript(""), 5000);
    };

    rec.onend = () => {
      // Redémarrer automatiquement si toujours actif (iOS/Android coupent après silence).
      // Léger délai pour éviter un InvalidStateError si le redémarrage est trop rapide
      // (cause fréquente d'un micro qui "tourne" à l'écran sans plus rien reconnaître).
      if (voiceRecRef.current === rec) {
        setTimeout(() => {
          if (voiceRecRef.current === rec) {
            try { rec.start(); }
            catch(err) { setVoiceTranscript("🚫 Micro interrompu — réactivez-le"); setTimeout(() => setVoiceTranscript(""), 4000); }
          }
        }, 300);
      }
    };

    try { rec.start(); } catch(e) { setVoiceTranscript("🚫 Impossible de démarrer le micro"); setTimeout(() => setVoiceTranscript(""), 4000); }

    const onOffline = () => {
      setVoiceTranscript("🚫 Connexion perdue — reconnaissance vocale interrompue");
      setTimeout(() => setVoiceTranscript(""), 5000);
      setVoiceActive(false);
    };
    window.addEventListener("offline", onOffline);

    return () => {
      voiceRecRef.current = null;
      try { rec.abort(); } catch(e) {}
      clearTimeout(voiceToastRef.current);
      setVoiceTranscript("");
      window.removeEventListener("offline", onOffline);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceActive]);
  useEffect(() => {
    if (cordReminderActive && !cordAlarmedRef.current) {
      cordAlarmedRef.current = true;
      startAlarm();
    } else if (!cordReminderActive && cordAlarmedRef.current) {
      cordAlarmedRef.current = false;
      stopAlarm();
    }
  }, [cordReminderActive]);

  // ── Métronome 100/min — scheduler Web Audio lookahead (robuste, fonctionne en background) ──
  // Pattern : setInterval 50ms pour planifier les bips 200ms à l'avance via ctx.currentTime
  // C'est la seule méthode fiable sur iOS/Android même quand l'app passe en arrière-plan.
  const metroCtxRef    = useRef(null);
  const metroNextRef   = useRef(0);   // prochain bip planifié (ctx.currentTime)
  const metroTimerRef  = useRef(null);
  const metronomeMutedRef2 = useRef(metronomeMuted);
  useEffect(() => { metronomeMutedRef2.current = metronomeMuted; }, [metronomeMuted]);
  const hasRoscRef2 = useRef(!!events.find(e=>e.id==="rosc"));
  useEffect(() => { hasRoscRef2.current = !!events.find(e=>e.id==="rosc"); }, [events]);

  const scheduleMetronome = () => {
    const ctx = metroCtxRef.current;
    if (!ctx || ctx.state === "closed") return;
    const lookahead = 0.2;  // planifier 200 ms à l'avance
    const interval  = 0.6;  // 100 BPM = 600 ms
    while (metroNextRef.current < ctx.currentTime + lookahead) {
      if (!metronomeMutedRef2.current && !hasRoscRef2.current) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "square"; o.frequency.value = 1000;
        const t = metroNextRef.current;
        g.gain.setValueAtTime(0.15, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
        o.start(t); o.stop(t + 0.03);
      }
      metroNextRef.current += interval;
    }
  };

  useEffect(() => {
    // Arrêter le scheduler si conditions non remplies
    if (!metronomeEnabled || !started || !running) {
      clearInterval(metroTimerRef.current);
      metroTimerRef.current = null;
      if (metroCtxRef.current) {
        metroCtxRef.current.close().catch(() => {});
        metroCtxRef.current = null;
      }
      return;
    }
    // Démarrer le scheduler
    const startScheduler = () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        ctx.resume().catch(() => {});
        metroCtxRef.current = ctx;
        metroNextRef.current = ctx.currentTime + 0.05;
        scheduleMetronome();
        metroTimerRef.current = setInterval(scheduleMetronome, 50);
      } catch(e) {}
    };
    if (!metroCtxRef.current || metroCtxRef.current.state === "closed") {
      startScheduler();
    }
    return () => {
      clearInterval(metroTimerRef.current);
      metroTimerRef.current = null;
      if (metroCtxRef.current) {
        metroCtxRef.current.close().catch(() => {});
        metroCtxRef.current = null;
      }
    };
  }, [metronomeEnabled, started, running]);

  // ── Bip changement de masseur + flash analyse de rythme ──
  const prevCpRef = useRef(null);
  useEffect(() => {
    if (!started || !running) { prevCpRef.current = null; return; }
    const cp = (sec - cycleOffset) % 120;
    if (prevCpRef.current !== null && prevCpRef.current > 0 && cp === 0) {
      playCycleBip();
      if (!events.find(e => e.id === "rosc") && !events.find(e => e.id === "deces")) {
        setShowRythmFlash(true);
      }
    }
    prevCpRef.current = cp;
  }, [sec, cycleOffset, started, running, events]);

  // CCF — bascule pause/reprise des compressions
  const compPaused = ccfPausedSince != null;
  const ccfPausedNow = ccfPausedTotal + (compPaused ? Math.max(0, sec - ccfPausedSince) : 0);
  const ccfPct = sec > 0 ? Math.max(0, Math.min(100, Math.round(((sec - ccfPausedNow) / sec) * 100))) : 100;
  const toggleCompressions = () => {
    if (compPaused) {
      setCcfPausedTotal(t => t + Math.max(0, sec - ccfPausedSince));
      setCcfPausedSince(null);
    } else {
      setCcfPausedSince(sec);
    }
    try { if (navigator.vibrate) navigator.vibrate(20); } catch(e){}
  };

  const confirmIot = () => {
    const parts = [
      iot.cormack && `Cormack ${iot.cormack}`,
      iot.sonde   && `sonde ${iot.sonde} mm`,
      iot.repere  && `repère ${iot.repere} cm`,
      iot.capno   && `ETCO2 ${iot.capno} mmHg`,
    ].filter(Boolean);
    if (iot.difficile) {
      const techPart = iot.techniquesDifficiles.length ? " (" + iot.techniquesDifficiles.join(", ") + ")" : "";
      const tentPart = iot.nbTentatives ? ` — ${iot.nbTentatives} tentative${parseInt(iot.nbTentatives) > 1 ? "s" : ""}` : "";
      parts.push(`intubation difficile${techPart}${tentPart}`);
    }
    if (iot.inhalation) parts.push("inhalation objectivée");
    const detail = parts.length ? ` (${parts.join(", ")})` : "";
    addEvent("iot", `Intubation${detail}`, "🫁");
    if (iot.capno) {
      setEtco2List(prev => [...prev, { val: iot.capno, sec, time: getNow() }]);
    }
    setModalIot(false);
  };

  const confirmFast = () => {
    const detail = fastResult ? ` — ${fastResult}` : "";
    addEvent("fast", `Fast-écho${detail}`, "🔊");
    setFastResult("");
    setModalFast(false);
  };

  const reset = () => {
    // Archiver la session si elle a du contenu (avant effacement)
    const hasContent = (events && events.length > 1) || pat.nom || sec > 0;
    if (hasContent) {
      const outcome = events.find(e => e.id === "rosc") ? "RACS"
                    : events.find(e => e.id === "deces") ? "Décès" : "—";
      const recidive = events.some(e => e.id === "re_arret");
      const snapshot = {
        key: Date.now(),
        archivedAt: new Date().toISOString(),
        type: isTrauma ? "Traumatique" : isVLI ? (vliUnlocked ? "VLI → Médicalisé" : "VLI") : "Adulte",
        label: pat.nom ? `${pat.nom} ${pat.prenom}`.trim() : "Sans nom",
        durationSec: sec,
        outcome,
        recidive,
        props: {
          patient: { ...pat },
          noFlow: noFlowMin, lowFlow: lowFlowMin, acrTime,
          iot: { ...iot }, events: [...events], totalSec: sec,
          trans: { ...trans }, hemocue: [...hemocueHist],
        },
      };
      setArchives(saveArchive(snapshot));
    }
    team.disconnect();
    setStarted(false); setRunning(false); setSec(0); setSecStored(0); setModule(null);
    setAcrTime(""); setNoFlowMin(""); setLowFlowMin(""); setLowFlowStart("");
    setEvents([]); setAlert(null); setCycleOffset(0);
    setShowPdf(false); setShowLog(false);
    setPat({ nom:"", prenom:"", ddn:"", age:"", sexe:"", atcd:"", traitement:"", histoire:"", mecanisme:"", lieu:"" });
    setIot({ cormack:"", sonde:"", repere:"", capno:"", difficile:false, techniquesDifficiles:[], nbTentatives:"", inhalation:false });
    setTrans({ hEffondrement:"", temoin:"", mceTemoin:"", lieu:"", hArriveePompiers:"", hPoseDSA:"", h1erChoc:"", chocsPompiers:0, chocsPublic:0, rythmeDSA:"", gestesSecouristes:"", note:"", saved:false });
    setModalTrans(false);
    setAdrTimerStart(0);
    setMainTab("actions"); setSuspectedAd([]); setModalEcmo(false); setModalDdac(false); setHottManualExpand(false);
    setModalFastTrauma(false); setFastTr({ morrison:"", kohler:"", douglas:"", pleureD:"", pleureG:"", pericarde:"",
      morrisonMode:"", kohlerMode:"", douglasMode:"", pleureDMode:"", pleureGMode:"", pericardeMode:"" });
    setModalThoraco(null); setModalHemocue(false); setHemocueVal(""); setModalTransfu(false); setTransfu({ cgr:"", pfc:"", plaq:"" });
    setModalExacyl(false); setModalHemoExt(false); setGarrotSite(""); setGarrotHeure(""); setHemocueHist([]); setModalPat(false);
    setVliUnlocked(false); setModalVliTransition(false);
    clearSession("acr_adulte_");
    setModalCord(false); setModalDeces(false); setModalIot(false); setModalFast(false);
    setModalRythme(false); setModalVvp(false); setModalElectrodes(false); setModalRacs(false); setModalChoc(false); setModalEcg(false); setModalRegul(false);
    setJoules("200"); setEcgText(""); setRegulText(""); setRegulDest("");
    setRacs({ fr:"", volume:"", pep:"", sat:"", fio2:"", capno:"", hypnovelV:"", sufentaV:"", curare:"", autresDrogues:"", tas:"", tad:"", fc:"", tempRacs:"", noradrV:"", dobut:"", autresHemo:"", remplissages:[] });
    setActiveTab("actions");
    setFastResult("");
    setIot({ cormack:"", sonde:"", repere:"", capno:"", difficile:false, techniquesDifficiles:[], nbTentatives:"", inhalation:false });
    setEtco2List([]);
    setCcfPausedTotal(0); setCcfPausedSince(null);
    setHemoList([]); setAmineList([]);
    setPat({ nom:"", prenom:"", ddn:"", age:"", sexe:"", atcd:"", traitement:"", histoire:"", mecanisme:"", lieu:"" });
  };

  const cp = (sec - cycleOffset) % 120, pct = (cp/120)*100, rem = 120 - cp;
  const warn = rem <= 30, crit = rem <= 8;
  const bar = crit ? P.rose : warn ? P.amber : P.blue;

  // Pas de tableau ACTIONS_SIMPLE — tous les boutons sont gérés individuellement dans la grille

  const [module, setModule] = useState(null);
  const [showOnboarding, setShowOnboarding] = useLocalState("acr_onboarding_done", false);
  const [showVliChoice, setShowVliChoice] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const isTrauma = module === "traumatique";
  const isVLI = module === "vli";
  // Déverrouillage VLI → passation au VLM : une fois débloqué, la grille complète
  // reste accessible pour le reste de la session (pas de retour arrière possible).
  const [vliUnlocked, setVliUnlocked] = useLocalState("acr_vli_unlocked", false);
  const [pupillesInitExpanded, setPupillesInitExpanded] = useState(false);
  const [racsPupillesExpanded, setRacsPupillesExpanded] = useState(false);
  const [modalVliTransition, setModalVliTransition] = useState(false);
  const [modalVasVLI, setModalVasVLI] = useState(false);
  const [vasVLIInhalation, setVasVLIInhalation] = useState(false);
  // mainTab est partagé entre Adulte/Trauma/VLI (même composant) — si un onglet "etio"
  // persistait d'une session adulte précédente, on le redirige en trauma/VLI restreint puisque
  // cet onglet n'existe plus (remplacé par la carte HOTT ou l'onglet Situations particulières).
  useEffect(() => {
    if ((isTrauma || (isVLI && !vliUnlocked)) && mainTab === "etio") setMainTab("actions");
    if (isVLI && !vliUnlocked && mainTab === "ther") setMainTab("actions");
    if (!(isVLI && !vliUnlocked) && mainTab === "vli_sit") setMainTab("actions");
  }, [isTrauma, isVLI, vliUnlocked, mainTab]);

  // Thème jour/nuit — choisi par le médecin, persisté
  const [theme, setTheme] = useLocalState("acr_theme", "day");
  useEffect(() => {
    document.body.classList.remove("acr-night", "acr-day");
    document.body.classList.add(theme === "day" ? "acr-day" : "acr-night");
  }, [theme]);

  // Archives locales des arrêts
  const [archives, setArchives] = useState(() => loadArchives());
  const [viewArchive, setViewArchive] = useState(null); // snapshot consulté
  useEffect(() => { if (!module) setArchives(loadArchives()); }, [module]);

  // Réglages globaux — doivent être déclarés tôt (utilisés dans des effets)
  const [modalSettings, setModalSettings] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState(null);
  const [importResult, setImportResult] = useState(null); // { ok, error } | null
  const importFileRef = useRef(null);
  const [ccfEnabled, setCcfEnabled] = useLocalState("acr_ccf_enabled", false);
  const [debriefEnabled, setDebriefEnabled] = useLocalState("acr_debrief_enabled", false);
  const [pedDiluEnabled, setPedDiluEnabled] = useLocalState("acr_ped_dilu_enabled", false);
  const [pedDiluMode, setPedDiluMode] = useLocalState("acr_ped_dilu_mode", "2");

  // Déverrouille l'audio dès le 1er contact (requis par iOS pour jouer un son ensuite)
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  // États spécifiques trauma (FAST, thoracostomies, hemocue, transfusion)
  const [modalFastTrauma, setModalFastTrauma] = useState(false);
  const [fastTr, setFastTr] = useLocalState("acr_adulte_fastTr", { morrison:"", kohler:"", douglas:"", pleureD:"", pleureG:"", pericarde:"",
    morrisonMode:"", kohlerMode:"", douglasMode:"", pleureDMode:"", pleureGMode:"", pericardeMode:"" });
  const sft = k => v => setFastTr(p => ({ ...p, [k]: v }));
  const [modalThoraco, setModalThoraco] = useState(null); // null | "d" | "g"
  const [modalHemocue, setModalHemocue] = useState(false);
  const [hemocueVal, setHemocueVal] = useState("");
  const [hemocueHist, setHemocueHist] = useLocalState("acr_adulte_hemocueHist", []); // [{val, time}]
  const [modalTransfu, setModalTransfu] = useState(false);
  const [transfu, setTransfu] = useState({ cgr:"", pfc:"", plaq:"" });
  const [modalExacyl, setModalExacyl] = useState(false);
  const [modalHemoExt, setModalHemoExt] = useState(false);
  const [garrotSite, setGarrotSite] = useState("");
  const [garrotHeure, setGarrotHeure] = useState("");
  const [hottManualExpand, setHottManualExpand] = useState(false); // ré-ouvrir la carte HOTT une fois réduite

  // Détection sessions sauvegardées
  const sessionAdulte = (events && events.length > 0) || sec > 0 || pat.nom;
  const sessionPed = (() => {
    try {
      const ev = JSON.parse(localStorage.getItem("acr_ped_events") || "[]");
      const s  = JSON.parse(localStorage.getItem("acr_ped_sec") || "0");
      return ev.length > 0 || s > 0;
    } catch { return false; }
  })();
  const aSessionEnCours = sessionAdulte || sessionPed;

  // ── PAGE D'ACCUEIL GLOBALE ────────────────────────────────────────────────
  if (!module) return (
    <div style={{ background:P.bg, minHeight:"100vh", fontFamily:sans,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      padding:"64px 20px 20px", boxSizing:"border-box", position:"relative" }}>

      {/* ── Onboarding — première ouverture uniquement ── */}
      {!showOnboarding && (
        <div style={{ position:"fixed", inset:0, zIndex:100,
          background:"rgba(8,15,35,0.96)", backdropFilter:"blur(12px)",
          display:"flex", flexDirection:"column", alignItems:"center",
          justifyContent:"flex-end", fontFamily:sans, paddingBottom:"env(safe-area-inset-bottom,20px)" }}>
          <div style={{ background:P.surface, borderRadius:"24px 24px 0 0",
            padding:"28px 20px 36px", width:"100%", maxWidth:420 }}>
            <div style={{ textAlign:"center", marginBottom:24 }}>
              <div style={{ width:64, height:64, borderRadius:20, margin:"0 auto 16px",
                background:`linear-gradient(135deg, ${P.rose}, #9B2C2C)`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:32 }}>❤️‍🩹</div>
              <p style={{ margin:"0 0 6px", fontSize:22, fontWeight:900, color:P.text, fontFamily:disp }}>
                Copilote ACR
              </p>
              <p style={{ margin:0, fontSize:13, color:P.textSoft }}>
                Aide cognitive SMUR — Arrêt cardiaque
              </p>
            </div>
            {[
              { icon:"⏱", title:"Chrono + Adrénaline", desc:"Timer automatique, alarme à chaque interval" },
              { icon:"⚡", title:"Analyse de rythme", desc:"Flash toutes les 2 min, 4 choix en 1 tap" },
              { icon:"📄", title:"Compte-rendu automatique", desc:"Rapport coloré prêt à partager en fin de réa" },
              { icon:"👶", title:"Module pédiatrique", desc:"Doses calculées automatiquement par poids" },
            ].map((s,i) => (
              <div key={i} style={{ display:"flex", gap:12, padding:"10px 0",
                borderBottom: i<3 ? `1px solid ${P.borderSoft}` : "none" }}>
                <span style={{ width:36, height:36, borderRadius:10, background:P.surfaceAlt,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:18, flexShrink:0 }}>{s.icon}</span>
                <div>
                  <p style={{ margin:0, fontSize:13, fontWeight:700, color:P.text }}>{s.title}</p>
                  <p style={{ margin:0, fontSize:11.5, color:P.textSoft }}>{s.desc}</p>
                </div>
              </div>
            ))}
            <button onClick={() => setShowOnboarding(true)}
              style={{ width:"100%", marginTop:20,
                background:`linear-gradient(135deg, ${P.rose}, #9B2C2C)`,
                border:"none", borderRadius:16, color:"#fff", fontSize:16, fontWeight:800,
                fontFamily:disp, padding:"18px", cursor:"pointer",
                boxShadow:`0 8px 24px color-mix(in srgb, ${P.rose} 35%, transparent)` }}>
              Commencer →
            </button>
            <button onClick={() => { setShowOnboarding(true); setShowGuide(true); }}
              style={{ width:"100%", marginTop:10,
                background:"transparent", border:`1.5px solid ${P.border}`, borderRadius:16,
                color:P.textMid, fontSize:14, fontWeight:700, fontFamily:sans, padding:"14px",
                cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
              📖 Découvrir toutes les fonctionnalités
            </button>
            <p style={{ margin:"12px 0 0", textAlign:"center", fontSize:11, color:P.textSoft }}>
              Usage professionnel exclusif · Outil d'aide cognitive
            </p>
          </div>
        </div>
      )}

      {/* Réglages en haut à gauche */}
      <div style={{ position:"absolute", top:16, left:16, zIndex:5, display:"flex", gap:8 }}>
        <button onClick={() => setModalSettings(true)}
          style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:11,
            width:40, height:40, cursor:"pointer", fontSize:18, color:P.textMid,
            display:"flex", alignItems:"center", justifyContent:"center", fontFamily:sans }}
          aria-label="Réglages">⚙️</button>
        <button onClick={() => setShowGuide(true)}
          style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:11,
            width:40, height:40, cursor:"pointer", fontSize:18, color:P.textMid,
            display:"flex", alignItems:"center", justifyContent:"center", fontFamily:sans }}
          aria-label="Guide complet">📖</button>
      </div>

      {/* Bascule Jour/Nuit en haut, bien à droite */}
      <div style={{ position:"absolute", top:16, right:12, zIndex:5 }}>
        <ThemeToggle theme={theme} setTheme={setTheme} compact />
      </div>

      {showGuide && <GuideApp onClose={() => setShowGuide(false)} />}

      {/* Logo */}
      <div style={{ textAlign:"center", marginBottom:40 }}>
        <div style={{ width:84, height:84, borderRadius:24,
          background:`linear-gradient(135deg, ${P.rose}, ${P.roseText})`,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:44,
          margin:"0 auto 18px", boxShadow:`0 10px 30px color-mix(in srgb, ${P.rose} 38%, transparent)` }}>❤️‍🩹</div>
        <p style={{ margin:"0 0 6px", fontSize:10.5, fontWeight:700, color:P.rose,
          textTransform:"uppercase", letterSpacing:"0.22em", fontFamily:mono }}>
          Aide cognitive
        </p>
        <h1 style={{ margin:0, fontSize:32, fontWeight:900, color:P.text,
          letterSpacing:"-0.03em", fontFamily:disp, lineHeight:1 }}>
          Copilote ACR
        </h1>
        <p style={{ margin:"8px 0 0", fontSize:12.5, color:P.textSoft }}>
          Réanimation de l'arrêt cardiaque · SMUR
        </p>
      </div>

      {/* Bandeau Reprendre session */}
      {aSessionEnCours && (
        <div style={{ width:"100%", maxWidth:380, marginBottom:16,
          background:P.amberSoft, border:`1.5px solid color-mix(in srgb, ${P.amber} 40%, transparent)`, borderRadius:14,
          padding:"12px 14px", boxShadow:`0 4px 14px color-mix(in srgb, ${P.amber} 13%, transparent)` }}>
          <p style={{ margin:"0 0 4px", fontSize:11, color:P.amberText, fontWeight:600,
            textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>
            ⚠ Session non clôturée
          </p>
          <p style={{ margin:"0 0 10px", fontSize:13, color:P.amberText }}>
            Une réa {sessionAdulte ? "adulte" : "pédiatrique"} est en cours de saisie.
          </p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
            <button onClick={() => setModule(sessionAdulte ? "adulte_extra" : "pediatrique")}
              style={{ background:P.amber, border:"none", borderRadius:9, color:"#fff",
                fontSize:12, fontWeight:600, padding:"9px 8px", cursor:"pointer", fontFamily:sans }}>
              ↻ Reprendre
            </button>
            <button onClick={() => {
              if (confirm("Effacer définitivement la session en cours ?")) {
                clearSession("acr_adulte_"); clearSession("acr_ped_");
                window.location.reload();
              }
            }} style={{ background:"transparent", border:`1.5px solid ${P.amber}`,
              borderRadius:9, color:P.amberText, fontSize:12, fontWeight:600,
              padding:"9px 8px", cursor:"pointer", fontFamily:sans }}>
              🗑 Effacer
            </button>
          </div>
        </div>
      )}

      {/* 4 modules — grille 2x2 compacte pour tout voir sans défiler */}
      <div style={{ width:"100%", maxWidth:380, display:"grid", gridTemplateColumns:"1fr 1fr", gap:11 }}>

        {/* ACR Adulte */}
        <button onClick={() => setModule("adulte_extra")} style={{
          background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:16,
          padding:"16px 12px", cursor:"pointer", fontFamily:sans, textAlign:"center",
          display:"flex", flexDirection:"column", alignItems:"center", gap:8,
          boxShadow:"0 2px 10px rgba(0,0,0,0.05)", transition:"all 0.12s" }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = P.rose; e.currentTarget.style.boxShadow = `0 4px 18px color-mix(in srgb, ${P.rose} 13%, transparent)`; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = P.border; e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,0.05)"; }}>
          <div style={{ width:46, height:46, borderRadius:13, background:P.roseSoft,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🚑</div>
          <div>
            <p style={{ margin:"0 0 2px", fontSize:8.5, fontWeight:700, color:P.rose,
              textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Extra-hospitalier</p>
            <p style={{ margin:0, fontSize:14.5, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>ACR Adulte</p>
          </div>
        </button>

        {/* ACR Traumatique */}
        <button onClick={() => setModule("traumatique")} style={{
          background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:16,
          padding:"16px 12px", cursor:"pointer", fontFamily:sans, textAlign:"center",
          display:"flex", flexDirection:"column", alignItems:"center", gap:8,
          boxShadow:"0 2px 10px rgba(0,0,0,0.05)" }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = P.slate; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = P.border; }}>
          <div style={{ width:46, height:46, borderRadius:13, background:P.slateSoft,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🩻</div>
          <div>
            <p style={{ margin:"0 0 2px", fontSize:8.5, fontWeight:700, color:P.slateText,
              textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Polytraumatisé</p>
            <p style={{ margin:0, fontSize:14.5, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>ACR Traumatique</p>
          </div>
        </button>

        {/* ACR Pédiatrique */}
        <button onClick={() => setModule("pediatrique")} style={{
          background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:16,
          padding:"16px 12px", cursor:"pointer", fontFamily:sans, textAlign:"center",
          display:"flex", flexDirection:"column", alignItems:"center", gap:8,
          boxShadow:"0 2px 10px rgba(0,0,0,0.05)", transition:"all 0.12s" }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = P.amber; e.currentTarget.style.boxShadow = `0 4px 18px color-mix(in srgb, ${P.amber} 13%, transparent)`; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = P.border; e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,0.05)"; }}>
          <div style={{ width:46, height:46, borderRadius:13, background:P.amberSoft,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>👶</div>
          <div>
            <p style={{ margin:"0 0 2px", fontSize:8.5, fontWeight:700, color:P.amber,
              textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Nourrisson · Enfant</p>
            <p style={{ margin:0, fontSize:14.5, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>ACR Pédiatrique</p>
          </div>
        </button>

        {/* ACR VLI */}
        <button onClick={() => setShowVliChoice(true)} style={{
          position:"relative", background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:16,
          padding:"16px 12px", cursor:"pointer", fontFamily:sans, textAlign:"center",
          display:"flex", flexDirection:"column", alignItems:"center", gap:8,
          boxShadow:"0 2px 10px rgba(0,0,0,0.05)", transition:"all 0.12s" }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = "#EA6A12"; e.currentTarget.style.boxShadow = "0 4px 18px rgba(234,106,18,0.2)"; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = P.border; e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,0.05)"; }}>
          <div style={{ width:46, height:46, borderRadius:13, background:"rgba(234,106,18,0.14)",
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🚒</div>
          <div>
            <p style={{ margin:"0 0 2px", fontSize:8.5, fontWeight:700, color:"#B24E0A",
              textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Protocole ISP</p>
            <p style={{ margin:0, fontSize:14.5, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>ACR VLI</p>
          </div>
        </button>

      </div>

      {/* Intra-hospitalier — pas encore disponible, discret pour ne pas encombrer la grille des 4 modules actifs */}
      <button onClick={() => setModule("adulte_intra")}
        style={{ background:"transparent", border:"none", color:P.textSoft, fontSize:11,
          cursor:"pointer", fontFamily:sans, padding:"10px 4px", textAlign:"center", width:"100%" }}>
        🏥 ACR Adulte Intra-hospitalier — bientôt disponible
      </button>

      {/* ── Modal de choix ACR VLI : Adulte ou Pédiatrique ── */}
      {showVliChoice && (
        <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,0.55)",
          display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
          onClick={e => { if (e.target === e.currentTarget) setShowVliChoice(false); }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:P.surface, borderRadius:18, padding:"22px 20px", maxWidth:340, width:"100%",
              boxShadow:"0 12px 40px rgba(0,0,0,0.3)", textAlign:"center" }}>
            <div style={{ width:52, height:52, borderRadius:15, background:"linear-gradient(135deg,#EA6A12,#B24E0A)",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, margin:"0 auto 12px" }}>🚒</div>
            <p style={{ margin:"0 0 3px", fontSize:9.5, fontWeight:700, color:"#B24E0A",
              textTransform:"uppercase", letterSpacing:"0.12em", fontFamily:mono }}>Protocole ISP</p>
            <p style={{ margin:"0 0 20px", fontSize:18, fontWeight:800, color:P.text, fontFamily:disp }}>ACR VLI</p>
            <div style={{ display:"flex", flexDirection:"column", gap:11 }}>
              <button onClick={() => { setShowVliChoice(false); setModule("vli"); }}
                style={{ background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:14,
                  padding:"16px 14px", cursor:"pointer", fontFamily:sans,
                  display:"flex", flexDirection:"column", alignItems:"center", gap:5 }}>
                <span style={{ fontSize:28 }}>🚑</span>
                <span style={{ fontSize:14.5, fontWeight:800, color:P.text, fontFamily:disp }}>Adulte</span>
                <span style={{ fontSize:9.5, color:P.textSoft }}>Protocole ISP adulte</span>
              </button>
              <button onClick={() => { setShowVliChoice(false); setModule("vli_pediatrique"); }}
                style={{ background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:14,
                  padding:"16px 14px", cursor:"pointer", fontFamily:sans,
                  display:"flex", flexDirection:"column", alignItems:"center", gap:5 }}>
                <span style={{ fontSize:28 }}>👶</span>
                <span style={{ fontSize:14.5, fontWeight:800, color:P.text, fontFamily:disp }}>Pédiatrique</span>
                <span style={{ fontSize:9.5, color:P.textSoft }}>Protocole ISP enfant — doses au poids</span>
              </button>
            </div>
            <button onClick={() => setShowVliChoice(false)}
              style={{ marginTop:16, background:"transparent", border:"none", color:P.textSoft,
                fontSize:12, cursor:"pointer", fontFamily:sans }}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* ── Arrêts archivés ── */}
      {/* Dashboard Analytics */}
      {showDashboard && (
        <DashboardView archives={archives} onClose={() => setShowDashboard(false)}
          P={P} mono={mono} sans={sans} disp={disp} fmtSec={fmtSec} />
      )}

      {archives.length > 0 && (
        <div style={{ width:"100%", maxWidth:420, marginTop:30 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
            <p style={{ margin:0, fontSize:11, fontWeight:700, color:P.textSoft,
              letterSpacing:"0.12em", textTransform:"uppercase", fontFamily:mono }}>
              Arrêts archivés · {archives.length}
            </p>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <button onClick={() => setShowDashboard(true)}
                style={{ background:P.blue, border:"none", borderRadius:8,
                  color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer",
                  fontFamily:sans, padding:"5px 10px", display:"flex", alignItems:"center", gap:4 }}>
                📊 Stats
              </button>
              <button onClick={() => {
                if (typeof window !== "undefined" && window.confirm("Effacer définitivement tous les arrêts archivés ?")) {
                  setArchives(clearArchives());
                }
              }} style={{ background:"transparent", border:"none", color:P.roseText,
                fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:sans }}>
                Tout effacer
              </button>
            </div>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {archives.map(a => {
              const d = new Date(a.archivedAt);
              const dateStr = d.toLocaleDateString("fr-FR", { day:"2-digit", month:"2-digit", year:"2-digit" })
                + " · " + d.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
              const dur = `${Math.floor((a.durationSec||0)/60)} min`;
              const oc = a.outcome === "RACS" ? { c:P.greenText, s:P.greenSoft }
                       : a.outcome === "Décès" ? { c:P.slateText, s:P.slateSoft }
                       : { c:P.textSoft, s:P.surfaceAlt };
              return (
                <div key={a.key} style={{ display:"flex", alignItems:"center", gap:10,
                  background:P.surface, border:`1px solid ${P.border}`, borderRadius:13, padding:"11px 13px" }}>
                  <button onClick={() => setViewArchive(a)}
                    style={{ flex:1, minWidth:0, background:"transparent", border:"none",
                      cursor:"pointer", fontFamily:sans, textAlign:"left", display:"flex",
                      flexDirection:"column", gap:3, padding:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                      <span style={{ fontSize:9, fontWeight:700, color:P.textSoft, fontFamily:mono,
                        background:P.surfaceAlt, borderRadius:5, padding:"1px 6px" }}>{a.type}</span>
                      <span style={{ fontSize:13, fontWeight:700, color:P.text, overflow:"hidden",
                        textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.label}</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:10.5, color:P.textSoft }}>
                      <span style={{ fontFamily:mono }}>{dateStr}</span>
                      <span>·</span><span style={{ fontFamily:mono }}>{dur}</span>
                      {a.outcome !== "—" && (
                        <span style={{ color:oc.c, background:oc.s, borderRadius:5,
                          padding:"1px 7px", fontWeight:700, fontSize:9.5 }}>{a.outcome}</span>
                      )}
                    </div>
                  </button>
                  <button onClick={() => {
                    if (typeof window !== "undefined" && window.confirm(`Supprimer l'arrêt « ${a.label} » ?`)) {
                      setArchives(deleteArchive(a.key));
                    }
                  }} style={{ background:"transparent", border:"none", color:P.textSoft,
                    fontSize:18, cursor:"pointer", padding:"0 4px", flexShrink:0, lineHeight:1 }}>×</button>
                </div>
              );
            })}
          </div>

          <p style={{ margin:"10px 2px 0", fontSize:9.5, color:P.textSoft, lineHeight:1.5, fontStyle:"italic" }}>
            ⚠️ Données stockées en clair sur cet appareil uniquement (non chiffrées, non synchronisées).
            Données de santé : n'utiliser que sur un appareil sécurisé et personnel ; anonymisation recommandée. Effacer après usage.
          </p>
        </div>
      )}

      <p style={{ marginTop:36, fontSize:10, color:P.textSoft, fontFamily:mono }}>
        Usage professionnel exclusif · Outil d'aide cognitive uniquement — chaque professionnel de santé demeure seul responsable de ses prescriptions et décisions thérapeutiques
      </p>

      {/* ── Réglages ── */}
      {modalSettings && (
        <Modal title="Réglages" icon="⚙️" soft={P.surfaceAlt} onClose={() => setModalSettings(false)}>

          <button onClick={() => { setModalSettings(false); setShowGuide(true); }}
            style={{ width:"100%", display:"flex", alignItems:"center", gap:12,
              background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13,
              padding:"13px 14px", cursor:"pointer", fontFamily:sans, textAlign:"left",
              marginBottom: 14 }}>
            <span style={{ width:36, height:36, borderRadius:10, background:P.blueSoft,
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>📖</span>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ margin:"0 0 2px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>Guide complet de l'application</p>
              <p style={{ margin:0, fontSize:11.5, color:P.textSoft, lineHeight:1.4 }}>
                Toutes les fonctionnalités, pour une prise en main avant utilisation réelle
              </p>
            </div>
            <span style={{ fontSize:16, color:P.textSoft, flexShrink:0 }}>›</span>
          </button>

          {/* Intervalle adrénaline */}
          <div style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13, padding:"13px 14px" }}>
            <p style={{ margin:"0 0 8px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>
              Intervalle adrénaline
            </p>
            <p style={{ margin:"0 0 10px", fontSize:11.5, color:P.textSoft, lineHeight:1.5 }}>
              Délai entre chaque injection d'adrénaline. L'alarme se déclenche automatiquement.
              Ce réglage remplace le choix en cours de réanimation.
            </p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
              {[3,4,5].map(m => (
                <button key={m} onClick={() => setAdrIntervalGlobal(m)}
                  style={{ background: adrIntervalGlobal===m ? P.rose : P.surface,
                    border:`1.5px solid ${adrIntervalGlobal===m ? P.rose : P.border}`,
                    borderRadius:11, padding:"10px 0", cursor:"pointer", fontFamily:mono,
                    fontSize:16, fontWeight:800,
                    color: adrIntervalGlobal===m ? "#fff" : P.text }}>
                  {m} min
                </button>
              ))}
            </div>
          </div>

          {/* ── Métronome MCE (100/min) ── */}
          <div style={{ display:"flex", alignItems:"flex-start", gap:12,
            background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13, padding:"13px 14px" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ margin:"0 0 3px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>Métronome MCE (100/min)</p>
              <p style={{ margin:0, fontSize:11.5, color:P.textSoft, lineHeight:1.5 }}>
                Tick sonore à <b>100/min</b> pendant les compressions. Un bouton sourdine est disponible
                en réanimation pour le couper sans le désactiver.
              </p>
            </div>
            <button onClick={() => setMetronomeEnabled(v => !v)}
              style={{ flexShrink:0, width:50, height:30, borderRadius:15, border:"none", cursor:"pointer",
                background: metronomeEnabled ? P.blue : P.border, position:"relative", transition:"background 0.15s", padding:0 }}>
              <span style={{ position:"absolute", top:3, left: metronomeEnabled ? 23 : 3, width:24, height:24,
                borderRadius:"50%", background:"#fff", transition:"left 0.15s", boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }} />
            </button>
          </div>

          {/* Protocoles de dilution pédiatrique */}
          <div style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13, padding:"13px 14px" }}>
            <div style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom: pedDiluEnabled ? 14 : 0 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <p style={{ margin:"0 0 3px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>Protocoles de dilution pédiatrique</p>
                <p style={{ margin:0, fontSize:11.5, color:P.textSoft, lineHeight:1.5 }}>
                  Affiche un <b>guide de préparation étape par étape</b> (volumes calculés selon le poids)
                  avant chaque injection d'Adrénaline en pédiatrie.
                </p>
              </div>
              <button onClick={() => setPedDiluEnabled(v => !v)}
                style={{ flexShrink:0, width:50, height:30, borderRadius:15, border:"none", cursor:"pointer",
                  background: pedDiluEnabled ? P.teal : P.border, position:"relative", transition:"background 0.15s",
                  padding:0 }}>
                <span style={{ position:"absolute", top:3, left: pedDiluEnabled ? 23 : 3, width:24, height:24,
                  borderRadius:"50%", background:"#fff", transition:"left 0.15s",
                  boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }} />
              </button>
            </div>
            {/* Choix du protocole quand le toggle est activé */}
            {pedDiluEnabled && (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {/* Protocole 1 */}
                <button onClick={() => setPedDiluMode("1")}
                  style={{ display:"flex", gap:10, background: pedDiluMode==="1" ? P.tealSoft : P.surface,
                    border:`1.5px solid ${pedDiluMode==="1" ? P.teal : P.border}`, borderRadius:12,
                    padding:"11px 13px", cursor:"pointer", textAlign:"left", fontFamily:sans }}>
                  <span style={{ width:20, height:20, borderRadius:"50%", flexShrink:0, marginTop:1,
                    border:`2px solid ${pedDiluMode==="1" ? P.teal : P.border}`,
                    background: pedDiluMode==="1" ? P.teal : "transparent",
                    display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {pedDiluMode==="1" && <span style={{ width:8, height:8, borderRadius:"50%", background:"#fff" }} />}
                  </span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:"0 0 2px", fontSize:12, fontWeight:700, color:P.text }}>
                      Protocole 1 — Double/simple dilution selon le poids
                    </p>
                    <p style={{ margin:0, fontSize:11, color:P.textSoft, lineHeight:1.4 }}>
                      {"< 10 kg : double dilution (1 mL / 4 min)"}
                      <br/>{"≥ 10 kg : dilution simple (1 mL / 4 min)"}
                    </p>
                  </div>
                </button>

                {/* Protocole 2 */}
                <button onClick={() => setPedDiluMode("2")}
                  style={{ display:"flex", gap:10, background: pedDiluMode==="2" ? P.tealSoft : P.surface,
                    border:`1.5px solid ${pedDiluMode==="2" ? P.teal : P.border}`, borderRadius:12,
                    padding:"11px 13px", cursor:"pointer", textAlign:"left", fontFamily:sans }}>
                  <span style={{ width:20, height:20, borderRadius:"50%", flexShrink:0, marginTop:1,
                    border:`2px solid ${pedDiluMode==="2" ? P.teal : P.border}`,
                    background: pedDiluMode==="2" ? P.teal : "transparent",
                    display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {pedDiluMode==="2" && <span style={{ width:8, height:8, borderRadius:"50%", background:"#fff" }} />}
                  </span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:"0 0 2px", fontSize:12, fontWeight:700, color:P.text }}>
                      Protocole 2 — Dilution simple universelle
                    </p>
                    <p style={{ margin:0, fontSize:11, color:P.textSoft, lineHeight:1.4 }}>
                      {"1 mL (1 mg) + 9 mL NaCl = 0,1 mg/mL"}
                      <br/>{"Volume = poids × 0,1 mL · 0,01 mg/kg (max 1 mg) / 4 min"}
                    </p>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* Mot-code vocal */}
          <div style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13, padding:"13px 14px" }}>
            <p style={{ margin:"0 0 8px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>
              Mot-code vocal
            </p>
            <p style={{ margin:"0 0 10px", fontSize:11.5, color:P.textSoft, lineHeight:1.5 }}>
              Mot à prononcer avant chaque commande ou question vocale (ex : « {voiceWakeWord || "Alpha"}, adrénaline »).
              Il filtre le bruit ambiant d'une réanimation pour que l'app ne réagisse pas à une simple conversation.
            </p>
            <input value={voiceWakeWord} onChange={e => setVoiceWakeWord(e.target.value)}
              placeholder="Alpha"
              style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
                borderRadius:10, padding:"11px 12px", fontSize:15, fontWeight:700,
                color:P.text, fontFamily:sans, outline:"none", boxSizing:"border-box", marginBottom:10 }}
              onFocus={e => e.target.style.borderColor = P.rose}
              onBlur={e  => e.target.style.borderColor = P.border} />
            <div style={{ background:`color-mix(in srgb, ${P.amber} 12%, ${P.surface})`,
              border:`1px solid color-mix(in srgb, ${P.amber} 35%, transparent)`,
              borderRadius:10, padding:"9px 11px", display:"flex", gap:8, alignItems:"flex-start" }}>
              <span style={{ fontSize:14, flexShrink:0 }}>💡</span>
              <p style={{ margin:0, fontSize:11, color:P.amberText, lineHeight:1.5 }}>
                Choisissez un mot qui ne risque pas d'être prononcé par hasard pendant une prise en charge :
                évitez les mots médicaux courants (comme « urgence » ou « protocole »), préférez un mot court,
                et si possible un mot qu'on ne prononcerait pas naturellement en deux temps avec une pause au milieu
                (ex : « Co-pilote » peut se couper en « Co… pilote »).
              </p>
            </div>
          </div>

          {/* Débrief post-arrêt */}
          <div style={{ display:"flex", alignItems:"flex-start", gap:12,
            background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13, padding:"13px 14px" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ margin:"0 0 3px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>Débrief post-arrêt</p>
              <p style={{ margin:0, fontSize:11.5, color:P.textSoft, lineHeight:1.5 }}>
                À la clôture, affiche un <b>écran de débrief</b> avec toutes les métriques de la réanimation
                (timing, thérapeutiques, qualité MCE, EtCO₂) avant d'effacer les données.
              </p>
            </div>
            <button onClick={() => setDebriefEnabled(v => !v)}
              style={{ flexShrink:0, width:50, height:30, borderRadius:15, border:"none", cursor:"pointer",
                background: debriefEnabled ? P.violet : P.border, position:"relative", transition:"background 0.15s",
                padding:0 }}>
              <span style={{ position:"absolute", top:3, left: debriefEnabled ? 23 : 3, width:24, height:24,
                borderRadius:"50%", background:"#fff", transition:"left 0.15s",
                boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }} />
            </button>
          </div>

          {/* Suivi CCF */}
          <div style={{ display:"flex", alignItems:"flex-start", gap:12,
            background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13, padding:"13px 14px" }}>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ margin:"0 0 3px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>Suivi CCF</p>
              <p style={{ margin:0, fontSize:11.5, color:P.textSoft, lineHeight:1.5 }}>
                Affiche un bouton « pause / reprise des compressions » et calcule la
                <b> fraction de compression thoracique</b> (objectif &gt; 60–80 %).
              </p>
            </div>
            <button onClick={() => setCcfEnabled(v => !v)}
              style={{ flexShrink:0, width:50, height:30, borderRadius:15, border:"none", cursor:"pointer",
                background: ccfEnabled ? P.green : P.border, position:"relative", transition:"background 0.15s",
                padding:0 }}>
              <span style={{ position:"absolute", top:3, left: ccfEnabled ? 23 : 3, width:24, height:24,
                borderRadius:"50%", background:"#fff", transition:"left 0.15s",
                boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }} />
            </button>
          </div>

          {/* Sauvegarde des données */}
          <div style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13, padding:"13px 14px" }}>
            <p style={{ margin:"0 0 8px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>
              Sauvegarde des données
            </p>
            <p style={{ margin:"0 0 12px", fontSize:11.5, color:P.textSoft, lineHeight:1.5 }}>
              Les données restent uniquement sur cet appareil. Exportez un fichier de sauvegarde
              avant un changement de téléphone, une mise à jour d'OS, ou pour vous prémunir d'une perte.
              Noms et prénoms sont réduits à leurs initiales dans le fichier exporté.
            </p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <button onClick={exportBackup}
                style={{ background:P.green, border:"none", borderRadius:11, color:"#fff",
                  padding:"11px 0", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans,
                  display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                ⬇ Exporter
              </button>
              <button onClick={() => importFileRef.current?.click()}
                style={{ background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:11, color:P.text,
                  padding:"11px 0", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans,
                  display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                ⬆ Importer
              </button>
              <input ref={importFileRef} type="file" accept="application/json,.json" style={{ display:"none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) setPendingImportFile(f); e.target.value = ""; }} />
            </div>
            {importResult && (
              <p style={{ margin:"10px 0 0", fontSize:11.5, fontWeight:600,
                color: importResult.ok ? P.greenText : P.roseText }}>
                {importResult.ok ? "✓ Sauvegarde importée avec succès." : `✕ ${importResult.error}`}
              </p>
            )}
          </div>

          {/* Confirmation avant import — remplace les réglages actuels */}
          {pendingImportFile && (
            <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:200,
              display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
              onClick={() => setPendingImportFile(null)}>
              <div onClick={e => e.stopPropagation()}
                style={{ background:P.surface, borderRadius:18, padding:"22px 20px", maxWidth:340,
                  boxShadow:"0 12px 40px rgba(0,0,0,0.3)" }}>
                <p style={{ margin:"0 0 10px", fontSize:16, fontWeight:800, color:P.text, fontFamily:disp }}>
                  ⚠️ Confirmer l'import
                </p>
                <p style={{ margin:"0 0 18px", fontSize:12.5, color:P.textMid, lineHeight:1.6 }}>
                  Les <b>archives</b> du fichier seront fusionnées avec celles déjà présentes (aucune perte).
                  Les <b>réglages</b> et une éventuelle <b>session en cours</b> seront en revanche
                  remplacés par le contenu du fichier — cette partie est irréversible.
                </p>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <button onClick={() => setPendingImportFile(null)}
                    style={{ background:P.surfaceAlt, border:`1.5px solid ${P.border}`, borderRadius:11,
                      color:P.textMid, padding:"11px 0", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                    Annuler
                  </button>
                  <button onClick={async () => {
                    const r = await importBackup(pendingImportFile);
                    setPendingImportFile(null);
                    if (r.ok) { window.location.reload(); }
                    else { setImportResult(r); setTimeout(() => setImportResult(null), 6000); }
                  }} style={{ background:P.rose, border:"none", borderRadius:11, color:"#fff",
                    padding:"11px 0", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                    Importer
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Contact / Retours — bug, amélioration, compliment */}
          <div style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:13, padding:"13px 14px" }}>
            <p style={{ margin:"0 0 8px", fontSize:14, fontWeight:800, color:P.text, fontFamily:disp }}>
              Contact / Retours
            </p>
            <p style={{ margin:"0 0 12px", fontSize:11.5, color:P.textSoft, lineHeight:1.5 }}>
              Un bug, une idée d'amélioration, ou juste un mot gentil — tout est bienvenu.
              Chaque bouton ouvre votre app mail avec le sujet pré-rempli.
            </p>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {[
                { icon:"🐛", label:"Signaler un bug", color:P.rose, soft:P.roseSoft, textC:P.roseText,
                  subject:"[Copilote ACR] Bug", body:`Décrivez ce qui s'est passé, et si possible les étapes pour reproduire :\n\n\n— \nVersion de l'app : ${APP_VERSION}` },
                { icon:"💡", label:"Suggérer une amélioration", color:P.amber, soft:P.amberSoft, textC:P.amberText,
                  subject:"[Copilote ACR] Suggestion", body:`Votre idée :\n\n\n— \nVersion de l'app : ${APP_VERSION}` },
                { icon:"👍", label:"Complimenter", color:P.green, soft:P.greenSoft, textC:P.greenText,
                  subject:"[Copilote ACR] Retour positif", body:`\n\n— \nVersion de l'app : ${APP_VERSION}` },
              ].map(c => (
                <a key={c.label}
                  href={`mailto:copilote.acr@gmail.com?subject=${encodeURIComponent(c.subject)}&body=${encodeURIComponent(c.body)}`}
                  style={{ display:"flex", alignItems:"center", gap:10, textDecoration:"none",
                    background:c.soft, border:`1px solid ${c.color}`, borderRadius:11,
                    padding:"11px 13px" }}>
                  <span style={{ fontSize:17, flexShrink:0 }}>{c.icon}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:c.textC, flex:1 }}>{c.label}</span>
                  <span style={{ fontSize:14, color:c.textC, flexShrink:0 }}>›</span>
                </a>
              ))}
            </div>
          </div>

          {/* Numéro de version — utile pour vérifier que toute l'équipe a bien la même version */}
          <p style={{ margin:"14px 0 0", textAlign:"center", fontSize:11, color:P.textSoft, fontFamily:mono }}>
            Copilote ACR · Version {APP_VERSION}
          </p>
        </Modal>
      )}

      {/* Consultation d'un arrêt archivé (lecture seule) */}
      {viewArchive && (
        <PdfView {...viewArchive.props} onClose={() => setViewArchive(null)} />
      )}
    </div>
  );

  // Module pédiatrique
  if (module === "pediatrique") return <ModulePediatrique onBack={() => setModule(null)} theme={theme} setTheme={setTheme} />;
  if (module === "vli_pediatrique") return <ModulePediatrique onBack={() => setModule(null)} theme={theme} setTheme={setTheme} isVLI />;

  // Modules non encore développés (intra-hospitalier uniquement)
  if (module && module !== "adulte_extra" && module !== "traumatique" && module !== "vli" && module !== "vli_pediatrique") return (
    <div style={{ background:P.bg, minHeight:"100vh", fontFamily:sans,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      padding:"0 24px" }}>
      <div style={{ textAlign:"center", maxWidth:320 }}>
        <div style={{ fontSize:56, marginBottom:20 }}>🔧</div>
        <h2 style={{ margin:"0 0 10px", fontSize:20, fontWeight:600, color:P.text }}>
          En cours de développement
        </h2>
        <p style={{ margin:"0 0 32px", fontSize:14, color:P.textSoft, lineHeight:1.6 }}>
          Ce module sera disponible prochainement.
        </p>
        <button onClick={() => setModule(null)}
          style={{ background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:13,
            padding:"13px 28px", fontSize:14, fontWeight:600, color:P.textMid,
            cursor:"pointer", fontFamily:sans }}>
          ← Retour
        </button>
      </div>
    </div>
  );

  // ── Modal Mode équipe — défini une fois, réutilisé sur l'écran pré-démarrage ET l'écran actif ──
  const teamModal = modalTeam && (
    <Modal title="Mode équipe" icon="👥" soft={P.surfaceAlt} onClose={() => setModalTeam(false)}>
      {!team.teamConnected ? (
        <>
          <p style={{ margin:"0 0 16px", fontSize:12.5, color:P.textSoft, lineHeight:1.5 }}>
            Synchronise la chronologie, l'heure d'ACR, le no-flow/low-flow et la transmission
            entre plusieurs appareils de l'équipe en temps réel.
          </p>
          <button onClick={async () => {
              if (!navigator.onLine) { setTeamJoinError("🚫 Pas de connexion internet — le mode équipe nécessite un réseau"); return; }
              setTeamJoinError("");
              try { await team.startSession(); }
              catch { setTeamJoinError("Impossible de créer la session — vérifiez la connexion"); }
            }}
            style={{ width:"100%", background:`linear-gradient(135deg,${P.blue},${P.blueText})`,
              border:"none", borderRadius:13, color:"#fff", fontSize:14, fontWeight:700,
              padding:"14px", cursor:"pointer", fontFamily:sans, marginBottom:16,
              boxShadow:`0 5px 16px color-mix(in srgb, ${P.blue} 30%, transparent)` }}>
            + Créer une session d'équipe
          </button>
          {teamJoinError && (
            <p style={{ margin:"-10px 0 16px", fontSize:11.5, color:P.roseText, textAlign:"center" }}>{teamJoinError}</p>
          )}
          <div style={{ borderTop:`1px solid ${P.borderSoft}`, margin:"4px 0 16px" }} />
          <Lbl>Rejoindre avec un code (6 caractères)</Lbl>
          <div style={{ display:"flex", gap:8 }}>
            <input value={teamJoinCode}
              onChange={e => { setTeamJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6)); setTeamJoinError(""); }}
              placeholder="X7K4M2"
              style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:10, padding:"12px", fontSize:20, color:P.text, fontFamily:mono,
                textAlign:"center", fontWeight:700, letterSpacing:"0.1em", outline:"none",
                textTransform:"uppercase" }}
              onFocus={e => e.target.style.borderColor = P.blue}
              onBlur={e  => e.target.style.borderColor = P.border} />
            <button onClick={async () => {
              if (teamJoinCode.length !== 6) { setTeamJoinError("Code à 6 caractères"); return; }
              const r = await team.joinSession(teamJoinCode);
              if (!r.ok) setTeamJoinError(r.error); else setModalTeam(false);
            }} style={{ background:P.blue, border:"none", borderRadius:10, color:"#fff",
              padding:"0 18px", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
              Rejoindre
            </button>
          </div>
          {teamJoinError && <p style={{ margin:"8px 0 0", fontSize:12, color:P.roseText }}>{teamJoinError}</p>}
        </>
      ) : (
        <>
          <div style={{ textAlign:"center", marginBottom:16 }}>
            <p style={{ margin:"0 0 6px", fontSize:10, fontWeight:700, color:P.textSoft,
              textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>Code de session</p>
            <p style={{ margin:"0 0 14px", fontSize:38, fontWeight:900, color:P.text,
              fontFamily:mono, letterSpacing:"0.1em" }}>{team.teamCode}</p>
            <img src={qrUrl(team.teamCode)} alt="QR code session"
              style={{ width:180, height:180, borderRadius:12, border:`1px solid ${P.border}` }} />
            <p style={{ margin:"10px 0 0", fontSize:12, color:P.greenText, fontWeight:700 }}>
              🟢 {team.teamDeviceCount} appareil(s) connecté(s)
            </p>
            <p style={{ margin:"4px 0 0", fontSize:10.5,
              color: team.syncStatus === "error" ? P.roseText : P.textSoft }}>
              {team.syncStatus === "error" ? "⚠️ Échec de synchronisation — nouvelle tentative au prochain geste"
                : team.syncStatus === "syncing" ? "🟡 Synchronisation en cours…"
                : team.lastSyncedAt ? `Synchronisé ${fmtSyncAge(team.lastSyncedAt)}` : "En attente de données…"}
            </p>
          </div>
          <button onClick={() => { team.disconnect(); setModalTeam(false); }}
            style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
              borderRadius:12, color:P.textMid, fontSize:13, fontWeight:600,
              padding:"12px", cursor:"pointer", fontFamily:sans }}>
            Quitter la session
          </button>
        </>
      )}
    </Modal>
  );

  // ── ACCUEIL ACR ADULTE EXTRA-HOSPITALIER ─────────────────────────────────
  if (!started) return (
    <div style={{ background:P.bg, minHeight:"100vh", fontFamily:sans, paddingBottom:40 }}>

      {/* Header avec retour */}
      <div style={{ background:P.surface, borderBottom:`1px solid ${P.border}`, padding:"14px 16px",
        display:"flex", alignItems:"center", gap:12, boxShadow:"0 2px 10px rgba(0,0,0,0.04)" }}>
        <button onClick={() => setModule(null)}
          style={{ background:"transparent", border:"none", color:P.textMid,
            fontSize:22, cursor:"pointer", padding:"0 6px", lineHeight:1, fontFamily:sans }}>‹</button>
        <div style={{ width:40, height:40, borderRadius:12,
          background: isTrauma ? P.slateSoft : P.roseSoft,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:21 }}>{isTrauma?"🩻":"🚑"}</div>
        <div style={{ flex:1 }}>
          <p style={{ margin:0, fontSize:15, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>{isTrauma?"ACR Traumatique":"ACR Adulte"}</p>
          <p style={{ margin:0, fontSize:10, color:P.textSoft, textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:mono }}>{isTrauma?"Polytraumatisé · SMUR":"Extra-hospitalier · SMUR"}</p>
        </div>
        <button onClick={() => setModalTeam(true)}
          style={{ background: team.teamConnected ? P.greenSoft : P.surfaceAlt,
            border:`1px solid ${team.teamConnected ? P.green : P.border}`, borderRadius:10,
            padding:"6px 9px", cursor:"pointer", fontFamily:sans, display:"flex",
            alignItems:"center", gap:5, flexShrink:0 }}>
          <span style={{ fontSize:13 }}>{team.syncStatus === "error" ? "🔴" : team.syncStatus === "syncing" ? "🟡" : team.teamConnected ? "🟢" : "👥"}</span>
          <span style={{ fontSize:10.5, fontWeight:700, color: team.teamConnected ? P.greenText : P.textMid }}>
            {team.teamConnected ? `${team.teamCode} · ${team.teamDeviceCount}` : "Équipe"}
          </span>
        </button>
      </div>

      <div style={{ padding:"14px 14px 0" }}>

        {/* Heure de l'arrêt */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:16,
          padding:"18px", boxShadow:"0 2px 8px rgba(0,0,0,0.04)", marginBottom:14 }}>
          <p style={{ margin:"0 0 12px", fontSize:10, fontWeight:700, color:P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.16em", fontFamily:mono,
            textAlign:"center" }}>Heure de l'arrêt cardiaque</p>
          <div style={{ display:"flex", justifyContent:"center", alignItems:"center" }}>
            <input type="time" value={acrTime}
              onChange={e => { setAcrTime(e.target.value); st("hEffondrement")(e.target.value); }}
              style={{ background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:14, color:P.text, fontSize:38, padding:"14px 22px",
                fontFamily:mono, textAlign:"center", fontWeight:800, fontVariantNumeric:"tabular-nums",
                outline:"none", appearance:"none", WebkitAppearance:"none" }}
              onFocus={e => e.target.style.borderColor = P.rose}
              onBlur={e  => e.target.style.borderColor = P.border} />
          </div>
          <p style={{ margin:"10px 0 0", fontSize:11, color:P.textSoft, textAlign:"center" }}>
            Laisser vide si inconnue
          </p>
        </div>

        {/* Bouton démarrer */}
        <button onClick={start} style={{
          width:"100%", background:`linear-gradient(135deg, ${P.rose}, ${P.roseText})`,
          border:"none", borderRadius:18, color:"#fff", fontSize:18, fontWeight:800, fontFamily:disp,
          letterSpacing:"-0.01em", padding:"22px", cursor:"pointer",
          boxShadow:`0 10px 30px color-mix(in srgb, ${P.rose} 40%, transparent)`,
          display:"flex", alignItems:"center", justifyContent:"center", gap:12 }}>
          <span style={{ fontSize:26 }}>🫀</span> Début RCP médicalisée
        </button>

      </div>
      {teamModal}
    </div>
  );

  // ── ÉCRAN RCP ──────────────────────────────────────────────────────────────
  return (
    <div style={{ background:P.bg, minHeight:"100vh", fontFamily:sans, paddingBottom:28 }}>

      {/* Modal Analyse de rythme */}
      {/* ── Modal Défibrillation ── */}
      {modalChoc && (
        <Modal title="Défibrillation" icon={<div style={{width:24,height:24,color:P.blue}}>{ICONS.choc}</div>}
          soft={P.blueSoft} onClose={() => setModalChoc(false)}>

          {/* Choc avec choix joules */}
          <div style={{ background:P.blueSoft, borderRadius:14, padding:"16px", marginBottom:12,
            border:`1.5px solid ${P.blue}` }}>
            <p style={{ margin:"0 0 12px", fontSize:14, fontWeight:600, color:P.blueText }}>
              ⚡ Choc délivré
            </p>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
              <Lbl>Énergie</Lbl>
              <div style={{ display:"flex", gap:8, flex:1 }}>
                {["150","200","300","360"].map(j => (
                  <button key={j} onClick={() => setJoules(j)}
                    style={{ flex:1, padding:"8px 4px", borderRadius:10, border:`1.5px solid ${joules===j ? P.blue : P.border}`,
                      background: joules===j ? P.blue : P.surface,
                      color: joules===j ? "#fff" : P.textMid,
                      fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:mono }}>
                    {j}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
              <span style={{ fontSize:12, color:P.textMid }}>Autre :</span>
              <input type="number" value={joules} onChange={e => setJoules(e.target.value)}
                style={{ width:80, background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:9,
                  padding:"8px 10px", fontSize:18, color:P.text, fontFamily:mono, outline:"none",
                  textAlign:"center", fontWeight:700, boxSizing:"border-box" }}
                onFocus={e => e.target.style.borderColor = P.blue}
                onBlur={e  => e.target.style.borderColor = P.border} />
              <span style={{ fontSize:12, color:P.textSoft }}>J</span>
            </div>
            <button onClick={() => {
              addEvent("choc", `Défibrillation ${joules} J délivrée`, "⚡");
              setModalChoc(false);
            }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.blue}, ${P.blueText})`,
              border:"none", borderRadius:12, color:"#fff", fontSize:15, fontWeight:600,
              padding:"14px", cursor:"pointer", fontFamily:sans,
              boxShadow:`0 6px 18px color-mix(in srgb, ${P.blue} 27%, transparent)` }}>
              ✓ Choc {joules} J délivré
            </button>
          </div>

          {/* Changement patchs */}
          <button onClick={() => {
            addEvent("patchs", "Changement de patchs — Position antéro-postérieure", "🔄");
            setModalChoc(false);
          }} style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
            borderRadius:12, padding:"14px 16px", cursor:"pointer", fontFamily:sans, textAlign:"left",
            marginBottom:8 }}>
            <p style={{ margin:"0 0 3px", fontSize:14, fontWeight:600, color:P.text }}>
              🔄 Changement de patchs
            </p>
            <p style={{ margin:0, fontSize:12, color:P.textSoft }}>Position antéro-postérieure</p>
          </button>

          {/* Double défibrillation */}
          <button onClick={() => {
            addEvent("doublechoc", "Double défibrillation délivrée", "⚡⚡");
            setModalChoc(false);
          }} style={{ width:"100%", background:P.blueSoft, border:`1.5px solid color-mix(in srgb, ${P.blue} 27%, transparent)`,
            borderRadius:12, padding:"14px 16px", cursor:"pointer", fontFamily:sans, textAlign:"left",
            display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:32, height:32, color:P.blue, flexShrink:0 }}>{ICONS.doublechoc}</div>
            <div>
              <p style={{ margin:"0 0 2px", fontSize:14, fontWeight:600, color:P.blueText }}>Double défibrillation</p>
              <p style={{ margin:0, fontSize:12, color:P.textSoft }}>Deux chocs simultanés délivrés</p>
            </div>
          </button>
        </Modal>
      )}
      {modalElectrodes && (
        <div style={{ position:"fixed", inset:0, background:"rgba(28,43,58,0.65)", zIndex:90,
          display:"flex", alignItems:"flex-end", justifyContent:"center",
          backdropFilter:"blur(3px)" }}>
          <div style={{ background:P.surface, width:"100%", maxWidth:480,
            borderRadius:"20px 20px 0 0", padding:"16px 16px 16px",
            boxShadow:"0 -16px 50px rgba(0,0,0,0.2)", fontFamily:sans,
            maxHeight:"94vh", overflowY:"auto" }}>

            {/* ── Section 1 : Efficacité du MCE (prioritaire) ── */}
            <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:8 }}>
              <div style={{ width:36, height:36, borderRadius:11, background:P.greenSoft,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>❤️</div>
              <div>
                <p style={{ margin:0, fontSize:15.5, fontWeight:800, color:P.text, fontFamily:sans }}>
                  Efficacité du massage
                </p>
                <p style={{ margin:0, fontSize:10.5, color:P.textSoft }}>
                  Vérifier en continu la qualité du MCE
                </p>
              </div>
            </div>
            <div style={{ display:"grid", gap:5, marginBottom:14 }}>
              {[
                { t:"Fréquence 100–120 / min" },
                { t:"Profondeur 5–6 cm" },
                { t:"Relâchement thoracique complet", s:"entre chaque compression" },
                { t:"Interruptions minimales", s:"< 10 s" },
                { t:"Relais du masseur toutes les 2 min" },
                { t:"EtCO₂ = témoin d'efficacité", s:"chute → masseur épuisé / sonde déplacée" },
              ].map((c, i) => (
                <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:8,
                  background:P.greenSoft, borderRadius:9, padding:"6px 10px",
                  borderLeft:`3px solid ${P.green}` }}>
                  <span style={{ color:P.green, fontSize:13, fontWeight:900, lineHeight:1.3, flexShrink:0 }}>✓</span>
                  <div>
                    <span style={{ fontSize:12, fontWeight:700, color:P.text }}>{c.t}</span>
                    {c.s && <span style={{ fontSize:10, color:P.textSoft }}> · {c.s}</span>}
                  </div>
                </div>
              ))}
            </div>

            {/* ── Section 2 : Pose des électrodes (secondaire) ── */}
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <div style={{ width:28, height:28, borderRadius:9, background:P.blueSoft,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:15 }}>🔌</div>
              <div>
                <p style={{ margin:0, fontSize:13.5, fontWeight:700, color:P.text }}>
                  Pose des électrodes
                </p>
                <p style={{ margin:0, fontSize:10.5, color:P.textSoft }}>
                  Confirmer le positionnement avant l'analyse
                </p>
              </div>
            </div>

            {/* Image ERC 2025 */}
            <div style={{ borderRadius:12, overflow:"hidden", marginBottom:10,
              border:`1px solid ${P.border}` }}>
              <img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAH5AlgDASIAAhEBAxEB/8QAGwABAAIDAQEAAAAAAAAAAAAAAAMEAQIFBgf/xABFEAACAgEBBQQHBgQDBwQDAQAAAQIDBBEFEiExURNBYXEGFCIyM1KRIzRTcoHBQmKhsRYk0RU1NnOCkvBDRJPxY4Si4f/EABkBAQEBAQEBAAAAAAAAAAAAAAABAgMEBf/EACMRAQEAAgIDAQADAQEBAAAAAAABAhEhMQMSQVEyYXETBCL/2gAMAwEAAhEDEQA/APZgGAMgwAMgwAMgAAAAAAAAAAAAMamTCMgDBk422dtRwk6qWpXP/wDkslt1Et0v5m0MfCWt89G+5cyn/iLA096f/aePuusvsc7ZOUn3sjO88U+sez2S9JMBvTWa/wCkv42fj5a+xsjJ9O8+fG1dk6pKVcnFrvTF8U+Hs+jmTz2xNuu5rHy5e2+EZdT0JxyxuN1W5dgAMqAAAAAAAAAAAAANd5KSj3s2IZfeq/yv9iYAAAAAAAAAAAABhvQAYlJQTlJ6Jd7OJn+kdePdKqmHaOPBvuODn7Xyc56TluQX8MTpj47WblHrLNsYVctHfFvw4ktG0MXIelV0W+mvE+fmYycXrFtPwZ0/4xn2fSDJ5HZO37KJKrKk518lLvR6uuyNsFOElKL4po45Y3HtuXbcAGVAAAAAAAAAAAAAAAAAABgyDAGQYAAAAZBgAZBgyAAAAAAAAAAAAAAYRkwjIFbaF/q2FdaucY8DwFk5WTc5vWTerZ7nbcXLZWRp8p4rFxbcu1V1Rbfe+h6PFqS1zy7W9iYfrWYt+OtcVrIk2zst4drsqWtUv6HotnYMMHHUI+8/efVli6qF1cq7IqUWuKZm+T/62168PAA6G1Nl2YVjcU5VPlLoc87yy8xzs0zFuMk09GuR7vZGX65g12P3ktJeZ4M9P6JWN13V68nqc/LNzbWPb0YAPM6AAAAAAAAAAAAACGf3qv8AK/2JiGf3qv8AK/2JigACAAAAAAAAAcn0gz/U8Pcg/tLOC8EdY8X6SXu3aUo68K1um/HN5M5XUcpJzlouLYlFwk4yWjXNM6mxMRWWO6a4R5eZPtnBcvt6o8f4kjtfLJn6s+l1twwAdWQ9B6N7ScLViWv2Ze74M8+SUWOq+E4vRxkmZym5ol0+jA0qmrKozXJrU3PG7AAAAAAAAAAAAAAAAAAAAADAMgDAAAAyYAAGQAAAAAAAAAAAAADCMmEZAiyK42Y9kJcYuL1KWBi1Y+PDsoJarVvvZ0LPhy8mVcf7vX+VF3wJAARprOEbIuM4qUX3M5Gb6P02xcsf7OfTuZ2QWZWdJZt4G+izHtddsWpI9B6PUX4alfZD7Oa5d508zZ1OXZXOaW9B6+ZPc92rdiueiSOuXk9ppiY6W4tSSa5MyawjuQjHotDY4tAAAAAAAAAAAAACGf3qv8r/AGJiGf3qv8r/AGJigACAAAAAAAAAfP8AaEndn3SS1bkz31kt2uTfcjxux0p7QtlLi+On1OmF9ZazZu6dPZtXZYVceq1LTWq0YB5bd3bvJqOffsmi2cpr2W1yRwciiePc65riv6nripn4MMuvpNLgzt4vNZdVzyw308uDMouMnF809DB7nB7rYl/b7MpffFaM6B5z0TyNYXUN8nvI9GePOaydZ0AAyoAAAAAAAAAAAAAAAAAAAAAwZAAAAADAAGTAAyAAAAAAAAAAMIyYRkDWa1g11RVo+Eo/L7JcKiW5fZHuftIDcABoAAGls3CGq5t6I3qonvqdzTa5JckR2cZ1x/mTLgZoAAAAAAAAAAAAAAACGf3qv8r/AGJiGf3qv8r/AGJigACAAAAAAAACvnS3MK6XSDPD7PtlXnQlF6avRntNrvTZmT/y2eDqn2dkZ9GmdvHN41jK8vYg0psVtUZx5SWpueK8PQAAg85tnH7HK30vZnxOed7bzXq8F37xwT6Phu8I82c1XU9HbnVtOC7pJpntj5/syW5tCh/zI+gGPLOVx6AAcWwAAAAAAAAAAAAAAAAAAAAAAAAAAAABgGQAAAAAAAAAAAGEZMIyAK2TFqUbUtd3g0uhZAFVWQa1Ul9TWd0I9+r6Lib5NFcqpNRSa46o1qjFQjKMUtUFax7WbUpexHp3koAEdr3ZVz6SSZcK0oqcXF8mZx7Xr2Vj9tcn1QSrAAAAAAAAAAAAAAAAIZ/eq/yv9iYhn96r/K/2JigACAAAAAAAACntaDs2bkRitXuPgeB5cz6S1qcTaPo7VkydlEuym+a7mdfHnMeKzlNufsLIUqXTJ8YvgdU4Etj7RxLda63JrviW8e/P7WNeRW64v+Jo5+Tx7vtK1jl8rqNqK1b0NI2OcvZi93qYVS11m3J+PIkPPw6uLt/X7PocY9LtbGeRjLcWsovgUKfR7Nt0bUYJ97Z7fDnPRwzl9nOxXu5VT6TX9z6HB6wi+qOLgejlOPJWXy7SS4pdyO2lotETyZTK8GM0yADk0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADCMmk7I1wcpcis+0u42Nxj8qAsytrj704rzZFLKhrpBSm/BcPqaRqhFabqfnxMyjrHdhLcfggaR29rbXLfe6tH7MTelaUwX8qNNba+f2i+jJK7FYnprw56lVsARPIjrpBOUuiIJTWcI2LSS1I+znbxsekflRJCuNa0jr9QMJ3V+7NSXSXM29Zmvfqa8nqZA2aZWXU3p7S84tEsbIT92Sl5Mha158TSVMJd2j8OATS2CpG2dPCz24fN3otJprVPVAZAAAAAAABDP71X+V/sTEM/vVf5X+xMUAAQAAAAAAAAADDaXNpAZKu0EvV+X8S/ub25dVXBy1l0RSvvnkaJrchrrp3slulkaAA4Og1qtGS4+VKhbk05V9zXNEQNS6Szbp13V2L2JJ+GpIcdwi/Dy4G0ZWw9y2S/qbmcZ9a6wObHKyI98Z+fAlhnpPS2Dj/ADLkallTVXQawnGyO9Bpo2KgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACpP7TIafuw7vE3I6eLm/5mSCrBvRanFndY7pyjZJe09NH3HWyJ7lE5PuRxIpqK15m8IlWIZmRD+NSXiuJNHabS+0q0XVPUpGYR37IQ+Z6G7jGdu6nqk+oC5A4tgACgAAAAA+K0ZpTJ02Kt+5L3fB9Dc0ti5waT0fc+jESrYI6LO0qjIkCAAAAACGf3qv8r/YmIZ/eq/yv9iYoAAgAAAAABHddGmG9N+S6khyrbHfc5v3VwiiW6WTbaeVda+D7OPRc/qRSTl785S/M9TJWzHq4Q8dWYluV01ZJEm7KpvdSlHp3o2V0O97r/m4FNOUfcnKK6G6usXNRl5m74qkyi4aSsaeig2KbO0rUtNNTc49No9bZdyh48zeEd1c231ZkDYAAgAABCU6Zb1XDrHuZ0qLo3170f1XQ5ptTb2Fyl/DLhI6Y5fKzlPrqgA6MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACnTzn+ZkhHX79i/mNpTUNNe96CrFbaU93H3fnehzC9tRS9h6ewub8SidcOmb2E+DDfy49IrUgL2zIfEn4pIuXESOgADi6AAAB66PTiwYjJTjrHigjWu1TbXFSXNM3I7a3Jb0eE48mbVz7SCly6roBsAArWh9ndKHdPivMtFO5NJTj70Xw/ctxeqT6hlkAAAABDP71X+V/sTEM/vVf5X+xMUAAQAAAAAEeQ92ixruizlw91HTyfu1v5WcyHuryMZ9NYslK572RJ9FoW4T397hwT0KKe85S+Z6mvFOTO8MmJcIvToZGm9KK6tHovEc1ymO7VFeBuOXAHhvLuAAgADlzAapMGs4Ka0ZrCTjLcnz7n1KJBJb0WgAL+Hb2tC196PBlg5uJPs8nT+Gz+50jtLuOd4AAVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVIcLbV4o1u4zrXjqbcsi3x0NbPj1fqX6qSUVKLUlqmcnIxZV5MaqdGpptJ9x0bsqmhpW2Ri3yTZDS1dnTsi9YwikmvEuO4lRV7Nk+NlmnhEu0Uwor3ILRcyQEttXQACKA1VkHLdU1vdNTYI0vnuVSa56cDlrKtrsfZyThHgk+8t59u7HRd3H9ehzUtEdMZwza6dOfXZpGfsS8eRIn2d3P2J8vM5GmvM3pdkpxrhN7mq1XToLibdsGlc3ruT4TX9SaEdeL5HNpmENeLJAAgAAAAAhn96r/K/wBiYhn96r/K/wBiYoAAgAAAAAI8jjRZ+VnK10r16I61y1qmvBnIfGp+TMZtYlK+yT68WV7qdxuVfFd66FmvjVHToc7GxsmrIustlrBxffzGF1bdrW0Jdp8NOXkT00z7VTktEjfB+7R/UnNZ+S9JMfoAaVSck2+pxbbg51mddHaCoVesOp0S3GxJdhSvlq3DV8X/AELrenE50XvzlLu1aR08U3UyvDeFllfuvVdGSyvjZHR+xNcVqQms2lB6na+OVzmVi/XNTgpI2IceiWPj1yfuz4+TJjy5TVdZdw3ZSaUPe14HWXJalbEq0W/Lm+RaOmPTOXYADTIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANVFcXpxKuemlXKC4qRbRFlQc6m1zj7SLBRyMXFzd2y2Kk4r9Rs2CjVOUVonN6eXcTSqhbW5aaSa5rgytgURlQ/bsWkmuEi/D6vgjhSoS1UpvzlqSGVAaTqU3rvST8Ga9nauVv1iBRexa3mPIV1i9re3deB0ZzVcNWablv4q/wC0zGlb29OTk/HkW3fY5mZJuai+b9qS6dCAlyVJZVm/zb4eREdp0wF7ZtWtkJNc9W/2KKTlJRjzb0O3hVqO81yXsr9DOV4InsqhZpvLlyZulotDIOTQAAAAAAACGf3qv8r/AGJiGf3qv8r/AGJigACAAAAAAxJaprqceHGLXi1/U7JXjh1x6vjrzM5TcWXTl1vs24S/6X4G9i1rkuqZ0niUyWkoJ+ZyvV0pSg5z1i9PeM3HXLUu0WJbGONFc2m1oieCk5b0+HRdCvs+MY1zWnFTlx/Utky7WdBFF9nNxfKT1TJTEoqS0a1MxTdjrrotepkjVc48I2cPFajs5v3rOHgtANMqzdrlGPvNfQqwjuwSLN9P2LUOfN9WQJ6rU9Pi1pyz7DGm/OMer4mSxs6rtcpN8Uv7f/Z0yuozHZVMXjxqmtVu6FSGJZC1Rb3q/mOgDjZtqcMJaLRGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADCMmEZAp4/wAL9X/cgw/s7b6XzU3JeTJ8f4X6v+5DlUz3o30/EhzXzLoX+lWgRUXxvhvR59670yUgAAKAACntKpSodvKVfH9CjCi+xJxqf6vQv5r7SdWOv43rL8q5ltLRaG5lqM63XLpxrap9pZDTRcFrrxOxTX2dUYc9EQJb+TCPdFbxbM27AAEAAAAAAAAEM/vVf5X+xMQz+9V/lf7ExQABAAAAAAAAAOZlLczJJfxR3jplDPju3Vz+Zbv7kvSztzcf7PKurfe1JForZdb4XV+/D+q6E9dkba1OL1TRzvPLc/GwAMKAAAUZxbypV1LVaavwZcsmq65TfJLUhw4NVuyXvWPef7HTG3HlLN8NFjWvnKK/Q6OyqVCEp/on4EE29NFzfBeZ1KK1VVGC7kbmVy7YskSAAqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMIyYRkCnj/AAv1f9yQjx/hfq/7kgqql+PKFnb4/Cf8Ue6RNj5Eb4arhJcJRfNMlK2RjNy7Wh7lq+kvMvfYsggx8lXaxktyxc4snIABpfPs6Zy6JgVsddtmW3PlH2I/uXCvgw3cSvXnJbz82WC3sjFHHIs8NCyVsf49v6FkVAAEAAAAAAAAEM/vVf5X+xMQz+9V/lf7ExQABAAAAAAAAAKm0Y/YKS5xki2RZEd6ia8GBzeaKlf+Vvdb+HN6x8H0LUOMI+RpfSrq3F8HzT6M4zjiulSAgxbnJOuzhZDg/HxJyWaWAAb0WpBVym7ba6F3vel5FpLRJLkirifaTsvf8T0j5Fpm8vxJ+pMavtclfLDi/PuOmVNnw0pc++T1/QtnSTUYvIACoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwjJhBvRNgVMf4X6v+5IR0fCXm/7kgqgACoMjFjdpJNwsjykjSnJlGfY5K3bO590i0R3Uwvhu2R1X9i7/USGltatqlB96KqnbhPdt1sp7p83HzLcJxsipQkpJ96GtCtiXODWNdwsgtIv5l1LZFkY8L46S4SXKS5oghkTx5KvL5fw2Lk/MdnS3jfGu81/YslSLUciE0/ZmtC2RAAAAAAAAAAAQz+9V/lf7ExDP71X+V/sTFAAEAAAAAAAAAxL3Xr0MlbNu7KrRcZT4JAUIcn5syYitIpGThe3WK+TS21dVwsj/VdCSi6N9e8uDXBroyQq31Tqn29C/NHqanPFTpaIcubhjTa56aI3qtjdBSg9f2I8yDnjy3Vq1x0JO+S9JKIKumMF3I3fJmlNsba1KLNyXtV/Bf8AlYeCLBT2fP2J1vmnqvIuHdyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABhGl73aZv8AlZuiHMelSXWSQGlS0rj5GwS0SQCgIsl3KmTx0pWdyfI2odjqi7klPTikBuAAo1qtGVJ4kqpOzEluPvg/df8AoWwJdIrU5kZy7O1dlb8r7/IsThGyLjJKUX3M0tprujpZFMr9nk43wpdtX8snxX6l4o0uxrqIN40t6K47ku7yZdxc6rJit17s9OMZc0QQzKp+zN9nP5Z8DevGqvp3Zx4wbSkuaL/qLwKGuVic9cirr/Ev9SxTlU3vSE/a74vg/oTQnABAAAAAAQz+9V/lf7ExDP71X+V/sTFAAEAAAAAAAAA5V0+1yJy7o+yjpze7BvojkV+4tTOV4ax7bAA4too3OV8q+zklH+JrgyUAtFW2mVM3dQvzQ6k1N0bob0f1T7iQr3Y73u1oe7Z07pGt77TprZVOibtoWqfvQ6+RNTdC6O9B+a6GlOSpvcsW5Z8r7zF2NrLtKXuWdVyfmW/lP8Wa59lfCa5a7r/U6x55ZLSdeRHs59z7mdzGsVtEJrvRrHemKlABpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGEQZfF1x/m1J0RXVynZW1yjrqBqDfs5eA7OXgFaA37OXgOzl4AaA37OXgOzl4AaA37OXgOzl4AaA37OXgOzl4AQW012rSyCfj3larFspvlHGulBNaqMuKZ0Ozl4Gjqn20JrTSOuvEsqVD2+ZV8THVi61v8A1EHRlXLeplXYuPHg/wCheA2gACKAAAAAIZ/eq/yv9iYjlBu+M+5JokAAAAAAAAAAACHKemNY+kWc2PCKOnkwlZj2QjzlHRFVYdmi5fUxlNtYq4LPqc+qHqc+qMeta3FYFn1OfVGfU5fMh603FUFr1OXzIepy+ZD1puKN1ELl7S0a5Nc0QdpdjcLF2la/iXNeZ1fUn8yM+pP519DUl6qbjnp05NfdOLN8KGTjwn6vJWVwlp2cuf6Etmx4TlvQm659Y8DONRm4k5LSF0ZPVvXdaOmM0zbtZx86u57j1rtXOEuaLRBdjV5MErYLe6rmv1K8KcvGklVNXV68pvRr9S8Mr4MIyRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMarqgMgAAAAAAAAAAAAAAAAAAAAABFZkVVe/ZGP6gSggrzMex6Qti35k2uoGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5+0NrUYK0k9Z9ETbQyViYllr5pcPM8JfZZk2zslrJvizphh7c1nK6dPK9Icq5tVPciU47VzIy1V0tSmD0TGRz3Xo9m+kUt+NeVxT4bx6WE42QUovVPvPm/I9P6M57nF41j1a905eTCa3G8cnowAcGwAAAAAAAAAAAAANLLI1Vuc3olzNzgek+W6qY0RfGfFmsZu6S3SjtD0husnKGO92PLU41uRbc9bJyl5sjB6pjJ05W7bQsnB6wk0/A6uBt7Ix5KNr34eJyAWyXs2+h4mVXl0xsreqZOeR9Gczssl0yfCfI9ceXPH1unWXYADCgAAAAAAAAAAAFHau0I4GM585vhFFk3wLspKKbk0ku9nIy/SLEx5uME7ZLoebydrZmSmp3PdfcuBRO2Pi/WLl+PV1+lNEpaTonBdddTrYudj5kdabFLw7z58SUZFuPYp1TcZLoavinxJk+jA5extqRz6d2XC2K4rqdQ89mrqunYACAAAAAAAAAAAAB5vb+2LKrfV8ae6170kaxxuV1Et07eZnUYdbndNLou9nDu9Kva+yo4dWzz1t9t0tbbJTfiyM74+KTti5PT4/pTBySvpcV1TO5jZdOXWp0zUkfPCzhZtuFcp1SaWvFdzJl4p8Jk+ggq7PzIZuNG2HfzRaPPZp0AAAAAAAAAAAAAAAAAABwvSmxxw4RXKTK+wMCEsWVlsE9/r0LXpHV21dEFzctC9jVKmiEF3I6e2sNMybqk9h4blruaG8Nj4Uf/STL4Me1/WtRzcvY+NbTJQrUZacGjgbN3sPa0IS4Pe3WexODtXE3Np418VwlNa/U6YZfKzlPr0qMmI+6jJyaAAAAAAAAAAAAAA8X6SWOe0pLuij2h4bb2j2lY0dfF2zl05wAPS5gAAs7NbWfTpz3j6BH3UeC2Ql/tGly5KWp72LUoprkefy9t4sgA4tgAAAAAAAAAAHjfSPKd+c60/ZhwR7Cct2EpdFqfPcubsyrJPvkzt4pztjJCDsbFxIzjK2xap8FqabQ2VKuTsoWsOnQ3/1x9vVPS625QDTT0fAHVlf2LkPH2hU0+Enoz3Seq1PnNUty2Eukkz6Fi2K3Hrmu+KPP5Z9bxSgA4tgAAAAAAAAAAiybVTj2WP8AhTZ8+yLXdfOyXOTbPZ7fs7PZtmj4y4HiD0eKcbc8gAHZkAAHovRXIasspb4Pij1B4bYV3Y7Sr15S4HuUebyzWTpj0AA5NAAAAAAAAAAAAAAAAKEqo33OU+LhLgTkVj7Gc9eT4oki9UmWrGQaWWbjiurMTtUd1pp8dGQSEd1EL0lNcnqiQjlaozcX3LUQSYreko66pPgWCHGi41ceb4kwqAAAAAAAAAAAAADWa1hJLoeO9IKd26FiXNaM9mcHb2LvY8tF7r1R08d1UynDyYAPU5AAA6ewYKWY5NaqMT2WPFxpin0PNejmO5KUtODf9D1KWi0PN5Ly6Y9MgA5NAAAAAAAAAAAgzZbuJc/5WfP92VtrUU22+R7va0t3Z9z/AJTxmzbI15kXPk+87eO6xtYy5r0GDV2WLCLWj04lgJ6rgDxW7u3onSrds/HumpSrWvhw1KGTsTXWWPL/AKWdnUG8fJlj9ZuMryeRiXY2naw0T7z1no5kdts9JvjB6HK27OPYxhr7WuuhY9E5+xdDoz1e1zw3XLWstPSAA4tAAAAAAAAAAA4XpTPdwoR6yPJHp/SyX2dMfFnmD1eL+Lll2AA6IAADaqbrtjOPNM+hYtna49c13xR87PdbEnv7Npf8px8s421i6AAPO6AAAAAAAAAAAAAAAAIcilXQafB6cCKl61pdOBbKM59lkSWnsP8AoUSyhGXvLU1VUE9d03TTWqBFCOmmNtsrJLk9BdZuxajxk+RLhrTHhrza4lSplwMgEAAAAAAAAAAAAAAI7q421yjJapokAHgto4M8a1vde43wZSPdumu7tI2RUo7z01KN+wMa1tx1h5Honln1i4fjyRNi4tmTZuwi2u9noIejdKlrK1teR0qsOnFpcaopcOLLfLPhMKsbPojj4lcIpLRcS0aU8ao+Ruee9tgAIAAAAAAAAAAA523Xpsy08N3nuduxctmWpHhj0eLpzy7ep2bcrsSD11aWjLMoqS0fI85svN9Wt3Zv7OX9D0cZKcVKL1TPL5cLjk7YZbjEa4weqX9TZtRTb5IHP2tkurHca+b4NmMZcrpq3UcXPu7fKnLu14HX9FH9vajz56D0UX29p78prDTzy7r1QAPK6AAAAAAAAAAA8x6WP26V4HnD0vpZCTdM9Hu6aanmj1eP+Lll2AA6IAAAe19HXrs2B4o9r6PLTZsDl5emse3VAB5nQAAAAAAAAAAAAAACOdsILiwNpyUIuT5IqwW/vSkveMycrnrJaQXd1N+QWIuylF/Zy0XRjdtf8SRKBsaRqUU+9vvZviySh2b4OINZw3uKekl3gWgV4ZGj3bFo+pOpKXJ6hGQAAAAAAAAAAANJ2wguLA3IbrlBaLjJ9xpK6dnCtaLqzEIKPHm+oCuO7FLvNgAoYktU11MgKY89F2cuDXIsFWcFLiuDXJmY3Sr4WLVdUVlZBpCyM17LNyAAAAAAAAAAANZwjOLjJap80cPM9GabZOWPN1t9z5HdckubRpK+qC1lNIsys6Szbx9/o/mUJy0jOK70zq0UyrqioPR6cU+RdyMh3vditK1/UiM+TyXLhvHHSPdslwlJJfylDbFLeNBVxb0fcdMw1ryejXFHPHL1srVm48msS98qZ/8Aaz0Hozi3UWWStrcU+Wp16s2KSVy3Wu/uLMLq5+7NM9V8vtNOMx0kBjXUycmgAAAAAAAAA1lOMVrJpAa3UV31uFsFKL7mcXK9GKLG5UWSrb7nyOw8qhc7Ykc86pL7N78uiLMrj0mtvLZPo/kY8klZCevQrvY+Uv4U/wBT0spSsm5z5v8AoYF8+XxqeOPMPZWWv/S/qjEdmZcpOMaW2vE9QIuUJqcHo1/Us/8ARfqXxx5yOxM+XKh/VHq9j41mLhQruWkl3G8M+GmlkXF9e4mhlUzekbIsuXkuUSY6TAwmnyMmFAAAAAAAAAAAfAhnkRT0it5+BHObuk1F6QX9TMYqK0SA1crJ8ZS3V0EYQXFPV9WbSipLR8jTsV3NoKkBF2L/ABJDsWuVjAlBpFz0akuPczEZzcknDTqwJARyjOUuekTHYv8AEYEjSa48TTcSfsS3X5mOxf4kjaNMU9eLYG0bpw4WLVdUTwnGa1i9SE0cGnvQejBpbBHTb2kePBrmiQIAAARWXRr4c30RtdPs4N9/cV4R/ilxkwDdtnN7q6GVXFceb6s2A2oAAoAAAAAAADR1xfFcH4BStr799G4G003rujPhyfRkpVnBS4rg+5klFjmmpe9HmETAAAAYfIDS66NMN6T8l1OfZfbc3rJxj0Riybutc3y7l0NTnll8jcjXs4dDVuMHoov6EgMba007Vd8ZL9DaMlJarX9TIAGnaruUn+hu2lzehjej1X1EGnarvjL6GyUJrXd+vAzvL5l9TPMDMZTr+HNx8O4vYuR2y0lwmuaKBmEuztjNeT8jeOX6zY6wMJ6rUydGAAAACHKsdVDa5vgBFk5e69yrjLvfQpNb73ptyl1YitF4mTlctukhol3AAyoACAAABhxT5oyCjMJzpetbaXy9x0qLVdWpL9TmE2HPcucO6XE3jl8rOUdEAHRgAAAAACLJlu1PTv4EpXyuKjHq9QMQW7FIyAFAAFAAAI77Oyqc0tdCQgzfu0hO0VP9o2fIh/tGfyIpg7esY3XTxcx3WODjpw1LZy9nfeX+U6hzymq3AAGVaxe5en3S4MtFO7lH8yLa5BlkAAVsh62wh3czJrZ95XkbCrAABQEOVY6qJTjzRQWdf1RZjalunVNVNObj0OZ6/d4EuFkTtyJKfetS+tibXZT0sjHqbkV3CcJeOhKZUAAUAAA1hwyVp/EuJsaS9m2uX6CJVsABA0telcn0RuR5HwJ+QHLjyMhckDhe3UABAAAFbMSe6mV9yPyosZfOBCevxfxcsu2rhHR+yi5i/BRVfJlrG+BEnm6XDtKYktYtGQ+R5nR0cWW/RCXgTFbAf+XiuhZO7kAAAVNoP7KK6stlPaHuw8xVioADzugDEnuxb6FdZev/AKcvqamNvSWyLOq107wVfWftN7s3pp1Jar1ZJrdaa6luFhLKlbS5g1tXsa9OJmL1imZVkAEAJ7tkJfzJAxLufR6mp2Xp10ZNYPWKZsdnIAAAAACvk/Er/UsFfJ+JWAAI7W4uMly10YVIAAAAChXzvu0vNFgr5ybxpaLXiiztK5IAO7C1s77y/wAp1DmbNX28n3aHTOOfbUAR3SaSiucuBvFbsUjKtLuUfzItrkipdyj+ZFtckEZAAFW77zHxibGL/vMPymRVjCkm2lzRkifs3p90kSgVtofdJfoco6u0PusvNHKOuHTNC1s77y/ylUtbO+8PyLl0k7dC9exr8r1N4vWKYkt6LT7zSmXsuL5xOLaQABQ1lNR017zYi97IevKK4BEpHb71f5iQjt96v8whVwABAjuWtM14EhiS1i0ByI8jWxtzjFeZtFaap80zTnd5I4/XT4kBVz8t4lakoOTZNj29vTGejjr3Met1td86SAAyK2X70CEuzrjYtJLUqX1SpW8vajrp5Hp8ec1pzyl7aPky3jfAj5EdeMmt6x73fouRDjZ6sypUKtxS5Mmd95wYzXa5ZwlF92vE3I7vc/VEi5I4fHRdwPhNdGWins9+zNfzFw7TpyoACgVNoL7OL6MtlfOi5Y707nqBQMSkopa970MrkR3vSMW/mRwnbq2t+FLyKMfdRdt+FLyKUfdR6PD1XPNkkxviyIyXF+JI35P41nHtaktYtdTSp6x0fNG5HL2Jby5PmeSOyQBPVaoEEcPiz8zeXus0h8Wfmbz9x+Rr6OrX8OPkbkdD1pi/AkOzkAAAAABXyv4H4lgr5Xux8xAI7/gy8iQ0vWtM14BW0OMEZbSWrK9blVFJ8Y9SV7t0HHXg0AhbCzXckpadDcq4eBXiOTg23LnqSysk3pCP6sX+hK2lzD0048iONT13pvVm8oqS0YFPLxIOErIey0tSLFwe0gp2S1T7kWMiNldE9PajobYU1LHj10Nbuk1y3r7KD3IOKfREpSq2dCvKd6nJt9xZnao8Fxl0JVa2tO6tExWjB9unJ6y0LJKI7uUfzItrkipdyj+ZFtckEZAAFW/7zD8psa3/AHmH5TYVYiu96v8AMSkV/wDB5kq5AVtoJvFlotTlLkd5pNaMo5WDFpzre613G8ctcJY55b2am7pPThpzGJhdrCNlr59yOjCuNcdIpJFyy+JI2IrE4T34/qiUHNoT1SYAAEVfxZkpFX8WYEpHbzr/ADEhHb71f5hCrgACAAA5d8dzImuvEgn7NkZd3JlvNX+YT/lIJJNNM5ZdtzpiUYzWkkmvEykktEtEQVxs0ajPk+9am+5Y/es4eC0I0zOxR4R4y6G0Nd32nqzEYRhyX6mxAabWiehBZq4Srs71opE4a1WjEuhDiz36ku+PAkVcIyclFJvv0KsoOjITg92M/pqWN2x87Fp4RNX9SMWSUpxh9SUxXSlj2yXNS5mVyGU0S7T4MtLpx8NToHKpluZEJdz4M6pvHpi9gANIGtkd6uUeq0NgBx4966PQ1sippRfeyRrScl4msu59HqcusnT40nGTqlD+JdxTXD2ZLRruZ0747t2vzrUrZaj2MpSXFcjpjl63TNm5tWbS5k2LGW9KTi0ny1NseiMYKTWsurJxn5N8Qxx1yDmAcG2IxUVojIMT91lEdLbctVo9SU3ur3Oyemns8TQ1lNVJzF7AlrjpPmiyUMCWlk4deJfOk6c6AAoAAAV8ri4LxLBWyPjVrzEGTW34cvI2MT9xhWtXGtGyhFPVLia0/CRuAAAUAAGtkd6uS6ogwJa0KL96PBlkp2J41/aRWtc/e8Cz8RcGi110MQnGcU4vVMyQRf8Auf8ApJSL/wBy/wApKKI7vdj+ZFtckVLvdXg0W48YoJWQABVt45K8EbGr45E/A2FWIsj4eviSrkiPI+E/NG8fdQGSHMluY0336ExUyn2t1dK66yLCp6I7tMV4EgS0WgIAACgAAEVXGc346EreibIqPdb6vUIlNLOM6/zG5pPhZW/EQq2AAgAAKOf8SDK2q5aosZz+1ivArKEU9dOJyz7bx6aQ9myUevEkI58LYvqSGa0AAgAADS2tW1uL/Qjx7W9a7OE4/wBSchyKVOO/F7s48mjU/Kl/XQxq97CevNrUpaScdE9H3lrEylXCNWRHs5dzfJkNiULppPVPijpnOGcby003YrVtuPHVnWqlvVxl1Ry3xRewZb1C15omFMlkAG2QAAcq3hkWLxNZLVNdTNj1um+rMHHLt0nSWz7XErs748ylkvflCpfxPV+RfxdHRfGXJHPxouc5Wy8kdL+sz8WUtFoADi2AAAZjHfthHq9TBNhx3sht8orgax7TLpNnw+xjL5XxKZ1LoKyqUX3o5D39NFomuDN5xnGpqZbmRB9eDOocd6pJ66tNHWre9CL6ouPRl22ABpkAAAqye9kN9yWhZfBFSrjvS6vUCQxL3WZD5MKjx/hIkIsb4KJRQAAUAAANKS0a1QAFWWLKD3see74PkO1yYe/Un4ploF2mlOrIlLIadcl3Fwir+LPzJRSNbVrXLyJ6XrXF+BEZxPh6dGQqcA0telcn4MIr1+1Oc+rNzSr4aNxVR5Hwn+hvF+yvIq5EMlxluyjumIUXWQW/botO4uuBLdkxr9mPtTfJIxjUyhrZZxnLn4G9WNXU9UtZdWSj/AABFAAAAAGJe6/I0o+FE3l7r8jSj4SCJCO7hFS+V6khia1i0BYi9YpmSLHe9TF+BKEAABzs1/5lL+UhJs1f5lP+UhOWfbpj0js9+BIR2fEgiQyoACABzAAxLjour0MmH78PzIs7L06jqjOtQnFSWnJnNztn117s6pTrWujUWdVcjS+HaUyj1R3cnKhDcilvSl4y5lvZ79qyPjwKseRPhvTJ06o549t3p0QAdGAAwByebl5s1UEnrq35iU41uW9JLRsglbPI9mlaR75v9jlZdukvCaneyLpUVv2NdZy/Y2UFXKUI8EmybZdcaYW6dz4si13pSl3Nto3l/FmdgAOLYAABZ2f702VixgPSycf1N4ds5dL5zMmHZ5D6S4nTKmfDWtTXOLOlm4zOKpy91+R0MSW9jw8Foc8ubPf2TXemzGDWS2ADowAADEvdfkVKPhIty4p+RXqgowSco/UDIfJm2i+ZfUaLT3l9QqDG+CiUxVWoQ0co/U30j8y+oGoNtI/OvqNI/OvqBqDbSPzr6jSPzr6gag20j86+pnSPzL6gaA30j8y+o0j8y+oFer4lnmSmK4KM5tyXF8OJJpD5l9RRoZxfdfmbaQ+ZfUVKFaaUlx8QJSO74U/I234/MvqYm4yg47y4rqEQV/Dj5GwhBRilvR4eJtovmX1Co7Pcl5GKfhR8iRxi01vL6iMIxikpLReIGAbaR+dfUaR+dfUDUG2kfnX1GkfnX1A1BtpH5l9TOkfmX1A0BvpH5l9RpD5l9QNHyfkR0e5p0J9IfMvqaV1xgmt9cX1AB8mb6Q+ZfUaQ+ZfUDGL8CPkTGlSjGCjF6pG4QAAFLaEfckuujKp07ao2w3ZciP1OvqzGWO2pdOZLjbHwJS56lXvb2r1M+pw6sz61faKJku+pw+Zj1OHzSHrV9ooRio66GS96lD5pGPUo/Mx609opGJ8It9C96lH5mYlgxlFrefETGpuLNb1ri/A2NYR3YqOvI2OrDl3w7PIku58UYqe7kV+L0L1+PG6UW21p0Mxxq4tPd1a5MzrnbW+NJgAaZCK+lXRUXOcfyvQlAHFuwqqsmWsXLXinLib6aLgdOdMLJKUo6tGOwq+RGMpbWpdKMJbmJNrnN8CNLRJHRnjVzjGKW6o8kjX1SvxGUtJdKAL/AKpDqx6pX4mfSte0UAX/AFSvxHqkOrHpT2igSY0t3Jj/ADLQt+qQ6sRxIRmpJvVFxxsqWyxYNbI79covvRsDow48dVqnzRZwH9pYvIs+rVuyU2tWySMIx91JGZNVq3cbAA0yAAA+KIfVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4MPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAGldNdWvZwUdeeiNwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHN2jtT1W2GPRU78ma1UF3eZ0jgbShfgbYjtGFMrqpR3ZKPNdxZzUqZ5W24LelhUyXyxlx/uXtnZks2iU7KZUzjJxlGXUp0+keDY0pudT/AJo/6HThdXOrtYTjKDWu8nqi3/CJAefxo5W25WXyybMfGUt2EK3o2b12ZOyto04998r8a/hGU+cWPU27oORt2+2mWF2Vkob1yUt16ao6z5Mmhkwcn0evtvwrZXWSskrZJOT14aIo7MltTPonGvJ7OtTetsval5IvqbelMHJuuu2Nsyyd97ybXLSDl4/+Mjp2XmZFcbsnaF8LZLXdhwUSaNu2YOb2t+y9m3WZlqvlW/Yly3l3JlajAyM2qN+Xn2wnNbyhXLRRQ0bdwHH2XkX1Z12z8m3tnBb0LHza8TsCzRFPOuy6p0rFoVsZS0sb/hRcORtu+2m/BVVkoKduklF6argTbZz54WPBUrW+2W7DXu8Rro26Bk4sdj5co79m071c+e6/ZTNs3LytnbNqhZNW5dktyMtOD8Rr8NuwDiLY2W6+0e0r/WNNefs6lnYudZl0WQyFpfTLcn4+I0bdEyecw/8AaGfk5lUMyVdMLWnLnJcXol0NpxydjZ2N/mrL6LpbklPuL6pt6EHM21nW4tdVON8e+W7F9PEry2PlxrdkNo3vIS14v2W+hNLt2wc/Y2fLOxG7VpdXLcnp16nQJeFAV86Fs8O2OO9LXHSL104key68mrCjHMk5XavVuWv9QLhU2nlywsGy+EVJx04PzLZzPSH/AHPf+n9yztL0r17R2vbXGyGz63GS1T3+aLWDk7QtvccvEjTXut7ylrxKOJtmdWJTWsDInuwS3kuD4cy9g7Tll3ut4d1Pst701w8jVn9JFfI2pmLaVuHiY0LXBJ8ZaPTh/qay2zlYkovaGC665PTfhLXQihfVj+k+VO6yNcXWlrJ6ceBttrPozMX1PEavutktFDjpxGv6Nu5CcZwjKL1jJap9Tl5e15LKeLgUPIuXvcdIxLSUsLZWmusqaefikUvRmlR2e7nxstm3J+RJJ2pLM2zSt+zBqnHvVcuJ0MDLWbixuUJQ11TjLmmiyYSS5JIloyc/aO1YYU40whK7In7tcf3OgcHYcVk7RzsuzjNT3Y69y/8AEJPpUvrO22t5YVCXyufH+5Ps/aduTkSxsnGlRdGO9x5NFy7Jox2ldbCvXlvS01NasrGyLNKbq7JpfwyTaRd/0LAORiX2y9IMymVknXGCcYt8FyN/SG62jZkp02SrnvJaxejJrnRtczbL6saU8WtW2rTSL7+Jvjysnj1yuhuWOKcoruZS2rdZVsSdtc5RsUIveT480bxy/V9jQyrW5uNSk9Xxk9Brg2vHNqzbpbduxG12MK1JLTjrw7yni4OZtGqOVk51tTs4whXwSXca7Nqso9Ir67bndJVe+1xa4F1OU29CYORn5ORk7QWz8W3sUo71tnel0RBl4WRs6iWVi59s5V8ZQslqpIaXbpbXybMTZ1t1LSnHTRta947fIey4X0wVt7hGSjyTbKe1r1k+jsrktFOMXp04okyLJ1ejm/XJwnGmOjXNchrhNr+LO2zHrlfBV2te1FdzJTlu63/DvbdpLtew139eOpUwsTO2jh1WX58663H2VDm/FsaXb0AOLsq7Io2jfs/JtdyhHehN89P/ABmczIyMzaLwMW7sIVx3rbFz8kTRt2QcDMxcjZlLy8XOts7PRzhZLVSRPtXadlWzKLsd7kshpKT/AIU1qPU27AOMtkXSgpw2pkOxrXe11izp4sbYY9cb5qdqWkpLvYsExzc7Mza8lUYWJ2r3dXOT0ijpAkVw7Nq5+DKMto4sFTJ6b9b10O1GcZVqafsta6+BxvSK5WUwwalv33SWkV3It5qeLsS2KfGund1/TQ1ZtlVjtPOzbJ/7NxoSpg9O0sem95FjZ2055F9mLlVdjk1rVxT4NeA2BBQ2RRouabf1Kud9n6S4M48HOO6/HmXjo/te2jl5GO64YuM77J69/CPmUbdobWxIdtlYdTpXvbkuKO2c7bmXDH2fZB8bLU4Qj3vUk/Fq5i5EMrHhdU/ZmtVqclbWz7snIqxcOuxUzcW97TvL+yMaWJs2mqxaTS1a6N8Tj4l2Vg5udKOBddG21tOK0XBsSTlKv0Ze1ZXQjbgQhW5JSkp8l1Bvg7Zpy73jzrnRf8k+8Eqx0wARQrLOx3kzx3bGNsOcZcNfLqWShmbIw82bsurasfOcXoyzX0S5ePiTqlLJrq3NOMpJL+pyfR+uU8LNhDXsZSar18v/AKLMfRzDUk5yusS/hlPgdSqqFNarqioQjySWiRd6mmdOR6M2x9Rljt6W1Te9F8zTbMlk7UwMap71kZ70tO5cP9C5l7Gxcu53PfrsfOVctNSTB2XjYLcqYtzlznN6sbm9mr0oekj3Y4dj92FybZ17ciqql2zsjGvTXeb4GMnGqy6ZU3x3oS7ihT6P4VVik1ZalyjOWqX6DjS8ofRjjs+5/wD5pf2Rn0X+42/85/2R0cLBpwapVUKSjKTk9XrxGFhU4NUq6N7dlLee89eIt7JHP9J65S2dGcVqq7FJ+XI6eNkV5GPC2qScZLXh3EkoxnFxmlKLWjT5M5cvR7Ccm4u2uL5xjPRDjWg25pl7Jv7CSs7OSct3jy5kGz9mbLzcSu2EG5OK3l2j1T7+862Lh04dPY0Q3Yc2uerKVuwMKyxzgrKW+arlohL8TTfEwMDEy/8ALpK/dfDfbenkdEpYWy8XBk50Re/JaOUpatoukqxxPSD7xs7/AJ3+hj0iTrswslrWFVvteHL/AEOnlYVOXOqVu9rVLejo9OJNbVC+uVdsVOEuDT7yy9GiFsLK1ZCcXBrVST4HE2/ZGcMPLranVVd7TjxXP/8Awnfo7ha8Hco/IrOB0IYePDF9WVUex003HxQmpTmt1dW6e1U49nprva8NDj+j2tt+dkpNV22+z48W/wByX/DmHr7125r7m/wOnTTXRVGqqKhCK0SQ4k4HI9H/AL1tL/nfux6RfEwP+ev2Oli4NOJO6dW9rdLelq9eIy8GnMdTu3vspb0dHpxG+dprjTmbe+xzcDKl8OuzST6cUdid1cKXdKcVWlrva8NBfRXkVSqugpwlzTOYvR3D3uMrnDX3HPgOLOV5R+jUXKnJv00jba3H/wA/U7ZpXXCquNdcVGEVoku43Jbuk4R3WwoqlbbLdhFat9DGNkVZVStonvwfBPTQzkUQyaJ02a7k1o9HoaYeJVhUKmnXcTb4vUipzmekP+57/wBP7nTIcvGrzMeVN2u5Lno9GWdpUOzpwWz8ZOa+FHv8C0pxk9FJPyZyv8N4HS3/AL2WMLY+Lg3drQp7264+1LXgLom3Njj1ZPpPlQvrjZFVp6SWvHgbZ+JPZOQtoYEPslwtqXLTqdaGDTDOnmR3u1nHdfHhpw7v0LDSkmmtU+aZfZNK1dtW0cFyqlrC2Lj5eDOV6P5SxlZs/Jartrm91S4anUw9nUYM5vH34qfFxctV9DGbszFztHfXrNcpxejG50uqszshVFysnGMV3t6I0xsmvKq7WmW9BtpPTnoc6Po7hKSc5XWJd0p8Dp00149SrpgoQjySJdHKQ87h2rZO2MijIe5Ve96E3yPREGVh0Zle5kVqce7XmvISljXIw8XNUZX1QtUV7LfccfZtVNPpHk146jGtV8FHl3Fn/DmHrwsvUflVnAvYezsXC+71KMmtHLm3+pdyRNObjSVXpRlRm0nZWt3Xv5GfSi6tbOdTnHtJSTUdeOhdz9lY2fKMrlJTitFOD0ZAvR/B7GVbjOTlzm5e19S7nZqm2P8AcFn5I/3RDm1ys9F4qPFqqEv0Wh1MjEqycV41mvZtJPR6Pgb1UwqojTFawjHdSfHgTa6VtlZFd2zaJQkvZgoy48mjn4dsLvSfJnVNTj2Wmqeq7iaXo7hSscl2sIvnCM9EWsbZeLiZDuog4Scd3RPhp5DcTlx8rHx36RWRz0+zuinCW80tdF3/AKHQlsPZkYuUq2o9XY9P7l3MwqM2vcyK1NLk+TXkygvR3C19qV04/LKzgXZprtWFNfo9OOP8JRW7x14am2Z/wy/+RH9i9dg0XYfqsotU6JaRemiRmzDqsw/VJb3Zbqjz46LxJtdOe/8Ahf8A/XLOxP8AdGN+T9yf1Or1L1T2uy3Nznx08zfGohi0Qpq13ILRavVktNOTX/xXd/yV/ZFSzGxn6Q3156e7alKt7zitTurBpjnSzFvdrKO6+PDTyGZgY+dBRyK1LTk+TX6l9k0pT2HsyuDlODjFc27Gl/cnsqwJYdONa4dhNJVqUufTRlePo7hJrfldZFfwys4FzJ2djZWPCm2v2Ie5o9N0b/tdOVl7HWDj2ZGHmXU9nFyUXLg/A6mysizL2dTdavbkuPDnx5lWPo9hprfldZFfwzs4HUhCMIKMEoxS0SXcLSRsc3aW1PVpLHx49rlz92HdHxZ0jnZexcTMyHdcrN9pJ6T0JNfS7+NNm4EcaUsjJtjbl2e9Nvl4It59XrGBfXHi5waWnUo/4cwOlv8A8jOji41eJRGmrXcjy1erLb9Ioejt8bNl116rfqbjJd64le5rL9JqI1+0seGsmu5/+aFrJ2HiX3StTsqnL3uzlpqWcLZ+PgQcaItOXvSb1bG52mq02jtGrArW8nO2fCFa5yZUwMGVl/r20ZxlkP3Ia8K1/qW87ZeNnzhO9T1gtFuy0Kv+HMDpb/8AIxNaOXV3k1qmmka03VXw36bIzj1i9SHCwKcGqVdG9uyer3palKfo7hSk3B21a90J8CcLyrbTlC7b+DChqVsHrNruWuvH9NQdTB2ZjYGrog9985yerYFpIuAAigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIr768eqVlst2KBy/SP7vT+d/wBgc8s7Lp7PD4Mc8d1//9k="
                alt="Positionnement électrodes ERC 2025"
                style={{ width:"100%", maxHeight:128, objectFit:"contain", display:"block" }} />
            </div>

            {/* Légende positions */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:12 }}>
              {[
                { pos:"Antéro-apical",    desc:"Sous-claviculaire D + apex G", color:P.blue },
                { pos:"Antéro-postérieur",desc:"Sternal + dorsal G",           color:P.teal },
                { pos:"Antéro-latéral",   desc:"Sternal + latéral G",          color:P.violet },
              ].map(p => (
                <div key={p.pos} style={{ background:P.surfaceAlt, borderRadius:9, padding:"7px 10px",
                  borderLeft:`3px solid ${p.color}` }}>
                  <p style={{ margin:"0 0 1px", fontSize:11.5, fontWeight:700, color:P.text }}>{p.pos}</p>
                  <p style={{ margin:0, fontSize:10, color:P.textSoft }}>{p.desc}</p>
                </div>
              ))}
              <div style={{ background:P.amberSoft, borderRadius:9, padding:"7px 10px",
                borderLeft:`3px solid ${P.amber}` }}>
                <p style={{ margin:"0 0 1px", fontSize:11.5, fontWeight:700, color:P.amberText }}>Femme</p>
                <p style={{ margin:0, fontSize:10, color:P.amberText }}>Électrode sous le sein gauche</p>
              </div>
            </div>

            {/* Bouton valider */}
            <button onClick={() => {
              addEvent("electrodes", "Vérifications de départ : efficacité MCE + pose des électrodes", "✓");
              setModalElectrodes(false);
            }} style={{
              width:"100%", background:`linear-gradient(135deg,${P.green},${P.greenText})`,
              border:"none", borderRadius:13, color:"#fff", fontSize:14.5, fontWeight:700,
              padding:"13px", cursor:"pointer", fontFamily:sans,
              boxShadow:`0 6px 18px color-mix(in srgb, ${P.green} 35%, transparent)`,
              display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
              ✓ Vérifications faites
            </button>

            {/* Bouton ignorer */}
            <button onClick={() => setModalElectrodes(false)}
              style={{ width:"100%", background:"transparent", border:"none", padding:"8px",
                color:P.textSoft, fontSize:12, cursor:"pointer", fontFamily:sans, marginTop:2 }}>
              Ignorer
            </button>
          </div>
        </div>
      )}

      {/* Modal Analyse de rythme avec icônes SVG */}
      {modalRythme && (
        <Modal title="Analyse de rythme"
          icon={<div style={{width:24,height:24}}>{ICONS.rythme}</div>}
          soft={P.amberSoft} onClose={() => setModalRythme(false)}>

          {[
            { id:"rv_fvtv", label:"FV / TV",    sub:"Fibrillation ou Tachycardie ventriculaire", svg:ICONS.fvtv,     accent:P.rose,  soft:P.roseSoft,  textC:P.roseText,  log:"Rythme : FV / TV" },
            { id:"rv_aesp", label:"AESP",        sub:"Activité électrique sans pouls",            svg:ICONS.aesp,     accent:P.amber, soft:P.amberSoft, textC:P.amberText, log:"Rythme : AESP" },
            { id:"rv_asy",  label:"Asystolie",   sub:"Absence d'activité électrique",             svg:ICONS.asystolie,accent:P.slate, soft:P.slateSoft, textC:P.slateText, log:"Rythme : Asystolie" },
            { id:"rosc",    label:"RACS",         sub:"Retour activité cardiaque spontanée",       svg:ICONS.racs,     accent:P.green, soft:P.greenSoft, textC:P.greenText, log:"RACS — Retour activité cardiaque spontanée" },
          ].map(r => (
            <button key={r.id}
              onClick={() => { addEvent(r.id, r.log, "📈"); setModalRythme(false); }}
              style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:12, padding:"12px 14px", cursor:"pointer", fontFamily:sans,
                textAlign:"left", marginBottom:10, display:"flex", alignItems:"center", gap:14,
                transition:"all 0.1s" }}
              onPointerDown={e => { e.currentTarget.style.background = r.soft; e.currentTarget.style.borderColor = r.accent; }}
              onPointerUp={e   => { e.currentTarget.style.background = P.surfaceAlt; e.currentTarget.style.borderColor = P.border; }}
              onPointerLeave={e => { e.currentTarget.style.background = P.surfaceAlt; e.currentTarget.style.borderColor = P.border; }}>
              <div style={{ width:44, height:44, background:r.soft, borderRadius:12, padding:8,
                boxSizing:"border-box", color:r.accent, flexShrink:0 }}>
                {r.svg}
              </div>
              <div>
                <p style={{ margin:0, fontSize:15, fontWeight:600, color:P.text }}>{r.label}</p>
                <p style={{ margin:"2px 0 0", fontSize:12, color:P.textSoft }}>{r.sub}</p>
              </div>
            </button>
          ))}

          {/* Séparateur */}
          <div style={{ borderTop:`1px solid ${P.borderSoft}`, margin:"6px 0 12px" }} />

          {/* ECG post-RACS */}
          <button
            onClick={() => { setModalRythme(false); setModalEcg(true); }}
            style={{ width:"100%", background:P.tealSoft, border:`1.5px solid #B2DADA`,
              borderRadius:12, padding:"12px 14px", cursor:"pointer", fontFamily:sans,
              textAlign:"left", display:"flex", alignItems:"center", gap:14 }}>
            <div style={{ width:44, height:44, background:"#B2DADA", borderRadius:12, padding:8,
              boxSizing:"border-box", color:P.teal, flexShrink:0 }}>
              <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="4" y="8" width="32" height="26" rx="4"/>
                <polyline points="8,21 12,21 15,13 18,29 21,17 24,25 27,21 32,21"/>
              </svg>
            </div>
            <div>
              <p style={{ margin:0, fontSize:15, fontWeight:600, color:P.tealText }}>ECG post-RACS</p>
              <p style={{ margin:"2px 0 0", fontSize:12, color:P.teal }}>
                {ecgText ? "Décrit ✓ — Modifier" : "Décrire l'électrocardiogramme"}
              </p>
            </div>
          </button>
        </Modal>
      )}

      {/* Modal mesure hémodynamique */}
      {modalHemo && (
        <Modal title="Mesure hémodynamique" icon="💓" soft={P.greenSoft} onClose={() => setModalHemo(false)}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:12 }}>
            {[{k:"pas",l:"PAS",c:P.rose},{k:"pad",l:"PAD",c:P.blue},{k:"fc",l:"FC",c:P.violet}].map(({k,l,c}) => (
              <div key={k}>
                <p style={{ margin:"0 0 5px", fontSize:9, fontWeight:700, color:c, fontFamily:mono, letterSpacing:"0.1em" }}>{l}</p>
                <input type="number" inputMode="numeric" value={hemoForm[k]}
                  onChange={e => setHemoForm(f => ({...f,[k]:e.target.value}))} placeholder="—"
                  style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                    borderRadius:10, padding:"12px 8px", fontSize:24, color:P.text, fontFamily:mono,
                    textAlign:"center", fontWeight:800, boxSizing:"border-box", outline:"none" }}
                  onFocus={e => e.target.style.borderColor = c}
                  onBlur={e  => e.target.style.borderColor = P.border} />
                <p style={{ margin:"3px 0 0", fontSize:9, color:P.textSoft, textAlign:"center", fontFamily:mono }}>
                  {k==="fc" ? "bpm" : "mmHg"}
                </p>
              </div>
            ))}
          </div>
          {(hemoForm.pas && hemoForm.pad) && (
            <div style={{ background:P.amberSoft, border:`1px solid ${P.amber}`, borderRadius:9,
              padding:"7px 12px", marginBottom:12, display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:9.5, fontWeight:700, color:P.amberText, fontFamily:mono }}>PAM calculée :</span>
              <span style={{ fontSize:20, fontWeight:800, color:P.amberText, fontFamily:mono }}>
                {Math.round(parseFloat(hemoForm.pad) + (parseFloat(hemoForm.pas) - parseFloat(hemoForm.pad)) / 3)} mmHg
              </span>
              {Math.round(parseFloat(hemoForm.pad) + (parseFloat(hemoForm.pas) - parseFloat(hemoForm.pad)) / 3) < 65
                && <span style={{ fontSize:9.5, color:P.roseText, fontWeight:700 }}>⚠️ &lt; 65 objectif</span>}
            </div>
          )}
          {/* Shock Index (SI = FC / PAS) */}
          {(hemoForm.fc && hemoForm.pas) && (() => {
            const si = parseFloat(hemoForm.fc) / parseFloat(hemoForm.pas);
            const siR = Math.round(si * 100) / 100;
            const siC = si < 0.9 ? P.greenText : si <= 1.4 ? P.amberText : P.roseText;
            const siL = si < 0.9 ? "Normal" : si <= 1.4 ? "Inquiétant" : "Critique";
            const siI = si < 0.9 ? "✅" : si <= 1.4 ? "⚠️" : "🔴";
            return (
              <div style={{ background: si < 0.9 ? P.greenSoft : si <= 1.4 ? P.amberSoft : P.roseSoft,
                border:`1px solid ${siC}`, borderRadius:9, padding:"7px 12px", marginBottom:12,
                display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:9.5, fontWeight:700, color:siC, fontFamily:mono }}>Shock Index :</span>
                <span style={{ fontSize:20, fontWeight:800, color:siC, fontFamily:mono }}>{siR}</span>
                <span style={{ fontSize:12 }}>{siI}</span>
                <span style={{ fontSize:9.5, fontWeight:700, color:siC }}>{siL}</span>
                {si >= 0.9 && <span style={{ fontSize:9, color:siC, marginLeft:"auto" }}>objectif &lt; 0,9</span>}
              </div>
            );
          })()}
          <button onClick={() => {
            if (!hemoForm.pas && !hemoForm.pad && !hemoForm.fc) { setModalHemo(false); return; }
            setHemoList(prev => [...prev, { sec, time: getNow(), ...hemoForm }]);
            try { if (navigator.vibrate) navigator.vibrate(28); } catch(e){}
            setModalHemo(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.green}, ${P.greenText})`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
            padding:"13px", cursor:"pointer", fontFamily:sans,
            boxShadow:`0 5px 14px color-mix(in srgb, ${P.green} 28%, transparent)` }}>
            ✓ Enregistrer la mesure
          </button>
        </Modal>
      )}

      {/* Modal instaurtion amine */}
      {modalAmine && (
        <Modal title="Instauration amine" icon="💊" soft={P.greenSoft} onClose={() => setModalAmine(false)}>
          <Lbl>Médicament</Lbl>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
            {["Noradrénaline","Adrénaline","Dobutamine","Autre"].map(t => (
              <button key={t} onClick={() => setAmineForm(f => ({...f, type:t}))}
                style={{ background: amineForm.type===t ? P.greenSoft : P.surfaceAlt,
                  border:`1.5px solid ${amineForm.type===t ? P.green : P.border}`,
                  borderRadius:10, padding:"10px 8px", cursor:"pointer", fontFamily:sans,
                  fontSize:12, fontWeight:700, color: amineForm.type===t ? P.greenText : P.text }}>
                {t}
              </button>
            ))}
          </div>
          <Lbl>Dose</Lbl>
          <div style={{ display:"flex", gap:8, marginBottom:14 }}>
            <input type="number" inputMode="decimal" value={amineForm.dose}
              onChange={e => setAmineForm(f => ({...f, dose:e.target.value}))} placeholder="ex : 0.2"
              style={{ flex:2, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:10, padding:"12px", fontSize:22, color:P.text, fontFamily:mono,
                textAlign:"center", fontWeight:800, outline:"none" }}
              onFocus={e => e.target.style.borderColor = P.green}
              onBlur={e  => e.target.style.borderColor = P.border} />
            <select value={amineForm.unit} onChange={e => setAmineForm(f => ({...f, unit:e.target.value}))}
              style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:10, padding:"8px", fontSize:12, color:P.text, fontFamily:mono,
                fontWeight:700, outline:"none", cursor:"pointer" }}>
              {["mg/h","µg/kg/min","µg/min","mL/h"].map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <button onClick={() => {
            if (!amineForm.dose) { setModalAmine(false); return; }
            const label = `${amineForm.type} ${amineForm.dose} ${amineForm.unit}`;
            setAmineList(prev => [...prev, { sec, time: getNow(), type: amineForm.type, dose: amineForm.dose, unit: amineForm.unit, label }]);
            addEvent("amine", label, "💊");
            try { if (navigator.vibrate) navigator.vibrate(28); } catch(e){}
            setModalAmine(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.green}, ${P.greenText})`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
            padding:"13px", cursor:"pointer", fontFamily:sans,
            boxShadow:`0 5px 14px color-mix(in srgb, ${P.green} 28%, transparent)` }}>
            ✓ Enregistrer l'amine
          </button>
        </Modal>
      )}

      {/* Modal saisie EtCO₂ */}
      {modalEtco2 && (
        <Modal title="EtCO₂ — capnographie" icon="📈" soft={P.tealSoft} onClose={() => setModalEtco2(false)}>
          <Lbl>Valeur mesurée (mmHg)</Lbl>
          <input type="number" inputMode="numeric" value={etco2Val}
            onChange={e => setEtco2Val(e.target.value)} placeholder="ex : 22" autoFocus
            style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
              borderRadius:12, padding:"16px", fontSize:30, color:P.text, fontFamily:mono,
              textAlign:"center", fontWeight:800, boxSizing:"border-box", outline:"none" }}
            onFocus={e => e.target.style.borderColor = P.teal}
            onBlur={e  => e.target.style.borderColor = P.border} />

          {/* Alertes intelligentes en temps réel */}
          {(() => {
            const v = parseFloat(String(etco2Val).replace(",","."));
            if (isNaN(v) || etco2Val === "") return (
              <p style={{ margin:"10px 0 0", fontSize:11, color:P.textSoft, lineHeight:1.6 }}>
                Repère : &lt; 10 mmHg → optimiser MCE · &gt; 40 mmHg → RACS probable · chute brutale → sonde déplacée
              </p>
            );
            if (v < 10) return (
              <div style={{ margin:"10px 0 0", background:P.roseSoft, border:`1.5px solid ${P.rose}`,
                borderRadius:10, padding:"10px 14px" }}>
                <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:P.roseText }}>
                  ⚠️ EtCO₂ {v} mmHg — MCE insuffisant ou arrêt irréversible
                </p>
                <p style={{ margin:"4px 0 0", fontSize:11, color:P.roseText, lineHeight:1.5 }}>
                  Vérifier qualité du MCE · positions mains · fréquence · profondeur 5–6 cm.
                  Valeur &lt; 10 mmHg persistante après 20 min = critère d'arrêt (ERC 2021).
                </p>
              </div>
            );
            if (v >= 40) return (
              <div style={{ margin:"10px 0 0", background:P.greenSoft, border:`1.5px solid ${P.green}`,
                borderRadius:10, padding:"10px 14px" }}>
                <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:P.greenText }}>
                  🟢 EtCO₂ {v} mmHg — RACS probable
                </p>
                <p style={{ margin:"4px 0 0", fontSize:11, color:P.greenText, lineHeight:1.5 }}>
                  Remontée brutale ≥ 40 mmHg est fortement prédictive d'un retour de circulation.
                  Réduire les compressions et vérifier le pouls.
                </p>
              </div>
            );
            if (v >= 10 && v < 20) return (
              <div style={{ margin:"10px 0 0", background:P.amberSoft, border:`1px solid ${P.amber}`,
                borderRadius:10, padding:"10px 14px" }}>
                <p style={{ margin:0, fontSize:12.5, fontWeight:700, color:P.amberText }}>
                  ⏱ EtCO₂ {v} mmHg — MCE à optimiser
                </p>
                <p style={{ margin:"4px 0 0", fontSize:11, color:P.amberText, lineHeight:1.5 }}>
                  Objectif ≥ 20 mmHg avec un MCE de qualité. Vérifier fréquence et profondeur.
                </p>
              </div>
            );
            return (
              <div style={{ margin:"10px 0 0", background:P.greenSoft, border:`1px solid ${P.green}`,
                borderRadius:10, padding:"10px 14px" }}>
                <p style={{ margin:0, fontSize:12.5, fontWeight:700, color:P.greenText }}>
                  ✅ EtCO₂ {v} mmHg — MCE efficace
                </p>
              </div>
            );
          })()}

          <button onClick={() => {
            const v = parseFloat(String(etco2Val).replace(",", "."));
            if (!isNaN(v)) {
              setEtco2List(prev => [...prev, { val: String(etco2Val).replace(",", "."), sec, time: getNow() }]);
              try { if (navigator.vibrate) navigator.vibrate(28); } catch(e){}
            }
            setModalEtco2(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.teal}, ${P.tealText})`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
            padding:"14px", cursor:"pointer", fontFamily:sans, marginTop:14,
            boxShadow:`0 5px 16px color-mix(in srgb, ${P.teal} 30%, transparent)` }}>
            ✓ Ajouter à la courbe
          </button>
        </Modal>
      )}

      {/* Modal ECG post-RACS */}
      {modalEcg && (
        <Modal title="ECG post-RACS" icon="📈" soft={P.tealSoft} onClose={() => setModalEcg(false)}>
          <p style={{ margin:"0 0 10px", fontSize:12, color:P.textSoft }}>
            Décrivez librement le tracé ECG obtenu après retour de circulation
          </p>
          <textarea value={ecgText} onChange={e => setEcgText(e.target.value)}
            placeholder={"Ex : RSR à 70/min, axe normal, BBG complet, sus-décalage ST V1-V4...\nOu : TSV, FC 140/min, QRS fins, intervalle QT allongé..."}
            rows={6}
            style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
              borderRadius:10, padding:"12px 14px", fontSize:14, color:P.text, fontFamily:sans,
              boxSizing:"border-box", outline:"none", resize:"vertical", lineHeight:1.7 }}
            onFocus={e => e.target.style.borderColor = P.teal}
            onBlur={e  => e.target.style.borderColor = P.border}
          />
          <div style={{ display:"flex", gap:10, marginTop:14 }}>
            <button onClick={() => setModalEcg(false)}
              style={{ flex:1, background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:11,
                padding:"12px", color:P.textMid, fontSize:13, fontWeight:500, cursor:"pointer", fontFamily:sans }}>
              ← Retour
            </button>
            <button onClick={() => {
              if (ecgText.trim()) addEvent("ecg", `ECG post-RACS : ${ecgText.trim()}`, "📈");
              setModalEcg(false);
            }} style={{ flex:2, background:`linear-gradient(135deg, ${P.teal}, #1A6A6A)`,
              border:"none", borderRadius:11, padding:"12px", color:"#fff",
              fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:sans,
              boxShadow:`0 4px 14px color-mix(in srgb, ${P.teal} 27%, transparent)` }}>
              ✓ Enregistrer l'ECG
            </button>
          </div>
        </Modal>
      )}

      {/* Modal Voie veineuse */}
      {modalVvp && (
        <Modal title="Voie d'abord" icon={<div style={{width:24,height:24,color:P.green}}>{ICONS.vvp}</div>} soft={P.greenSoft} onClose={() => setModalVvp(false)}>
          <ChoiceBtn label="Voie veineuse périphérique" sub="VVP — cathéter veineux périphérique"
            accent={P.green} soft={P.greenSoft} textC={P.greenText}
            onClick={() => { addEvent("vvp","Voie veineuse périphérique (VVP) posée","🩹"); setModalVvp(false); }} />
          <ChoiceBtn label="Voie intra-osseuse" sub="VIO — tibia, humérus"
            accent={P.teal} soft={P.tealSoft} textC={P.tealText}
            onClick={() => { addEvent("vio","Voie intra-osseuse (VIO) posée","🦴"); setModalVvp(false); }} />
        </Modal>
      )}

      {/* Modal Cordarone */}
      {modalCord && (
        <Modal title="Cordarone (Amiodarone)" icon={<div style={{width:24,height:24,color:P.amber}}>{ICONS.amio}</div>} soft={P.amberSoft} onClose={() => setModalCord(false)}>
          <ChoiceBtn label="300 mg IV/IO" sub="1re injection · après le 3e choc infructueux"
            accent={P.amber} soft={P.amberSoft} textC={P.amberText}
            onClick={() => { addEvent("cord300","Cordarone 300 mg IV/IO","💊"); setModalCord(false); }} />
          <ChoiceBtn label="150 mg IV/IO" sub="2e injection · après le 5e choc infructueux"
            accent={P.amber} soft={P.amberSoft} textC={P.amberText}
            onClick={() => { addEvent("cord150","Cordarone 150 mg IV/IO","💊"); setModalCord(false); }} />
        </Modal>
      )}

      {/* Modal Décès */}
      {modalDeces && (
        <Modal title="Constat de décès" icon="🕊️" soft={P.slateSoft}
          onClose={() => { setModalDeces(false); setOmlStep(0); setOmlTxt(""); }}>
          {omlStep === 0 ? (
            <>
              <ChoiceBtn label="Avec OML" sub="Obstacle médico-légal — signalement nécessaire"
                accent={P.rose} soft={P.roseSoft} textC={P.roseText}
                onClick={() => setOmlStep(1)} />
              <ChoiceBtn label="Sans OML" sub="Pas d'obstacle médico-légal"
                accent={P.slate} soft={P.slateSoft} textC={P.slateText}
                onClick={() => setOmlStep(2)} />
            </>
          ) : omlStep === 2 ? (
            <>
              <p style={{ margin:"0 0 10px", fontSize:12.5, fontWeight:600, color:P.text }}>
                🕊️ Constat de décès — sans OML
              </p>
              <p style={{ margin:"0 0 8px", fontSize:12, color:P.textSoft }}>
                Certificat remis à (optionnel) :
              </p>
              <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                <input value={decesRemisA} onChange={e => setDecesRemisA(e.target.value)}
                  placeholder="Ex : famille, pompiers, gendarmerie..."
                  style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                    borderRadius:9, padding:"10px 12px", fontSize:14, color:P.text,
                    fontFamily:sans, outline:"none", boxSizing:"border-box" }}
                  onFocus={e => e.target.style.borderColor = P.slate}
                  onBlur={e  => e.target.style.borderColor = P.border} />
              </div>
              <button onClick={() => {
                const remis = decesRemisA.trim();
                addEvent("deces", remis
                  ? `Constat de décès — sans OML · Certificat remis à : ${remis}`
                  : "Constat de décès — sans OML", "🕊️");
                setModalDeces(false); setOmlStep(0); setDecesRemisA("");
              }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.slate}, #374151)`,
                border:"none", borderRadius:11, color:"#fff", fontSize:14, fontWeight:700,
                fontFamily:disp, padding:"13px", cursor:"pointer", marginBottom:8 }}>
                ✓ Confirmer le constat
              </button>
              <button onClick={() => setOmlStep(0)}
                style={{ width:"100%", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:12, cursor:"pointer", fontFamily:sans, padding:"6px" }}>
                ← Retour
              </button>
            </>
          ) : (
            <>
              <p style={{ margin:"0 0 12px", fontSize:12, color:P.textSoft }}>
                Autorité contactée pour l'OML :
              </p>
              {[
                { label:"Gendarmerie", sub:"Gendarmerie nationale" },
                { label:"Police", sub:"Police nationale" },
                { label:"OPJ", sub:"Officier de police judiciaire" },
              ].map(c => (
                <ChoiceBtn key={c.label} label={c.label} sub={c.sub}
                  accent={P.rose} soft={P.roseSoft} textC={P.roseText}
                  onClick={() => {
                    addEvent("deces", `Constat de décès — avec OML, remis à : ${c.label}`, "🕊️");
                    setModalDeces(false); setOmlStep(0); setOmlTxt("");
                  }} />
              ))}
              <div style={{ marginTop:6 }}>
                <Lbl>Autre / préciser</Lbl>
                <div style={{ display:"flex", gap:8 }}>
                  <input value={omlTxt} onChange={e => setOmlTxt(e.target.value)}
                    placeholder="Ex : parquet contacté..."
                    style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                      borderRadius:9, padding:"10px 12px", fontSize:14, color:P.text,
                      fontFamily:sans, outline:"none", boxSizing:"border-box" }}
                    onFocus={e => e.target.style.borderColor = P.rose}
                    onBlur={e  => e.target.style.borderColor = P.border} />
                  <button onClick={() => {
                    addEvent("deces", `Constat de décès — avec OML, remis à : ${omlTxt.trim() || "autre"}`, "🕊️");
                    setModalDeces(false); setOmlStep(0); setOmlTxt("");
                  }} style={{ background:P.rose, border:"none", borderRadius:9,
                    color:"#fff", padding:"10px 14px", fontSize:13, fontWeight:600,
                    cursor:"pointer", fontFamily:sans, flexShrink:0 }}>✓</button>
                </div>
              </div>
              <button onClick={() => setOmlStep(0)}
                style={{ width:"100%", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:12, cursor:"pointer", fontFamily:sans,
                  marginTop:12, padding:"6px" }}>← Retour</button>
            </>
          )}
        </Modal>
      )}

      {/* Modal Intubation */}
      {modalIot && (
        <Modal title="Intubation oro-trachéale" icon={<div style={{width:24,height:24,color:P.violet}}>{ICONS.iot}</div>} soft={P.violetSoft} onClose={() => setModalIot(false)}>

          {/* ── Intubation difficile — dépliable, techniques utilisées ── */}
          <div style={{ background: iot.difficile ? P.roseSoft : P.surfaceAlt,
            border:`1.5px solid ${iot.difficile ? P.rose : P.border}`, borderRadius:12,
            padding:"12px 14px", marginBottom:18 }}>
            <button onClick={() => si("difficile")(!iot.difficile)}
              style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
                background:"transparent", border:"none", cursor:"pointer", padding:0, textAlign:"left" }}>
              <span style={{ fontSize:18, flexShrink:0 }}>{iot.difficile ? "⚠️" : "🫁"}</span>
              <span style={{ flex:1, fontSize:13.5, fontWeight:800,
                color: iot.difficile ? P.roseText : P.text }}>Intubation difficile</span>
              <span style={{ width:44, height:26, borderRadius:13, flexShrink:0,
                background: iot.difficile ? P.rose : P.border, position:"relative", transition:"background 0.15s" }}>
                <span style={{ position:"absolute", top:2, left: iot.difficile ? 20 : 2, width:22, height:22,
                  borderRadius:"50%", background:"#fff", transition:"left 0.15s", boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }} />
              </span>
            </button>
            {iot.difficile && (
              <div style={{ marginTop:12 }}>
                <Lbl>Technique(s) utilisée(s)</Lbl>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {["Mandrin d'Eschmann (bougie)","Vidéolaryngoscope","Masque laryngé standard","Fastrach (ML intubation)","Dispositif supra-glottique (secours)","Cricothyroïdotomie"].map(t => {
                    const active = iot.techniquesDifficiles.includes(t);
                    return (
                      <button key={t} onClick={() => si("techniquesDifficiles")(
                          active ? iot.techniquesDifficiles.filter(x => x !== t) : [...iot.techniquesDifficiles, t]
                        )}
                        style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                          borderRadius:9, border:`1.5px solid ${active ? P.rose : P.border}`,
                          background: active ? P.rose : P.surface, color: active ? "#fff" : P.textMid,
                          fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:sans, textAlign:"left" }}>
                        <span style={{ width:16, height:16, borderRadius:4, flexShrink:0,
                          border:`1.5px solid ${active ? "#fff" : P.border}`,
                          background: active ? "rgba(255,255,255,0.25)" : "transparent",
                          display:"flex", alignItems:"center", justifyContent:"center", fontSize:10 }}>
                          {active && "✓"}
                        </span>
                        {t}
                      </button>
                    );
                  })}
                </div>
                <div style={{ marginTop:12 }}>
                  <Lbl>Nombre de tentatives</Lbl>
                  <ChipGroup options={["1","2","3","4+"]} value={iot.nbTentatives} onChange={si("nbTentatives")} />
                </div>
              </div>
            )}
          </div>

          <div style={{ marginBottom:18 }}>
            <Lbl>Cormack</Lbl>
            <ChipGroup options={["1","2","3","4"]} value={iot.cormack} onChange={si("cormack")} />
          </div>

          <div style={{ marginBottom:18 }}>
            <Lbl>Taille de sonde (mm)</Lbl>
            <ChipGroup options={["6","6.5","7","7.5","8","8.5","9"]} value={iot.sonde} onChange={si("sonde")} />
          </div>

          <div style={{ marginBottom:18 }}>
            <Lbl>Repère à l'arcade dentaire (cm)</Lbl>
            <ChipGroup
              options={["15","16","17","18","19","20","21","22","23","24","25","26"]}
              value={iot.repere} onChange={si("repere")} />
          </div>

          <div style={{ marginBottom:24 }}>
            <Lbl>Capnographie à l'intubation (mmHg)</Lbl>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <input type="number" min="0" max="100" value={iot.capno}
                onChange={e => si("capno")(e.target.value)} placeholder="ex : 35"
                style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                  borderRadius:9, padding:"10px 14px", fontSize:20, color:P.text,
                  fontFamily:mono, outline:"none", textAlign:"center", fontWeight:500 }}
                onFocus={e => e.target.style.borderColor = P.violet}
                onBlur={e  => e.target.style.borderColor = P.border} />
              <span style={{ fontSize:13, color:P.textSoft, fontFamily:mono }}>mmHg</span>
            </div>
          </div>

          <button onClick={() => si("inhalation")(!iot.inhalation)}
            style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
              background: iot.inhalation ? P.amberSoft : P.surfaceAlt,
              border:`1.5px solid ${iot.inhalation ? P.amber : P.border}`, borderRadius:11,
              padding:"11px 13px", marginBottom:18, cursor:"pointer", fontFamily:sans, textAlign:"left" }}>
            <span style={{ fontSize:16, flexShrink:0 }}>{iot.inhalation ? "🟠" : "💧"}</span>
            <span style={{ flex:1, fontSize:12.5, fontWeight:700, color: iot.inhalation ? P.amberText : P.textMid }}>
              Inhalation objectivée (régurgitation/liquide gastrique)
            </span>
            <span style={{ width:20, height:20, borderRadius:6, flexShrink:0,
              border:`1.5px solid ${iot.inhalation ? P.amber : P.border}`,
              background: iot.inhalation ? P.amber : "transparent",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:"#fff" }}>
              {iot.inhalation && "✓"}
            </span>
          </button>

          <button onClick={confirmIot} style={{
            width:"100%", background:"linear-gradient(135deg,#7B6FB0,#5A4E8A)",
            border:"none", borderRadius:12, color:"#fff", fontSize:15, fontWeight:600,
            padding:"16px", cursor:"pointer", fontFamily:sans,
            boxShadow:"0 6px 18px rgba(123,111,176,0.3)" }}>
            ✓ Valider l'intubation
          </button>
        </Modal>
      )}

      {/* Modal Fast-écho */}
      {modalFast && (
        <Modal title="Fast-écho" icon={<div style={{width:24,height:24,color:P.blue}}>{ICONS.fast}</div>} soft={P.blueSoft} onClose={() => setModalFast(false)}>
          <div style={{ marginBottom:20 }}>
            <Lbl>Résultat de l'échographie</Lbl>
            <TArea value={fastResult} onChange={setFastResult} rows={4}
              placeholder={"Ex : épanchement péricardique abondant, collapsus VD...\nActivité cardiaque présente / absente\nPneumothorax G / D..."} />
          </div>
          <button onClick={confirmFast} style={{
            width:"100%", background:"linear-gradient(135deg,#3B82C4,#2563A8)",
            border:"none", borderRadius:12, color:"#fff", fontSize:15, fontWeight:600,
            padding:"16px", cursor:"pointer", fontFamily:sans,
            boxShadow:"0 6px 18px rgba(59,130,196,0.3)" }}>
            ✓ Valider le Fast-écho
          </button>
        </Modal>
      )}

      {/* ── Modal ECMO ── */}
      <EcmoModal open={modalEcmo} onClose={() => setModalEcmo(false)}
        onConfirm={({ decision, verdict, note }) => {
          const msg = `ECMO ${decision} (${verdict})${note ? " — " + note : ""}`;
          addEvent("ecmo", msg, "🫀");
        }}
        P={P} mono={mono} sans={sans} Modal={Modal} Lbl={Lbl} TArea={TArea} />

      {/* ── Modal Don d'organes (DDAC) ── */}
      <DdacModal open={modalDdac} onClose={() => setModalDdac(false)}
        onConfirm={({ decision, verdict, note }) => {
          const msg = `Don d'organes ${decision} (${verdict})${note ? " — " + note : ""}`;
          addEvent("ddac", msg, "🤝");
        }}
        P={P} mono={mono} sans={sans} Modal={Modal} Lbl={Lbl} TArea={TArea} />

      {/* ── Modal FAST écho (trauma) ── */}
      {modalFastTrauma && (
        <Modal title="FAST écho" icon={<div style={{width:24,height:24,color:P.blue}}>{ICONS.fast}</div>}
          soft={P.blueSoft} onClose={() => setModalFastTrauma(false)}>
          {/* Bouton Normal rapide */}
          <button onClick={() => {
            addEvent("fast", "FAST normale", "🔊");
            setModalFastTrauma(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg,${P.green},#2F7A4F)`,
            border:"none", borderRadius:12, color:"#fff", fontSize:15, fontWeight:700,
            padding:"15px", cursor:"pointer", fontFamily:sans, marginBottom:14,
            boxShadow:`0 4px 14px color-mix(in srgb, ${P.green} 27%, transparent)` }}>
            ✓ FAST normale (rapide)
          </button>

          <p style={{ margin:"0 0 10px", fontSize:11, color:P.textSoft, textAlign:"center" }}>
            ou décrire par site :
          </p>

          {[
            { k:"morrison", label:"Espace de Morrison",    sub:"hépato-rénal", pneumo:false },
            { k:"kohler",   label:"Espace de Köhler",      sub:"spléno-rénal", pneumo:false },
            { k:"douglas",  label:"Cul-de-sac de Douglas", sub:"pelvien",      pneumo:false },
            { k:"pleureD",  label:"Plèvre droite",         sub:"",             pneumo:true },
            { k:"pleureG",  label:"Plèvre gauche",         sub:"",             pneumo:true },
            { k:"pericarde",label:"Péricarde",             sub:"",             pneumo:false },
          ].map(s => {
            const modeKey = s.k + "Mode";
            const mode = fastTr[modeKey] || "";
            const opts = [
              { id:"epanchement", label:"Épanchement", c:P.rose },
              ...(s.pneumo ? [{ id:"pneumo", label:"Pneumothorax", c:P.amber }] : []),
              { id:"normal", label:"Normal", c:P.green },
              { id:"note",   label:"Note libre", c:P.blue },
            ];
            return (
              <div key={s.k} style={{ marginBottom:13 }}>
                <Lbl>{s.label}{s.sub ? ` — ${s.sub}` : ""}</Lbl>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:4,
                  marginBottom: mode === "note" ? 6 : 0 }}>
                  {opts.map(o => (
                    <button key={o.id} onClick={() => {
                      sft(modeKey)(o.id);
                      if (o.id === "note") { if (mode !== "note") sft(s.k)(""); }
                      else { sft(s.k)(o.label); }
                    }}
                      style={{
                        background: mode === o.id ? o.c : P.surfaceAlt,
                        border:`1.5px solid ${mode === o.id ? o.c : P.border}`,
                        borderRadius:9, padding:"7px 12px", cursor:"pointer",
                        fontFamily:sans, fontSize:11.5, fontWeight:700,
                        color: mode === o.id ? "#fff" : P.text, whiteSpace:"nowrap" }}>
                      {o.label}
                    </button>
                  ))}
                </div>
                {mode === "note" && (
                  <TInput value={fastTr[s.k]} onChange={sft(s.k)} placeholder="Décrire la trouvaille..." />
                )}
              </div>
            );
          })}

          <button onClick={() => {
            const parts = [];
            const map = { morrison:"Morrison", kohler:"Köhler", douglas:"Douglas", pleureD:"Plèvre D", pleureG:"Plèvre G", pericarde:"Péricarde" };
            Object.keys(map).forEach(k => { if (fastTr[k]?.trim()) parts.push(`${map[k]} : ${fastTr[k].trim()}`); });
            addEvent("fast", parts.length ? `FAST — ${parts.join(" · ")}` : "FAST réalisée", "🔊");
            setModalFastTrauma(false);
          }} style={{ width:"100%", background:P.blue, border:"none", borderRadius:12,
            color:"#fff", fontSize:14, fontWeight:600, padding:"13px", cursor:"pointer",
            fontFamily:sans, marginTop:8 }}>
            ✓ Enregistrer la description
          </button>
        </Modal>
      )}

      {/* ── Modal Thoracostomie (D/G) ── */}
      {modalThoraco && (
        <Modal title={`Thoracostomie ${modalThoraco === "d" ? "droite" : "gauche"}`}
          icon="🫁" soft={P.blueSoft} onClose={() => setModalThoraco(null)}>
          <p style={{ margin:"0 0 12px", fontSize:12, color:P.textSoft }}>
            Résultat à l'ouverture de la plèvre :
          </p>
          {[
            { v:"rien", label:"Rien",  c:P.slate,  cs:P.slateSoft,  ct:P.slateText },
            { v:"air",  label:"Air",   c:P.blue,   cs:P.blueSoft,   ct:P.blueText },
            { v:"sang", label:"Sang",  c:P.rose,   cs:P.roseSoft,   ct:P.roseText },
          ].map(o => (
            <button key={o.v} onClick={() => {
              const cote = modalThoraco === "d" ? "droite" : "gauche";
              addEvent("thoraco", `Thoracostomie ${cote} — ${o.label}`, "✚");
              setModalThoraco(null);
            }} style={{ width:"100%", background:o.cs, border:`1.5px solid ${o.c}`,
              borderRadius:12, padding:"14px", marginBottom:8, cursor:"pointer",
              fontFamily:sans, fontSize:15, fontWeight:600, color:o.ct, textAlign:"left" }}>
              {o.label}
            </button>
          ))}
        </Modal>
      )}

      {/* ── Modal Hemocue ── */}
      {modalHemocue && (
        <Modal title="Hemocue" icon="🩸" soft={P.violetSoft} onClose={() => { setModalHemocue(false); setHemocueVal(""); }}>
          {/* Historique + écart */}
          {hemocueHist.length > 0 && (
            <div style={{ background:P.violetSoft, border:`1px solid color-mix(in srgb, ${P.violet} 20%, transparent)`, borderRadius:10,
              padding:"10px 12px", marginBottom:14 }}>
              <p style={{ margin:"0 0 6px", fontSize:9, fontWeight:600, color:P.violetText,
                textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Mesures précédentes</p>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {hemocueHist.map((h, i) => (
                  <span key={i} style={{ fontSize:12, fontFamily:mono, fontWeight:700, color:P.violetText,
                    background:P.surface, borderRadius:7, padding:"3px 8px" }}>
                    {h.time} · {h.val} g/dL
                  </span>
                ))}
              </div>
              {hemocueHist.length >= 2 && (() => {
                const last = parseFloat(String(hemocueHist[hemocueHist.length-1].val).replace(",", "."));
                const prev = parseFloat(String(hemocueHist[hemocueHist.length-2].val).replace(",", "."));
                if (isNaN(last) || isNaN(prev)) return null;
                const d = Math.round((last - prev) * 10) / 10;
                const up = d > 0;
                return (
                  <p style={{ margin:"8px 0 0", fontSize:12, fontWeight:700,
                    color: d < 0 ? P.roseText : P.greenText }}>
                    Écart 2 dernières : {up ? "+" : ""}{String(d).replace(".", ",")} g/dL {d < 0 ? "↓" : d > 0 ? "↑" : "→"}
                  </p>
                );
              })()}
            </div>
          )}

          <Lbl>Nouvelle mesure — Hémoglobine (g/dL)</Lbl>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <input type="number" inputMode="decimal" step="0.1" value={hemocueVal}
              onChange={e => setHemocueVal(e.target.value)} placeholder="Ex : 8,5"
              style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:9, padding:"12px", fontSize:18, color:P.text, fontFamily:mono,
                outline:"none", textAlign:"center", fontWeight:700, boxSizing:"border-box" }}
              onFocus={e => e.target.style.borderColor = P.violet}
              onBlur={e  => e.target.style.borderColor = P.border} />
            <span style={{ fontSize:14, color:P.textMid, fontWeight:600 }}>g/dL</span>
          </div>
          <button onClick={() => {
            const v = hemocueVal.trim();
            if (!v) { addEvent("hemocue", "Hemocue réalisé", "🩸"); setModalHemocue(false); return; }
            const h = getNow();
            const newHist = [...hemocueHist, { val: v, time: h, sec }];
            setHemocueHist(newHist);
            // écart avec la mesure précédente
            let ecartTxt = "";
            if (newHist.length >= 2) {
              const last = parseFloat(v.replace(",", "."));
              const prev = parseFloat(String(newHist[newHist.length-2].val).replace(",", "."));
              if (!isNaN(last) && !isNaN(prev)) {
                const d = Math.round((last - prev) * 10) / 10;
                ecartTxt = ` (écart ${d > 0 ? "+" : ""}${String(d).replace(".", ",")} g/dL)`;
              }
            }
            addEvent("hemocue", `Hemocue : ${v} g/dL${ecartTxt}`, "🩸");
            setHemocueVal(""); setModalHemocue(false);
          }} style={{ width:"100%", background:P.violet, border:"none", borderRadius:12,
            color:"#fff", fontSize:14, fontWeight:600, padding:"13px", cursor:"pointer",
            fontFamily:sans, marginTop:14 }}>
            ✓ Enregistrer
          </button>
        </Modal>
      )}

      {/* ── Modal Transfusion préhospitalière ── */}
      {modalTransfu && (
        <Modal title="Transfusion préhospitalière" icon="🩸" soft={P.roseSoft}
          onClose={() => setModalTransfu(false)}>
          <p style={{ margin:"0 0 12px", fontSize:11, color:P.textSoft }}>
            Ratio 1:1:1 recommandé en transfusion massive (CGR : PFC : plaquettes).
          </p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14 }}>
            <div>
              <Lbl>CGR</Lbl>
              <input type="number" value={transfu.cgr} onChange={e => setTransfu(p => ({...p, cgr:e.target.value}))}
                placeholder="0" style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                  borderRadius:9, padding:"10px 4px", fontSize:16, color:P.text, fontFamily:mono,
                  outline:"none", textAlign:"center", fontWeight:700, boxSizing:"border-box" }} />
            </div>
            <div>
              <Lbl>PFC</Lbl>
              <input type="number" value={transfu.pfc} onChange={e => setTransfu(p => ({...p, pfc:e.target.value}))}
                placeholder="0" style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                  borderRadius:9, padding:"10px 4px", fontSize:16, color:P.text, fontFamily:mono,
                  outline:"none", textAlign:"center", fontWeight:700, boxSizing:"border-box" }} />
            </div>
            <div>
              <Lbl>Plaq.</Lbl>
              <input type="number" value={transfu.plaq} onChange={e => setTransfu(p => ({...p, plaq:e.target.value}))}
                placeholder="0" style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                  borderRadius:9, padding:"10px 4px", fontSize:16, color:P.text, fontFamily:mono,
                  outline:"none", textAlign:"center", fontWeight:700, boxSizing:"border-box" }} />
            </div>
          </div>
          <button onClick={() => {
            const parts = [];
            if (parseInt(transfu.cgr)) parts.push(`${transfu.cgr} CGR`);
            if (parseInt(transfu.pfc)) parts.push(`${transfu.pfc} PFC`);
            if (parseInt(transfu.plaq)) parts.push(`${transfu.plaq} CP`);
            addEvent("transfusion", parts.length ? `Transfusion : ${parts.join(" · ")}` : "Transfusion préhospitalière", "🩸");
            setModalTransfu(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg,${P.rose},#B94A4A)`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:600,
            padding:"13px", cursor:"pointer", fontFamily:sans }}>
            ✓ Enregistrer la transfusion
          </button>
        </Modal>
      )}

      {/* ── Modal Exacyl ── */}
      {modalExacyl && (
        <Modal title="Acide tranexamique (Exacyl®)" icon="💉" soft={P.greenSoft}
          onClose={() => setModalExacyl(false)}>
          <p style={{ margin:"0 0 14px", fontSize:11, color:P.roseText, fontWeight:600,
            background:P.roseSoft, borderRadius:9, padding:"8px 10px" }}>
            ⚠️ Dans les 3 h après le traumatisme — inutile/délétère au-delà
          </p>
          <button onClick={() => { addEvent("exacyl", "Exacyl 1 g IVL sur 10 min", "💉"); setModalExacyl(false); }}
            style={{ width:"100%", background:`linear-gradient(135deg,${P.green},#2F7A4F)`,
              border:"none", borderRadius:12, color:"#fff", fontSize:15, fontWeight:700,
              padding:"15px", cursor:"pointer", fontFamily:sans, marginBottom:10,
              boxShadow:`0 4px 14px color-mix(in srgb, ${P.green} 27%, transparent)` }}>
            1 g IVL sur 10 min<br/><span style={{fontSize:11,fontWeight:500,opacity:0.9}}>Dose de charge</span>
          </button>
          <button onClick={() => { addEvent("exacyl", "Exacyl 1 g IVSE sur 8 h", "💉"); setModalExacyl(false); }}
            style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.green}`,
              borderRadius:12, color:P.greenText, fontSize:15, fontWeight:700,
              padding:"15px", cursor:"pointer", fontFamily:sans }}>
            1 g sur 8 h<br/><span style={{fontSize:11,fontWeight:500,opacity:0.8}}>Dose d'entretien (relais IVSE)</span>
          </button>
        </Modal>
      )}

      {/* ── Modal Contrôle des hémorragies externes ── */}
      {modalHemoExt && (
        <Modal title="Contrôle des hémorragies externes" icon="🩸" soft={P.roseSoft}
          onClose={() => { setModalHemoExt(false); setGarrotSite(""); }}>

          {/* Garrot — avec site + heure de pose */}
          <div style={{ background:P.roseSoft, border:`1.5px solid ${P.rose}`, borderRadius:12,
            padding:"12px", marginBottom:12 }}>
            <p style={{ margin:"0 0 8px", fontSize:13, fontWeight:700, color:P.roseText }}>🪢 Garrot</p>
            <Lbl>Site de pose</Lbl>
            <input value={garrotSite} onChange={e => setGarrotSite(e.target.value)}
              placeholder="Ex : cuisse droite, racine du membre..."
              style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
                borderRadius:9, padding:"10px", fontSize:13, color:P.text, fontFamily:sans,
                outline:"none", boxSizing:"border-box", marginBottom:8 }}
              onFocus={e => e.target.style.borderColor = P.rose}
              onBlur={e  => e.target.style.borderColor = P.border} />
            <Lbl>Heure de pose (modifiable)</Lbl>
            <input type="time" value={garrotHeure || getNow()} onChange={e => setGarrotHeure(e.target.value)}
              style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
                borderRadius:9, padding:"10px", fontSize:14, color:P.text, fontFamily:mono,
                outline:"none", boxSizing:"border-box", marginBottom:10, textAlign:"center" }}
              onFocus={e => e.target.style.borderColor = P.rose}
              onBlur={e  => e.target.style.borderColor = P.border} />
            <button onClick={() => {
              const h = garrotHeure || getNow();
              const site = garrotSite.trim() ? ` (${garrotSite.trim()})` : "";
              addEvent("hemo", `Garrot posé${site}`, "🩸", h);
              setGarrotSite(""); setGarrotHeure(""); setModalHemoExt(false);
            }} style={{ width:"100%", background:`linear-gradient(135deg,${P.rose},#B94A4A)`,
              border:"none", borderRadius:10, color:"#fff", fontSize:13, fontWeight:600,
              padding:"11px", cursor:"pointer", fontFamily:sans }}>
              ✓ Poser le garrot
            </button>
          </div>

          {/* Autres techniques — log direct */}
          <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:600, color:P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Autres techniques</p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {[
              "Pansement compressif", "Packing (tamponnement)", "QuickClot",
              "Celox", "Agrafes", "Bivona (sonde nasale double ballonnet)", "iTClamp", "Point de compression",
            ].map(tech => (
              <button key={tech} onClick={() => { addEvent("hemo", tech, "🩸"); setModalHemoExt(false); }}
                style={{ background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:10,
                  padding:"11px 8px", cursor:"pointer", fontFamily:sans, fontSize:12, fontWeight:600,
                  color:P.text, textAlign:"center", lineHeight:1.3 }}
                onPointerEnter={e => e.currentTarget.style.borderColor = P.rose}
                onPointerLeave={e => e.currentTarget.style.borderColor = P.border}>
                {tech}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {/* ── Modal Transmission équipes en place ── */}
      {modalTrans && (
        <Modal title="Transmission équipes en place"
          icon={<div style={{width:24,height:24,color:P.amber}}>{ICONS.transmission}</div>}
          soft={P.amberSoft} onClose={() => setModalTrans(false)}>

          <p style={{ margin:"0 0 14px", fontSize:12, color:P.textSoft, lineHeight:1.5 }}>
            Recueil de ce qui a été fait avant l'arrivée SMUR (pompiers, témoins, SP).
            <br/>Les heures saisies créeront des entrées horodatées dans la chronologie.
          </p>

          {/* Contexte témoin */}
          <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px 12px", marginBottom:12 }}>
            <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:600, color:P.textSoft,
              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Contexte</p>
            <Lbl>Lieu de l'intervention</Lbl>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginBottom:8 }}>
              {LIEUX_INTERVENTION.map(l => (
                <button key={l.id} onClick={() => st("lieu")(trans.lieu === l.id ? "" : l.id)}
                  style={{ display:"flex", alignItems:"center", gap:5, padding:"7px 6px",
                    borderRadius:8, border:`1.5px solid ${trans.lieu===l.id ? P.amber : P.border}`,
                    background: trans.lieu===l.id ? P.amberSoft : P.surface,
                    color: trans.lieu===l.id ? P.amberText : P.textMid,
                    fontSize:11, fontWeight: trans.lieu===l.id ? 700 : 500,
                    cursor:"pointer", fontFamily:sans, textAlign:"left", minWidth:0 }}>
                  <span style={{ fontSize:13, flexShrink:0 }}>{l.icon}</span>
                  <span style={{ minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{l.label}</span>
                </button>
              ))}
            </div>
            <Lbl>Témoin de l'effondrement</Lbl>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5, marginBottom:8 }}>
              {["Oui","Non","Inconnu"].map(v => (
                <button key={v} onClick={() => st("temoin")(v)}
                  style={{ padding:"7px 4px", borderRadius:8, fontSize:11, fontWeight:600,
                    border:`1.5px solid ${trans.temoin===v ? P.amber : P.border}`,
                    background: trans.temoin===v ? P.amberSoft : P.surface,
                    color: trans.temoin===v ? P.amberText : P.textMid,
                    cursor:"pointer", fontFamily:sans }}>{v}</button>
              ))}
            </div>
            <Lbl>MCE par témoin / avant pompiers</Lbl>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5 }}>
              {["Oui","Non","Inconnu"].map(v => (
                <button key={v} onClick={() => st("mceTemoin")(v)}
                  style={{ padding:"7px 4px", borderRadius:8, fontSize:11, fontWeight:600,
                    border:`1.5px solid ${trans.mceTemoin===v ? P.amber : P.border}`,
                    background: trans.mceTemoin===v ? P.amberSoft : P.surface,
                    color: trans.mceTemoin===v ? P.amberText : P.textMid,
                    cursor:"pointer", fontFamily:sans }}>{v}</button>
              ))}
            </div>
          </div>

          {/* Prise en charge secouriste */}
          <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px 12px", marginBottom:12 }}>
            <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:600, color:P.textSoft,
              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Prise en charge secouriste</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
              <div>
                <Lbl>Arrivée pompiers</Lbl>
                <input type="time" value={trans.hArriveePompiers} onChange={e => st("hArriveePompiers")(e.target.value)}
                  style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
                    borderRadius:8, padding:"8px 6px", fontSize:14, fontFamily:mono,
                    color:P.text, outline:"none", textAlign:"center", boxSizing:"border-box" }} />
              </div>
              <div>
                <Lbl>Pose DSA</Lbl>
                <input type="time" value={trans.hPoseDSA} onChange={e => st("hPoseDSA")(e.target.value)}
                  style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
                    borderRadius:8, padding:"8px 6px", fontSize:14, fontFamily:mono,
                    color:P.text, outline:"none", textAlign:"center", boxSizing:"border-box" }} />
              </div>
            </div>
            <Lbl>Rythme initial DSA</Lbl>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5, marginBottom:8 }}>
              {[["choquable","Choquable"],["nonChoquable","Non choquable"],["nonAnalyse","Non analysé"]].map(([id,label]) => (
                <button key={id} onClick={() => st("rythmeDSA")(id)}
                  style={{ padding:"7px 4px", borderRadius:8, fontSize:10, fontWeight:600,
                    border:`1.5px solid ${trans.rythmeDSA===id ? P.amber : P.border}`,
                    background: trans.rythmeDSA===id ? P.amberSoft : P.surface,
                    color: trans.rythmeDSA===id ? P.amberText : P.textMid,
                    cursor:"pointer", fontFamily:sans }}>{label}</button>
              ))}
            </div>
            <Lbl>Chocs délivrés avant le SMUR</Lbl>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:8 }}>
              <div>
                <p style={{ margin:"0 0 4px", fontSize:9.5, color:P.textSoft, textAlign:"center" }}>Pompiers</p>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                  <button onClick={() => st("chocsPompiers")(Math.max(0, (parseInt(trans.chocsPompiers)||0) - 1))}
                    style={{ background:P.surface, border:`1.5px solid ${P.amber}`, borderRadius:"50%",
                      width:32, height:32, fontSize:15, fontWeight:700, color:P.amberText,
                      cursor:"pointer", fontFamily:sans, flexShrink:0 }}>−</button>
                  <span style={{ fontSize:24, fontWeight:700, color:P.amberText, fontFamily:mono, minWidth:30, textAlign:"center" }}>
                    {trans.chocsPompiers || 0}
                  </span>
                  <button onClick={() => st("chocsPompiers")((parseInt(trans.chocsPompiers)||0) + 1)}
                    style={{ background:P.amber, border:"none", borderRadius:"50%",
                      width:32, height:32, fontSize:15, fontWeight:700, color:"#fff",
                      cursor:"pointer", fontFamily:sans, flexShrink:0 }}>+</button>
                </div>
              </div>
              <div>
                <p style={{ margin:"0 0 4px", fontSize:9.5, color:P.textSoft, textAlign:"center" }}>DSA public</p>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                  <button onClick={() => st("chocsPublic")(Math.max(0, (parseInt(trans.chocsPublic)||0) - 1))}
                    style={{ background:P.surface, border:`1.5px solid ${P.blue}`, borderRadius:"50%",
                      width:32, height:32, fontSize:15, fontWeight:700, color:P.blueText,
                      cursor:"pointer", fontFamily:sans, flexShrink:0 }}>−</button>
                  <span style={{ fontSize:24, fontWeight:700, color:P.blueText, fontFamily:mono, minWidth:30, textAlign:"center" }}>
                    {trans.chocsPublic || 0}
                  </span>
                  <button onClick={() => st("chocsPublic")((parseInt(trans.chocsPublic)||0) + 1)}
                    style={{ background:P.blue, border:"none", borderRadius:"50%",
                      width:32, height:32, fontSize:15, fontWeight:700, color:"#fff",
                      cursor:"pointer", fontFamily:sans, flexShrink:0 }}>+</button>
                </div>
              </div>
            </div>
            <p style={{ margin:"0 0 8px", fontSize:9.5, color:P.textSoft, textAlign:"center", fontStyle:"italic" }}>
              Les deux s'ajoutent aux chocs SMUR pour le rappel Cordarone
            </p>
            <Lbl>Heure du 1er choc</Lbl>
            <input type="time" value={trans.h1erChoc} onChange={e => st("h1erChoc")(e.target.value)}
              style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
                borderRadius:8, padding:"8px 6px", fontSize:14, fontFamily:mono,
                color:P.text, outline:"none", textAlign:"center", boxSizing:"border-box" }} />
          </div>

          {/* Gestes entrepris par les secouristes */}
          <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px 12px", marginBottom:12 }}>
            <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:600, color:P.textSoft,
              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Gestes entrepris</p>
            <TArea value={trans.gestesSecouristes || ""} onChange={st("gestesSecouristes")}
              placeholder="MCE, DSA, O₂, garrot, immobilisation, position latérale..." rows={2} />
          </div>

          {/* Note libre */}
          <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px 12px" }}>
            <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:600, color:P.textSoft,
              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Note libre</p>
            <TArea value={trans.note} onChange={st("note")} rows={2}
              placeholder="Ex : trouvé au sol par épouse, suspicion intox..." />
          </div>

          <button onClick={() => {
            // Génère plusieurs entrées chronologie avec heures exactes
            const newEvents = [];
            const fmtTime = h => h || getNow();
            if (trans.hEffondrement) {
              const detail = [
                trans.temoin === "Oui" ? "témoigné" : trans.temoin === "Non" ? "non témoigné" : null,
                trans.mceTemoin === "Oui" ? "MCE par témoin" : null,
              ].filter(Boolean).join(", ");
              newEvents.push({ id:"effondrement", time:trans.hEffondrement, sec:0,
                label:`Heure de l'ACR${detail ? ` (${detail})` : ""}`, icon:"⏱️" });
            }
            if (trans.hArriveePompiers)
              newEvents.push({ id:"pompiers", time:trans.hArriveePompiers, sec:0,
                label:"Arrivée pompiers · début MCE secouriste", icon:"🚒" });
            if (trans.hPoseDSA)
              newEvents.push({ id:"dsa", time:trans.hPoseDSA, sec:0,
                label:`Pose DSA${trans.rythmeDSA ? ` (${trans.rythmeDSA === "choquable" ? "rythme choquable" : trans.rythmeDSA === "nonChoquable" ? "non choquable" : "non analysé"})` : ""}`, icon:"⚡" });
            const nbChocs = parseInt(trans.chocsPompiers) || 0;
            if (nbChocs > 0) {
              newEvents.push({ id:"chocs_pomp", time:trans.h1erChoc || getNow(), sec:0,
                label:`${nbChocs} choc(s) DSA délivré(s) par pompiers`, icon:"⚡" });
            }
            const nbChocsPublic = parseInt(trans.chocsPublic) || 0;
            if (nbChocsPublic > 0) {
              newEvents.push({ id:"chocs_public", time:trans.h1erChoc || getNow(), sec:0,
                label:`${nbChocsPublic} choc(s) DSA délivré(s) par un DSA public`, icon:"⚡" });
            }
            if (trans.note.trim())
              newEvents.push({ id:"trans_note", time:getNow(), sec:0,
                label:`Pré-SMUR : ${trans.note.trim()}`, icon:"📝" });

            // Trier par heure
            const sorted = [...events, ...newEvents].sort((a,b) => {
              const ta = a.time || "00:00", tb = b.time || "00:00";
              return ta.localeCompare(tb);
            });
            setEvents(sorted);
            st("saved")(true);
            setModalTrans(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg,${P.amber},#D97706)`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:600,
            padding:"14px", cursor:"pointer", fontFamily:sans, marginTop:14,
            boxShadow:`0 6px 18px color-mix(in srgb, ${P.amber} 20%, transparent)` }}>
            ✓ Enregistrer la transmission
          </button>
        </Modal>
      )}

      {/* ── Modal Note libre ── */}
      {modalNote && (
        <Modal title="Note libre" icon={<div style={{width:24,height:24,color:P.teal}}>{ICONS.note}</div>}
          soft={P.tealSoft} onClose={() => setModalNote(false)}>
          <p style={{margin:"0 0 10px",fontSize:12,color:P.textSoft}}>
            Note interne — s'affiche dans la chronologie uniquement
          </p>
          <TArea value={noteText} onChange={setNoteText} rows={5}
            placeholder="Ex : famille contactée, médecin traitant appelé, circonstances particulières..." />
          <button onClick={() => {
            if (noteText.trim()) {
              addEvent("note", noteText.trim(), "📝");
              setNoteText("");
            }
            setModalNote(false);
          }} style={{ width:"100%", background:`linear-gradient(135deg,${P.teal},#1A6A6A)`,
            border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:600,
            padding:"14px", cursor:"pointer", fontFamily:sans, marginTop:14,
            boxShadow:`0 6px 18px color-mix(in srgb, ${P.teal} 20%, transparent)` }}>
            ✓ Ajouter à la chronologie
          </button>
        </Modal>
      )}

      {/* ── Modal Soins post-RACS ── */}
      {/* ── Soins post-RACS — VLI restreint : surveillance seule, sans amines/sédation ── */}
      {modalRacs && isVLI && !vliUnlocked && (
        <div style={{ position:"fixed", inset:0, background:"rgba(28,43,58,0.6)", zIndex:80,
          display:"flex", flexDirection:"column", justifyContent:"flex-end", backdropFilter:"blur(2px)" }}
          onClick={() => setModalRacs(false)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:P.surface, width:"100%", borderRadius:"20px 20px 0 0",
              padding:"20px 16px 36px", boxShadow:"0 -12px 40px rgba(0,0,0,0.18)",
              fontFamily:sans, maxHeight:"90vh", overflowY:"auto", overflowX:"hidden",
              boxSizing:"border-box" }}>
            <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:16 }}>
              <div style={{ width:42, height:42, borderRadius:13,
                background:"linear-gradient(135deg, #EA6A12, #B24E0A)",
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:22,
                boxShadow:"0 5px 16px rgba(234,106,18,0.32)" }}>🫀</div>
              <div>
                <p style={{ margin:"0 0 1px", fontSize:9.5, fontWeight:700, color:"#B24E0A",
                  textTransform:"uppercase", letterSpacing:"0.14em", fontFamily:mono }}>RACS · Protocole ISP</p>
                <p style={{ margin:0, fontSize:18, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>Surveillance</p>
              </div>
              <button onClick={() => setModalRacs(false)}
                style={{ marginLeft:"auto", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:20, cursor:"pointer" }}>×</button>
            </div>

            <div style={{ background:"rgba(234,106,18,0.1)", border:"1px solid #EA6A12", borderRadius:10,
              padding:"10px 12px", marginBottom:14 }}>
              <p style={{ margin:"0 0 6px", fontSize:10, fontWeight:700, color:"#B24E0A",
                textTransform:"uppercase", letterSpacing:"0.06em", fontFamily:mono }}>Objectifs</p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"3px 12px" }}>
                {[["SpO₂","94–98 %"],["EtCO₂","35–45 mmHg"],["PAS / PAM",">90 / >65 mmHg"],
                  ["Glycémie","> 0,7 g/L"],["Hyperthermie","à prévenir"]].map(([l,v]) => (
                  <div key={l} style={{ display:"flex", justifyContent:"space-between" }}>
                    <span style={{ fontSize:10.5, color:"#B24E0A" }}>{l}</span>
                    <span style={{ fontSize:10.5, fontWeight:700, color:"#B24E0A", fontFamily:mono }}>{v}</span>
                  </div>
                ))}
              </div>
              <p style={{ margin:"6px 0 0", fontSize:9.5, color:"#B24E0A", fontStyle:"italic" }}>
                Surveillance uniquement — pas d'administration d'amine ou de sédation (protocole VLI)
              </p>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, marginBottom:9 }}>
              {[["fc","FC","/min"],["tas","PAS","mmHg"],["sat","SpO₂","%"],["fr","FR","/min"],
                ["tempRacs","T°","°C"],["capno","EtCO₂","mmHg"],["glycemie","Glycémie","g/L"],["glasgow","Glasgow","/15"]].map(([k,l,u]) => (
                <div key={k}>
                  <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                    textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>{l}</p>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <input type="number" inputMode="decimal" value={racs[k]} onChange={e => sr(k)(e.target.value)}
                      style={{ flex:1, minWidth:0, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                        borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text, fontFamily:mono,
                        outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                      onFocus={e => e.target.style.borderColor = "#EA6A12"}
                      onBlur={e  => e.target.style.borderColor = P.border} />
                    <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>{u}</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginBottom:14 }}>
              <Lbl>Pupilles</Lbl>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                {["Normales","Anormales","Non fait"].map(v => (
                  <button key={v} onClick={() => {
                      if (v === "Anormales") { setRacsPupillesExpanded(x => !x); return; }
                      sr("pupilles")(v); setRacsPupillesExpanded(false);
                    }}
                    style={{ padding:"8px 4px", borderRadius:9, fontSize:10.5, fontWeight:600,
                      border:`1.5px solid #EA6A12`,
                      background: (v==="Anormales" && racsPupillesExpanded) || (v!=="Anormales" && racs.pupilles===v) ? "#EA6A12" : P.surface,
                      color: (v==="Anormales" && racsPupillesExpanded) || (v!=="Anormales" && racs.pupilles===v) ? "#fff" : "#B24E0A",
                      cursor:"pointer", fontFamily:sans }}>
                    {v}
                  </button>
                ))}
              </div>
              {racs.pupilles && !["Normales","Non fait"].includes(racs.pupilles) && !racsPupillesExpanded && (
                <p style={{ margin:"6px 0 0", fontSize:10.5, color:"#B24E0A", fontWeight:700 }}>{racs.pupilles}</p>
              )}
              {racsPupillesExpanded && (
                <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                  {PUPILLES_DETAIL.map(({v,left,right}) => (
                    <button key={v} onClick={() => { sr("pupilles")(v); setRacsPupillesExpanded(false); }}
                      style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                        borderRadius:9, border:`1.5px solid ${P.border}`, background:P.surface,
                        fontSize:11.5, fontWeight:600, color:P.text, cursor:"pointer",
                        fontFamily:sans, textAlign:"left" }}>
                      <PupilIcon left={left} right={right} />{v}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <p style={{ margin:"0 0 14px", fontSize:11, color:P.textSoft, fontStyle:"italic" }}>
              📋 Penser à réaliser l'ECG 12 dérivations dès que possible.
            </p>

            <button onClick={() => {
              const parts = [];
              if (racs.fc) parts.push(`FC ${racs.fc}/min`);
              if (racs.tas) parts.push(`PAS ${racs.tas} mmHg`);
              if (racs.sat) parts.push(`SpO₂ ${racs.sat}%`);
              if (racs.fr) parts.push(`FR ${racs.fr}/min`);
              if (racs.tempRacs) parts.push(`T° ${racs.tempRacs}°C`);
              if (racs.capno) parts.push(`EtCO₂ ${racs.capno} mmHg`);
              if (racs.glycemie) parts.push(`Glycémie ${racs.glycemie} g/L`);
              if (racs.glasgow) parts.push(`Glasgow ${racs.glasgow}/15`);
              if (racs.pupilles) parts.push(`Pupilles ${racs.pupilles}`);
              addEvent("racs_surveillance_vli", parts.length ? `Surveillance post-RACS : ${parts.join(" · ")}` : "Surveillance post-RACS", "🫀");
              // Alimente les mêmes courbes que les boutons "+ Mesure" / "+ Valeur" —
              // la tendance reste visible quel que soit l'endroit où la constante a été saisie.
              if (racs.tas || racs.fc) {
                setHemoList(prev => [...prev, { sec, time: getNow(), pas:racs.tas, pad:racs.tad, fc:racs.fc }]);
              }
              if (racs.capno) {
                setEtco2List(prev => [...prev, { val: racs.capno, sec, time: getNow() }]);
              }
              setModalRacs(false);
            }} style={{ width:"100%", background:"linear-gradient(135deg,#EA6A12,#B24E0A)",
              border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
              padding:"14px", cursor:"pointer", fontFamily:sans }}>
              ✓ Enregistrer les constantes
            </button>
          </div>
        </div>
      )}

      {modalRacs && !(isVLI && !vliUnlocked) && (() => {
        // Calculs de dilution
        // Calculs de dilution
        const hypnovelDose  = racs.hypnovelV ? (parseFloat(racs.hypnovelV) * 1).toFixed(1)    : null;
        const sufentaDose   = racs.sufentaV  ? (parseFloat(racs.sufentaV)  * 5).toFixed(1)    : null;
        const noradrDose    = racs.noradrV   ? (parseFloat(racs.noradrV)   * 0.2).toFixed(2)  : null;

        const buildLog = () => {
          const p = [];
          if (racs.fr)            p.push(`FR ${racs.fr}/min`);
          if (racs.volume)        p.push(`Vt ${racs.volume} mL`);
          if (racs.pep)           p.push(`PEP ${racs.pep} cmH₂O`);
          if (racs.sat)           p.push(`SpO₂ ${racs.sat}%`);
          if (racs.fio2)          p.push(`FiO₂ ${racs.fio2}%`);
          if (racs.capno)         p.push(`EtCO₂ ${racs.capno} mmHg`);
          if (racs.hypnovelV)     p.push(`Hypnovel ${racs.hypnovelV} mL/h → ${hypnovelDose} mg/h`);
          if (racs.sufentaV)      p.push(`Sufentanyl ${racs.sufentaV} mL/h → ${sufentaDose} μg/h`);
          if (racs.curare)        p.push(`Curare ${racs.curare} mg`);
          if (racs.autresDrogues) p.push(racs.autresDrogues);
          if (racs.tas && racs.tad) p.push(`TA ${racs.tas}/${racs.tad} mmHg (PAM ${Math.round((parseFloat(racs.tas)+2*parseFloat(racs.tad))/3)} mmHg)`);
          else if (racs.tas)        p.push(`TAs ${racs.tas} mmHg`);
          if (racs.remplissages && racs.remplissages.length > 0) {
            const total = racs.remplissages.reduce((s,r)=>s+r.vol,0);
            p.push(`Remplissage total : ${total} mL (${racs.remplissages.map(r=>`${r.vol}mL ${r.sol}`).join(", ")})`);
          }
          if (racs.fc)            p.push(`FC ${racs.fc}/min`);
          if (racs.tempRacs)      p.push(`T° ${racs.tempRacs} °C`);
          if (racs.pupilles)      p.push(`Pupilles ${racs.pupilles}`);
          if (racs.noradrV)       p.push(`Noradrénaline ${racs.noradrV} mL/h → ${noradrDose} mg/h (8mg/40cc)`);
          if (racs.dobut)         p.push(`Dobutamine ${racs.dobut} μg/kg/min`);
          if (racs.autresHemo)    p.push(racs.autresHemo);
          return p.length ? `Soins post-RACS : ${p.join(" · ")}` : "Soins post-RACS initiés";
        };

        const inputSt = (accent) => ({
          flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`, borderRadius:9,
          padding:"10px 8px", fontSize:15, color:P.text, fontFamily:mono, outline:"none",
          textAlign:"center", fontWeight:600, boxSizing:"border-box"
        });

        const racsTabs = [
          { id:"ventil", label:"Ventilation", icon:"🌬️" },
          { id:"sedat",  label:"Sédation",    icon:"💊"  },
          { id:"hemo",   label:"Hémo.",       icon:"💓"  },
        ];

        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(28,43,58,0.6)", zIndex:80,
            display:"flex", flexDirection:"column", justifyContent:"flex-end",
            backdropFilter:"blur(2px)" }} onClick={() => setModalRacs(false)}>
            <div onClick={e => e.stopPropagation()}
              style={{ background:P.surface, width:"100%", borderRadius:"20px 20px 0 0",
                padding:"20px 16px 36px", boxShadow:"0 -12px 40px rgba(0,0,0,0.18)",
                fontFamily:sans, maxHeight:"90vh", display:"flex", flexDirection:"column" }}>

              {/* Titre */}
              <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:16, flexShrink:0 }}>
                <div style={{ width:42, height:42, borderRadius:13,
                  background:`linear-gradient(135deg, ${P.green}, ${P.greenText})`,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:22,
                  boxShadow:`0 5px 16px color-mix(in srgb, ${P.green} 32%, transparent)` }}>🫀</div>
                <div>
                  <p style={{ margin:"0 0 1px", fontSize:9.5, fontWeight:700, color:P.green,
                    textTransform:"uppercase", letterSpacing:"0.14em", fontFamily:mono }}>Après RACS</p>
                  <p style={{ margin:0, fontSize:18, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em", lineHeight:1 }}>Soins post-RACS</p>
                </div>
                <button onClick={() => setModalRacs(false)}
                  style={{ marginLeft:"auto", background:"transparent", border:"none",
                    color:P.textSoft, fontSize:20, cursor:"pointer", padding:4 }}>×</button>
              </div>

              {/* Onglets */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5,
                background:P.surfaceAlt, borderRadius:12, padding:4, marginBottom:16, flexShrink:0 }}>
                {racsTabs.map(t => (
                  <button key={t.id} onClick={() => setRacsTab(t.id)}
                    style={{ padding:"9px 4px", borderRadius:9, border:"none",
                      background: racsTab===t.id ? P.greenSoft : "transparent",
                      color: racsTab===t.id ? P.greenText : P.textSoft,
                      fontSize:12, fontWeight: racsTab===t.id ? 800 : 600, cursor:"pointer",
                      fontFamily: racsTab===t.id ? disp : sans,
                      boxShadow: racsTab===t.id ? `inset 0 0 0 1px color-mix(in srgb, ${P.green} 30%, transparent)` : "none",
                      display:"flex", alignItems:"center", justifyContent:"center", gap:5,
                      transition:"all 0.15s" }}>
                    <span>{t.icon}</span>{t.label}
                  </button>
                ))}
              </div>

              {/* Contenu — scrollable */}
              <div style={{ flex:1, overflowY:"auto" }}>

                {racsTab === "ventil" && (
                  <div style={{ width:"100%" }}>
                    {/* FR / Vt */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:4 }}>
                      {[
                        { label:"Fréq. resp.", key:"fr",     ph:"12",  unit:"/min"  },
                        { label:"Vol. Vt",     key:"volume", ph:"500", unit:"mL"    },
                      ].map(f => (
                        <div key={f.key} style={{ minWidth:0 }}>
                          <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                            textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>{f.label}</p>
                          <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                            <input type="number" inputMode="decimal" value={racs[f.key]}
                              onChange={e => sr(f.key)(e.target.value)} placeholder={f.ph}
                              style={{ flex:1, minWidth:0, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                                borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                                fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                              onFocus={e => e.target.style.borderColor = P.blue}
                              onBlur={e  => e.target.style.borderColor = P.border} />
                            <span style={{ fontSize:9, color:P.textSoft, flexShrink:0, whiteSpace:"nowrap" }}>{f.unit}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p style={{ margin:"0 0 10px", fontSize:9, color:P.textSoft, fontStyle:"italic", textAlign:"right" }}>
                      Objectif Vt 6 mL/kg de poids idéal
                    </p>

                    {/* PEP / SpO2 avec objectif SpO2 */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:4 }}>
                      <div style={{ minWidth:0 }}>
                        <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                          textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>PEP</p>
                        <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <input type="number" inputMode="decimal" value={racs.pep}
                            onChange={e => sr("pep")(e.target.value)} placeholder="5"
                            style={{ flex:1, minWidth:0, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                              borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                              fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                            onFocus={e => e.target.style.borderColor = P.blue}
                            onBlur={e  => e.target.style.borderColor = P.border} />
                          <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>cmH₂O</span>
                        </div>
                      </div>
                      {/* SpO2 — alerte si hors cible 94–98% (hyperoxie/hypoxie) */}
                      {(() => {
                        const s = parseFloat(String(racs.sat).replace(",","."));
                        const out = !isNaN(s) && (s < 94 || s > 98);
                        return (
                          <div style={{ minWidth:0 }}>
                            <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>SpO₂</p>
                            <div style={{ display:"flex", alignItems:"center", gap:4,
                              background: out ? P.roseSoft : "transparent", borderRadius:8 }}>
                              <input type="number" inputMode="decimal" value={racs.sat}
                                onChange={e => sr("sat")(e.target.value)} placeholder="96"
                                style={{ flex:1, minWidth:0, background: out ? "transparent" : P.surfaceAlt,
                                  border:`1.5px solid ${out ? P.rose : P.border}`,
                                  borderRadius:8, padding:"9px 4px", fontSize:15, color: out ? P.roseText : P.text,
                                  fontFamily:mono, outline:"none", textAlign:"center", fontWeight: out ? 800 : 600, boxSizing:"border-box" }}
                                onFocus={e => e.target.style.borderColor = P.blue}
                                onBlur={e  => e.target.style.borderColor = out ? P.rose : P.border} />
                              <span style={{ fontSize:9, color: out ? P.roseText : P.textSoft, flexShrink:0, fontWeight: out?700:400 }}>%</span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    {(() => {
                      const s = parseFloat(String(racs.sat).replace(",","."));
                      const out = !isNaN(s) && (s < 94 || s > 98);
                      return (
                        <p style={{ margin:"0 0 10px", fontSize:9, textAlign:"right",
                          color: out ? P.roseText : P.textSoft, fontWeight: out ? 700 : 400,
                          fontStyle: out ? "normal" : "italic" }}>
                          {out ? (s > 98 ? "⚠️ SpO₂ > 98% — risque d'hyperoxie, diminuer FiO₂" : "⚠️ SpO₂ < 94% — hypoxie") : "Objectif SpO₂ 94–98 %"}
                        </p>
                      );
                    })()}

                    {/* FiO2 / EtCO2 avec objectif Capno */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:4 }}>
                      <div style={{ minWidth:0 }}>
                        <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                          textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>FiO₂</p>
                        <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <input type="number" inputMode="decimal" value={racs.fio2}
                            onChange={e => sr("fio2")(e.target.value)} placeholder="100"
                            style={{ flex:1, minWidth:0, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                              borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                              fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                            onFocus={e => e.target.style.borderColor = P.blue}
                            onBlur={e  => e.target.style.borderColor = P.border} />
                          <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>%</span>
                        </div>
                      </div>
                      {/* EtCO2 — alerte si hors cible 35–45mmHg + tendance vs dernière valeur enregistrée */}
                      {(() => {
                        const v = parseFloat(String(racs.capno).replace(",","."));
                        const out = !isNaN(v) && (v < 35 || v > 45);
                        const lastVal = etco2List.length > 0 ? etco2List[etco2List.length - 1].val : null;
                        return (
                          <div style={{ minWidth:0, position:"relative" }}>
                            <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>EtCO₂</p>
                            {lastVal != null && <TrendBadge current={racs.capno} last={lastVal} P={P} goodDir="up" />}
                            <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                              <input type="number" inputMode="decimal" value={racs.capno}
                                onChange={e => sr("capno")(e.target.value)} placeholder="35"
                                style={{ flex:1, minWidth:0, background: out ? P.roseSoft : P.greenSoft,
                                  border:`1.5px solid ${out ? P.rose : P.green}`,
                                  borderRadius:8, padding:"9px 4px", fontSize:15, color: out ? P.roseText : P.greenText,
                                  fontFamily:mono, outline:"none", textAlign:"center", fontWeight:800, boxSizing:"border-box" }}
                                onFocus={e => e.target.style.borderColor = P.blue}
                                onBlur={e  => e.target.style.borderColor = out ? P.rose : P.green} />
                              <span style={{ fontSize:9, color: out ? P.roseText : P.greenText, flexShrink:0, fontWeight:700 }}>mmHg</span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    {(() => {
                      const v = parseFloat(String(racs.capno).replace(",","."));
                      const out = !isNaN(v) && (v < 35 || v > 45);
                      return (
                        <p style={{ margin:"0 0 4px", fontSize:9.5, textAlign:"right",
                          color: out ? P.roseText : P.greenText, fontWeight: out ? 700 : 600 }}>
                          {isNaN(v) ? "Objectif EtCO₂ 35–45 mmHg" : out ? "⚠️ EtCO₂ hors cible" : "✓ EtCO₂ dans la cible (35–45 mmHg)"}
                        </p>
                      );
                    })()}

                    {/* Graphique live EtCO2 */}
                    {etco2List.length > 0 && (
                      <div style={{ background:P.surfaceAlt, borderRadius:12, padding:"10px 12px", marginTop:10 }}>
                        <p style={{ margin:"0 0 6px", fontSize:9, fontWeight:700, color:P.textMid,
                          textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>
                          EtCO₂ — {etco2List.length} mesure{etco2List.length>1?"s":""}
                        </p>
                        <Etco2Curve data={etco2List} P={P} mono={mono} refSec={events.find(e=>e.id==="rosc")?.sec||0} />
                      </div>
                    )}
                  </div>
                )}

                {racsTab === "sedat" && (
                  <div>
                    {/* Hypnovel inline */}
                    <div style={{ background:P.surfaceAlt, borderRadius:12, padding:"12px", marginBottom:12 }}>
                      <Lbl>Hypnovel — 50 mg / 50 cc</Lbl>
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                        <input type="number" inputMode="decimal" value={racs.hypnovelV}
                          onChange={e => sr("hypnovelV")(e.target.value)} placeholder="5"
                          style={{ flex:1, background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:9,
                            padding:"12px 10px", fontSize:18, color:P.text, fontFamily:mono, outline:"none",
                            textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                          onFocus={e => e.target.style.borderColor = P.violet}
                          onBlur={e  => e.target.style.borderColor = P.border} />
                        <span style={{ fontSize:11, color:P.textSoft, whiteSpace:"nowrap" }}>mL/h</span>
                      </div>
                      {(() => {
                        const v = parseFloat(racs.hypnovelV);
                        const ok = !isNaN(v) && v > 0;
                        const dose = ok ? (v * 1).toFixed(2) : null;
                        return (
                          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                            background: ok ? P.violet+"22" : P.borderSoft, borderRadius:8, padding:"10px 14px",
                            border:`1.5px solid ${ok ? P.violet : P.border}` }}>
                            <span style={{ fontSize:12, color:P.textSoft }}>→ Posologie</span>
                            <span style={{ fontSize:20, fontWeight:700, color: ok ? P.violetText : P.textSoft, fontFamily:mono }}>
                              {ok ? `${dose} mg/h` : "—"}
                            </span>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Sufentanyl inline */}
                    <div style={{ background:P.surfaceAlt, borderRadius:12, padding:"12px", marginBottom:12 }}>
                      <Lbl>Sufentanyl — 250 μg / 50 cc</Lbl>
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                        <input type="number" inputMode="decimal" value={racs.sufentaV}
                          onChange={e => sr("sufentaV")(e.target.value)} placeholder="5"
                          style={{ flex:1, background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:9,
                            padding:"12px 10px", fontSize:18, color:P.text, fontFamily:mono, outline:"none",
                            textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                          onFocus={e => e.target.style.borderColor = P.violet}
                          onBlur={e  => e.target.style.borderColor = P.border} />
                        <span style={{ fontSize:11, color:P.textSoft, whiteSpace:"nowrap" }}>mL/h</span>
                      </div>
                      {(() => {
                        const v = parseFloat(racs.sufentaV);
                        const ok = !isNaN(v) && v > 0;
                        const dose = ok ? (v * 5).toFixed(1) : null;
                        return (
                          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                            background: ok ? P.violet+"22" : P.borderSoft, borderRadius:8, padding:"10px 14px",
                            border:`1.5px solid ${ok ? P.violet : P.border}` }}>
                            <span style={{ fontSize:12, color:P.textSoft }}>→ Posologie</span>
                            <span style={{ fontSize:20, fontWeight:700, color: ok ? P.violetText : P.textSoft, fontFamily:mono }}>
                              {ok ? `${dose} μg/h` : "—"}
                            </span>
                          </div>
                        );
                      })()}
                    </div>

                    <div style={{ marginBottom:12 }}>
                      <Lbl>Curare (bolus)</Lbl>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <input type="number" inputMode="decimal" value={racs.curare}
                          onChange={e => sr("curare")(e.target.value)} placeholder="50"
                          style={{ flex:1, background:P.surfaceAlt, border:`1.5px solid ${P.border}`, borderRadius:9,
                            padding:"12px 10px", fontSize:18, color:P.text, fontFamily:mono, outline:"none",
                            textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                          onFocus={e => e.target.style.borderColor = P.violet}
                          onBlur={e  => e.target.style.borderColor = P.border} />
                        <span style={{ fontSize:11, color:P.textSoft }}>mg</span>
                      </div>
                    </div>
                    <Lbl>Autres drogues</Lbl>
                    <TArea value={racs.autresDrogues} onChange={sr("autresDrogues")}
                      placeholder="Ex : Propofol 200 mg/h..." rows={2} />
                  </div>
                )}

                {racsTab === "hemo" && (
                  <div style={{ width:"100%" }}>

                    {/* TAs / TAd / FC — 3 champs séparés, avec tendance vs dernière mesure enregistrée */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:4 }}>
                      {[
                        { label:"TAs",        key:"tas", ph:"120", accent:P.rose, goodDir:"up" },
                        { label:"TAd",        key:"tad", ph:"80",  accent:P.rose, goodDir:"up" },
                        { label:"FC /min",    key:"fc",  ph:"80",  accent:P.rose, goodDir:"down" },
                      ].map(f => {
                        const lastVal = hemoList.length > 0 ? hemoList[hemoList.length - 1][f.key] : null;
                        return (
                        <div key={f.key} style={{ minWidth:0, position:"relative" }}>
                          <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                            textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>{f.label}</p>
                          {lastVal != null && <TrendBadge current={racs[f.key]} last={lastVal} P={P} goodDir={f.goodDir} />}
                          <input type="number" inputMode="decimal" value={racs[f.key]}
                            onChange={e => sr(f.key)(e.target.value)} placeholder={f.ph}
                            style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                              borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                              fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600,
                              boxSizing:"border-box" }}
                            onFocus={e => e.target.style.borderColor = f.accent}
                            onBlur={e  => e.target.style.borderColor = P.border} />
                        </div>
                        );
                      })}
                    </div>
                    {hemoList.length > 0 && (
                      <p style={{ margin:"6px 0 10px", fontSize:9, color:P.textSoft, textAlign:"right", fontStyle:"italic" }}>
                        vs dernière mesure enregistrée
                      </p>
                    )}

                    {/* PAM calculée */}
                    {(() => {
                      const sys = parseFloat(racs.tas), dia = parseFloat(racs.tad);
                      const pam = (!isNaN(sys) && !isNaN(dia) && sys>0 && dia>0)
                        ? Math.round((sys + 2*dia) / 3) : null;
                      return (
                        <div style={{ marginBottom:12 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
                            <span style={{ fontSize:9, color:P.textSoft, fontFamily:mono,
                              textTransform:"uppercase", letterSpacing:"0.08em" }}>PAM calculée</span>
                            <span style={{ fontSize:16, fontWeight:700, fontFamily:mono,
                              color: pam!==null ? (pam>=65?P.greenText:P.roseText) : P.textSoft }}>
                              {pam!==null ? `${pam} mmHg` : "—"}
                            </span>
                          </div>
                          <p style={{ margin:0, fontSize:9, color:P.textSoft, fontStyle:"italic" }}>
                            Objectif PAM {">"} 65 mmHg · post-TC {">"} 80 mmHg
                          </p>
                        </div>
                      );
                    })()}

                    {/* Graphique live — évolution TA/FC (les mesures déjà enregistrées) */}
                    {hemoList.length > 0 && (
                      <div style={{ background:P.surfaceAlt, borderRadius:12, padding:"10px 12px", marginBottom:12 }}>
                        <p style={{ margin:"0 0 6px", fontSize:9, fontWeight:700, color:P.textMid,
                          textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>
                          Évolution — {hemoList.length} mesure{hemoList.length>1?"s":""}
                        </p>
                        <HemoCurve hemoList={hemoList} amineList={amineList} P={P} mono={mono}
                          refSec={events.find(e=>e.id==="rosc")?.sec||0} />
                      </div>
                    )}

                    {/* Température — contrôle ciblé (ERC 2025 : prévention stricte de l'hyperthermie) */}
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10,
                      background: parseFloat(String(racs.tempRacs).replace(",",".")) > 37.5 ? P.roseSoft : P.amberSoft,
                      border:`1px solid ${parseFloat(String(racs.tempRacs).replace(",",".")) > 37.5 ? P.rose : P.amber}`,
                      borderRadius:9, padding:"7px 10px" }}>
                      <span style={{ fontSize:13, flexShrink:0 }}>🌡️</span>
                      <input type="number" inputMode="decimal" step="0.1" value={racs.tempRacs}
                        onChange={e => sr("tempRacs")(e.target.value)} placeholder="36,5"
                        style={{ width:62,
                          background:P.surface,
                          border:`1px solid ${parseFloat(String(racs.tempRacs).replace(",",".")) > 37.5 ? P.rose : P.amber}`,
                          borderRadius:7, padding:"5px 4px", fontSize:14, color:P.text,
                          fontFamily:mono, outline:"none", textAlign:"center", fontWeight:700,
                          boxSizing:"border-box", flexShrink:0 }}
                        onFocus={e => e.target.style.borderColor = P.amberText}
                        onBlur={e  => e.target.style.borderColor = P.amber} />
                      <span style={{ fontSize:12,
                        color: parseFloat(String(racs.tempRacs).replace(",",".")) > 37.5 ? P.roseText : P.amberText,
                        fontWeight:600, flexShrink:0 }}>°C</span>
                      <span style={{ fontSize:10,
                        color: parseFloat(String(racs.tempRacs).replace(",",".")) > 37.5 ? P.roseText : P.amberText,
                        fontWeight: parseFloat(String(racs.tempRacs).replace(",",".")) > 37.5 ? 700 : 400,
                        lineHeight:1.3 }}>
                        {parseFloat(String(racs.tempRacs).replace(",",".")) > 37.5
                          ? "⚠️ > 37,5 °C — hyperthermie à traiter"
                          : "Objectif : éviter > 37,5 °C (72h)"}
                      </span>
                    </div>

                    {/* Glycémie — ACSOS : éviter hypo/hyperglycémie */}
                    {(() => {
                      const g = parseFloat(String(racs.glycemie).replace(",","."));
                      const out = !isNaN(g) && (g < 1.0 || g > 1.8);
                      return (
                        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10,
                          background: out ? P.roseSoft : P.amberSoft,
                          border:`1px solid ${out ? P.rose : P.amber}`,
                          borderRadius:9, padding:"7px 10px" }}>
                          <span style={{ fontSize:13, flexShrink:0 }}>🩸</span>
                          <input type="number" inputMode="decimal" step="0.01" value={racs.glycemie}
                            onChange={e => sr("glycemie")(e.target.value)} placeholder="1,20"
                            style={{ width:62, background:P.surface, border:`1px solid ${out ? P.rose : P.amber}`,
                              borderRadius:7, padding:"5px 4px", fontSize:14, color:P.text,
                              fontFamily:mono, outline:"none", textAlign:"center", fontWeight:700,
                              boxSizing:"border-box", flexShrink:0 }}
                            onFocus={e => e.target.style.borderColor = P.amberText}
                            onBlur={e  => e.target.style.borderColor = P.amber} />
                          <span style={{ fontSize:12, color: out ? P.roseText : P.amberText, fontWeight:600, flexShrink:0 }}>g/L</span>
                          <span style={{ fontSize:10, color: out ? P.roseText : P.amberText,
                            fontWeight: out ? 700 : 400, lineHeight:1.3 }}>
                            {out ? "⚠️ Hors cible — corriger hypo/hyperglycémie" : "Objectif : 1,0-1,8 g/L (éviter hypo/hyper)"}
                          </span>
                        </div>
                      );
                    })()}

                    {/* Pupilles — examen neurologique rapide */}
                    <div style={{ marginBottom:10 }}>
                      <Lbl>Pupilles</Lbl>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                        {["Normales","Anormales","Non fait"].map(v => (
                          <button key={v} onClick={() => {
                              if (v === "Anormales") { setRacsPupillesExpanded(x => !x); return; }
                              sr("pupilles")(v); setRacsPupillesExpanded(false);
                            }}
                            style={{ padding:"8px 4px", borderRadius:9, fontSize:10.5, fontWeight:600,
                              border:`1.5px solid ${P.violet}`,
                              background: (v==="Anormales" && racsPupillesExpanded) || (v!=="Anormales" && racs.pupilles===v) ? P.violet : P.surface,
                              color: (v==="Anormales" && racsPupillesExpanded) || (v!=="Anormales" && racs.pupilles===v) ? "#fff" : P.violetText,
                              cursor:"pointer", fontFamily:sans }}>
                            {v}
                          </button>
                        ))}
                      </div>
                      {racs.pupilles && !["Normales","Non fait"].includes(racs.pupilles) && !racsPupillesExpanded && (
                        <p style={{ margin:"6px 0 0", fontSize:10.5, color:P.violetText, fontWeight:700 }}>{racs.pupilles}</p>
                      )}
                      {racsPupillesExpanded && (
                        <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                          {PUPILLES_DETAIL.map(({v,left,right}) => (
                            <button key={v} onClick={() => { sr("pupilles")(v); setRacsPupillesExpanded(false); }}
                              style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                                borderRadius:9, border:`1.5px solid ${P.border}`, background:P.surface,
                                fontSize:11.5, fontWeight:600, color:P.text, cursor:"pointer",
                                fontFamily:sans, textAlign:"left" }}>
                              <PupilIcon left={left} right={right} />{v}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Noradrénaline */}
                    <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px", marginBottom:10 }}>
                      <p style={{ margin:"0 0 6px", fontSize:9, fontWeight:500, color:P.textSoft,
                        textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>
                        Noradrénaline — 8 mg/40 cc
                      </p>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:7 }}>
                        <input type="number" inputMode="decimal" value={racs.noradrV}
                          onChange={e => sr("noradrV")(e.target.value)} placeholder="3"
                          style={{ flex:1, minWidth:0, background:P.surface, border:`1.5px solid ${P.border}`,
                            borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                            fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                          onFocus={e => e.target.style.borderColor = P.rose}
                          onBlur={e  => e.target.style.borderColor = P.border} />
                        <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>mL/h</span>
                      </div>
                      {(() => {
                        const v = parseFloat(racs.noradrV), ok = !isNaN(v) && v>0;
                        const dose = ok ? (v*0.2).toFixed(2) : null;
                        return (
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                            background: ok?P.rose+"22":P.borderSoft, borderRadius:7, padding:"7px 10px",
                            border:`1.5px solid ${ok?P.rose:P.border}` }}>
                            <span style={{ fontSize:11, color:P.textSoft }}>→ Posologie</span>
                            <span style={{ fontSize:17, fontWeight:700, color:ok?P.roseText:P.textSoft, fontFamily:mono }}>
                              {ok ? `${dose} mg/h` : "—"}
                            </span>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Dobutamine */}
                    <div style={{ marginBottom:12 }}>
                      <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                        textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Dobutamine</p>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <input type="number" inputMode="decimal" value={racs.dobut}
                          onChange={e => sr("dobut")(e.target.value)} placeholder="5"
                          style={{ flex:1, minWidth:0, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                            borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                            fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                          onFocus={e => e.target.style.borderColor = P.rose}
                          onBlur={e  => e.target.style.borderColor = P.border} />
                        <span style={{ fontSize:9, color:P.textSoft, flexShrink:0, whiteSpace:"nowrap" }}>μg/kg/min</span>
                      </div>
                    </div>

                    {/* ── Remplissage vasculaire ── */}
                    <RemplissageSection racs={racs} setRacs={setRacs} />

                    <p style={{ margin:"10px 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                      textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Autres thérapeutiques</p>
                    <TArea value={racs.autresHemo} onChange={sr("autresHemo")}
                      placeholder="Ex : Vasopressine 0,03 U/min..." rows={2} />
                  </div>
                )}

              </div>

              {/* Le bouton "Récidive d'arrêt" a été déplacé en tête de la grille d'actions,
                  bien plus visible qu'enfoui ici en bas du modal. */}

              {/* Valider */}
              <button onClick={() => {
                addEvent("racs_soins", buildLog(), "🫀");
                if (racs.tas || racs.fc) {
                  setHemoList(prev => [...prev, { sec, time: getNow(), pas: racs.tas, pad: racs.tad, fc: racs.fc }]);
                }
                if (racs.capno) {
                  setEtco2List(prev => [...prev, { val: racs.capno, sec, time: getNow() }]);
                }
                setModalRacs(false);
              }}
                style={{ width:"100%", background:"linear-gradient(135deg,#3EA876,#2A7D57)",
                  border:"none", borderRadius:14, color:"#fff", fontSize:15, fontWeight:600,
                  padding:"15px", cursor:"pointer", fontFamily:sans, marginTop:14, flexShrink:0,
                  boxShadow:"0 6px 18px rgba(62,168,118,0.3)" }}>
                ✓ Enregistrer les soins post-RACS
              </button>
            </div>
          </div>
        );
      })()}

      {alert && (
        <div onClick={() => setAlert(null)} style={{ position:"fixed", top:0, left:0, right:0, zIndex:50,
          background:"linear-gradient(90deg,#C89435,#D4A040)", padding:"12px 18px",
          display:"flex", alignItems:"center", gap:10, cursor:"pointer",
          boxShadow:"0 4px 18px rgba(200,148,53,0.35)" }}>
          <span style={{ fontSize:18 }}>⏱</span>
          <div>
            <p style={{ margin:0, color:"#fff", fontSize:14, fontWeight:600 }}>2 minutes écoulées</p>
            <p style={{ margin:0, color:"rgba(255,255,255,0.8)", fontSize:12 }}>{alert}</p>
          </div>
          <span style={{ marginLeft:"auto", color:"rgba(255,255,255,0.5)", fontSize:16 }}>×</span>
        </div>
      )}

      {/* ── Bandeau vocal fin, fixe — toujours visible tant que le micro est actif, même en défilant ── */}
      {SpeechRecognitionAPI && voiceActive && (() => {
        const bannerTop = alert ? 56 : 0;
        if (voiceToast) return (
          <div style={{ position:"fixed", top:bannerTop, left:0, right:0, zIndex:49,
            background:`linear-gradient(135deg, ${P.green}, #2A7D57)`, padding:"7px 14px",
            boxShadow:"0 2px 8px rgba(0,0,0,0.15)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:16, flexShrink:0 }}>{voiceToast.icon}</span>
              <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:"#fff", flex:1 }}>{voiceToast.label}</p>
              <span style={{ fontSize:10, color:"rgba(255,255,255,0.85)", flexShrink:0 }}>2s…</span>
              <button onClick={voiceToast.cancel}
                style={{ background:"rgba(255,255,255,0.25)", border:"none", borderRadius:7,
                  color:"#fff", fontSize:11, fontWeight:700, padding:"4px 8px", cursor:"pointer", flexShrink:0 }}>
                Annuler
              </button>
            </div>
          </div>
        );
        if (voiceAnswer) return (
          <div style={{ position:"fixed", top:bannerTop, left:0, right:0, zIndex:49,
            background:`linear-gradient(135deg, ${P.blue}, #0B43A0)`, padding:"7px 14px",
            boxShadow:"0 2px 8px rgba(0,0,0,0.15)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:16, flexShrink:0 }}>{voiceAnswer.icon}</span>
              <p style={{ margin:0, fontSize:12.5, fontWeight:700, color:"#fff", flex:1 }}>{voiceAnswer.speak}</p>
              <button onClick={() => setVoiceAnswer(null)}
                style={{ background:"transparent", border:"none", color:"rgba(255,255,255,0.8)",
                  fontSize:16, cursor:"pointer", flexShrink:0, padding:0 }}>✕</button>
            </div>
          </div>
        );
        if (voiceTranscript) return (
          <div style={{ position:"fixed", top:bannerTop, left:0, right:0, zIndex:49,
            background:"rgba(10,17,27,0.85)", padding:"7px 14px" }}>
            <p style={{ margin:0, fontSize:12, color:"rgba(255,255,255,0.85)", fontFamily:mono }}>
              🎙️ "{voiceTranscript}"
            </p>
          </div>
        );
        return (
          <div style={{ position:"fixed", top:bannerTop, left:0, right:0, zIndex:49,
            background: voiceWakeFlash ? `linear-gradient(135deg, ${P.green}, #2A7D57)` : `linear-gradient(135deg, ${P.rose}, #9B2C2C)`,
            padding:"6px 14px", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ width:7, height:7, borderRadius:"50%", background:"#fff", flexShrink:0,
              boxShadow:"0 0 0 3px rgba(255,255,255,0.3)" }} />
            <p style={{ margin:0, fontSize:11, fontWeight:700, color:"#fff", flex:1 }}>
              🎙️ À l'écoute — dites « {voiceWakeWord || "Alpha"} » avant une commande
            </p>
          </div>
        );
      })()}

      {/* Header + Timer */}
      <div style={{ background:P.surface, borderBottom:`1px solid ${P.border}`,
        padding:`${alert ? 56 + (voiceActive?34:0) : voiceActive ? 34+14 : 14}px 16px 14px`,
        boxShadow:"0 2px 10px rgba(0,0,0,0.04)" }}>

        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:20 }}>{isVLI ? "🚒" : isTrauma ? "🩻" : "❤️‍🩹"}</span>
            <div>
              <p style={{ margin:0, fontSize:13, fontWeight:600, color:P.text }}>{pat.nom ? `${pat.nom} ${pat.prenom}` : (isVLI ? (vliUnlocked ? "ACR VLI → Médicalisé" : "ACR VLI") : isTrauma ? "ACR Traumatique" : "Copilote ACR")}</p>
              <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:2 }}>
                {pat.age && <span style={{ fontSize:11, color:P.textSoft }}>{pat.age} ans{pat.sexe ? ` · ${pat.sexe}` : ""}</span>}
                {pat.age && noFlowMin !== undefined && <span style={{ fontSize:11, color:P.textSoft }}>·</span>}
                <span style={{ fontSize:11, color:P.textSoft }}>ACR =</span>
                <input type="time" value={acrTime}
                  onChange={e => { setAcrTime(e.target.value); st("hEffondrement")(e.target.value); }}
                  style={{ background:"transparent", border:"none", borderBottom:`1px solid ${P.border}`,
                    fontSize:11, color:P.text, fontFamily:mono, fontWeight:600,
                    outline:"none", padding:"0 2px", width:52, cursor:"pointer" }}
                  onFocus={e => e.target.style.borderBottomColor = P.rose}
                  onBlur={e  => e.target.style.borderBottomColor = P.border} />
              </div>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {SpeechRecognitionAPI && (
              <button
                onClick={() => {
                  if (!voiceActive) {
                    if (!navigator.onLine) {
                      setVoiceTranscript("🚫 Pas de connexion internet — la reconnaissance vocale ne fonctionne pas hors ligne");
                      setTimeout(() => setVoiceTranscript(""), 5000);
                      return;
                    }
                    try { new (window.AudioContext||window.webkitAudioContext)().resume(); } catch(e){}
                  }
                  setVoiceActive(v => !v);
                }}
                style={{ background: voiceWakeFlash ? `linear-gradient(135deg, ${P.green}, #2A7D57)`
                    : voiceActive ? `linear-gradient(135deg, ${P.rose}, #9B2C2C)` : P.surfaceAlt,
                  border: voiceActive ? "none" : `1px solid ${P.border}`, borderRadius:10,
                  padding:"6px 9px", cursor:"pointer", fontFamily:sans, display:"flex",
                  alignItems:"center", flexShrink:0,
                  boxShadow: voiceActive ? `0 2px 8px color-mix(in srgb, ${P.rose} 35%, transparent)` : "none" }}>
                <span style={{ fontSize:14 }}>🎙️</span>
              </button>
            )}
            <button onClick={() => setModalTeam(true)}
              style={{ background: team.teamConnected ? P.greenSoft : P.surfaceAlt,
                border:`1px solid ${team.teamConnected ? P.green : P.border}`, borderRadius:10,
                padding:"6px 9px", cursor:"pointer", fontFamily:sans, display:"flex",
                alignItems:"center", gap:5 }}>
              <span style={{ fontSize:13 }}>{team.syncStatus === "error" ? "🔴" : team.syncStatus === "syncing" ? "🟡" : team.teamConnected ? "🟢" : "👥"}</span>
              <span style={{ fontSize:10.5, fontWeight:700, color: team.teamConnected ? P.greenText : P.textMid }}>
                {team.teamConnected ? `${team.teamCode} · ${team.teamDeviceCount}` : "Équipe"}
              </span>
            </button>
            <ThemeToggle theme={theme} setTheme={setTheme} compact />
          </div>
        </div>

        {/* Bandeau d'information VLI — rappel du cadre du protocole, tant que non déverrouillé */}
        {isVLI && !vliUnlocked && (
          <div style={{ background:"rgba(234,106,18,0.12)", border:"1px solid #EA6A12", borderRadius:9,
            padding:"6px 10px", display:"flex", alignItems:"center", gap:6, marginBottom:12 }}>
            <span style={{ fontSize:12 }}>ℹ️</span>
            <span style={{ fontSize:10.5, fontWeight:700, color:"#B24E0A" }}>
              Actes limités au protocole VLI en vigueur
            </span>
          </div>
        )}

        {/* Grand timer — style moniteur */}
        <div style={{ textAlign:"center", marginBottom:14 }}>
          <p style={{ margin:"0 0 2px", fontSize:9.5, color:P.textSoft, letterSpacing:"0.14em",
            textTransform:"uppercase", fontFamily:mono, fontWeight:700,
            display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
            {running && <span style={{ width:7, height:7, borderRadius:"50%", background: isVLI && !vliUnlocked ? "#EA6A12" : P.rose,
              display:"inline-block", animation:"pulse 1.4s infinite" }} />}
            Début RCP médicalisé
          </p>
          <span style={{ fontSize:60, fontWeight:800, letterSpacing:"-0.04em",
            color: running ? P.text : P.textSoft, fontFamily:mono, lineHeight:0.95,
            fontVariantNumeric:"tabular-nums" }}>
            {fmtSec(sec)}
          </span>

          {/* Sous-ligne moniteur : no-flow / low-flow en pastilles discrètes */}
          <div style={{ display:"flex", justifyContent:"center", gap:7, marginTop:9, flexWrap:"wrap" }}>
            <div style={{ display:"flex", alignItems:"center", gap:5, background:P.surfaceAlt,
              border:`1px solid ${P.border}`, borderRadius:20, padding:"4px 11px" }}>
              <span style={{ fontSize:9, fontWeight:700, color:P.amberText, fontFamily:mono, letterSpacing:"0.06em" }}>NO-FLOW</span>
              <select value={noFlowMin} onChange={e => setNoFlowMin(e.target.value)}
                style={{ background:"transparent", border:"none", borderBottom:`1px solid ${P.border}`,
                  fontSize:13, fontWeight:700, color:P.text, fontFamily:mono, textAlign:"center",
                  outline:"none", padding:"0 2px 1px", cursor:"pointer", appearance:"none", WebkitAppearance:"none" }}>
                <option value="">—</option>
                {Array.from({ length:61 }, (_, i) => (
                  <option key={i} value={String(i)}>{i}</option>
                ))}
              </select>
              <span style={{ fontSize:9, color:P.textSoft }}>min</span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:5, background:P.surfaceAlt,
              border:`1px solid ${P.border}`, borderRadius:20, padding:"4px 11px" }}>
              <span style={{ fontSize:9, fontWeight:700, color:P.blueText, fontFamily:mono, letterSpacing:"0.06em" }}>LOW-FLOW</span>
              <select value={lowFlowMin} onChange={e => setLowFlowMin(e.target.value)}
                style={{ background:"transparent", border:"none", borderBottom:`1px solid ${P.border}`,
                  fontSize:13, fontWeight:700, color:P.text, fontFamily:mono, textAlign:"center",
                  outline:"none", padding:"0 2px 1px", cursor:"pointer", appearance:"none", WebkitAppearance:"none" }}>
                <option value="">—</option>
                {Array.from({ length:61 }, (_, i) => (
                  <option key={i} value={String(i)}>{i}</option>
                ))}
              </select>
              <span style={{ fontSize:9, color:P.textSoft }}>min</span>
            </div>
          </div>
        </div>

        {/* ── Suivi CCF (si activé dans les réglages) ── */}
        {ccfEnabled && started && !events.find(e => e.id === "rosc") && (
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10,
            background:P.surface, border:`1.5px solid ${compPaused ? P.amber : P.border}`,
            borderRadius:12, padding:"9px 12px", boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
            <span style={{ fontSize:9, fontWeight:700, color:P.textSoft, fontFamily:mono, letterSpacing:"0.08em" }}>CCF</span>
            <span style={{ fontSize:20, fontWeight:800, fontFamily:mono, fontVariantNumeric:"tabular-nums", lineHeight:1,
              color: ccfPct >= 60 ? P.greenText : P.amberText }}>{ccfPct}%</span>
            {compPaused && <span style={{ fontSize:9.5, fontWeight:700, color:P.amberText, fontFamily:mono }}>● COMPRESSIONS ARRÊTÉES</span>}
            <button onClick={toggleCompressions}
              style={{ marginLeft:"auto", border:`1px solid ${compPaused ? P.green : P.amber}`,
                background: compPaused ? `color-mix(in srgb, ${P.green} 14%, transparent)` : `color-mix(in srgb, ${P.amber} 14%, transparent)`,
                color: compPaused ? P.greenText : P.amberText, borderRadius:9, padding:"7px 11px",
                fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>
              {compPaused ? "▶ Reprendre" : "⏸ Pause compressions"}
            </button>
          </div>
        )}

        {/* Minuteur Adrénaline */}
        {adrTimerStart > 0 && started && !events.find(e => e.id === "rosc") && (
          <AdrenalineTimer
            startSec={adrTimerStart}
            intervalMin={adrIntervalGlobal}
            setIntervalMin={null}
            onAdminister={() => { addEvent("adr","Adrénaline 1 mg IV/IO","💉"); setAdrTimerStart(Date.now()); }}
            onCancel={() => setAdrTimerStart(0)}
            running={running}
            P={P} mono={mono} sans={sans} fmtSec={fmtSec}
          />
        )}

        {/* Compteur chocs cumulés + rappel Cordarone */}
        {(() => {
          const chocsSmur = events.filter(e => e.id === "choc").length;
          const chocsPomp = (parseInt(trans.chocsPompiers) || 0) + (parseInt(trans.chocsPublic) || 0);
          const chocsTotal = chocsSmur + chocsPomp;
          const adrCount = events.filter(e => e.id === "adr").length;
          const cordCount = events.filter(e => e.id === "cord300" || e.id === "cord150").length;
          if (chocsTotal === 0 && !started) return null;
          const showCord300 = chocsTotal >= 3 && cordCount === 0;
          const showCord150 = chocsTotal >= 5 && cordCount === 1;
          return (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 }}>
              <div style={{ background: chocsTotal > 0 ? P.blueSoft : P.surfaceAlt,
                border:`1px solid ${chocsTotal > 0 ? P.blue+"44" : P.border}`,
                borderRadius:10, padding:"7px 10px" }}>
                <p style={{ margin:"0 0 2px", fontSize:9, color:P.textSoft, textTransform:"uppercase",
                  letterSpacing:"0.09em", fontFamily:mono }}>Chocs cumulés</p>
                <div style={{ display:"flex", alignItems:"baseline", gap:5 }}>
                  <span style={{ fontSize:24, fontWeight:700, color: P.blueText, fontFamily:mono, lineHeight:1 }}>
                    {chocsTotal}
                  </span>
                  {chocsPomp > 0 && (
                    <span style={{ fontSize:10, color:P.textSoft, fontFamily:mono }}>
                      ({chocsPomp} avant SMUR + {chocsSmur} SMUR)
                    </span>
                  )}
                </div>
              </div>
              <div style={{ background: adrCount > 0 ? P.roseSoft : P.surfaceAlt,
                border:`1px solid ${adrCount > 0 ? P.rose+"44" : P.border}`,
                borderRadius:10, padding:"7px 10px" }}>
                <p style={{ margin:"0 0 2px", fontSize:9, color:P.textSoft, textTransform:"uppercase",
                  letterSpacing:"0.09em", fontFamily:mono }}>Adré · Cord.</p>
                <span style={{ fontSize:16, fontWeight:700, color:P.roseText, fontFamily:mono }}>
                  {adrCount} × 1mg · {cordCount}
                </span>
              </div>
              {(showCord300 || showCord150) && (
                <div style={{ gridColumn:"1 / -1", background:P.amberSoft,
                  border:`1.5px solid ${P.amber}`, borderRadius:10, padding:"8px 12px",
                  display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:18 }}>💊</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:11, fontWeight:700, color:P.amberText }}>
                      Rappel : Cordarone {showCord300 ? "300 mg" : "150 mg"}
                    </p>
                    <p style={{ margin:0, fontSize:10, color:P.amberText }}>
                      Après le {showCord300 ? "3ᵉ" : "5ᵉ"} choc cumulé
                    </p>
                  </div>
                  <button onClick={() => {
                    if (showCord300) addEvent("cord300", "Cordarone 300 mg IV (après 3ᵉ choc)", "💊");
                    else             addEvent("cord150", "Cordarone 150 mg IV (après 5ᵉ choc)", "💊");
                  }}
                    style={{ background:P.amber, border:"none", borderRadius:7,
                      color:"#fff", padding:"6px 10px", fontSize:11, fontWeight:600,
                      cursor:"pointer", fontFamily:sans }}>
                    Administrer
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* Barre cycle */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
          <span style={{ fontSize:10, color:P.textSoft, fontFamily:mono }}>Cycle RCP · 2 min</span>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:10, fontWeight:500, color: warn ? bar : P.textSoft, fontFamily:mono }}>
              {warn ? `⚠ ${rem}s` : `${rem}s`}
            </span>
            <button onClick={() => { setCycleOffset(sec); prevCpRef.current = null; addEvent("cycle","↺ Cycle remis à zéro","↺"); }}
              style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:6,
                padding:"2px 8px", fontSize:10, color:P.textMid, cursor:"pointer",
                fontFamily:sans, lineHeight:1.4 }}>
              ↺ Reset
            </button>
          </div>
        </div>
        <div style={{ background:P.surfaceAlt, borderRadius:99, height:5, overflow:"hidden" }}>
          <div style={{ width:`${pct}%`, height:5, borderRadius:99, background:bar,
            transition:"width 1s linear, background 0.5s" }} />
        </div>

        {/* Rappel MCE discret */}
        <p style={{ margin:"8px 0 0", fontSize:10, color:P.textSoft, textAlign:"center",
          letterSpacing:"0.01em", lineHeight:1.5 }}>
          {events.find(e => e.id === "iot")
            ? <span style={{ color:P.violetText, fontWeight:700 }}>🫁 IOT — Compressions continues · Ventilations asynchrones 10/min</span>
            : "100–120 /min · 5–6 cm · relâchement complet · ratio 30:2"
          }
        </p>
      </div>

      <div style={{ padding:"10px 12px 0" }}>

        {/* ── Bouton transition VLM (VLI uniquement, tant que non déverrouillé) ── */}
        {isVLI && !vliUnlocked && (
          <button onClick={() => setModalVliTransition(true)}
            style={{ width:"100%", background:"linear-gradient(135deg,#EA6A12,#B24E0A)", border:"none",
              borderRadius:13, padding:"12px 14px", marginBottom:12, display:"flex", alignItems:"center",
              gap:10, cursor:"pointer", boxShadow:"0 4px 14px rgba(234,106,18,0.4)" }}>
            <span style={{ fontSize:20 }}>🚒</span>
            <div style={{ textAlign:"left", flex:1 }}>
              <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:"#fff" }}>VLM arrivée</p>
              <p style={{ margin:0, fontSize:10, color:"rgba(255,255,255,0.85)" }}>Débloquer la prise en charge médicale complète</p>
            </div>
            <span style={{ color:"#fff", fontSize:16 }}>›</span>
          </button>
        )}

        {/* ── Onglet unique : Actions ── */}
        {true && <>

          {/* ── Rangée d'accès rapide : Patient · Transmission · Régulation ── */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
            {/* Patient */}
            <button onClick={() => setModalPat(true)}
              style={{ background:P.surface, border:`1px solid ${pat.nom ? P.blue : P.border}`, borderRadius:14,
                padding:"11px 6px", cursor:"pointer", fontFamily:sans, display:"flex",
                flexDirection:"column", alignItems:"center", gap:6, minWidth:0,
                boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
              <span style={{ width:34, height:34, borderRadius:10,
                background:`color-mix(in srgb, ${P.blue} 16%, transparent)`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:17, color:P.blue }}>🪪</span>
              <span style={{ fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>Patient</span>
              <span style={{ fontSize:8.5, color:P.textSoft, fontFamily:mono, letterSpacing:"0.03em",
                maxWidth:"100%", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{pat.nom ? `${pat.nom}` : "à renseigner"}</span>
            </button>
            {/* Transmission */}
            <button onClick={() => setModalTrans(true)}
              style={{ background: trans.saved ? P.greenSoft : P.amberSoft,
                border:`1px solid ${trans.saved ? P.green : P.amber}`, borderRadius:14,
                padding:"11px 6px", cursor:"pointer", fontFamily:sans, display:"flex",
                flexDirection:"column", alignItems:"center", gap:6, minWidth:0,
                boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
              <span style={{ width:34, height:34, borderRadius:10,
                background: trans.saved ? `color-mix(in srgb, ${P.green} 20%, transparent)` : `color-mix(in srgb, ${P.amber} 20%, transparent)`,
                display:"flex", alignItems:"center", justifyContent:"center",
                color: trans.saved ? P.greenText : P.amberText }}>
                <span style={{ width:18, height:18, display:"flex" }}>{ICONS.transmission}</span>
              </span>
              <span style={{ fontSize:11.5, fontWeight:800, color: trans.saved ? P.greenText : P.amberText, fontFamily:disp }}>Transmission</span>
              <span style={{ fontSize:8.5, color: trans.saved ? P.greenText : P.amberText, opacity:0.85, fontFamily:mono, letterSpacing:"0.03em" }}>{trans.saved ? "enregistrée" : "à compléter"}</span>
            </button>
            {/* Régulation */}
            <button onClick={() => setModalRegul(true)}
              style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14,
                padding:"11px 6px", cursor:"pointer", fontFamily:sans, display:"flex",
                flexDirection:"column", alignItems:"center", gap:6, minWidth:0,
                boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
              <span style={{ width:34, height:34, borderRadius:10,
                background:`color-mix(in srgb, ${P.teal} 16%, transparent)`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, color:P.teal }}>📞</span>
              <span style={{ fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>Régulation</span>
              <span style={{ fontSize:8.5, color:P.textSoft, fontFamily:mono, letterSpacing:"0.03em" }}>SAMU</span>
            </button>
          </div>

          {/* ── Carte Hemocue Hb — trauma uniquement, si valeurs saisies ── */}
          {isTrauma && hemocueHist.length > 0 && (
            <div style={{ background:P.surface, border:`1px solid ${P.rose}`, borderRadius:13,
              padding:"9px 12px", marginBottom:10, boxShadow:`0 2px 8px color-mix(in srgb, ${P.rose} 12%, transparent)` }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:5 }}>
                <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                  <span style={{ width:24, height:24, borderRadius:8,
                    background:`color-mix(in srgb, ${P.rose} 16%, transparent)`,
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, color:P.rose }}>🩸</span>
                  <p style={{ margin:0, fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>Hemocue Hb <span style={{ fontSize:8, fontWeight:600, color:P.textSoft, fontFamily:mono }}>g/dL</span></p>
                </div>
                <span style={{ fontSize:20, fontWeight:800, color:P.roseText, fontFamily:mono, fontVariantNumeric:"tabular-nums", lineHeight:1 }}>
                  {hemocueHist[hemocueHist.length-1].val}
                </span>
              </div>
              <div style={{ display:"flex", gap:12, marginBottom:4 }}>
                {[{c:P.rose,l:"Hb"},{c:P.green,l:"12 g/dL seuil normal",dash:true},{c:P.rose,l:"7 g/dL seuil transfusion",dash:true}].map(({c,l,dash},i)=>(
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:3 }}>
                    <svg width="14" height="8" viewBox="0 0 14 8"><line x1="0" y1="4" x2="14" y2="4" stroke={c} strokeWidth={dash?1.5:2.5} strokeDasharray={dash?"3 2":undefined} /></svg>
                    <span style={{ fontSize:8, color:c, fontFamily:mono, fontWeight:700 }}>{l}</span>
                  </div>
                ))}
              </div>
              <HemocueCurve data={hemocueHist} P={P} mono={mono} refSec={0} />
            </div>
          )}

          {/* ── Carte EtCO₂ (capnographie, courbe en direct) ── */}
          <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:13,
            padding:"9px 12px", marginBottom:10, boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: etco2Open ? 5 : 0 }}>
              <button onClick={() => setEtco2Open(v => !v)}
                style={{ display:"flex", alignItems:"center", gap:7, background:"transparent", border:"none",
                  cursor:"pointer", padding:0, flex:1, minWidth:0, textAlign:"left" }}>
                <span style={{ width:24, height:24, borderRadius:8,
                  background:`color-mix(in srgb, ${P.teal} 16%, transparent)`,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:P.teal }}>📈</span>
                <p style={{ margin:0, fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>EtCO₂ <span style={{ fontSize:8, fontWeight:600, color:P.textSoft, fontFamily:mono }}>mmHg</span></p>
                <span style={{ fontSize:10, color:P.textSoft, marginLeft:4 }}>{etco2Open ? "▾" : "▸"}</span>
              </button>
              <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                {etco2List.length > 0 && (
                  <span style={{ fontSize:20, fontWeight:800, color:P.tealText, fontFamily:mono, fontVariantNumeric:"tabular-nums", lineHeight:1 }}>{etco2List[etco2List.length-1].val}</span>
                )}
                <button onClick={() => { setEtco2Val(""); setModalEtco2(true); }}
                  style={{ background:`color-mix(in srgb, ${P.teal} 14%, transparent)`, color:P.tealText,
                    border:`1px solid ${P.teal}`, borderRadius:9, padding:"6px 11px", fontSize:11,
                    fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>+ Valeur</button>
              </div>
            </div>
            {etco2Open && <Etco2Curve data={etco2List} P={P} mono={mono} />}
          </div>

          {/* ── Carte Hémodynamique post-RACS ── visible seulement si RACS */}
          {events.find(e => e.id === "rosc") && (
            <div style={{ background:P.surface, border:`1px solid ${P.green}`, borderRadius:13,
              padding:"9px 12px", marginBottom:10, boxShadow:`0 2px 8px color-mix(in srgb, ${P.green} 14%, transparent)` }}>
              {/* En-tête */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: hemoOpen ? 6 : 0 }}>
                <button onClick={() => setHemoOpen(v => !v)}
                  style={{ display:"flex", alignItems:"center", gap:7, background:"transparent", border:"none",
                    cursor:"pointer", padding:0, flex:1, minWidth:0, textAlign:"left" }}>
                  <span style={{ width:24, height:24, borderRadius:8, background:P.greenSoft,
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:13 }}>💓</span>
                  <p style={{ margin:0, fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>Hémodynamique <span style={{ fontSize:8, fontWeight:600, color:P.textSoft, fontFamily:mono }}>post-RACS</span></p>
                  <span style={{ fontSize:10, color:P.textSoft, marginLeft:4 }}>{hemoOpen ? "▾" : "▸"}</span>
                </button>
                <div style={{ display:"flex", gap:7 }}>
                  <button onClick={() => { setAmineForm({ type:"Noradrénaline", dose:"", unit:"mg/h" }); setModalAmine(true); }}
                    style={{ background:`color-mix(in srgb, ${P.green} 14%, transparent)`, color:P.greenText,
                      border:`1px solid ${P.green}`, borderRadius:9, padding:"5px 9px", fontSize:10.5,
                      fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>+ Amine</button>
                  <button onClick={() => { setHemoForm({ pas:"", pad:"", fc:"" }); setModalHemo(true); }}
                    style={{ background:`color-mix(in srgb, ${P.green} 14%, transparent)`, color:P.greenText,
                      border:`1px solid ${P.green}`, borderRadius:9, padding:"5px 9px", fontSize:10.5,
                      fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>+ Mesure</button>
                </div>
              </div>
              {/* Légende */}
              {hemoOpen && hemoList.length > 0 && (
                <div style={{ display:"flex", gap:12, marginBottom:5 }}>
                  {[{c:P.rose,l:"PAS"},{c:P.blue,l:"PAD"},{c:P.amber,l:"PAM",dash:true},{c:P.violet,l:"FC",dot:true}].map(({c,l,dash,dot})=>(
                    <div key={l} style={{ display:"flex", alignItems:"center", gap:3 }}>
                      <svg width="18" height="8" viewBox="0 0 18 8">
                        <line x1="0" y1="4" x2="18" y2="4" stroke={c} strokeWidth="2"
                          strokeDasharray={dash?"5 3":dot?"2 3":undefined} />
                      </svg>
                      <span style={{ fontSize:9, fontWeight:700, color:c, fontFamily:mono }}>{l}</span>
                    </div>
                  ))}
                </div>
              )}
              {hemoOpen && <HemoCurve hemoList={hemoList} amineList={amineList} P={P} mono={mono} refSec={events.find(e=>e.id==="rosc")?.sec||0} />}
            </div>
          )}

          {/* ── Tab bar Actions / (Étiologie) / Thérapeutiques / (Situations particulières VLI) ── */}
          <div style={{ display:"grid", gridTemplateColumns: (isTrauma || (isVLI && !vliUnlocked)) ? "1fr 1fr" : "1fr 1fr 1fr", gap:5,
            background:P.surfaceAlt, borderRadius:12, padding:4, marginBottom:10 }}>
            {(isVLI && !vliUnlocked ? [
              { id:"actions", label:"Actions",       icon:"⚡" },
              { id:"vli_sit", label:"Situations",    icon:"🎯" },
            ] : isTrauma ? [
              { id:"actions", label:"Actions",       icon:"⚡" },
              { id:"ther",    label:"Thérapeutiques", icon:"💊" },
            ] : [
              { id:"actions", label:"Actions",       icon:"⚡" },
              { id:"etio",    label:"Étiologie",     icon:"🔍" },
              { id:"ther",    label:"Thérapeutiques", icon:"💊" },
            ]).map(t => (
              <button key={t.id} onClick={() => setMainTab(t.id)}
                style={{ padding:"8px 4px", borderRadius:9, border:"none",
                  background: mainTab===t.id ? P.surface : "transparent",
                  color: mainTab===t.id ? P.text : P.textSoft,
                  fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:sans,
                  boxShadow: mainTab===t.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                  display:"flex", alignItems:"center", justifyContent:"center", gap:4 }}>
                <span>{t.icon}</span>{t.label}
              </button>
            ))}
          </div>

          {/* ── Contenu Actions — VLI restreint (protocole ISP, avant transition VLM) ── */}
          {mainTab === "actions" && isVLI && !vliUnlocked && (() => {
            const adrAlarmActive = adrTimerStart > 0 && started && !events.find(e => e.id === "rosc")
              && ((Date.now() - adrTimerStart) / 1000 >= adrIntervalGlobal * 60);
            const lastRhythm = [...events].reverse().find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:9, marginBottom:10 }}>
                {/* ── Récidive d'arrêt + RACS Surveillance — en tête dès que RACS est obtenu ── */}
                {events.some(e => e.id === "rosc") && (
                  <>
                    <button onClick={() => {
                      const roscTime = events.find(e => e.id === "rosc")?.time || "?";
                      addEvent("re_arret", `↩ Récidive d'arrêt — RACS précédent à ${roscTime}`, "🔴");
                      setEvents(prev => prev.filter(e => e.id !== "rosc"));
                      setAdrTimerStart(Date.now());
                      setCycleOffset(sec);
                      prevCpRef.current = null;
                      setRunning(true);
                    }}
                      style={{ width:"100%", background:`linear-gradient(135deg, ${P.rose}, #9B1010)`,
                        border:"none", borderRadius:13, color:"#fff", padding:"12px 14px",
                        cursor:"pointer", fontFamily:sans, display:"flex", alignItems:"center", gap:10,
                        boxShadow:`0 6px 18px color-mix(in srgb, ${P.rose} 35%, transparent)` }}>
                      <span style={{ fontSize:20, flexShrink:0 }}>🔴</span>
                      <div style={{ textAlign:"left", flex:1, minWidth:0 }}>
                        <p style={{ margin:0, fontSize:13, fontWeight:800 }}>Récidive d'arrêt</p>
                        <p style={{ margin:0, fontSize:10.5, opacity:0.85 }}>Reprendre la réanimation</p>
                      </div>
                      <span style={{ fontSize:15, flexShrink:0 }}>↩</span>
                    </button>

                    <button onClick={() => setModalRacs(true)}
                      style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
                        background:`color-mix(in srgb, ${P.green} 12%, ${P.surface})`,
                        border:`1.5px solid ${P.green}`, borderRadius:13, padding:"12px 14px",
                        cursor:"pointer", fontFamily:sans, textAlign:"left",
                        boxShadow:`0 2px 8px color-mix(in srgb, ${P.green} 18%, transparent)` }}>
                      <span style={{ width:36, height:36, borderRadius:10,
                        background:`color-mix(in srgb, ${P.green} 20%, transparent)`,
                        display:"flex", alignItems:"center", justifyContent:"center", fontSize:19, flexShrink:0 }}>🫀</span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ margin:0, fontSize:13.5, fontWeight:800, color:P.greenText, fontFamily:disp }}>
                          RACS — Surveillance
                        </p>
                        <p style={{ margin:0, fontSize:10.5, color:P.greenText, opacity:0.85 }}>
                          Constantes à renseigner en attendant le VLM
                        </p>
                      </div>
                      <span style={{ fontSize:16, color:P.greenText, flexShrink:0 }}>›</span>
                    </button>
                  </>
                )}

                {/* Examen pupillaire initial — disparaît une fois répondu */}
                {!events.some(e => e.id === "pupilles_initial") && (
                  <div style={{ background:"rgba(234,106,18,0.1)", border:"1.5px solid #EA6A12", borderRadius:13, padding:"11px 13px" }}>
                    <p style={{ margin:0, fontSize:12, fontWeight:800, color:"#B24E0A", fontFamily:disp }}>
                      🔍 Examen pupillaire initial
                    </p>
                    <p style={{ margin:"1px 0 8px", fontSize:9.5, color:"#B24E0A", opacity:0.75, fontStyle:"italic" }}>
                      à réaliser avant la 1ère injection d'adrénaline
                    </p>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                      {["Normales","Anormales","Non fait"].map(v => (
                        <button key={v} onClick={() => {
                            if (v === "Anormales") { setPupillesInitExpanded(x => !x); return; }
                            addEvent("pupilles_initial", `Examen pupillaire initial : ${v}`, "🔍");
                          }}
                          style={{ padding:"9px 4px", borderRadius:9, fontSize:11, fontWeight:700,
                            border:"1.5px solid #EA6A12",
                            background: v==="Anormales" && pupillesInitExpanded ? "#EA6A12" : P.surface,
                            color: v==="Anormales" && pupillesInitExpanded ? "#fff" : "#B24E0A",
                            cursor:"pointer", fontFamily:sans }}>
                          {v}
                        </button>
                      ))}
                    </div>
                    {pupillesInitExpanded && (
                      <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                        {PUPILLES_DETAIL.map(({v,left,right}) => (
                          <button key={v} onClick={() => {
                              addEvent("pupilles_initial", `Examen pupillaire initial : Anormales — ${v}`, "🔍");
                              setPupillesInitExpanded(false);
                            }}
                            style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                              borderRadius:9, border:"1.5px solid #C5CFDD", background:P.surface,
                              fontSize:11.5, fontWeight:600, color:P.text, cursor:"pointer",
                              fontFamily:sans, textAlign:"left" }}>
                            <PupilIcon left={left} right={right} />{v}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
                  <ActionBtn action={{ label:"Adrénaline", dose:"1 mg IV/IO", vital:true, svg:ICONS.adr, accent:P.rose, soft:P.roseSoft, textC:P.roseText,
                      hapticType:"long", badge: adrAlarmActive ? { text:"!", color:P.rose, pulse:true } : null }}
                    onClick={() => { addEvent("adr","Adrénaline 1 mg IV/IO","💉"); setAdrTimerStart(Date.now()); }} />
                  <ActionBtn action={{ label:"Défibrillation", dose:"selon DSA", vital:true, svg:ICONS.choc, accent:P.blue, soft:P.blueSoft, textC:P.blueText,
                      hapticType:"double", badge: lastRhythm?.id === "rv_fvtv" ? { text:"FV", color:P.blue, pulse:false } : null }}
                    onClick={() => setModalChoc(true)} />
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
                  <ActionBtn action={{ label:"Analyse de rythme", svg:ICONS.rythme, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                    onClick={() => setModalRythme(true)} />
                  <ActionBtn action={{ label:"Voie d'abord", svg:ICONS.vvp, accent:P.green, soft:P.greenSoft, textC:P.greenText }}
                    onClick={() => setModalVvp(true)} />
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
                  <ActionBtn action={{ label:"Cordarone", svg:ICONS.amio, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                    onClick={() => setModalCord(true)} />
                  <ActionBtn action={{ label:"Sécurisation VAS", svg:ICONS.iot, accent:"#EA6A12", soft:"rgba(234,106,18,0.12)", textC:"#B24E0A",
                      badge: (events.some(e => e.id === "iot") || events.some(e => e.id === "vas_supraglottique")) ? { text:"✓", color:P.green, pulse:false } : null }}
                    onClick={() => setModalVasVLI(true)} />
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:9 }}>
                  <ActionBtn action={{ label:"Planche à masser", svg:ICONS.planche, accent:P.teal, soft:P.tealSoft, textC:P.tealText }}
                    onClick={() => addEvent("planche","Planche à masser mise en place","🦺")} />
                </div>

                {/* La carte EtCO₂ n'est plus dupliquée ici — celle affichée en haut de l'écran,
                    juste après Patient/Transmission/Régulation, est commune à tous les modes
                    (y compris VLI) et suffit déjà. */}

                {/* Carte Hémodynamique post-RACS — surveillance seule, pas de bouton Amine */}
                {events.find(e => e.id === "rosc") && (
                  <div style={{ background:P.surface, border:`1px solid ${P.green}`, borderRadius:13,
                    padding:"9px 12px", boxShadow:`0 2px 8px color-mix(in srgb, ${P.green} 14%, transparent)` }}>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: hemoOpen ? 6 : 0 }}>
                      <button onClick={() => setHemoOpen(v => !v)}
                        style={{ display:"flex", alignItems:"center", gap:7, background:"transparent", border:"none",
                          cursor:"pointer", padding:0, flex:1, minWidth:0, textAlign:"left" }}>
                        <span style={{ width:24, height:24, borderRadius:8, background:P.greenSoft,
                          display:"flex", alignItems:"center", justifyContent:"center", fontSize:13 }}>💓</span>
                        <p style={{ margin:0, fontSize:11.5, fontWeight:800, color:P.text, fontFamily:disp }}>Hémodynamique <span style={{ fontSize:8, fontWeight:600, color:P.textSoft, fontFamily:mono }}>post-RACS</span></p>
                        <span style={{ fontSize:10, color:P.textSoft, marginLeft:4 }}>{hemoOpen ? "▾" : "▸"}</span>
                      </button>
                      <button onClick={() => { setHemoForm({ pas:"", pad:"", fc:"" }); setModalHemo(true); }}
                        style={{ background:`color-mix(in srgb, ${P.green} 14%, transparent)`, color:P.greenText,
                          border:`1px solid ${P.green}`, borderRadius:9, padding:"5px 9px", fontSize:10.5,
                          fontWeight:700, cursor:"pointer", fontFamily:sans, whiteSpace:"nowrap" }}>+ Mesure</button>
                    </div>
                    {hemoOpen && hemoList.length > 0 && (
                      <div style={{ display:"flex", gap:12, marginBottom:5 }}>
                        {[{c:P.rose,l:"PAS"},{c:P.blue,l:"PAD"},{c:P.amber,l:"PAM",dash:true},{c:P.violet,l:"FC",dot:true}].map(({c,l,dash,dot})=>(
                          <div key={l} style={{ display:"flex", alignItems:"center", gap:3 }}>
                            <svg width="18" height="8" viewBox="0 0 18 8">
                              <line x1="0" y1="4" x2="18" y2="4" stroke={c} strokeWidth="2"
                                strokeDasharray={dash?"5 3":dot?"2 3":undefined} />
                            </svg>
                            <span style={{ fontSize:9, fontWeight:700, color:c, fontFamily:mono }}>{l}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {hemoOpen && <HemoCurve hemoList={hemoList} amineList={amineList} P={P} mono={mono} refSec={events.find(e=>e.id==="rosc")?.sec||0} />}
                  </div>
                )}

                {/* Le bouton "RACS — Surveillance" est désormais en tête de grille — voir plus haut. */}
              </div>
            );
          })()}

          {/* ── Contenu Actions (grille complète — médicalisé, tous modules sauf VLI restreint) ── */}
          {mainTab === "actions" && !(isVLI && !vliUnlocked) && (
          <div style={{ display:"flex", flexDirection:"column", gap:9, marginBottom:10 }}>

            {/* ── Récidive d'arrêt + Soins post-RACS — en tête dès que RACS est obtenu ── */}
            {events.some(e => e.id === "rosc") && (
              <>
                <button onClick={() => {
                  const roscTime = events.find(e => e.id === "rosc")?.time || "?";
                  addEvent("re_arret", `↩ Récidive d'arrêt — RACS précédent à ${roscTime}`, "🔴");
                  setEvents(prev => prev.filter(e => e.id !== "rosc"));
                  setAdrTimerStart(Date.now());
                  setCycleOffset(sec);
                  prevCpRef.current = null;
                  setRunning(true);
                }}
                  style={{ width:"100%", background:`linear-gradient(135deg, ${P.rose}, #9B1010)`,
                    border:"none", borderRadius:13, color:"#fff", padding:"12px 14px",
                    cursor:"pointer", fontFamily:sans, display:"flex", alignItems:"center", gap:10,
                    boxShadow:`0 6px 18px color-mix(in srgb, ${P.rose} 35%, transparent)` }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>🔴</span>
                  <div style={{ textAlign:"left", flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:13, fontWeight:800 }}>Récidive d'arrêt</p>
                    <p style={{ margin:0, fontSize:10.5, opacity:0.85 }}>Reprendre la réanimation</p>
                  </div>
                  <span style={{ fontSize:15, flexShrink:0 }}>↩</span>
                </button>

                <button onClick={() => setModalRacs(true)}
                  style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
                    background:`color-mix(in srgb, ${P.green} 12%, ${P.surface})`,
                    border:`1.5px solid ${P.green}`, borderRadius:13, padding:"12px 14px",
                    cursor:"pointer", fontFamily:sans, textAlign:"left",
                    boxShadow:`0 2px 8px color-mix(in srgb, ${P.green} 18%, transparent)` }}>
                  <span style={{ width:36, height:36, borderRadius:10,
                    background:`color-mix(in srgb, ${P.green} 20%, transparent)`,
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:19, flexShrink:0 }}>🫀</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:13.5, fontWeight:800, color:P.greenText, fontFamily:disp }}>
                      Soins post-RACS
                    </p>
                    <p style={{ margin:0, fontSize:10.5, color:P.greenText, opacity:0.85 }}>
                      RACS obtenu — renseigner constantes, amines, température
                    </p>
                  </div>
                  <span style={{ fontSize:16, color:P.greenText, flexShrink:0 }}>›</span>
                </button>
              </>
            )}

            {/* ── Examen pupillaire initial — disparaît une fois répondu ── */}
            {!events.some(e => e.id === "pupilles_initial") && (
              <div style={{ background:P.violetSoft, border:`1.5px solid ${P.violet}`, borderRadius:13, padding:"11px 13px" }}>
                <p style={{ margin:0, fontSize:12, fontWeight:800, color:P.violetText, fontFamily:disp }}>
                  🔍 Examen pupillaire initial
                </p>
                <p style={{ margin:"1px 0 8px", fontSize:9.5, color:P.violetText, opacity:0.75, fontStyle:"italic" }}>
                  à réaliser avant la 1ère injection d'adrénaline
                </p>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                  {["Normales","Anormales","Non fait"].map(v => (
                    <button key={v} onClick={() => {
                        if (v === "Anormales") { setPupillesInitExpanded(x => !x); return; }
                        addEvent("pupilles_initial", `Examen pupillaire initial : ${v}`, "🔍");
                      }}
                      style={{ padding:"9px 4px", borderRadius:9, fontSize:11, fontWeight:700,
                        border:`1.5px solid ${P.violet}`,
                        background: v==="Anormales" && pupillesInitExpanded ? P.violet : P.surface,
                        color: v==="Anormales" && pupillesInitExpanded ? "#fff" : P.violetText,
                        cursor:"pointer", fontFamily:sans }}>
                      {v}
                    </button>
                  ))}
                </div>
                {pupillesInitExpanded && (
                  <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:5 }}>
                    {PUPILLES_DETAIL.map(({v,left,right}) => (
                      <button key={v} onClick={() => {
                          addEvent("pupilles_initial", `Examen pupillaire initial : Anormales — ${v}`, "🔍");
                          setPupillesInitExpanded(false);
                        }}
                        style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 11px",
                          borderRadius:9, border:`1.5px solid ${P.border}`, background:P.surface,
                          fontSize:11.5, fontWeight:600, color:P.text, cursor:"pointer",
                          fontFamily:sans, textAlign:"left" }}>
                        <PupilIcon left={left} right={right} />{v}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Carte HOTT persistante (trauma uniquement) — remplace l'ancien onglet Étiologie ── */}
            {isTrauma && (() => {
              const HOTT_STEPS = {
                hypovolemie: { sub:"Contrôle hémorragie", action: () => setModalHemoExt(true) },
                hypoxie:     { sub:"Intubation",           action: () => setModalIot(true) },
                pno:         { sub:"Thoracostomie",        action: () => setModalThoraco("d") },
                tamponnade:  { sub:"Fast-écho",            action: () => setModalFastTrauma(true) },
              };
              const doneIds = CAUSES_HOTT.filter(c => suspectedAd.includes(c.id));
              const allDone = doneIds.length === CAUSES_HOTT.length;
              const collapsed = allDone && !hottManualExpand;
              const markDone = (c) => {
                if (!suspectedAd.includes(c.id)) {
                  setSuspectedAd(prev => [...prev, c.id]);
                  addEvent("etio", `Cause recherchée : ${c.label}`, "🔍");
                }
                HOTT_STEPS[c.id].action();
              };

              if (collapsed) return (
                <button onClick={() => setHottManualExpand(true)}
                  style={{ width:"100%", display:"flex", alignItems:"center", gap:9,
                    background:P.greenSoft, border:`1px solid ${P.green}`, borderRadius:12,
                    padding:"10px 13px", cursor:"pointer", fontFamily:sans, textAlign:"left" }}>
                  <span style={{ width:26, height:26, borderRadius:"50%", background:P.green,
                    display:"flex", alignItems:"center", justifyContent:"center", color:"#fff",
                    fontSize:14, fontWeight:900, flexShrink:0 }}>✓</span>
                  <span style={{ flex:1, fontSize:12.5, fontWeight:700, color:P.greenText }}>
                    {CAUSES_HOTT.length}/{CAUSES_HOTT.length} causes HOTT recherchées
                  </span>
                  <span style={{ fontSize:14, color:P.greenText }}>›</span>
                </button>
              );

              const cardColor = allDone ? P.green : doneIds.length > 0 ? P.amber : P.rose;
              const cardSoft  = allDone ? P.greenSoft : doneIds.length > 0 ? P.amberSoft : P.roseSoft;
              const cardText  = allDone ? P.greenText : doneIds.length > 0 ? P.amberText : P.roseText;
              return (
                <div style={{ background:cardSoft, border:`1.5px solid ${cardColor}`, borderRadius:14,
                  padding:"13px 14px", boxShadow:`0 3px 12px color-mix(in srgb, ${cardColor} 15%, transparent)` }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                    <span style={{ fontSize:16 }}>🔍</span>
                    <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:cardText, fontFamily:disp, flex:1 }}>
                      Causes HOTT à rechercher
                    </p>
                    <span style={{ background:cardColor, color:"#fff", fontSize:11, fontWeight:800,
                      padding:"2px 8px", borderRadius:8, fontFamily:mono }}>
                      {doneIds.length}/{CAUSES_HOTT.length}
                    </span>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                    {CAUSES_HOTT.map(c => {
                      const done = suspectedAd.includes(c.id);
                      const doneEvt = done ? [...events].reverse().find(e => e.id === "etio" && e.label.includes(c.label)) : null;
                      return done ? (
                        <div key={c.id} style={{ display:"flex", alignItems:"center", gap:9,
                          background:P.greenSoft, borderRadius:10, padding:"9px 10px", opacity:0.8 }}>
                          <span style={{ width:22, height:22, borderRadius:"50%", background:P.green,
                            display:"flex", alignItems:"center", justifyContent:"center", color:"#fff",
                            fontSize:13, fontWeight:900, flexShrink:0 }}>✓</span>
                          <span style={{ fontSize:16, flexShrink:0 }}>{c.icon}</span>
                          <span style={{ flex:1, fontSize:12.5, fontWeight:700, color:P.greenText,
                            textDecoration:"line-through" }}>{c.label}</span>
                          {doneEvt && <span style={{ fontSize:9.5, color:P.greenText, flexShrink:0 }}>{doneEvt.time}</span>}
                        </div>
                      ) : (
                        <button key={c.id} onClick={() => markDone(c)}
                          style={{ display:"flex", alignItems:"center", gap:9, background:P.surface,
                            border:"none", borderRadius:10, padding:"9px 10px", cursor:"pointer",
                            textAlign:"left", fontFamily:sans }}>
                          <span style={{ width:22, height:22, borderRadius:"50%", border:`2px solid ${cardColor}`,
                            flexShrink:0 }} />
                          <span style={{ fontSize:16, flexShrink:0 }}>{c.icon}</span>
                          <span style={{ flex:1, fontSize:12.5, fontWeight:700, color:P.text }}>{c.label}</span>
                          <span style={{ fontSize:10.5, color:cardText, fontWeight:700, flexShrink:0, whiteSpace:"nowrap" }}>
                            {HOTT_STEPS[c.id].sub} ›
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Gestes rythmés — vitaux */}
            {(() => {
              const adrAlarmActive = adrTimerStart > 0 && started && !events.find(e => e.id === "rosc")
                && ((Date.now() - adrTimerStart) / 1000 >= adrIntervalGlobal * 60);
              const lastRhythm = [...events].reverse().find(e => ["rv_fvtv","rv_aesp","rv_asy"].includes(e.id));
              const iotDone = events.some(e => e.id === "iot");
              return (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <ActionBtn action={{ label:"Adrénaline", dose:"1 mg IV/IO", vital:true, svg:ICONS.adr, accent:P.rose, soft:P.roseSoft, textC:P.roseText,
                  hapticType:"long", badge: adrAlarmActive ? { text:"!", color:P.rose, pulse:true } : null }}
                onClick={() => { addEvent("adr","Adrénaline 1 mg IV/IO","💉"); setAdrTimerStart(Date.now()); }} />
              <ActionBtn action={{ label:"Défibrillation", dose:"4 J/kg", vital:true, svg:ICONS.choc, accent:P.blue, soft:P.blueSoft, textC:P.blueText,
                  hapticType:"double", badge: lastRhythm?.id === "rv_fvtv" ? { text:"FV", color:P.blue, pulse:false } : null }}
                onClick={() => setModalChoc(true)} />
            </div>
              );
            })()}
            {/* Voies & gestes */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <ActionBtn action={{ label:"Analyse de rythme", svg:ICONS.rythme, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                onClick={() => setModalRythme(true)} />
              <ActionBtn action={{ label:"Voie d'abord", svg:ICONS.vvp, accent:P.green, soft:P.greenSoft, textC:P.greenText }}
                onClick={() => setModalVvp(true)} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              {isTrauma ? (
                <ActionBtn action={{ label:"Fast-écho", svg:ICONS.fast, accent:P.blue, soft:P.blueSoft, textC:P.blueText }}
                  onClick={() => setModalFastTrauma(true)} />
              ) : (
                <ActionBtn action={{ label:"Cordarone", svg:ICONS.amio, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                  onClick={() => setModalCord(true)} />
              )}
              <ActionBtn action={{ label:"Intubation", svg:ICONS.iot, accent:P.violet, soft:P.violetSoft, textC:P.violetText,
                  badge: events.some(e => e.id === "iot") ? { text:"✓", color:P.green, pulse:false } : null }}
                onClick={() => setModalIot(true)} />
            </div>

            {/* Le bouton "Soins post-RACS" est désormais en tête de grille — voir plus haut. */}

            {/* ── Bouton + : révèle les actions secondaires ── */}
            <button onClick={() => setShowMoreActions(v => !v)}
              style={{ background:"transparent", border:`1.5px dashed ${P.border}`,
                borderRadius:13, padding:"10px", cursor:"pointer", fontFamily:sans,
                display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                color:P.textMid, fontSize:12.5, fontWeight:700 }}>
              <span style={{ fontSize:15 }}>{showMoreActions ? "−" : "+"}</span>
              {showMoreActions ? "Moins d'actions" : "Plus d'actions"}
            </button>

            {showMoreActions && (<>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <ActionBtn action={{ label:"Planche à masser", svg:ICONS.planche, accent:P.teal, soft:P.tealSoft, textC:P.tealText }}
                onClick={() => addEvent("planche","Planche à masser mise en place","🦺")} />
              {isTrauma ? (
                <ActionBtn action={{ label:"Cordarone", svg:ICONS.amio, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                  onClick={() => setModalCord(true)} />
              ) : (
                <ActionBtn action={{ label:"Fast-écho", svg:ICONS.fast, accent:P.blue, soft:P.blueSoft, textC:P.blueText }}
                  onClick={() => setModalFast(true)} />
              )}
            </div>
            <div style={{ display:"grid", gridTemplateColumns: events.some(e => e.id === "rosc") ? "1fr" : "1fr 1fr", gap:9 }}>
              {!events.some(e => e.id === "rosc") && (
                <ActionBtn action={{ label:"Soins post-RACS", icon:"🫀", accent:P.green, soft:P.greenSoft, textC:P.greenText }}
                  onClick={() => setModalRacs(true)} />
              )}
              <ActionBtn action={{ label:"Constat de décès", svg:ICONS.deces, accent:P.slate, soft:P.slateSoft, textC:P.slateText }}
                onClick={() => setModalDeces(true)} />
            </div>
            </>)}
          </div>
          )}

          {/* ── Contenu "Situations particulières" — VLI restreint ── */}
          {mainTab === "vli_sit" && isVLI && !vliUnlocked && (() => {
            const hemorragieCount = events.filter(e => e.id === "vli_hemorragie").length;
            const cyanokitCount = events.filter(e => e.id === "vli_cyanokit").length;
            const hypothermieDone = events.some(e => e.id === "vli_hypothermie");
            const vasDone = events.some(e => e.id === "vli_vas");
            const enceinteDone = events.some(e => e.id === "vli_enceinte");
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:9, marginBottom:10 }}>

                {/* Hémorragie — Isofundine 500mL/10min, jusqu'à 2 VVP */}
                <div style={{ background: hemorragieCount>0 ? P.roseSoft : P.surface,
                  border:`1.5px solid ${P.rose}`, borderRadius:13, padding:"12px 14px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: hemorragieCount>0 ? 8 : 0 }}>
                    <span style={{ fontSize:20, flexShrink:0 }}>🩸</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:P.roseText }}>Hémorragie</p>
                      <p style={{ margin:0, fontSize:10, color:P.roseText, opacity:0.85 }}>
                        Arrêt du saignement + Isofundine 500 mL sur 10 min
                      </p>
                    </div>
                  </div>
                  {hemorragieCount === 0 && (
                    <button onClick={() => addEvent("vli_hemorragie", "Hémorragie — Isofundine 500 mL sur 10 min (1ère VVP)", "🩸")}
                      style={{ width:"100%", marginTop:8, background:P.rose, border:"none", borderRadius:10,
                        color:"#fff", padding:"10px", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                      Démarrer Isofundine 500 mL / 10 min
                    </button>
                  )}
                  {hemorragieCount === 1 && (
                    <button onClick={() => addEvent("vli_hemorragie", "2ème VVP + Isofundine 500 mL sur 10 min", "🩸")}
                      style={{ width:"100%", marginTop:8, background:P.surface, border:`1.5px solid ${P.rose}`, borderRadius:10,
                        color:P.roseText, padding:"10px", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                      + 2ème VVP + Isofundine 500 mL / 10 min
                    </button>
                  )}
                  {hemorragieCount >= 2 && (
                    <p style={{ margin:"8px 0 0", fontSize:11, color:P.roseText, fontWeight:700 }}>
                      ✓ {hemorragieCount} × 500 mL Isofundine — {hemorragieCount * 500} mL au total
                    </p>
                  )}
                </div>

                {/* Ventilation — Obstruction VAS */}
                <button onClick={() => { if (!vasDone) addEvent("vli_vas", "Désobstruction VAS — Exposition douce au laryngoscope + Pince Magill", "🫁"); }}
                  style={{ display:"flex", alignItems:"center", gap:10, background: vasDone ? P.greenSoft : P.surface,
                    border:`1.5px solid ${vasDone ? P.green : P.border}`, borderRadius:13, padding:"12px 14px",
                    cursor: vasDone ? "default" : "pointer", textAlign:"left", fontFamily:sans }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>{vasDone ? "✅" : "🫁"}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:12.5, fontWeight:800, color: vasDone ? P.greenText : P.text }}>Obstruction VAS</p>
                    <p style={{ margin:0, fontSize:10, color: vasDone ? P.greenText : P.textSoft }}>
                      Exposition douce au laryngoscope + Pince Magill
                    </p>
                  </div>
                  {!vasDone && <span style={{ fontSize:14, color:P.textSoft }}>›</span>}
                </button>

                {/* Intoxication aux fumées — Cyanokit */}
                <div style={{ background: cyanokitCount>0 ? "rgba(84,101,124,0.08)" : P.surface,
                  border:`1.5px solid ${P.slateText}`, borderRadius:13, padding:"12px 14px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: 8 }}>
                    <span style={{ fontSize:20, flexShrink:0 }}>💨</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:P.text }}>Intoxication aux fumées</p>
                      <p style={{ margin:0, fontSize:10, color:P.textSoft }}>
                        Hydroxocobalamine (Cyanokit) 5 g/15 min · dilution 5g/200mL = 25 mg/mL IVL · voie dédiée
                      </p>
                    </div>
                  </div>
                  {cyanokitCount === 0 && (
                    <button onClick={() => addEvent("vli_cyanokit", "Cyanokit 5 g sur 15 min (voie dédiée) — 1ère dose", "💨")}
                      style={{ width:"100%", background:P.slateText, border:"none", borderRadius:10,
                        color:"#fff", padding:"10px", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                      Démarrer Cyanokit 5 g / 15 min
                    </button>
                  )}
                  {cyanokitCount === 1 && (
                    <button onClick={() => addEvent("vli_cyanokit", "Cyanokit 5 g sur 15 min — 2ème dose (renouvelée 1 fois)", "💨")}
                      style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.slateText}`, borderRadius:10,
                        color:P.slateText, padding:"10px", fontSize:12.5, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                      + Renouveler Cyanokit 5 g / 15 min
                    </button>
                  )}
                  {cyanokitCount >= 2 && (
                    <p style={{ margin:0, fontSize:11, color:P.slateText, fontWeight:700 }}>
                      ✓ 2 doses administrées — dose maximale du protocole atteinte
                    </p>
                  )}
                </div>

                {/* Hypothermie */}
                <button onClick={() => { if (!hypothermieDone) addEvent("vli_hypothermie", "ACR et hypothermie — pas d'adrénaline ni de cordarone si T<30°C, 3 CEE max, réchauffement +++", "🥶"); }}
                  style={{ display:"flex", alignItems:"center", gap:10, background: hypothermieDone ? P.blueSoft : P.surface,
                    border:`1.5px solid ${hypothermieDone ? P.blue : P.border}`, borderRadius:13, padding:"12px 14px",
                    cursor: hypothermieDone ? "default" : "pointer", textAlign:"left", fontFamily:sans }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>🥶</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:12.5, fontWeight:800, color: hypothermieDone ? P.blueText : P.text }}>Hypothermie</p>
                    <p style={{ margin:0, fontSize:10, color: hypothermieDone ? P.blueText : P.textSoft }}>
                      ⚠️ Pas d'adrénaline ni de cordarone si T&lt;30°C · 3 CEE max · réchauffer +++
                    </p>
                  </div>
                  {!hypothermieDone && <span style={{ fontSize:14, color:P.textSoft }}>›</span>}
                </button>

                {/* Femme enceinte */}
                <button onClick={() => { if (!enceinteDone) addEvent("vli_enceinte", "ACR chez femme enceinte — décubitus dorsal, inclinaison utérine gauche continue (libérer veine cave inf.)", "🤰"); }}
                  style={{ display:"flex", alignItems:"center", gap:10, background: enceinteDone ? P.violetSoft : P.surface,
                    border:`1.5px solid ${enceinteDone ? P.violet : P.border}`, borderRadius:13, padding:"12px 14px",
                    cursor: enceinteDone ? "default" : "pointer", textAlign:"left", fontFamily:sans }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>🤰</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:12.5, fontWeight:800, color: enceinteDone ? P.violetText : P.text }}>Femme enceinte</p>
                    <p style={{ margin:0, fontSize:10, color: enceinteDone ? P.violetText : P.textSoft }}>
                      Inclinaison utérine gauche continue — objectif : libérer la veine cave inf.
                    </p>
                  </div>
                  {!enceinteDone && <span style={{ fontSize:14, color:P.textSoft }}>›</span>}
                </button>

              </div>
            );
          })()}

          {/* ── Contenu Étiologie ── */}
          {mainTab === "etio" && (
            <>
              <EtiologieTab title="5H — Causes métaboliques" causes={CAUSES_5H}
                suspected={suspectedAd}
                onToggle={(id, label) => {
                  if (suspectedAd.includes(id)) {
                    setSuspectedAd(suspectedAd.filter(x => x !== id));
                  } else {
                    setSuspectedAd([...suspectedAd, id]);
                    addEvent("etio", `Étiologie suspectée : ${label}`, "🔍");
                  }
                }}
                P={P} mono={mono} sans={sans} />
              <EtiologieTab title="5T — Causes mécaniques" causes={CAUSES_5T}
                suspected={suspectedAd}
                onToggle={(id, label) => {
                  if (suspectedAd.includes(id)) {
                    setSuspectedAd(suspectedAd.filter(x => x !== id));
                  } else {
                    setSuspectedAd([...suspectedAd, id]);
                    addEvent("etio", `Étiologie suspectée : ${label}`, "🔍");
                  }
                }}
                P={P} mono={mono} sans={sans} />
            </>
          )}

          {/* ── Contenu Thérapeutiques spécifiques ── */}
          {mainTab === "ther" && (
            <TherapeutiquesTab list={isTrauma ? THERAPEUTIQUES_TRAUMA : THERAPEUTIQUES_ADULTE} addEvent={addEvent}
              localMat={null} onOpenEcmo={() => setModalEcmo(true)} onOpenDdac={() => setModalDdac(true)}
              onOpenModal={(id) => {
                if (id === "fast_trauma") setModalFastTrauma(true);
                else if (id === "thoraco_d") setModalThoraco("d");
                else if (id === "thoraco_g") setModalThoraco("g");
                else if (id === "hemocue") setModalHemocue(true);
                else if (id === "transfusion") setModalTransfu(true);
                else if (id === "exacyl") setModalExacyl(true);
                else if (id === "hemo_ext") setModalHemoExt(true);
                else if (id === "octaplas") {
                  const lastHemo = hemoList.length > 0 ? hemoList[hemoList.length - 1] : null;
                  const ageNum = pat?.age ? String(pat.age).match(/\d+/)?.[0] || "" : "";
                  const mec = MECANISMES_TRAUMA.find(m => m.id === pat?.mecanisme);
                  // Priorité aux valeurs en cours de saisie sur l'écran post-RACS (plus récentes
                  // que la dernière entrée enregistrée dans l'historique hémodynamique)
                  setBattForm({
                    age: ageNum,
                    pas: racs.tas || lastHemo?.pas || "",
                    glasgow: "",
                    fr: racs.fr || "",
                    spo2: racs.sat || "",
                    fc: racs.fc || lastHemo?.fc || "",
                    penetrant: mec?.penetrant || false, hcin: mec?.hcin || false,
                  });
                  setModalOctaplas(true);
                }
              }}
              P={P} mono={mono} sans={sans} />
          )}

        {/* Bandeau Note libre — adulte */}
        <div style={{ marginBottom:10 }}>
          {!showNote ? (
            <button onClick={() => setShowNote(true)}
              style={{ width:"100%", background:P.tealSoft, border:`1.5px solid #B2DADA`,
                borderRadius:12, padding:"10px 14px", cursor:"pointer", fontFamily:sans,
                display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:22, height:22, color:P.teal, flexShrink:0 }}>{ICONS.note}</div>
              <span style={{ fontSize:12, fontWeight:500, color:P.tealText }}>Ajouter une note libre</span>
              <span style={{ marginLeft:"auto", fontSize:16, color:P.teal, lineHeight:1 }}>+</span>
            </button>
          ) : (
            <div style={{ background:P.tealSoft, border:`1.5px solid #B2DADA`, borderRadius:12, padding:"12px 14px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <div style={{ width:20, height:20, color:P.teal, flexShrink:0 }}>{ICONS.note}</div>
                <p style={{ margin:0, fontSize:12, fontWeight:600, color:P.tealText }}>Note libre</p>
                <button onClick={() => { setShowNote(false); setNoteText(""); }}
                  style={{ marginLeft:"auto", background:"transparent", border:"none",
                    color:P.teal, fontSize:18, cursor:"pointer", lineHeight:1 }}>×</button>
              </div>
              <textarea value={noteText} onChange={e => setNoteText(e.target.value)}
                placeholder="Ex : famille contactée, antécédents connus, circonstances..."
                rows={3}
                style={{ width:"100%", background:"rgba(255,255,255,0.7)",
                  border:`1.5px solid #B2DADA`, borderRadius:8, padding:"10px 12px",
                  fontSize:13, color:P.text, fontFamily:sans, outline:"none",
                  resize:"none", boxSizing:"border-box", lineHeight:1.6, marginBottom:8 }}
                onFocus={e => e.target.style.borderColor = P.teal}
                onBlur={e  => e.target.style.borderColor = "#B2DADA"} />
              <button onClick={() => {
                if (noteText.trim()) addEvent("note", noteText.trim(), "📝");
                setNoteText(""); setShowNote(false);
              }} style={{ width:"100%", background:`linear-gradient(135deg,${P.teal},#1A6A6A)`,
                border:"none", borderRadius:9, color:"#fff", fontSize:13, fontWeight:600,
                padding:"10px", cursor:"pointer", fontFamily:sans }}>
                ✓ Ajouter à la chronologie
              </button>
            </div>
          )}
        </div>

          {/* ── Métronome : bouton sourdine si activé ── */}
          {metronomeEnabled && started && !events.find(e=>e.id==="rosc") && (
            <button onClick={() => setMetronomeMuted(v => !v)}
              style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
                background: metronomeMuted ? P.surfaceAlt : `color-mix(in srgb, ${P.blue} 10%, ${P.surface})`,
                border:`1px solid ${metronomeMuted ? P.border : P.blue}`,
                borderRadius:11, padding:"8px 14px", cursor:"pointer", fontFamily:sans,
                marginBottom:8, textAlign:"left" }}>
              <span style={{ fontSize:18, flexShrink:0 }}>{metronomeMuted ? "🔇" : "🎵"}</span>
              <p style={{ margin:0, fontSize:12, fontWeight:700, flex:1,
                color: metronomeMuted ? P.textMid : P.blueText }}>
                Métronome 100/min — {metronomeMuted ? "Sourdine" : "Actif"}
              </p>
              <span style={{ fontSize:11, fontWeight:600, flexShrink:0,
                color: metronomeMuted ? P.textSoft : P.blueText }}>
                {metronomeMuted ? "Réactiver ▶" : "Sourdine 🔇"}
              </span>
            </button>
          )}

        {/* ── Critères d'arrêt de réanimation (>20 min, sans RACS) ── */}
        {started && sec >= 1200 && !events.find(e => e.id === "rosc") && !events.find(e => e.id === "deces") && (
          <button onClick={() => setModalCriteres(true)}
            style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
              background:`color-mix(in srgb, ${P.amber} 12%, ${P.surface})`,
              border:`1.5px solid ${P.amber}`, borderRadius:13, padding:"11px 14px",
              cursor:"pointer", fontFamily:sans, marginBottom:10, textAlign:"left",
              boxShadow:`0 2px 8px color-mix(in srgb, ${P.amber} 15%, transparent)` }}>
            <span style={{ width:32, height:32, borderRadius:10,
              background:`color-mix(in srgb, ${P.amber} 20%, transparent)`,
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>⏱</span>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ margin:0, fontSize:12.5, fontWeight:800, color:P.amberText, fontFamily:disp }}>
                Critères d'arrêt à évaluer
              </p>
              <p style={{ margin:0, fontSize:10.5, color:P.amberText, opacity:0.8 }}>
                Réanimation en cours depuis {Math.floor(sec/60)} min · ouvrir la check-list
              </p>
            </div>
            <span style={{ fontSize:16, color:P.amberText, flexShrink:0 }}>›</span>
          </button>
        )}

        </>}

        {/* Chronologie */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14,
          overflow:"hidden", marginBottom:10, boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
          <div style={{ display:"flex", alignItems:"center", padding:"0 8px 0 0" }}>
            <button onClick={() => setShowLog(v => !v)}
              style={{ flex:1, background:"transparent", border:"none", padding:"12px 16px",
                display:"flex", justifyContent:"space-between", alignItems:"center",
                cursor:"pointer", fontFamily:sans }}>
              <span style={{ fontSize:13, fontWeight:500, color:P.textMid }}>Chronologie</span>
              <span style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ background:P.blueSoft, color:P.blueText, borderRadius:20,
                  padding:"1px 8px", fontSize:10, fontFamily:mono }}>{events.length}</span>
                <span style={{ color:P.textSoft, fontSize:11 }}>{showLog ? "▲" : "▼"}</span>
              </span>
            </button>
            {events.filter(e => e.id !== "start").length > 0 && (
              <button onClick={undoLast}
                style={{ background:`color-mix(in srgb, ${P.amber} 14%, transparent)`,
                  border:`1px solid ${P.amber}`, borderRadius:9, padding:"6px 10px",
                  cursor:"pointer", fontFamily:sans, fontSize:11, fontWeight:700,
                  color:P.amberText, whiteSpace:"nowrap", flexShrink:0, display:"flex",
                  alignItems:"center", gap:4 }}>
                ↩ <span>Annuler</span>
              </button>
            )}
          </div>
          {showLog && (
            <div style={{ maxHeight:240, overflowY:"auto", borderTop:`1px solid ${P.borderSoft}` }}>
              {events.length === 0 && (
                <p style={{ padding:"14px 16px", margin:0, fontSize:12, color:P.textSoft }}>Aucun événement</p>
              )}
              {[...events].sort((a,b) => {
                const ta = a.time || "00:00", tb = b.time || "00:00";
                return tb.localeCompare(ta); // décroissant (récents en haut)
              }).map((e, i) => {
                const realIdx = events.findIndex(it => it === e);
                return (
                  <div key={realIdx} style={{ display:"flex", gap:8, padding:"7px 14px",
                    background: i%2===0 ? P.surface : P.surfaceAlt, alignItems:"center" }}>
                    {/* Heure éditable */}
                    <input
                      type="time"
                      value={e.time}
                      onChange={ev => {
                        const newTime = ev.target.value;
                        setEvents(prev => {
                          const updated = prev.map((item, idx) =>
                            idx === realIdx ? { ...item, time: newTime } : item
                          );
                          // Tri chronologique croissant
                          return updated.sort((a,b) => {
                            const ta = a.time || "00:00", tb = b.time || "00:00";
                            return ta.localeCompare(tb);
                          });
                        });
                      }}
                      style={{ background:"transparent", border:`1px solid transparent`,
                        borderRadius:6, padding:"2px 4px", fontSize:11, color:P.blue,
                        fontFamily:mono, fontWeight:600, cursor:"pointer", width:52, outline:"none",
                        textAlign:"center" }}
                      onFocus={ev => ev.target.style.borderColor = P.blue}
                      onBlur={ev  => ev.target.style.borderColor = "transparent"}
                    />
                    {/* Icône SVG selon l'id de l'événement */}
                    {(() => {
                      const iconMap = {
                        "rv_fvtv": ICONS.fvtv, "rv_aesp": ICONS.aesp,
                        "rv_asy": ICONS.asystolie, "rosc": ICONS.racs,
                        "adr": ICONS.adr, "cord300": ICONS.amio, "cord150": ICONS.amio,
                        "choc": ICONS.choc, "doublechoc": ICONS.doublechoc,
                        "patchs": ICONS.choc,
                        "vvp": ICONS.vvp, "vio": ICONS.vio,
                        "planche": ICONS.planche, "fast": ICONS.fast,
                        "iot": ICONS.iot, "deces": ICONS.deces,
                      };
                      const svg = iconMap[e.id];
                      return svg
                        ? <div style={{ width:20, height:20, color:P.textMid, flexShrink:0 }}>{svg}</div>
                        : <span style={{ fontSize:14, flexShrink:0 }}>{e.icon}</span>;
                    })()}
                    <input
                      type="text"
                      value={e.label}
                      onChange={ev => {
                        const newLabel = ev.target.value;
                        setEvents(prev => prev.map((item, idx) =>
                          idx === realIdx ? { ...item, label: newLabel } : item
                        ));
                      }}
                      style={{ fontSize:12, color:P.textMid, flex:1, minWidth:0,
                        background:"transparent", border:"1px solid transparent",
                        borderRadius:6, padding:"2px 4px", fontFamily:sans, outline:"none" }}
                      onFocus={ev => ev.target.style.borderColor = P.teal}
                      onBlur={ev => ev.target.style.borderColor = "transparent"}
                    />
                    <button
                      onClick={() => setEvents(prev => prev.filter((_, idx) => idx !== realIdx))}
                      title="Retirer cet événement"
                      style={{ background:"transparent", border:`1px solid ${P.border}`,
                        borderRadius:6, padding:"2px 7px", cursor:"pointer",
                        color:P.textSoft, fontSize:12, fontFamily:sans, flexShrink:0,
                        lineHeight:1.4, transition:"all 0.1s" }}
                      onPointerEnter={ev => { ev.currentTarget.style.background = P.roseSoft; ev.currentTarget.style.color = P.roseText; ev.currentTarget.style.borderColor = P.rose; }}
                      onPointerLeave={ev => { ev.currentTarget.style.background = "transparent"; ev.currentTarget.style.color = P.textSoft; ev.currentTarget.style.borderColor = P.border; }}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Contrôles */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:70 }}>
          <button onClick={() => setRunning(v => !v)}
            style={{ background:P.surface, border:`1.5px solid ${running ? P.amber : P.green}`,
              borderRadius:11, padding:"10px 6px",
              color: running ? P.amberText : P.greenText,
              fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:sans }}>
            {running ? "⏸ Pause" : "▶ Reprendre"}
          </button>
          <button onClick={() => setShowPdf(true)}
            style={{ background:"linear-gradient(135deg,#3B82C4,#2563A8)", border:"none",
              borderRadius:11, padding:"10px 6px", color:"#fff",
              fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:sans,
              boxShadow:"0 4px 12px rgba(59,130,196,0.25)" }}>
            📄 Compte-rendu
          </button>
          <button onClick={() => setModalReset(true)}
            style={{ background:P.surface, border:`1.5px solid ${P.border}`,
              borderRadius:11, padding:"10px 6px", color:P.textSoft,
              fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:sans }}>
            ↺ Clôturer
          </button>
        </div>

        {/* Le bouton micro et son retour visuel vivent maintenant dans le header (compact) et
            le bandeau fixe en haut de l'écran — voir plus haut, avant "Header + Timer". */}
      </div>

      {/* ── Modal Sécurisation VAS — VLI (choix supra-glottique / IOT) ── */}
      {modalVasVLI && (
        <Modal title="Sécurisation des voies aériennes" icon="🫁" soft={P.violetSoft} onClose={() => setModalVasVLI(false)}>
          <button onClick={() => setVasVLIInhalation(v => !v)}
            style={{ width:"100%", display:"flex", alignItems:"center", gap:10,
              background: vasVLIInhalation ? P.amberSoft : P.surfaceAlt,
              border:`1.5px solid ${vasVLIInhalation ? P.amber : P.border}`, borderRadius:11,
              padding:"11px 13px", marginBottom:14, cursor:"pointer", fontFamily:sans, textAlign:"left" }}>
            <span style={{ fontSize:16, flexShrink:0 }}>{vasVLIInhalation ? "🟠" : "💧"}</span>
            <span style={{ flex:1, fontSize:12.5, fontWeight:700, color: vasVLIInhalation ? P.amberText : P.textMid }}>
              Inhalation objectivée (régurgitation/liquide gastrique)
            </span>
            <span style={{ width:20, height:20, borderRadius:6, flexShrink:0,
              border:`1.5px solid ${vasVLIInhalation ? P.amber : P.border}`,
              background: vasVLIInhalation ? P.amber : "transparent",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:"#fff" }}>
              {vasVLIInhalation && "✓"}
            </span>
          </button>
          <ChoiceBtn label="Dispositif supra-glottique" sub="Geste infirmier — protocole VLI"
            accent="#EA6A12" soft="rgba(234,106,18,0.12)" textC="#B24E0A"
            onClick={() => {
              addEvent("vas_supraglottique", `Dispositif supra-glottique posé${vasVLIInhalation ? " (inhalation objectivée)" : ""}`, "🫁");
              setVasVLIInhalation(false); setModalVasVLI(false);
            }} />
          <ChoiceBtn label="Intubation orotrachéale (IOT)" sub="Réservée à l'IADE"
            accent={P.violet} soft={P.violetSoft} textC={P.violetText}
            onClick={() => {
              addEvent("iot", `Intubation orotrachéale (IADE)${vasVLIInhalation ? " (inhalation objectivée)" : ""}`, "🫁");
              setVasVLIInhalation(false); setModalVasVLI(false);
            }} />
        </Modal>
      )}

      {/* ── Modal Certificat de décès — VLI (sans OML uniquement + alerte suspicion) ── */}
      {/* Le certificat de décès n'existe pas en VLI — un IDE (ISP) n'a jamais l'autorité de
          constater un décès, avec ou sans OML. Ce cas relève uniquement du VLM après transition,
          ou de la régulation médicale (bouton "Régulation") en cas de doute avant son arrivée. */}
      {/* ── Modal confirmation transition VLM (VLI uniquement) ── */}
      {modalVliTransition && (
        <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,0.55)",
          display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
          onClick={e => { if (e.target === e.currentTarget) setModalVliTransition(false); }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:P.surface, borderRadius:18, padding:"22px 20px", maxWidth:340,
              boxShadow:"0 12px 40px rgba(0,0,0,0.3)" }}>
            <p style={{ margin:"0 0 10px", fontSize:16, fontWeight:800, color:P.text, fontFamily:disp }}>
              🚒 Confirmer l'arrivée du VLM
            </p>
            <p style={{ margin:"0 0 18px", fontSize:12.5, color:P.textMid, lineHeight:1.6 }}>
              Ceci débloque la <b>prise en charge médicale complète</b> (gestes et thérapeutiques
              hors du cadre du protocole VLI). Tout ce qui a déjà été saisi (patient, transmission,
              chocs, adrénaline...) reste intact — le médecin reprend exactement là où vous en êtes.
              <br /><br />
              <b>Action irréversible</b> — pas de retour au mode restreint ensuite.
            </p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <button onClick={() => setModalVliTransition(false)}
                style={{ background:P.surfaceAlt, border:`1.5px solid ${P.border}`, borderRadius:11,
                  color:P.textMid, padding:"11px 0", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                Annuler
              </button>
              <button onClick={() => {
                addEvent("vli_transition", "🚒 VLM arrivée — passation de la prise en charge médicale", "🚒");
                setVliUnlocked(true);
                setModalVliTransition(false);
              }} style={{ background:"linear-gradient(135deg,#EA6A12,#B24E0A)", border:"none", borderRadius:11,
                color:"#fff", padding:"11px 0", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:sans }}>
                ✓ Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Dossier patient ── */}
      {modalPat && (
        <Modal title="Dossier patient" icon="🪪" soft={P.surfaceAlt} onClose={() => setModalPat(false)}>
          <div style={{ display:"grid", gap:12 }}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <div><Lbl>Nom</Lbl><TInput value={pat.nom} onChange={sf("nom")} placeholder="Dupont" /></div>
              <div><Lbl>Prénom</Lbl><TInput value={pat.prenom} onChange={sf("prenom")} placeholder="Jean" /></div>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <div><Lbl>Date de naissance</Lbl><TInput type="date" value={pat.ddn} onChange={v => { sf("ddn")(v); sf("age")(calcAge(v)); }} /></div>
              <div><Lbl>Âge</Lbl><TInput value={pat.age} onChange={sf("age")} placeholder="67 ans" /></div>
            </div>
            {isTrauma && (
              <div>
                <Lbl>Mécanisme lésionnel</Lbl>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
                  {MECANISMES_TRAUMA.map(m => (
                    <button key={m.id} onClick={() => sf("mecanisme")(pat.mecanisme === m.id ? "" : m.id)}
                      style={{ display:"flex", alignItems:"center", gap:6, padding:"9px 8px",
                        borderRadius:9, border:`1.5px solid ${pat.mecanisme===m.id ? P.rose : P.border}`,
                        background: pat.mecanisme===m.id ? P.roseSoft : P.surface,
                        color: pat.mecanisme===m.id ? P.roseText : P.textMid,
                        fontSize:12, fontWeight: pat.mecanisme===m.id ? 700 : 500,
                        cursor:"pointer", fontFamily:sans, textAlign:"left" }}>
                      <span style={{ fontSize:14, flexShrink:0 }}>{m.icon}</span>
                      <span style={{ minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.label}</span>
                    </button>
                  ))}
                </div>
                {pat.mecanisme && (() => {
                  const m = MECANISMES_TRAUMA.find(x => x.id === pat.mecanisme);
                  return (m.penetrant || m.hcin) ? (
                    <p style={{ margin:"6px 0 0", fontSize:9.5, color:P.textSoft, fontStyle:"italic" }}>
                      {m.penetrant && "Trauma pénétrant"}{m.penetrant && m.hcin && " · "}{m.hcin && "Haute cinétique"}
                      {" "}— préremplira automatiquement le score BATT
                    </p>
                  ) : null;
                })()}
              </div>
            )}
            <div><Lbl>Température (°C)</Lbl>
              <TInput value={pat.temp} onChange={sf("temp")} placeholder="Ex : 35,2 — penser hypothermie / ECMO" /></div>
            <div><Lbl>Antécédents médicaux</Lbl>
              <TArea value={pat.atcd} onChange={sf("atcd")} placeholder="HTA, diabète, ACFA..." rows={2} /></div>
            <div><Lbl>Traitements habituels</Lbl>
              <TArea value={pat.traitement} onChange={sf("traitement")} placeholder="Metformine, Bisoprolol..." rows={2} /></div>
            <div><Lbl>Histoire de la maladie</Lbl>
              <TArea value={pat.histoire} onChange={sf("histoire")} placeholder="Circonstances, symptômes précédents..." rows={3} /></div>
          </div>
          <button onClick={() => setModalPat(false)}
            style={{ width:"100%", background:P.text, border:"none", borderRadius:12,
              color:P.bg, fontSize:14, fontWeight:700, padding:"13px", cursor:"pointer",
              fontFamily:sans, marginTop:14 }}>
            ✓ Enregistrer
          </button>
        </Modal>
      )}

      {teamModal}

      {/* ── Modal confirmation Reset (double validation) ── */}
      {modalReset && (
        <div style={{ position:"fixed", inset:0, background:"rgba(28,43,58,0.55)", zIndex:90,
          display:"flex", alignItems:"center", justifyContent:"center", padding:20,
          backdropFilter:"blur(2px)" }} onClick={() => setModalReset(false)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:P.surface, borderRadius:18, padding:"22px 20px", maxWidth:340,
              width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ textAlign:"center", marginBottom:14 }}>
              <div style={{ width:52, height:52, borderRadius:16, background:P.roseSoft,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:26,
                margin:"0 auto 12px" }}>⚠️</div>
              <p style={{ margin:0, fontSize:16, fontWeight:700, color:P.text }}>Réinitialiser la session ?</p>
              <p style={{ margin:"8px 0 0", fontSize:12.5, color:P.textSoft, lineHeight:1.5 }}>
                La session va être <b>archivée</b> (consultable depuis l'accueil), puis l'écran sera
                remis à zéro pour une nouvelle réanimation : chronologie, dossier patient, transmission.
              </p>
            </div>
            <button onClick={() => {
                setModalReset(false);
                if (debriefEnabled) { setShowDebrief(true); } else { reset(); }
              }}
              style={{ width:"100%", background:`linear-gradient(135deg,${P.rose},#B94A4A)`,
                border:"none", borderRadius:12, color:"#fff", fontSize:14, fontWeight:700,
                padding:"13px", cursor:"pointer", fontFamily:sans, marginBottom:9,
                boxShadow:`0 4px 14px color-mix(in srgb, ${P.rose} 27%, transparent)` }}>
              Archiver et réinitialiser
            </button>
            <button onClick={() => setModalReset(false)}
              style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:12, color:P.textMid, fontSize:14, fontWeight:600,
                padding:"13px", cursor:"pointer", fontFamily:sans }}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* ── Modal Régulation ── */}
      {modalRegul && (
        <div style={{ position:"fixed", inset:0, background:"rgba(28,43,58,0.55)", zIndex:80,
          display:"flex", alignItems:"flex-end", justifyContent:"center",
          backdropFilter:"blur(2px)" }} onClick={() => setModalRegul(false)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:P.surface, width:"100%", borderRadius:"20px 20px 0 0",
              padding:"22px 18px 40px", boxShadow:"0 -12px 40px rgba(0,0,0,0.18)",
              fontFamily:sans, maxHeight:"85vh", overflowY:"auto" }}>

            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
              <div style={{ width:38, height:38, borderRadius:11, background:P.amberSoft,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>📞</div>
              <div>
                <p style={{ margin:0, fontSize:15, fontWeight:600, color:P.text }}>Appel régulation</p>
                <p style={{ margin:0, fontSize:11, color:P.textSoft }}>Transmission du bilan et orientation</p>
              </div>
              <button onClick={() => setModalRegul(false)}
                style={{ marginLeft:"auto", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:20, cursor:"pointer", padding:4 }}>×</button>
            </div>

            {/* Destination */}
            <div style={{ marginBottom:14 }}>
              <Lbl>Destination</Lbl>
              <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:10 }}>
                {["USIC","Réanimation","Coro","SAUV","Déchocage","Autre"].map(d => (
                  <button key={d} onClick={() => setRegulDest(regulDest === d ? "" : d)}
                    style={{ padding:"7px 14px", borderRadius:20, fontSize:13, fontWeight:500,
                      border:`1.5px solid ${regulDest===d ? P.blue : P.border}`,
                      background: regulDest===d ? P.blueSoft : P.surfaceAlt,
                      color: regulDest===d ? P.blueText : P.textMid,
                      cursor:"pointer", fontFamily:sans, transition:"all 0.1s" }}>
                    {d}
                  </button>
                ))}
              </div>
              {regulDest === "Autre" && (
                <TInput value={regulDest === "Autre" ? "" : regulDest}
                  onChange={v => setRegulDest(v)} placeholder="Préciser la destination..." />
              )}
            </div>

            {/* Texte libre */}
            <div style={{ marginBottom:20 }}>
              <Lbl>Compte-rendu de l'appel</Lbl>
              <textarea value={regulText} onChange={e => setRegulText(e.target.value)}
                placeholder={"Médecin régulateur contacté...\nOrientation décidée...\nConsignes reçues...\nHeure de départ prévue..."}
                rows={5}
                style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                  borderRadius:10, padding:"12px 14px", fontSize:14, color:P.text, fontFamily:sans,
                  boxSizing:"border-box", outline:"none", resize:"vertical", lineHeight:1.7 }}
                onFocus={e => e.target.style.borderColor = P.blue}
                onBlur={e  => e.target.style.borderColor = P.border}
              />
            </div>

            <button onClick={() => {
              const dest = regulDest ? ` — Destination : ${regulDest}` : "";
              const txt  = regulText.trim() ? ` — ${regulText.trim()}` : "";
              addEvent("regul", `Appel régulation${dest}${txt}`, "📞");
              setModalRegul(false);
            }} style={{ width:"100%", background:"linear-gradient(135deg,#E8750A,#C4620A)",
              border:"none", borderRadius:14, color:"#fff", fontSize:15, fontWeight:600,
              padding:"15px", cursor:"pointer", fontFamily:sans,
              boxShadow:"0 6px 18px rgba(232,117,10,0.3)" }}>
              ✓ Enregistrer l'appel
            </button>
          </div>
        </div>
      )}

      {/* ── Modal OctaplasLG — 2 chemins (direct ou BATT score) ── */}
      {modalOctaplas && (() => {
        // Calcul BATT score en temps réel
        const age = parseInt(battForm.age) || 0;
        const pas = parseInt(battForm.pas) || -1;
        const gcs = parseInt(battForm.glasgow) || -1;
        const fr  = parseInt(battForm.fr) || -1;
        const spo2 = parseInt(battForm.spo2) || -1;
        const fc  = parseInt(battForm.fc) || -1;

        const pts = {
          age:   age >= 75 ? 2 : age >= 65 ? 1 : 0,
          pas:   pas > 0 && pas < 60 ? 14 : pas >= 60 && pas < 100 ? 5 : 0,
          gcs:   gcs > 0 && gcs <= 8 ? 4 : gcs > 8 && gcs <= 12 ? 3 : 0,
          fr:    fr > 0 && (fr < 10 || fr >= 30) ? 2 : 0,
          spo2:  spo2 > 0 && spo2 < 90 ? 2 : 0,
          fc:    fc > 0 && fc > 100 ? 1 : 0,
          pen:   battForm.penetrant ? 2 : 0,
          hcin:  battForm.hcin ? 2 : 0,
        };
        const total = Object.values(pts).reduce((a,b) => a+b, 0);
        const indication = total >= 8;
        const hasAnyData = battForm.age || battForm.pas || battForm.glasgow || battForm.fr || battForm.spo2 || battForm.fc || battForm.penetrant || battForm.hcin;

        const Bfield = ({ label, key, placeholder, unit, pts: p }) => (
          <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0",
            borderBottom:`1px solid ${P.border}` }}>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ margin:0, fontSize:12, color:P.text }}>{label}</p>
            </div>
            <input type="number" inputMode="numeric" value={battForm[key]}
              onChange={e => setBattForm(f => ({...f, [key]:e.target.value}))}
              placeholder={placeholder}
              style={{ width:64, background:P.surfaceAlt, border:`1px solid ${P.border}`,
                borderRadius:8, padding:"6px 8px", fontSize:14, fontWeight:700,
                color:P.text, fontFamily:mono, textAlign:"center", outline:"none" }}
              onFocus={e => e.target.style.borderColor = P.rose}
              onBlur={e => e.target.style.borderColor = P.border} />
            {unit && <span style={{ fontSize:10, color:P.textSoft, minWidth:24 }}>{unit}</span>}
            <span style={{ minWidth:32, textAlign:"right", fontSize:12, fontWeight:700,
              color: pts[key]>0 ? P.roseText : P.textSoft, fontFamily:mono }}>
              {pts[key] > 0 ? `+${pts[key]}` : "—"}
            </span>
          </div>
        );

        const Btoggle = ({ label, key, pts: p, sub }) => (
          <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0",
            borderBottom:`1px solid ${P.border}` }}>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ margin:0, fontSize:12, color:P.text }}>{label}</p>
              {sub && <p style={{ margin:0, fontSize:10, color:P.textSoft }}>{sub}</p>}
            </div>
            <button onClick={() => setBattForm(f => ({...f, [key]:!f[key]}))}
              style={{ width:44, height:26, borderRadius:13, border:"none", cursor:"pointer",
                background: battForm[key] ? P.rose : P.border, position:"relative", transition:"background 0.15s", padding:0 }}>
              <span style={{ position:"absolute", top:2, left: battForm[key]?21:2, width:22, height:22,
                borderRadius:"50%", background:"#fff", transition:"left 0.15s",
                boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }} />
            </button>
            <span style={{ minWidth:32, textAlign:"right", fontSize:12, fontWeight:700,
              color: battForm[key] ? P.roseText : P.textSoft, fontFamily:mono }}>
              {battForm[key] ? `+${p}` : "—"}
            </span>
          </div>
        );

        return (
          <div style={{ position:"fixed", inset:0, zIndex:82, background:"rgba(0,0,0,0.55)",
            display:"flex", alignItems:"flex-end", fontFamily:sans }}
            onClick={e => { if(e.target===e.currentTarget) setModalOctaplas(false); }}>
            <div style={{ width:"100%", background:P.bg, borderRadius:"20px 20px 0 0",
              padding:"20px 16px 32px", maxHeight:"94vh", overflowY:"auto",
              boxShadow:"0 -16px 50px rgba(0,0,0,0.3)" }}>

              {/* En-tête */}
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                <div style={{ width:40, height:40, borderRadius:12,
                  background:`linear-gradient(135deg, ${P.rose}, ${P.roseText})`,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>🩸</div>
                <div style={{ flex:1 }}>
                  <p style={{ margin:"0 0 1px", fontSize:9.5, fontWeight:700, color:P.rose,
                    textTransform:"uppercase", letterSpacing:"0.12em", fontFamily:mono }}>ACR Traumatique</p>
                  <p style={{ margin:0, fontSize:17, fontWeight:800, color:P.text, fontFamily:disp }}>OctaplasLG</p>
                </div>
                <button onClick={() => setModalOctaplas(false)}
                  style={{ background:"transparent", border:"none", color:P.textSoft, fontSize:22, cursor:"pointer" }}>×</button>
              </div>

              {/* Note transport */}
              <div style={{ background:P.amberSoft, border:`1px solid ${P.amber}`, borderRadius:10,
                padding:"8px 12px", marginBottom:14 }}>
                <p style={{ margin:0, fontSize:11.5, color:P.amberText, fontWeight:600 }}>
                  ⏱ Condition requise : délai de transport &gt; 20 minutes
                </p>
                <p style={{ margin:"2px 0 0", fontSize:11, color:P.amberText, opacity:0.85 }}>
                  2 unités en préhospitalier — puis au moins 1 critère ci-dessous
                </p>
              </div>

              {/* Chemin 1 : Administration directe */}
              <button onClick={() => {
                addEvent("therap", "OctaplasLG — 2 unités administrées", "🩸");
                setModalOctaplas(false);
              }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.rose}, ${P.roseText})`,
                border:"none", borderRadius:13, color:"#fff", fontSize:14, fontWeight:800,
                fontFamily:disp, padding:"15px", cursor:"pointer", marginBottom:14,
                boxShadow:`0 5px 16px color-mix(in srgb, ${P.rose} 35%, transparent)`,
                display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                🩸 Administrer directement
              </button>

              {/* Séparateur */}
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                <div style={{ flex:1, height:1, background:P.border }} />
                <span style={{ fontSize:11, color:P.textSoft, fontFamily:mono, whiteSpace:"nowrap" }}>ou calculer le BATT score</span>
                <div style={{ flex:1, height:1, background:P.border }} />
              </div>

              {/* Calculateur BATT */}
              <div style={{ background:P.surfaceAlt, borderRadius:13, padding:"12px 14px", marginBottom:12 }}>
                <p style={{ margin:"0 0 10px", fontSize:10, fontWeight:700, color:P.textSoft,
                  textTransform:"uppercase", letterSpacing:"0.12em", fontFamily:mono }}>Calculateur BATT Score</p>
                <p style={{ margin:"-4px 0 10px", fontSize:10, color:P.textSoft, fontStyle:"italic" }}>
                  Âge et dernières TA/FC pré-remplis si déjà saisis — modifiables
                </p>

                <Bfield label="Âge" keyN="age" placeholder="ans" unit="ans" ptsV={pts.age}
                  value={battForm.age} onChange={v => setBattForm(f=>({...f,age:v}))} />
                {/* Âge inline direct */}
                <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:`1px solid ${P.border}` }}>
                  <div style={{ flex:1 }}>
                    <p style={{ margin:0, fontSize:12, color:P.text }}>Âge</p>
                    <p style={{ margin:0, fontSize:9.5, color:P.textSoft }}>≥ 65 ans +1 · ≥ 75 ans +2</p>
                  </div>
                  <input type="number" inputMode="numeric" value={battForm.age}
                    onChange={e => setBattForm(f => ({...f, age:e.target.value}))} placeholder="ans"
                    style={{ width:60, background:P.surface, border:`1px solid ${P.border}`, borderRadius:8,
                      padding:"6px 8px", fontSize:14, fontWeight:700, color:P.text, fontFamily:mono, textAlign:"center", outline:"none" }}
                    onFocus={e => e.target.style.borderColor=P.rose}
                    onBlur={e => e.target.style.borderColor=P.border} />
                  <span style={{ fontSize:10, color:P.textSoft, minWidth:20 }}>ans</span>
                  <span style={{ minWidth:32, textAlign:"right", fontSize:12, fontWeight:700,
                    color:pts.age>0?P.roseText:P.textSoft, fontFamily:mono }}>{pts.age>0?`+${pts.age}`:"—"}</span>
                </div>

                {[
                  { key:"pas", label:"PAS systolique", sub:"< 60 +14 · 60–99 +5", unit:"mmHg", p:pts.pas },
                  { key:"glasgow", label:"Glasgow", sub:"≤ 8 +4 · 9–12 +3", unit:"/15", p:pts.gcs },
                  { key:"fr", label:"Fréquence respiratoire", sub:"< 10 ou ≥ 30 +2", unit:"/min", p:pts.fr },
                  { key:"spo2", label:"SpO₂", sub:"< 90 % → +2", unit:"%", p:pts.spo2 },
                  { key:"fc", label:"Fréquence cardiaque", sub:"> 100 → +1", unit:"/min", p:pts.fc },
                ].map(({ key, label, sub, unit, p }) => (
                  <div key={key} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:`1px solid ${P.border}` }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ margin:0, fontSize:12, color:P.text }}>{label}</p>
                      <p style={{ margin:0, fontSize:9.5, color:P.textSoft }}>{sub}</p>
                    </div>
                    <input type="number" inputMode="numeric" value={battForm[key]}
                      onChange={e => setBattForm(f => ({...f, [key]:e.target.value}))} placeholder="—"
                      style={{ width:60, background:P.surface, border:`1px solid ${P.border}`, borderRadius:8,
                        padding:"6px 8px", fontSize:14, fontWeight:700, color:P.text, fontFamily:mono, textAlign:"center", outline:"none" }}
                      onFocus={e => e.target.style.borderColor=P.rose}
                      onBlur={e => e.target.style.borderColor=P.border} />
                    <span style={{ fontSize:10, color:P.textSoft, minWidth:20 }}>{unit}</span>
                    <span style={{ minWidth:32, textAlign:"right", fontSize:12, fontWeight:700,
                      color:p>0?P.roseText:P.textSoft, fontFamily:mono }}>{p>0?`+${p}`:"—"}</span>
                  </div>
                ))}

                {[
                  { key:"penetrant", label:"Traumatisme pénétrant", p:2 },
                  { key:"hcin", label:"Traumatisme à haute cinétique", p:2 },
                ].map(({ key, label, p }) => (
                  <div key={key} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:`1px solid ${P.border}` }}>
                    <p style={{ margin:0, fontSize:12, color:P.text, flex:1 }}>{label}</p>
                    <button onClick={() => setBattForm(f => ({...f, [key]:!f[key]}))}
                      style={{ width:44, height:26, borderRadius:13, border:"none", cursor:"pointer",
                        background:battForm[key]?P.rose:P.border, position:"relative", transition:"background 0.15s", padding:0, flexShrink:0 }}>
                      <span style={{ position:"absolute", top:2, left:battForm[key]?21:2, width:22, height:22,
                        borderRadius:"50%", background:"#fff", transition:"left 0.15s",
                        boxShadow:"0 1px 3px rgba(0,0,0,0.3)" }} />
                    </button>
                    <span style={{ minWidth:32, textAlign:"right", fontSize:12, fontWeight:700,
                      color:battForm[key]?P.roseText:P.textSoft, fontFamily:mono }}>{battForm[key]?`+${p}`:"—"}</span>
                  </div>
                ))}
              </div>

              {/* Score total */}
              {hasAnyData && (
                <div style={{ background: indication ? P.roseSoft : P.greenSoft,
                  border:`2px solid ${indication ? P.rose : P.green}`, borderRadius:13,
                  padding:"12px 16px", marginBottom:14, display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ flex:1 }}>
                    <p style={{ margin:0, fontSize:10, fontWeight:700,
                      color:indication?P.roseText:P.greenText, fontFamily:mono,
                      textTransform:"uppercase", letterSpacing:"0.1em" }}>Score BATT</p>
                    <p style={{ margin:0, fontSize:28, fontWeight:900,
                      color:indication?P.roseText:P.greenText, fontFamily:mono, lineHeight:1 }}>{total}</p>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <p style={{ margin:0, fontSize:14, fontWeight:800,
                      color:indication?P.roseText:P.greenText }}>
                      {indication ? "🩸 Indication OctaplasLG" : "✅ Pas d'indication"}
                    </p>
                    <p style={{ margin:"2px 0 0", fontSize:11,
                      color:indication?P.roseText:P.greenText }}>
                      {indication ? "Score ≥ 8 — administrer 2 unités" : `Score < 8 (seuil 8)`}
                    </p>
                  </div>
                </div>
              )}

              {/* Bouton selon BATT */}
              {hasAnyData && indication && (
                <button onClick={() => {
                  addEvent("therap", `OctaplasLG — 2 unités (BATT score ${total})`, "🩸");
                  setModalOctaplas(false);
                }} style={{ width:"100%", background:`linear-gradient(135deg, ${P.rose}, ${P.roseText})`,
                  border:"none", borderRadius:13, color:"#fff", fontSize:14, fontWeight:800,
                  fontFamily:disp, padding:"15px", cursor:"pointer",
                  boxShadow:`0 5px 16px color-mix(in srgb, ${P.rose} 35%, transparent)` }}>
                  🩸 Administrer — BATT {total}
                </button>
              )}
              {hasAnyData && !indication && (
                <div style={{ background:P.greenSoft, border:`1px solid ${P.green}`, borderRadius:11,
                  padding:"11px 14px", textAlign:"center" }}>
                  <p style={{ margin:0, fontSize:13, fontWeight:700, color:P.greenText }}>
                    ✅ Score BATT {total} — pas d'indication OctaplasLG à ce stade
                  </p>
                </div>
              )}

            </div>
          </div>
        );
      })()}

      {/* ── Flash Analyse de rythme — toutes les 2 min ── */}
      {showRythmFlash && (
        <div style={{ position:"fixed", inset:0, zIndex:95,
          background:"rgba(8,15,35,0.88)", display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center", fontFamily:sans,
          backdropFilter:"blur(8px)" }}>

          {/* Animation pulsante */}
          <style>{`@keyframes rythmPulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.08);opacity:0.85} }`}</style>

          <div style={{ textAlign:"center", marginBottom:28 }}>
            <div style={{ width:72, height:72, borderRadius:22, margin:"0 auto 14px",
              background:"linear-gradient(135deg,#E53E3E,#9B2C2C)",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:36, animation:"rythmPulse 1.2s ease-in-out infinite",
              boxShadow:"0 0 40px rgba(229,62,62,0.5)" }}>⚡</div>
            <p style={{ margin:"0 0 4px", fontSize:11, fontWeight:800, color:"#FC8181",
              textTransform:"uppercase", letterSpacing:"0.2em", fontFamily:mono }}>
              Fin de cycle — 2 min
            </p>
            <p style={{ margin:"0 0 6px", fontSize:26, fontWeight:900, color:"#FFF",
              fontFamily:disp, letterSpacing:"-0.02em" }}>
              Analyse de rythme
            </p>
            <p style={{ margin:0, fontSize:14, color:"rgba(255,255,255,0.6)" }}>
              Pause compressions · Identifier le rythme
            </p>
          </div>

          {/* Boutons rythme */}
          <div style={{ width:"100%", maxWidth:360, padding:"0 20px", display:"flex", flexDirection:"column", gap:10 }}>
            {/* FV / TV */}
            <button onClick={() => {
              addEvent("rv_fvtv", "Rythme : FV/TV", "⚡");
              setShowRythmFlash(false);
              setModalChoc(true); // ouvrir directement le modal CEE
            }} style={{ background:"linear-gradient(135deg,#E53E3E,#9B2C2C)", border:"none",
              borderRadius:16, padding:"16px", cursor:"pointer", fontFamily:disp,
              display:"flex", alignItems:"center", gap:14, color:"#fff",
              boxShadow:"0 8px 24px rgba(229,62,62,0.4)" }}>
              <span style={{ fontSize:28 }}>⚡</span>
              <div style={{ textAlign:"left" }}>
                <p style={{ margin:0, fontSize:17, fontWeight:900, letterSpacing:"-0.01em" }}>FV / TV</p>
                <p style={{ margin:0, fontSize:12, opacity:0.8 }}>Rythme choquable → Défibrillation</p>
              </div>
            </button>

            {/* AESP */}
            <button onClick={() => {
              addEvent("rv_aesp", "Rythme : AESP", "💔");
              setShowRythmFlash(false);
            }} style={{ background:"rgba(255,255,255,0.08)", border:"1.5px solid rgba(255,255,255,0.2)",
              borderRadius:16, padding:"14px 16px", cursor:"pointer", fontFamily:disp,
              display:"flex", alignItems:"center", gap:14, color:"#fff" }}>
              <span style={{ fontSize:24 }}>💔</span>
              <div style={{ textAlign:"left" }}>
                <p style={{ margin:0, fontSize:16, fontWeight:800 }}>AESP</p>
                <p style={{ margin:0, fontSize:11, opacity:0.7 }}>Activité électrique sans pouls → Continuer</p>
              </div>
            </button>

            {/* Asystolie */}
            <button onClick={() => {
              addEvent("rv_asy", "Rythme : Asystolie", "📉");
              setShowRythmFlash(false);
            }} style={{ background:"rgba(255,255,255,0.08)", border:"1.5px solid rgba(255,255,255,0.2)",
              borderRadius:16, padding:"14px 16px", cursor:"pointer", fontFamily:disp,
              display:"flex", alignItems:"center", gap:14, color:"#fff" }}>
              <span style={{ fontSize:24 }}>📉</span>
              <div style={{ textAlign:"left" }}>
                <p style={{ margin:0, fontSize:16, fontWeight:800 }}>Asystolie</p>
                <p style={{ margin:0, fontSize:11, opacity:0.7 }}>Tracé plat → Vérifier branchements → Continuer</p>
              </div>
            </button>

            {/* RACS */}
            <button onClick={() => {
              addEvent("rosc", "RACS", "💚");
              setShowRythmFlash(false);
            }} style={{ background:"linear-gradient(135deg,#276749,#1C4532)", border:"none",
              borderRadius:16, padding:"14px 16px", cursor:"pointer", fontFamily:disp,
              display:"flex", alignItems:"center", gap:14, color:"#fff",
              boxShadow:"0 6px 18px rgba(39,103,73,0.4)" }}>
              <span style={{ fontSize:24 }}>💚</span>
              <div style={{ textAlign:"left" }}>
                <p style={{ margin:0, fontSize:16, fontWeight:800 }}>RACS</p>
                <p style={{ margin:0, fontSize:11, opacity:0.8 }}>Retour à une circulation spontanée</p>
              </div>
            </button>

            {/* Continuer sans logguer */}
            <button onClick={() => setShowRythmFlash(false)}
              style={{ background:"transparent", border:"none", color:"rgba(255,255,255,0.4)",
                fontSize:12, padding:"10px", cursor:"pointer", fontFamily:sans }}>
              ✕ Fermer sans enregistrer
            </button>
          </div>
        </div>
      )}

      {/* ── Modal Critères d'arrêt de réanimation ── */}
      {modalCriteres && (
        <div style={{ position:"fixed", inset:0, zIndex:80, background:"rgba(0,0,0,0.55)",
          display:"flex", alignItems:"flex-end", fontFamily:sans }}
          onClick={e => { if(e.target===e.currentTarget) setModalCriteres(false); }}>
          <div style={{ width:"100%", background:P.bg, borderRadius:"20px 20px 0 0",
            padding:"20px 16px 32px", maxHeight:"92vh", overflowY:"auto",
            boxShadow:"0 -16px 50px rgba(0,0,0,0.3)" }}>

            {/* En-tête */}
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
              <div style={{ width:42, height:42, borderRadius:13,
                background:`linear-gradient(135deg, ${P.amber}, ${P.amberText})`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:22,
                boxShadow:`0 5px 14px color-mix(in srgb, ${P.amber} 35%, transparent)` }}>⏱</div>
              <div>
                <p style={{ margin:"0 0 1px", fontSize:9.5, fontWeight:700, color:P.amber,
                  textTransform:"uppercase", letterSpacing:"0.14em", fontFamily:mono }}>Évaluation après {Math.floor(sec/60)} min</p>
                <p style={{ margin:0, fontSize:18, fontWeight:800, color:P.text, fontFamily:disp, letterSpacing:"-0.01em" }}>
                  Critères d'arrêt{isTrauma ? " — Trauma" : ""}
                </p>
              </div>
              <button onClick={() => setModalCriteres(false)}
                style={{ marginLeft:"auto", background:"transparent", border:"none",
                  color:P.textSoft, fontSize:22, cursor:"pointer" }}>×</button>
            </div>

            {/* Check-list */}
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:18 }}>
              {(isTrauma ? [
                { icon:"🔍", text:"Causes HOTT recherchées et traitées (Hypovolémie, Hypoxie, pneumothOrax, Tamponnade) ?" },
                { icon:"🫁", text:"Thoracostomies bilatérales réalisées (exclut pneumothorax suffocant) ?" },
                { icon:"🩸", text:"Contrôle hémorragique tenté (externe, ceinture pelvienne, produits sanguins/Exacyl) ?" },
                { icon:"⚠️", text:"Traumatisme fermé + no-flow prolongé + aucun signe de vie : pronostic quasi nul" },
                { icon:"🔪", text:"Traumatisme pénétrant : thoracotomie de sauvetage envisagée si perte de vitalité récente et centre équipé ?" },
                { icon:"🤝", text:"Décision collégiale d'équipe ?" },
                { icon:"👨‍👩‍👧", text:"Famille informée / présence souhaitée ?" },
              ] : [
                { icon:"🔍", text:"Cause réversible recherchée et traitée (5H/5T) ?" },
                { icon:"📈", text:"EtCO₂ persistant < 10 mmHg malgré MCE de qualité ?" },
                { icon:"⏱", text:"Durée ≥ 20 min (≥ 30 min si rythme choquable initial) ?" },
                { icon:"💊", text:"Tous les traitements administrés (adré, cordarone si FV/TV) ?" },
                { icon:"🤝", text:"Décision collégiale d'équipe ?" },
                { icon:"👨‍👩‍👧", text:"Famille informée / présence souhaitée ?" },
              ]).map((c, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:10,
                  background:P.surfaceAlt, borderRadius:11, padding:"10px 12px",
                  border:`1px solid ${P.border}` }}>
                  <span style={{ fontSize:18, flexShrink:0 }}>{c.icon}</span>
                  <p style={{ margin:0, fontSize:13, color:P.text, lineHeight:1.4 }}>{c.text}</p>
                </div>
              ))}
            </div>

            {/* Note */}
            <div style={{ background:P.amberSoft, borderRadius:10, padding:"10px 12px", marginBottom:16,
              border:`1px solid ${P.amber}` }}>
              <p style={{ margin:0, fontSize:11.5, color:P.amberText, lineHeight:1.5 }}>
                ℹ️ Cette check-list est un <b>aide-mémoire non bloquant</b>. 
                Chaque médecin demeure seul responsable de la décision d'arrêt, 
                selon le contexte clinique global.
              </p>
            </div>

            {/* Boutons */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <button onClick={() => {
                addEvent("arret_decision", `Décision d'arrêt de réanimation après ${Math.floor(sec/60)} min`, "🕊️");
                setModalCriteres(false);
              }} style={{ background:`linear-gradient(135deg, ${P.slateText}, #374151)`,
                border:"none", borderRadius:13, color:"#fff", fontSize:13, fontWeight:800,
                fontFamily:disp, padding:"14px 10px", cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center", gap:7 }}>
                🕊️ Arrêt décidé
              </button>
              <button onClick={() => setModalCriteres(false)}
                style={{ background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                  borderRadius:13, color:P.text, fontSize:13, fontWeight:700,
                  fontFamily:sans, padding:"14px 10px", cursor:"pointer" }}>
                ▶ Continuer la réa
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Débrief post-arrêt ── */}
      {showDebrief && (
        <DebriefModal
          events={events} totalSec={sec} noFlow={noFlowMin} lowFlow={lowFlowMin}
          etco2List={etco2List} ccfEnabled={ccfEnabled} ccfPct={ccfPct}
          onClose={() => { setShowDebrief(false); reset(); }}
          P={P} mono={mono} sans={sans} disp={disp} fmtSec={fmtSec}
        />
      )}

      {/* ── Toast Undo ── */}
      {undoToast && (
        <div key={undoToast.key}
          style={{ position:"fixed", bottom:80, left:"50%", zIndex:96,
            transform:"translateX(-50%)", maxWidth:"90%",
            background:P.surface, border:`1.5px solid ${P.amber}`, borderRadius:14,
            padding:"10px 12px", display:"flex", alignItems:"center", gap:10,
            boxShadow:`0 8px 26px rgba(0,0,0,0.18)`, fontFamily:sans }}>
          <span style={{ fontSize:17 }}>↩</span>
          <div style={{ minWidth:0, flex:1 }}>
            <p style={{ margin:0, fontSize:10, fontWeight:700, color:P.amberText,
              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Annulé</p>
            <p style={{ margin:0, fontSize:12, fontWeight:600, color:P.text,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{undoToast.label}</p>
          </div>
          <button onClick={restoreEvent}
            style={{ background:P.amber, border:"none", borderRadius:9,
              padding:"7px 12px", cursor:"pointer", fontSize:12, fontWeight:700,
              color:"#fff", fontFamily:sans, whiteSpace:"nowrap", flexShrink:0 }}>
            Restaurer
          </button>
          <button onClick={() => setUndoToast(null)}
            style={{ background:"transparent", border:"none", color:P.textSoft,
              fontSize:18, cursor:"pointer", lineHeight:1, padding:"0 2px" }}>×</button>
        </div>
      )}

      {/* ── Toast de confirmation d'ajout à la chronologie ── */}
      {confirmAdd && (
        <div key={confirmAdd.key}
          style={{ position:"fixed", bottom:24, left:"50%", zIndex:95,
            transform:"translateX(-50%)", maxWidth:"86%",
            background:`linear-gradient(135deg, ${P.green}, ${P.greenText})`,
            color:"#fff", borderRadius:13, padding:"11px 16px",
            display:"flex", alignItems:"center", gap:10, pointerEvents:"none",
            boxShadow:`0 8px 26px color-mix(in srgb, ${P.green} 50%, transparent)`,
            animation:"acrConfirmIn 1.5s ease forwards", fontFamily:sans }}>
          <span style={{ width:24, height:24, borderRadius:"50%", background:"rgba(255,255,255,0.25)",
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:900, flexShrink:0 }}>✓</span>
          <div style={{ minWidth:0 }}>
            <p style={{ margin:0, fontSize:10, fontWeight:700, opacity:0.85, letterSpacing:"0.05em", textTransform:"uppercase", fontFamily:mono }}>Ajouté à la chronologie</p>
            <p style={{ margin:0, fontSize:13, fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{confirmAdd.label}</p>
          </div>
        </div>
      )}

      {/* PDF adulte — overlay */}
      {showPdf && (
        <PdfView patient={pat} noFlow={noFlowMin} lowFlow={lowFlowMin} acrTime={acrTime}
          iot={iot} events={events} totalSec={sec} trans={trans} hemocue={hemocueHist} hemo={hemoList} amines={amineList} etco2={etco2List} onClose={() => setShowPdf(false)} />
      )}

    </div>
  );
}

export default function AppWithBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}