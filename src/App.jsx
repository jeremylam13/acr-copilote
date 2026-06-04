import { useState, useEffect, useRef } from "react";

const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap";
document.head.appendChild(fontLink);

const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02); box-shadow: 0 8px 28px rgba(217,107,107,0.7); }
  }
`;
document.head.appendChild(styleSheet);

const P = {
  bg:"#F2F5F9", surface:"#FFFFFF", surfaceAlt:"#EEF2F7",
  border:"#DDE3ED", borderSoft:"#E8ECF4",
  text:"#1C2B3A", textMid:"#5A7080", textSoft:"#92A4B5",
  blue:"#3B82C4", blueSoft:"#EBF2FA", blueText:"#2563A8",
  rose:"#D96B6B", roseSoft:"#FAEEEE", roseText:"#B94A4A",
  amber:"#C89435", amberSoft:"#FBF5E8", amberText:"#9A6E1A",
  green:"#3EA876", greenSoft:"#EAF7F1", greenText:"#2A7D57",
  violet:"#7B6FB0", violetSoft:"#F0EEF9", violetText:"#5A4E8A",
  slate:"#7A90A4", slateSoft:"#EEF2F7", slateText:"#4A6070",
  teal:"#2A8F8F", tealSoft:"#E8F5F5", tealText:"#1A6A6A",
};
const sans = "'DM Sans', system-ui, sans-serif";
const mono = "'DM Mono', monospace";

const getNow = () => new Date().toTimeString().slice(0, 5);
const fmtSec = s => `${Math.floor(s/60).toString().padStart(2,"0")}:${(s%60).toString().padStart(2,"0")}`;

function useTimer(active) {
  const [s, setS] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    if (active) ref.current = setInterval(() => setS(p => p + 1), 1000);
    else clearInterval(ref.current);
    return () => clearInterval(ref.current);
  }, [active]);
  return [s, setS];
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

// ── BIP SONORE (Web Audio API) ─────────────────────────────────────────────────
function playAdrenalineBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // 3 bips courts et doux
    [0, 0.3, 0.6].forEach(t => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880; // La5
      osc.type = "sine";
      const start = ctx.currentTime + t;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, start + 0.18);
      osc.start(start);
      osc.stop(start + 0.2);
    });
    // Ferme le contexte après 1 sec
    setTimeout(() => { try { ctx.close(); } catch {} }, 1000);
  } catch {}
}

function vibrateAdrenaline() {
  try {
    if ("vibrate" in navigator) navigator.vibrate([200, 100, 200, 100, 200]);
  } catch {}
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
      playAdrenalineBeep();
      vibrateAdrenaline();
      setPlayed(true);
    }
  }, [expired, played]);

  if (!expired) {
    // Mode DISCRET : petite chip en haut à droite
    return (
      <div style={{
        position:"sticky", top:0, zIndex:8,
        display:"flex", justifyContent:"flex-end", padding:"4px 0",
        pointerEvents:"none",
      }}>
        <div style={{
          background:P.rose+"15", border:`1px solid ${P.rose}44`, borderRadius:99,
          padding:"4px 10px", display:"flex", alignItems:"center", gap:6,
          pointerEvents:"auto", boxShadow:"0 1px 4px rgba(0,0,0,0.06)",
        }}>
          <span style={{ fontSize:11, color:P.roseText, fontFamily:mono, fontWeight:600 }}>
            ⏱ Prochaine adré
          </span>
          <span style={{ fontSize:13, color:P.roseText, fontFamily:mono, fontWeight:700 }}>
            {fmtSec(remaining)}
          </span>
          <div style={{ display:"flex", gap:2, marginLeft:4 }}>
            {[3,4,5].map(m => (
              <button key={m} onClick={() => setIntervalMin(m)}
                style={{
                  background: intervalMin===m ? P.rose : "transparent",
                  border:"none", borderRadius:99, padding:"2px 6px",
                  fontSize:10, fontWeight:600, fontFamily:mono,
                  color: intervalMin===m ? "#fff" : P.roseText,
                  cursor:"pointer",
                }}>{m}</button>
            ))}
          </div>
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
      boxShadow:`0 6px 20px ${P.rose}55`,
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
      <button onClick={onAdminister}
        style={{
          background:"#fff", border:"none", borderRadius:9,
          padding:"8px 14px", fontSize:13, fontWeight:700,
          color:P.roseText, cursor:"pointer", fontFamily:sans,
          boxShadow:"0 2px 8px rgba(0,0,0,0.15)",
        }}>
        Administrer
      </button>
      <button onClick={onCancel}
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
  <p style={{ margin:"0 0 5px", fontSize:10, fontWeight:500, color:P.textSoft,
    textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:mono }}>{children}</p>
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

function ActionBtn({ action, onClick }) {
  const [press, setPress] = useState(false);
  const [flash, setFlash] = useState(false);
  const active = flash || press;
  return (
    <button
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerLeave={() => setPress(false)}
      onClick={() => { setFlash(true); setTimeout(() => setFlash(false), 600); onClick(); }}
      style={{
        background: active ? action.soft : P.surface,
        border: `1.5px solid ${active ? action.accent : P.border}`,
        borderRadius:14, padding:"14px 10px", cursor:"pointer", fontFamily:sans,
        display:"flex", flexDirection:"column", alignItems:"center", gap:6,
        transform: press ? "scale(0.95)" : "scale(1)",
        transition:"all 0.12s",
        boxShadow: flash ? `0 0 0 3px ${action.soft}` : "0 1px 4px rgba(0,0,0,0.05)",
        minWidth:0, boxSizing:"border-box", width:"100%",
      }}>
      {/* Icône : SVG ou emoji */}
      {action.svg
        ? <div style={{
            width:34, height:34,
            color: action.accent,
            opacity: active ? 1 : 0.6,
            transform: active ? "scale(1.12)" : "scale(1)",
            transition:"all 0.12s",
          }}>
            {action.svg}
          </div>
        : <span style={{
            fontSize: active ? 28 : 24,
            transition:"font-size 0.12s",
            filter: active ? `drop-shadow(0 0 4px ${action.accent})` : "none",
          }}>
            {action.icon}
          </span>
      }
      <span style={{
        fontSize:11, fontWeight: active ? 600 : 500,
        color: active ? action.textC : P.textMid,
        textAlign:"center", lineHeight:1.3,
        transition:"color 0.12s",
      }}>
        {action.label}
      </span>
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
function PdfView({ patient, noFlow, lowFlow, acrTime, iot, events, totalSec, trans, hemocue, onClose }) {
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
      t.h1erChoc || t.temoin || t.mceTemoin || (parseInt(t.chocsPompiers)||0) > 0 || t.rythmeDSA || t.gestesSecouristes || t.note);
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
      if (t.gestesSecouristes) lines.push(`Gestes secouristes: ${t.gestesSecouristes}`);
      if (t.note)             lines.push(`Note pré-SMUR     : ${t.note}`);
      lines.push("");
    }

    lines.push("── CHRONOLOGIE ─────────────────────");
    events.forEach(e => {
      lines.push(`${e.time}  ${e.label}`);
    });
    lines.push("");

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
    lines.push("───────────────────────────────────");
    lines.push("Usage professionnel exclusif");
    lines.push("Outil d'aide cognitive — chaque");
    lines.push("professionnel reste responsable");
    lines.push("de ses prescriptions.");
    return lines.join("\n");
  };

  const handleShare = async () => {
    const text = buildText();
    const date = new Date().toISOString().slice(0,10);
    const nom  = patient?.nom ? `_${patient.nom}` : "";
    const filename = `ACR${nom}_${date}.txt`;

    // Méthode 1 : Web Share API (iOS Safari, Android Chrome) — partage natif
    if (navigator.share) {
      try {
        const file = new File([text], filename, { type: "text/plain" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "Compte-rendu ACR" });
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

    // Méthode 2 : data URI (fallback Android)
    try {
      const a = document.createElement("a");
      a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    } catch(e) {}

    // Méthode 3 : ouvrir dans un nouvel onglet (dernier recours)
    const w = window.open("", "_blank");
    if (w) {
      w.document.write("<pre style='font-family:monospace;font-size:13px;padding:16px;white-space:pre-wrap'>" +
        text.replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</pre>");
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
    <div style={{ position:"fixed", inset:0, background:P.bg, zIndex:60,
      overflowY:"auto", fontFamily:sans, boxSizing:"border-box" }}>

      {/* Header sticky */}
      <div style={{ position:"sticky", top:0, background:P.surface,
        borderBottom:`1px solid ${P.border}`, padding:"14px 16px",
        display:"flex", alignItems:"center", justifyContent:"space-between",
        zIndex:10, boxShadow:"0 2px 8px rgba(0,0,0,0.06)" }}>
        <div>
          <p style={{ margin:0, fontSize:14, fontWeight:600, color:P.text }}>Compte-rendu SMUR</p>
          <p style={{ margin:0, fontSize:11, color:P.textSoft }}>
            {new Date().toLocaleDateString("fr-FR")} · {getNow()}
          </p>
        </div>
        <button onClick={onClose}
          style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`,
            borderRadius:10, padding:"8px 14px", cursor:"pointer",
            fontFamily:sans, fontSize:13, fontWeight:500, color:P.textMid }}>
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
            t.h1erChoc || t.temoin || t.mceTemoin || (parseInt(t.chocsPompiers)||0) > 0 || t.rythmeDSA || t.gestesSecouristes || t.note);
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
                {t.note             && <Field label="Note pré-SMUR"      value={t.note} />}
              </div>
            </Section>
          );
        })()}

        {/* Hemocue — suivi Hb */}
        {hemocue && hemocue.length > 0 && (
          <Section title="Hemocue (Hb)">
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

        {/* Résumé */}
        <Section title="Résumé médical">
          <div style={{ background:P.surfaceAlt, borderRadius:12, padding:"14px",
            border:`1px solid ${P.border}` }}>
            <p style={{ margin:0, fontSize:13, lineHeight:1.8, color:P.text }}>
              ACR pris en charge le {new Date().toLocaleDateString("fr-FR")}.
              {patient?.nom ? ` Patient : ${patient.nom}.` : ""}
              {acrTime ? ` Heure d'arrêt : ${acrTime}.` : ""}
              {noFlow  ? ` No-flow : ${noFlow} min.` : " No-flow inconnu."}
              {lowFlow ? ` Low-flow : ${lowFlow} min.` : ""}
              {` Durée RCP : ${fmtSec(totalSec)}.`}
              {chocs ? ` ${chocs} choc(s) électrique(s).` : ""}
              {adrs  ? ` Adrénaline ${adrs} fois.` : ""}
              {iot?.sonde ? ` IOT sonde ${iot.sonde} mm${iot.repere ? `, repère ${iot.repere} cm` : ""}${iot.capno ? `, EtCO2 ${iot.capno} mmHg` : ""}.` : ""}
              {rosc  ? ` ROSC à ${rosc.time}.` : deces ? ` ${deces.label}.` : " Issue non renseignée."}
            </p>
          </div>
        </Section>

      </div>

      {/* Boutons fixes en bas */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, zIndex:20,
        background:P.surface, borderTop:`1px solid ${P.border}`,
        padding:"10px 14px 16px", boxShadow:"0 -4px 16px rgba(0,0,0,0.08)" }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, maxWidth:600, margin:"0 auto" }}>
          <button onClick={handleCopy}
            style={{ background: copied ? P.greenSoft : P.surfaceAlt,
              border:`1.5px solid ${copied ? P.green : P.border}`,
              borderRadius:12, padding:"12px 8px", cursor:"pointer",
              fontFamily:sans, fontSize:13, fontWeight:600,
              color: copied ? P.greenText : P.textMid,
              display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
            {copied ? "✓ Copié !" : "📋 Copier"}
          </button>
          <button onClick={handleShare}
            style={{ background:"linear-gradient(135deg,#3B82C4,#2563A8)",
              border:"none", borderRadius:12, padding:"12px 8px",
              cursor:"pointer", fontFamily:sans, fontSize:13, fontWeight:600,
              color:"#fff", display:"flex", alignItems:"center",
              justifyContent:"center", gap:6 }}>
            📤 Envoyer / Sauvegarder
          </button>
        </div>
        <p style={{ textAlign:"center", fontSize:9, color:P.textSoft, margin:"8px 0 0",
          fontStyle:"italic" }}>
          Usage professionnel · Chaque praticien reste responsable de ses prescriptions
        </p>
      </div>

      {/* Header sticky */}
      <div style={{ position:"sticky", top:0, background:P.surface, borderBottom:`1px solid ${P.border}`,
        padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-between",
        zIndex:10, boxShadow:"0 2px 8px rgba(0,0,0,0.06)" }}>
        <div>
          <p style={{ margin:0, fontSize:14, fontWeight:600, color:P.text }}>Compte-rendu SMUR</p>
          <p style={{ margin:0, fontSize:11, color:P.textSoft }}>
            {new Date().toLocaleDateString("fr-FR")} · {getNow()}
          </p>
        </div>
        <button onClick={onClose}
          style={{ background:P.surfaceAlt, border:`1px solid ${P.border}`, borderRadius:10,
            padding:"8px 16px", cursor:"pointer", fontFamily:sans, fontSize:13,
            fontWeight:500, color:P.textMid }}>← Retour</button>
      </div>

      <div style={{ padding:"16px 14px 40px", maxWidth:600, margin:"0 auto", boxSizing:"border-box", width:"100%" }}>

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
            t.h1erChoc || t.temoin || t.mceTemoin || (parseInt(t.chocsPompiers)||0) > 0 || t.rythmeDSA || t.gestesSecouristes || t.note);
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
                {t.note             && <Field label="Note pré-SMUR"      value={t.note} />}
              </div>
            </Section>
          );
        })()}

        {/* Hemocue — suivi Hb */}
        {hemocue && hemocue.length > 0 && (
          <Section title="Hemocue (Hb)">
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
        <Section title="Résumé médical">
          <div style={{ background:P.surfaceAlt, borderRadius:12, padding:"14px",
            border:`1px solid ${P.border}` }}>
            <p style={{ margin:0, fontSize:13, lineHeight:1.8, color:P.text }}>
              Arrêt cardio-respiratoire pris en charge le {new Date().toLocaleDateString("fr-FR")}.
              {patient?.nom ? ` Patient : ${patient.nom}${patient.age ? `, ${patient.age}` : ""}.` : ""}
              {acrTime ? ` Heure d'arrêt : ${acrTime}.` : ""}
              {noFlow  ? ` No-flow estimé : ${noFlow} min.` : " No-flow inconnu."}
              {lowFlow ? ` Low-flow : ${lowFlow} min.` : ""}
              {` Durée totale de RCP : ${fmtSec(totalSec)}.`}
              {chocs ? ` ${chocs} choc(s) électrique(s) délivré(s).` : ""}
              {adrs  ? ` Adrénaline administrée ${adrs} fois.` : ""}
              {iot?.sonde ? ` Intubation oro-trachéale réalisée (sonde ${iot.sonde} mm${iot.repere ? `, repère ${iot.repere} cm` : ""}${iot.capno ? `, ETCO2 ${iot.capno} mmHg` : ""}).` : ""}
              {rosc  ? ` Reprise de pouls obtenue à ${rosc.time}.` :
               deces ? ` ${deces.label} à ${deces.time}.` : " Issue non renseignée."}
            </p>
          </div>
        </Section>

        <p style={{ textAlign:"center", fontSize:9, color:P.textSoft, marginTop:8, fontStyle:"italic" }}>
          Usage professionnel exclusif · Outil d'aide cognitive — chaque professionnel demeure responsable de ses prescriptions
        </p>

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
          boxShadow:`0 3px 10px ${P.blue}33`, marginBottom: (racs.remplissages||[]).length>0 ? 10 : 0 }}>
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
            background:P.blueSoft, borderRadius:8, border:`1px solid ${P.blue}44` }}>
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
  { age:"NN",       p:3,  masque:"00-0",  aspi:"6",    lame:"Dte 0/1", mandrin:"6",      sonde:"3",   repere:9,  guedel:"0-0", fr:25, vt:"BAVU",  ezio:"E-ZIO 15mm",         adrMg:0.05, adrMl:0.5, amioMg:15,  amioMl:0.5, defib4:12,  defib6:18,  defib8:24,  fcN:135, pasN:60,  pamTC:45, pamHTC:35, vtR:"30-50",  frR:"40",  ie:"1/2", peep:5, sng:6,  fio2:"100% puis QSP 94-98%", midPSE:0.3, sufBolus:0.6, sufPSE:0.6 , nimbex1:0.9, nimbex2:0.45, rempliVol:30, rempliDebit:12, adrPSE1:1.8, adrPSE2:4.5, adrPSE3:9, adrPSE4:13.5 },
  { age:"NN",       p:4,  masque:"00-0",  aspi:"6",    lame:"Dte 0/1", mandrin:"6",      sonde:"3",   repere:9,  guedel:"0-0", fr:25, vt:"BAVU",  ezio:"E-ZIO 15mm",         adrMg:0.05, adrMl:0.5, amioMg:20,  amioMl:0.5, defib4:16,  defib6:24,  defib8:32,  fcN:130, pasN:60,  pamTC:45, pamHTC:35, vtR:"30-50",  frR:"40",  ie:"1/2", peep:5, sng:6,  fio2:"100% puis QSP 94-98%", midPSE:0.4, sufBolus:0.8, sufPSE:0.8 , nimbex1:1.2, nimbex2:0.4, rempliVol:40, rempliDebit:16, adrPSE1:2.4, adrPSE2:6, adrPSE3:12, adrPSE4:18 },
  { age:"3 mois",   p:5,  masque:"0-1",  aspi:"6",  lame:"Dte 0/1", mandrin:"6",      sonde:"3.5", repere:10, guedel:"0",   fr:25, vt:"BAVU",  ezio:"E-ZIO 15mm",         adrMg:0.05, adrMl:0.5, amioMg:25,  amioMl:0.5, defib4:20,  defib6:30,  defib8:40,  fcN:120, pasN:80,  pamTC:55, pamHTC:40, vtR:"30",     frR:"40",  ie:"1/2", peep:5, sng:6,  fio2:"100% puis QSP 94-98%", midPSE:0.5, sufBolus:1.0, sufPSE:1.0 , nimbex1:1.5, nimbex2:0.5, rempliVol:50, rempliDebit:20, adrPSE1:3, adrPSE2:7.5, adrPSE3:15, adrPSE4:22.5 },
  { age:"4-5 mois", p:6,  masque:"0-1",  aspi:"6-8",  lame:"1",       mandrin:"6",      sonde:"3.5", repere:10, guedel:"0",   fr:25, vt:50,  ezio:"E-ZIO 25mm",         adrMg:0.1,  adrMl:1,   amioMg:30,  amioMl:1,   defib4:25,  defib6:36,  defib8:50,  fcN:120, pasN:80,  pamTC:55, pamHTC:40, vtR:"25-30",  frR:"25",  ie:"1/2", peep:5, sng:8,  fio2:"100% puis QSP 94-98%", midPSE:0.6, sufBolus:1.2, sufPSE:1.2 , nimbex1:1.8, nimbex2:0.6, rempliVol:60, rempliDebit:24, adrPSE1:3.6, adrPSE2:9, adrPSE3:18, adrPSE4:27 },
  { age:"6 mois",   p:7,  masque:"0-1",  aspi:"6-8",  lame:"1",       mandrin:"6",      sonde:"3.5", repere:10, guedel:"0",   fr:25, vt:50,  ezio:"E-ZIO 25mm",         adrMg:0.1,  adrMl:1,   amioMg:35,  amioMl:1,   defib4:30,  defib6:42,  defib8:60,  fcN:120, pasN:80,  pamTC:55, pamHTC:40, vtR:"25-30",  frR:"25",  ie:"1/2", peep:5, sng:8,  fio2:"100% puis QSP 94-98%", midPSE:0.7, sufBolus:1.4, sufPSE:1.4 , nimbex1:2, nimbex2:0.7, rempliVol:70, rempliDebit:28, adrPSE1:4.2, adrPSE2:10.5, adrPSE3:21, adrPSE4:31.5 },
  { age:"8 mois",   p:8,  masque:"0-1",  aspi:"6-8",  lame:"1",       mandrin:"6",      sonde:"3.5", repere:11, guedel:"0",   fr:25, vt:50,  ezio:"E-ZIO 25mm",         adrMg:0.1,  adrMl:1,   amioMg:40,  amioMl:1,   defib4:35,  defib6:48,  defib8:70,  fcN:115, pasN:80,  pamTC:55, pamHTC:40, vtR:"25-30",  frR:"25",  ie:"1/2", peep:5, sng:8,  fio2:"100% puis QSP 94-98%", midPSE:0.8, sufBolus:1.6, sufPSE:1.6 , nimbex1:2.4, nimbex2:0.8, rempliVol:80, rempliDebit:32, adrPSE1:4.8, adrPSE2:12, adrPSE3:24, adrPSE4:36 },
  { age:"12 mois",  p:10, masque:"1-2",  aspi:"8",    lame:"1",       mandrin:"10",     sonde:"4",   repere:11, guedel:"1",   fr:20, vt:60,  ezio:"E-ZIO 25mm",         adrMg:0.1,  adrMl:1,   amioMg:50,  amioMl:1,   defib4:40,  defib6:60,  defib8:80,  fcN:110, pasN:90,  pamTC:55, pamHTC:40, vtR:"25-30",  frR:"25",  ie:"1/2", peep:5, sng:8,  fio2:"100% puis QSP 94-98%", midPSE:1.0, sufBolus:2.0, sufPSE:2.0 , nimbex1:3, nimbex2:1, rempliVol:100, rempliDebit:40, adrPSE1:6, adrPSE2:15, adrPSE3:30, adrPSE4:45 },
  { age:"18 mois",  p:11, masque:"1-2",  aspi:"8",    lame:"1-2",     mandrin:"10",     sonde:"4",   repere:12, guedel:"1",   fr:20, vt:66,  ezio:"E-ZIO 25mm",         adrMg:0.15, adrMl:1.5, amioMg:55,  amioMl:1.5, defib4:45,  defib6:66,  defib8:90,  fcN:110, pasN:90,  pamTC:57, pamHTC:42, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.1, sufBolus:2.2, sufPSE:2.2 , nimbex1:3.3, nimbex2:1.1, rempliVol:110, rempliDebit:40, adrPSE1:1.3, adrPSE2:3.3, adrPSE3:6.6, adrPSE4:9.9 },
  { age:"2 ans",    p:12, masque:"1-2",  aspi:"8",    lame:"1-2",     mandrin:"10",     sonde:"4",   repere:12, guedel:"1",   fr:20, vt:72,  ezio:"E-ZIO 25mm",         adrMg:0.15, adrMl:1.5, amioMg:60,  amioMl:1.5, defib4:50,  defib6:72,  defib8:100, fcN:110, pasN:100, pamTC:58, pamHTC:43, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.2, sufBolus:2.4, sufPSE:2.4 , nimbex1:3.6, nimbex2:1.2, rempliVol:120, rempliDebit:40, adrPSE1:1.4, adrPSE2:3.6, adrPSE3:7.2, adrPSE4:10.8 },
  { age:"3 ans",    p:14, masque:"3",  aspi:"8",    lame:"1-2",     mandrin:"10",     sonde:"4",   repere:13, guedel:"1",   fr:20, vt:84,  ezio:"E-ZIO 25mm",         adrMg:0.15, adrMl:1.5, amioMg:70,  amioMl:1.5, defib4:55,  defib6:84,  defib8:110, fcN:105, pasN:100, pamTC:60, pamHTC:45, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.4, sufBolus:2.8, sufPSE:2.8 , nimbex1:4.2, nimbex2:1.4, rempliVol:140, rempliDebit:40, adrPSE1:1.7, adrPSE2:4.2, adrPSE3:8.4, adrPSE4:12.6 },
  { age:"4 ans",    p:15, masque:"3",    aspi:"8-10", lame:"1-2",     mandrin:"10",     sonde:"4.5", repere:14, guedel:"1",   fr:20, vt:90,  ezio:"E-ZIO 25mm",         adrMg:0.15, adrMl:1.5, amioMg:75,  amioMl:1.5, defib4:60,  defib6:90,  defib8:120, fcN:105, pasN:100, pamTC:61, pamHTC:46, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.5, sufBolus:3.0, sufPSE:3.0 , nimbex1:4.5, nimbex2:1.5, rempliVol:150, rempliDebit:40, adrPSE1:1.8, adrPSE2:4.5, adrPSE3:9, adrPSE4:13.5 },
  { age:"5 ans",    p:17, masque:"3",    aspi:"8-10", lame:"1-2",     mandrin:"10",     sonde:"4.5", repere:14, guedel:"1",   fr:20, vt:102, ezio:"E-ZIO 25mm",         adrMg:0.2,  adrMl:2,   amioMg:85,  amioMl:2,   defib4:70,  defib6:102, defib8:140, fcN:105, pasN:105, pamTC:63, pamHTC:48, vtR:"20-25",  frR:"25",  ie:"1/2", peep:5, sng:10, fio2:"100% puis QSP 94-98%", midPSE:1.7, sufBolus:3.4, sufPSE:3.4 , nimbex1:5, nimbex2:1.7, rempliVol:170, rempliDebit:40, adrPSE1:2, adrPSE2:5.1, adrPSE3:10.2, adrPSE4:15.3 },
  { age:"6-7 ans",  p:20, masque:"3",  aspi:"10",   lame:"2-3",     mandrin:"10",     sonde:"5",   repere:15, guedel:"2",   fr:20, vt:120, ezio:"E-ZIO 25mm",         adrMg:0.2,  adrMl:2,   amioMg:100, amioMl:2,   defib4:80,  defib6:120, defib8:160, fcN:100, pasN:105, pamTC:66, pamHTC:51, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:2.0, sufBolus:4.2, sufPSE:4.2 , nimbex1:1.5, nimbex2:2.1, rempliVol:200, rempliDebit:40, adrPSE1:2.5, adrPSE2:6.3, adrPSE3:12.6, adrPSE4:18.9 },
  { age:"8 ans",    p:25, masque:"3-4",  aspi:"10",   lame:"2-3",     mandrin:"12",     sonde:"5.5", repere:16, guedel:"2",   fr:15, vt:150, ezio:"E-ZIO 25mm",         adrMg:0.25, adrMl:2.5, amioMg:125, amioMl:2.5, defib4:100, defib6:150, defib8:200, fcN:95,  pasN:105, pamTC:67, pamHTC:52, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:2.5, sufBolus:5.0, sufPSE:5.0 , nimbex1:1.8, nimbex2:2.5, rempliVol:250, rempliDebit:40, adrPSE1:3, adrPSE2:7.5, adrPSE3:15, adrPSE4:22.5 },
  { age:"9 ans",    p:28, masque:"3-4",  aspi:"12",   lame:"2-3",     mandrin:"12-14",  sonde:"6",   repere:"16-17", guedel:"2",   fr:15, vt:168, ezio:"E-ZIO 25mm",         adrMg:0.3,  adrMl:3,   amioMg:160, amioMl:3,   defib4:150, defib6:150, defib8:300, fcN:95,  pasN:105, pamTC:69, pamHTC:54, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:2.8, sufBolus:5.6, sufPSE:5.6 , nimbex1:2.1, nimbex2:2.8, rempliVol:280, rempliDebit:40, adrPSE1:3.3, adrPSE2:8.4, adrPSE3:16.8, adrPSE4:25.2 },
  { age:"10 ans",   p:32, masque:"3-4",    aspi:"12",   lame:"3",       mandrin:"14-15",  sonde:"6.5", repere:17, guedel:"2",   fr:15, vt:192, ezio:"E-ZIO 25mm",         adrMg:0.3,  adrMl:3,   amioMg:160, amioMl:3,   defib4:150, defib6:200, defib8:300, fcN:95,  pasN:105, pamTC:70, pamHTC:55, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:3.2, sufBolus:6.4, sufPSE:6.4 , nimbex1:2.4, nimbex2:3.2, rempliVol:320, rempliDebit:40, adrPSE1:3.8, adrPSE2:9.6, adrPSE3:19.2, adrPSE4:28.8 },
  { age:"11 ans",   p:35, masque:"4",    aspi:"12",   lame:"3",       mandrin:"14-15",  sonde:"6.5", repere:"17-18", guedel:"3",   fr:15, vt:210, ezio:"E-ZIO 25mm",         adrMg:0.35, adrMl:3.5, amioMg:175, amioMl:3.5, defib4:150, defib6:200, defib8:300, fcN:90,  pasN:105, pamTC:72, pamHTC:57, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:12, fio2:"100% puis QSP 94-98%", midPSE:3.5, sufBolus:7.0, sufPSE:7.0 , nimbex1:2.6, nimbex2:3.5, rempliVol:350, rempliDebit:40, adrPSE1:4.2, adrPSE2:10.5, adrPSE3:21, adrPSE4:31.5 },
  { age:"12 ans",   p:40, masque:"4",    aspi:"12",   lame:"3",       mandrin:"14-15",  sonde:"6.5", repere:18, guedel:"2-3",   fr:10, vt:240, ezio:"E-ZIO 25mm ou 45mm", adrMg:0.4,  adrMl:4,   amioMg:200, amioMl:4,   defib4:175, defib6:250, defib8:300, fcN:80,  pasN:110, pamTC:80, pamHTC:65, vtR:"15-25",  frR:"18",  ie:"1/2", peep:5, sng:14, fio2:"100% puis QSP 94-98%", midPSE:4.0, sufBolus:8.0, sufPSE:8.0 , nimbex1:3, nimbex2:4, rempliVol:400, rempliDebit:"Garde veine", adrPSE1:4.8, adrPSE2:12, adrPSE3:24, adrPSE4:36 },
  { age:"15 ans",   p:50, masque:"4-5",  aspi:"12",   lame:"3",       mandrin:"14-15",  sonde:"7",   repere:"19-20", guedel:"2-3",   fr:10, vt:300, ezio:"E-ZIO 25mm ou 45mm", adrMg:0.5,  adrMl:5,   amioMg:250, amioMl:5,   defib4:200, defib6:250, defib8:300, fcN:75,  pasN:120, pamTC:80, pamHTC:65, vtR:"12-20",  frR:"15",  ie:"1/2", peep:5, sng:14, fio2:"100% puis QSP 94-98%", midPSE:5.0, sufBolus:10.0, sufPSE:10.0 , nimbex1:3.7, nimbex2:5, rempliVol:500, rempliDebit:"Garde veine", adrPSE1:6, adrPSE2:15, adrPSE3:30, adrPSE4:45 },
];

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
    adrenalineMg:       row.adrMg,
    adrenalineMl:       row.adrMl,
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
          boxShadow:`0 3px 10px ${P.blue}33`,
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
            background:P.blueSoft, borderRadius:8, border:`1px solid ${P.blue}44` }}>
            <span style={{ fontSize:11, color:P.textSoft }}>Total remplissage</span>
            <span style={{ fontSize:17, fontWeight:700, color:P.blueText, fontFamily:mono }}>{total} mL</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RCP PÉDIATRIQUE ───────────────────────────────────────────────────────────

function RcpPediatrique({ onBack, acrTime, poids, mat }) {
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
  const [omlTxtPed,     setOmlTxtPed]     = useState("");
  const [showPatPed,    setShowPatPed]    = useState(false);
  const [patPed, setPatPed] = useLocalState("acr_ped_pat", { nom:"", prenom:"", ddn:"", age:"", poids:"", temp:"", atcd:"", traitement:"", histoire:"" });
  const spf = k => v => setPatPed(p => ({ ...p, [k]: v }));
  const [showNotePed,  setShowNotePed]   = useState(false);
  const [noteTextPed,  setNoteTextPed]   = useState("");
  // Transmission équipes pré-SMUR
  const [modalTransPed, setModalTransPed] = useState(false);
  const [transPed, setTransPed] = useLocalState("acr_ped_trans", {
    hEffondrement:"", temoin:"", mceTemoin:"",
    hArriveePompiers:"", hPoseDSA:"", h1erChoc:"",
    chocsPompiers:0, rythmeDSA:"",
    note:"", saved:false,
  });
  // Minuteur Adrénaline pédiatrique
  const [adrTimerStartPed, setAdrTimerStartPed] = useLocalState("acr_ped_adrStart", 0);
  const [adrIntervalPed,   setAdrIntervalPed]   = useLocalState("acr_ped_adrInterval", 4);
  // Onglets pédiatrique
  const [mainTabPed,       setMainTabPed]       = useLocalState("acr_ped_mainTab", "actions");
  const [suspectedPed,     setSuspectedPed]     = useLocalState("acr_ped_suspected", []);
  const [modalEcmoPed,     setModalEcmoPed]     = useState(false);
  const stp = k => v => setTransPed(p => ({ ...p, [k]: v }));

  const [noFlowMin,    setNoFlowMin]    = useLocalState("acr_ped_noFlow", "");
  const [lowFlowMin,   setLowFlowMin]   = useLocalState("acr_ped_lowFlow", "");
  const [lowFlowStart, setLowFlowStart] = useLocalState("acr_ped_lowFlowStart", "");
  const [localAcrTime, setLocalAcrTime] = useLocalState("acr_ped_acrTime", acrTime || "");

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
  const [racsTabPed,   setRacsTabPed]   = useState("ventil");
  const [showDopee,    setShowDopee]    = useState(false);
  const [racsPed, setRacsPed] = useState({
    fr:"", volume:"", pep:"", sat:"", fio2:"", capno:"",
    tas:"", tad:"", fc:"", noradrV:"",
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

  const addEvent = (id, label, icon, customTime) =>
    setEvents(p => [...p, { id, label, icon, time: customTime || getNow(), sec }]);

  const start = () => {
    const lf = getNow();
    setLowFlowStart(lf);
    setRunning(true);
    setEvents([{ id:"start", label:"Début RCP médicalisée", icon:"🫀", time:lf, sec:0 }]);
  };
  useEffect(() => { window.scrollTo(0, 0); start(); }, []);

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
            style={{width:"100%",background:P.blueSoft,border:`1.5px solid ${P.blue}44`,
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
        <Modal title="Intubation IOT" icon={<div style={{width:24,height:24,color:P.violet}}>{ICONS.iot}</div>}
          soft={P.violetSoft} onClose={() => setModalIotPed(false)}>
          <div style={{background:P.amberSoft,border:`1px solid ${P.amber}44`,borderRadius:10,padding:"10px 14px",marginBottom:14}}>
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

          <button onClick={()=>{
            const detail = [iotSonde&&`sonde ${iotSonde}mm`, iotRepere&&`repère ${iotRepere}cm`, iotCapno&&`ETCO2 ${iotCapno}mmHg`].filter(Boolean).join(", ");
            addEvent("iot",`Intubation IOT${detail?` (${detail})`:""}`, "🫁");
            setModalIotPed(false);
          }} style={{width:"100%",background:`linear-gradient(135deg,${P.violet},#5A4E8A)`,
            border:"none",borderRadius:12,color:"#fff",fontSize:14,fontWeight:600,
            padding:"14px",cursor:"pointer",fontFamily:sans,
            boxShadow:`0 6px 18px ${P.violet}33`}}>
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
        <Modal title="Appel régulation" icon="📞" soft="#FFF3E0" onClose={() => setModalRegulPed(false)}>
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
      {modalRacsPed && (
        <div style={{position:"fixed",inset:0,background:"rgba(28,43,58,0.6)",zIndex:80,
          display:"flex",flexDirection:"column",justifyContent:"flex-end",backdropFilter:"blur(2px)"}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:P.surface,width:"100%",borderRadius:"20px 20px 0 0",
              padding:"20px 16px 40px",boxShadow:"0 -12px 40px rgba(0,0,0,0.18)",
              fontFamily:sans,maxHeight:"90vh",display:"flex",flexDirection:"column"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexShrink:0}}>
              <div style={{width:38,height:38,borderRadius:11,background:P.greenSoft,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>🫀</div>
              <div>
                <p style={{margin:0,fontSize:15,fontWeight:600,color:P.text}}>Soins post-RACS</p>
                <p style={{margin:0,fontSize:11,color:P.textSoft}}>Paramètres post-RACS pédiatrique</p>
              </div>
              <button onClick={()=>setModalRacsPed(false)}
                style={{marginLeft:"auto",background:"transparent",border:"none",color:P.textSoft,fontSize:20,cursor:"pointer"}}>×</button>
            </div>
            {/* Onglets */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,
              background:P.surfaceAlt,borderRadius:12,padding:4,marginBottom:14,flexShrink:0}}>
              {[{id:"ventil",label:"Ventil.",icon:"🌬️"},{id:"sedat",label:"Sédation",icon:"💊"},{id:"hemo",label:"Hémo.",icon:"💓"}].map(t=>(
                <button key={t.id} onClick={()=>setRacsTabPed(t.id)}
                  style={{padding:"8px 4px",borderRadius:9,border:"none",
                    background:racsTabPed===t.id?P.surface:"transparent",
                    color:racsTabPed===t.id?P.text:P.textSoft,
                    fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:sans,
                    boxShadow:racsTabPed===t.id?"0 1px 4px rgba(0,0,0,0.08)":"none",
                    display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                  <span>{t.icon}</span>{t.label}
                </button>
              ))}
            </div>
            <div style={{flex:1,overflowY:"auto"}}>
              {racsTabPed==="ventil" && (
                <div style={{width:"100%"}}>
                  {/* Encadré normes ventilation */}
                  {localMat && (
                    <div style={{background:P.amberSoft,border:`1px solid ${P.amber}44`,
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
                      {pair.map(([k,l,u])=>(
                        <div key={k} style={{minWidth:0}}>
                          <p style={{margin:"0 0 4px",fontSize:9,fontWeight:500,color:P.textSoft,
                            textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>{l}</p>
                          <div style={{display:"flex",alignItems:"center",gap:4}}>
                            <input type="number" inputMode="decimal" value={racsPed[k]} onChange={e=>srp(k)(e.target.value)}
                              style={{flex:1,minWidth:0,background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
                                borderRadius:8,padding:"9px 4px",fontSize:15,color:P.text,fontFamily:mono,
                                outline:"none",textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                              onFocus={e=>e.target.style.borderColor=P.blue}
                              onBlur={e=>e.target.style.borderColor=P.border}/>
                            <span style={{fontSize:9,color:P.textSoft,flexShrink:0,whiteSpace:"nowrap"}}>{u}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                  <p style={{margin:"2px 0 0",fontSize:9,color:"#94B8D0",fontStyle:"italic",textAlign:"right"}}>
                    SpO₂ 94–98 % · EtCO₂ 35–45 mmHg
                  </p>

                  {/* Accordéon DOPÉE */}
                  <div style={{marginTop:12}}>
                    <button onClick={()=>setShowDopee(v=>!v)}
                      style={{width:"100%",background:showDopee?"#FEF3C7":"#FFFBEB",
                        border:`1.5px solid ${showDopee?"#F59E0B":"#FCD34D"}`,
                        borderRadius:10,padding:"10px 14px",cursor:"pointer",fontFamily:sans,
                        display:"flex",alignItems:"center",justifyContent:"space-between",
                        transition:"all 0.15s"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:16}}>⚠️</span>
                        <div style={{textAlign:"left"}}>
                          <p style={{margin:0,fontSize:13,fontWeight:600,color:"#92400E"}}>
                            Vérifier DOPÉE
                          </p>
                          <p style={{margin:0,fontSize:9,color:"#B45309",fontStyle:"italic"}}>
                            Problème de ventilation
                          </p>
                        </div>
                      </div>
                      <span style={{fontSize:12,color:"#92400E",fontWeight:600}}>
                        {showDopee?"▲":"▼"}
                      </span>
                    </button>

                    {showDopee && (
                      <div style={{background:"#FFFBEB",border:`1.5px solid #FCD34D`,
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
                              <p style={{margin:"2px 0 0",fontSize:11,color:"#92400E",lineHeight:1.4}}>
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
                    <div style={{background:P.amberSoft,border:`1px solid ${P.amber}44`,
                      borderRadius:10,padding:"10px 12px",marginBottom:12}}>
                      <p style={{margin:"0 0 6px",fontSize:9,fontWeight:600,color:P.amberText,
                        textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
                        Doses sédation — {localPoids} kg · {localRow.age}
                      </p>
                      {/* Midazolam */}
                      <div style={{marginBottom:8,paddingBottom:8,borderBottom:`1px solid ${P.amber}33`}}>
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
                    <div style={{background:P.violetSoft,border:`1px solid ${P.violet}44`,borderRadius:10,padding:"10px 12px"}}>
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
                    <div style={{background:P.amberSoft,border:`1px solid ${P.amber}44`,borderRadius:10,padding:"10px 12px",marginBottom:12}}>
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
                  {/* TAs / TAd / FC — 3 colonnes compactes sans overflow */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,marginBottom:4}}>
                    {[["tas","TAs",P.rose],["tad","TAd",P.rose],["fc","FC",P.rose]].map(([k,l,a])=>(
                      <div key={k} style={{minWidth:0}}>
                        <p style={{margin:"0 0 3px",fontSize:9,fontWeight:500,color:P.textSoft,
                          textTransform:"uppercase",letterSpacing:"0.06em",fontFamily:mono}}>{l}</p>
                        <input type="number" inputMode="decimal" value={racsPed[k]} onChange={e=>srp(k)(e.target.value)}
                          style={{width:"100%",minWidth:0,background:P.surfaceAlt,border:`1.5px solid ${P.border}`,
                            borderRadius:8,padding:"8px 2px",fontSize:14,color:P.text,fontFamily:mono,
                            outline:"none",textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                          onFocus={e=>e.target.style.borderColor=a} onBlur={e=>e.target.style.borderColor=P.border}/>
                      </div>
                    ))}
                  </div>
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
                        {pam!==null&&localMat&&(<p style={{margin:0,fontSize:9,color:"#94B8D0",fontStyle:"italic"}}>Objectif hors TC {">"} {localMat.pamHTC} · si TC {">"} {localMat.pamTC} mmHg</p>)}
                      </div>
                    );
                  })()}

                  {/* ADRÉNALINE IVSE — paliers cliquables + vitesse éditable */}
                  {localMat && (
                    <div style={{background:P.roseSoft,border:`1px solid ${P.rose}44`,borderRadius:10,padding:"10px 12px",marginBottom:10}}>
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
              setModalRacsPed(false);
            }} style={{width:"100%",background:"linear-gradient(135deg,#3EA876,#2A7D57)",
              border:"none",borderRadius:14,color:"#fff",fontSize:14,fontWeight:600,
              padding:"14px",cursor:"pointer",fontFamily:sans,marginTop:12,flexShrink:0}}>
              ✓ Enregistrer
            </button>
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

      {/* Header */}
      <div style={{background:P.surface,borderBottom:`1px solid ${P.border}`,
        padding:`${alert?"56px":"14px"} 16px 14px`,boxShadow:"0 2px 10px rgba(0,0,0,0.04)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <button onClick={onBack}
              style={{background:"transparent",border:"none",color:P.textMid,
                fontSize:22,cursor:"pointer",padding:"0 6px",lineHeight:1,fontFamily:sans}}>‹</button>
            <div>
              <p style={{margin:0,fontSize:13,fontWeight:600,color:P.text}}>ACR Pédiatrique</p>
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
          <span style={{fontSize:11,background:P.amberSoft,color:P.amberText,
            padding:"3px 10px",borderRadius:20,fontFamily:mono}}>Pédiatrique</span>
        </div>

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

        {/* Chronomètre */}
        <div style={{textAlign:"center",marginBottom:12}}>
          <p style={{margin:"0 0 2px",fontSize:10,color:P.textSoft,letterSpacing:"0.1em",
            textTransform:"uppercase",fontFamily:mono}}>Début RCP médicalisé</p>
          <span style={{fontSize:58,fontWeight:300,letterSpacing:"-0.03em",
            color:running?P.text:P.textSoft,fontFamily:mono,lineHeight:1}}>{fmtSec(sec)}</span>
        </div>

        {/* Minuteur Adrénaline pédiatrique */}
        {adrTimerStartPed > 0 && running && !events.find(e => e.id === "rosc") && (
          <AdrenalineTimer
            startSec={adrTimerStartPed}
            intervalMin={adrIntervalPed}
            setIntervalMin={setAdrIntervalPed}
            onAdminister={() => { addEvent("adr",`Adrénaline ${localMat?.adrenalineMg||""}mg IV/IO (10μg/kg)`,"💉"); setAdrTimerStartPed(Date.now()); }}
            onCancel={() => setAdrTimerStartPed(0)}
            running={running}
            P={P} mono={mono} sans={sans} fmtSec={fmtSec}
          />
        )}

        {/* Compteur chocs cumulés + rappel Amiodarone */}
        {(() => {
          const chocsSmur  = events.filter(e => e.id === "choc").length;
          const chocsPomp  = parseInt(transPed.chocsPompiers) || 0;
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
                      ({chocsPomp} pomp. + {chocsSmur} SMUR)
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
                <div style={{gridColumn:"1 / -1",background:"#FEF3C7",
                  border:"1.5px solid #F59E0B",borderRadius:10,padding:"8px 12px",
                  display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:18}}>💊</span>
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{margin:0,fontSize:11,fontWeight:700,color:"#92400E"}}>
                      Rappel : Amiodarone {localMat.amio} mg ({localMat.amioMl} mL)
                    </p>
                    <p style={{margin:0,fontSize:10,color:"#B45309"}}>
                      Après le {showAmio1 ? "3ᵉ" : "5ᵉ"} choc cumulé · 5 mg/kg · {localPoids} kg
                    </p>
                  </div>
                  <button onClick={() => addEvent("cord",`Amiodarone ${localMat.amio}mg IV/IO (5mg/kg)`,"💊")}
                    style={{background:"#F59E0B",border:"none",borderRadius:7,
                      color:"#fff",padding:"6px 10px",fontSize:11,fontWeight:600,
                      cursor:"pointer",fontFamily:sans}}>
                    Administrer
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* Encarts No-flow / Low-flow indépendants */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          <div style={{background:P.surfaceAlt,borderRadius:10,padding:"7px 10px",border:`1px solid ${P.border}`}}>
            <p style={{margin:"0 0 4px",fontSize:9,color:P.textSoft,textTransform:"uppercase",
              letterSpacing:"0.09em",fontFamily:mono}}>No-flow</p>
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <input type="number" min="0" max="60" value={noFlowMin}
                onChange={e=>setNoFlowMin(e.target.value)} placeholder="—"
                style={{flex:1,minWidth:0,background:P.surface,border:`1px solid ${P.border}`,borderRadius:7,
                  padding:"5px 4px",fontSize:17,color:P.text,fontFamily:mono,outline:"none",
                  textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                onFocus={e=>e.target.style.borderColor=P.rose}
                onBlur={e=>e.target.style.borderColor=P.border}/>
              <span style={{fontSize:9,color:P.textSoft,flexShrink:0}}>min</span>
            </div>
            <p style={{margin:"3px 0 0",fontSize:8,color:P.textSoft,fontStyle:"italic"}}>Sans massage</p>
          </div>
          <div style={{background:P.surfaceAlt,borderRadius:10,padding:"7px 10px",border:`1px solid ${P.border}`}}>
            <p style={{margin:"0 0 4px",fontSize:9,color:P.textSoft,textTransform:"uppercase",
              letterSpacing:"0.09em",fontFamily:mono}}>Low-flow</p>
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <input type="number" min="0" max="240" value={lowFlowMin}
                onChange={e=>setLowFlowMin(e.target.value)} placeholder="—"
                style={{flex:1,minWidth:0,background:P.surface,border:`1px solid ${P.border}`,borderRadius:7,
                  padding:"5px 4px",fontSize:17,color:P.text,fontFamily:mono,outline:"none",
                  textAlign:"center",fontWeight:600,boxSizing:"border-box"}}
                onFocus={e=>e.target.style.borderColor=P.blue}
                onBlur={e=>e.target.style.borderColor=P.border}/>
              <span style={{fontSize:9,color:P.textSoft,flexShrink:0}}>min</span>
            </div>
            <p style={{margin:"3px 0 0",fontSize:8,color:P.textSoft,fontStyle:"italic"}}>Durée MCE</p>
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
          <span style={{fontSize:10,color:P.textSoft,fontFamily:mono}}>Cycle RCP · 2 min</span>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:10,fontWeight:500,color:warn?bar:P.textSoft,fontFamily:mono}}>{warn?`⚠ ${rem}s`:`${rem}s`}</span>
            <button onClick={()=>{setCycleOffset(sec);addEvent("cycle","↺ Cycle remis à zéro","↺");}}
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
          Nourrisson : 2 doigts · 4 cm · 15:2 · 100–120/min
        </p>
      </div>

      <div style={{padding:"10px 12px 0", boxSizing:"border-box", width:"100%"}}>

        {/* Rappel doses + matériel */}
        {localMat && (
          <div style={{background:P.amberSoft,border:`1px solid ${P.amber}44`,borderRadius:12,
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
            <p style={{margin:"8px 0 0",fontSize:9,color:"#9B2C2C",fontWeight:600,
              lineHeight:1.4,borderTop:"1px solid #F5C99E",paddingTop:6}}>
              ⚠️ Doses à recalculer et vérifier avant administration — le praticien demeure seul responsable.
            </p>
          </div>
        )}
        <Collapsible icon="🪪"
          title={patPed.nom ? `${patPed.nom} ${patPed.prenom}${patPed.ddn ? ` · ${calcAge(patPed.ddn)||patPed.ddn}` : ""}` : "Dossier patient"}
          badge="éditable">
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
                  <p style={{ margin:"4px 0 0", fontSize:11, color:P.amber, fontWeight:600 }}>
                    → {calcAge(patPed.ddn)}
                  </p>
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
        </Collapsible>

        {/* Bandeau Transmission équipes en place — pédiatrique */}
        <button onClick={() => setModalTransPed(true)}
          style={{ width:"100%", background: transPed.saved ? P.greenSoft : P.amberSoft,
            border:`1.5px solid ${transPed.saved ? "#A6D6B0" : "#F5C99E"}`,
            borderRadius:12, padding:"10px 14px", cursor:"pointer", fontFamily:sans,
            display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
          <div style={{ width:24, height:24, color: transPed.saved ? P.greenText : P.amberText, flexShrink:0 }}>{ICONS.transmission}</div>
          <div style={{ flex:1, minWidth:0, textAlign:"left" }}>
            <p style={{ margin:0, fontSize:12, fontWeight:600, color: transPed.saved ? P.greenText : P.amberText }}>
              {transPed.saved ? "Transmission équipes enregistrée" : "Transmission équipes en place"}
            </p>
            <p style={{ margin:"1px 0 0", fontSize:10, color: transPed.saved ? P.greenText : P.amberText, opacity:0.85 }}>
              {transPed.saved ? "Cliquer pour modifier" : "Recueil pré-SMUR (pompiers, témoin, DSA…)"}
            </p>
          </div>
          <span style={{ fontSize:16, color: transPed.saved ? P.greenText : P.amberText }}>
            {transPed.saved ? "✓" : "→"}
          </span>
        </button>

        {/* ── Tab bar Actions / Étiologie / Thérapeutiques ── */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,
          background:P.surfaceAlt,borderRadius:12,padding:4,marginBottom:10}}>
          {[
            { id:"actions", label:"Actions",       icon:"⚡" },
            { id:"etio",    label:"Étiologie",     icon:"🔍" },
            { id:"ther",    label:"Thérapeutiques", icon:"💊" },
          ].map(t => (
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

        {/* ── Contenu Actions (grille pédiatrique) ── */}
        {mainTabPed === "actions" && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginBottom:10}}>
          <ActionBtn action={{label:"Analyse de rythme",svg:ICONS.rythme,accent:P.amber,soft:P.amberSoft,textC:P.amberText}}
            onClick={()=>setModalRythme(true)}/>
          <ActionBtn action={{label:"Voie d'abord",svg:ICONS.vvp,accent:P.green,soft:P.greenSoft,textC:P.greenText}}
            onClick={()=>setModalVvpPed(true)}/>
          <ActionBtn action={{label:adrLabel,svg:ICONS.adr,accent:P.rose,soft:P.roseSoft,textC:P.roseText}}
            onClick={()=>{ addEvent("adr",`Adrénaline ${localMat?.adrenalineMg||""}mg IV/IO (10μg/kg)`,"💉"); setAdrTimerStartPed(Date.now()); }}/>
          <ActionBtn action={{label:"Défibrillation",svg:ICONS.choc,accent:P.blue,soft:P.blueSoft,textC:P.blueText}}
            onClick={()=>setModalChocPed(true)}/>
          <ActionBtn action={{label:amioLabel,svg:ICONS.amio,accent:P.amber,soft:P.amberSoft,textC:P.amberText}}
            onClick={()=>addEvent("cord",`Amiodarone ${localMat?.amio||""}mg IV/IO (5mg/kg)`,"💊")}/>
          <ActionBtn action={{label:"Planche à masser",svg:ICONS.planche,accent:P.teal,soft:P.tealSoft,textC:P.tealText}}
            onClick={()=>addEvent("planche","Planche à masser mise en place","🦺")}/>
          <ActionBtn action={{label:"Fast-écho",svg:ICONS.fast,accent:P.blue,soft:P.blueSoft,textC:P.blueText}}
            onClick={()=>setModalFastPed(true)}/>
          <ActionBtn action={{label:"Intubation IOT",svg:ICONS.iot,accent:P.violet,soft:P.violetSoft,textC:P.violetText}}
            onClick={()=>setModalIotPed(true)}/>
          <ActionBtn action={{label:"Soins post-RACS",icon:"🫀",accent:P.green,soft:P.greenSoft,textC:P.greenText}}
            onClick={()=>setModalRacsPed(true)}/>
          <ActionBtn action={{label:"Constat de décès",svg:ICONS.deces,accent:P.slate,soft:P.slateSoft,textC:P.slateText}}
            onClick={()=>setModalDecesPed(true)}/>
        </div>
        )}

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

        {/* Chronologie */}
        <div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:14,overflow:"hidden",marginBottom:10}}>
          <button onClick={()=>setShowLog(v=>!v)}
            style={{width:"100%",background:"transparent",border:"none",padding:"12px 16px",
              display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",fontFamily:sans}}>
            <span style={{fontSize:13,fontWeight:500,color:P.textMid}}>Chronologie</span>
            <span style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{background:P.blueSoft,color:P.blueText,borderRadius:20,
                padding:"1px 8px",fontSize:10,fontFamily:mono}}>{events.length}</span>
              <span style={{color:P.textSoft,fontSize:11}}>{showLog?"▲":"▼"}</span>
            </span>
          </button>
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
                    <span style={{fontSize:11,color:P.textMid,flex:1,minWidth:0,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {e.label}
                    </span>
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

          {/* Horaires */}
          <div style={{background:P.surfaceAlt,borderRadius:10,padding:"10px 12px",marginBottom:12}}>
            <p style={{margin:"0 0 8px",fontSize:10,fontWeight:600,color:P.textSoft,
              textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>Horaires (HH:MM)</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <Lbl>Heure de l'ACR</Lbl>
                <input type="time" value={transPed.hEffondrement} onChange={e=>{stp("hEffondrement")(e.target.value);setLocalAcrTime(e.target.value);}}
                  style={{width:"100%",background:P.surface,border:`1.5px solid ${P.border}`,
                    borderRadius:8,padding:"8px 6px",fontSize:14,fontFamily:mono,
                    color:P.text,outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
              </div>
              <div>
                <Lbl>Arrivée pompiers</Lbl>
                <input type="time" value={transPed.hArriveePompiers} onChange={e=>stp("hArriveePompiers")(e.target.value)}
                  style={{width:"100%",background:P.surface,border:`1.5px solid ${P.border}`,
                    borderRadius:8,padding:"8px 6px",fontSize:14,fontFamily:mono,
                    color:P.text,outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div>
                <Lbl>Pose DSA</Lbl>
                <input type="time" value={transPed.hPoseDSA} onChange={e=>stp("hPoseDSA")(e.target.value)}
                  style={{width:"100%",background:P.surface,border:`1.5px solid ${P.border}`,
                    borderRadius:8,padding:"8px 6px",fontSize:14,fontFamily:mono,
                    color:P.text,outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
              </div>
              <div>
                <Lbl>1er choc</Lbl>
                <input type="time" value={transPed.h1erChoc} onChange={e=>stp("h1erChoc")(e.target.value)}
                  style={{width:"100%",background:P.surface,border:`1.5px solid ${P.border}`,
                    borderRadius:8,padding:"8px 6px",fontSize:14,fontFamily:mono,
                    color:P.text,outline:"none",textAlign:"center",boxSizing:"border-box"}}/>
              </div>
            </div>
          </div>

          {/* Chocs et rythme */}
          <div style={{background:P.blueSoft,border:`1px solid ${P.blue}44`,
            borderRadius:10,padding:"10px 12px",marginBottom:12}}>
            <p style={{margin:"0 0 8px",fontSize:10,fontWeight:600,color:P.blueText,
              textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:mono}}>
              Chocs délivrés par le DSA
            </p>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:14,marginBottom:8}}>
              <button onClick={()=>stp("chocsPompiers")(Math.max(0,(parseInt(transPed.chocsPompiers)||0)-1))}
                style={{background:P.surface,border:`1.5px solid ${P.blue}`,borderRadius:"50%",
                  width:40,height:40,fontSize:18,fontWeight:700,color:P.blueText,
                  cursor:"pointer",fontFamily:sans}}>−</button>
              <span style={{fontSize:32,fontWeight:700,color:P.blueText,fontFamily:mono,minWidth:42,textAlign:"center"}}>
                {transPed.chocsPompiers || 0}
              </span>
              <button onClick={()=>stp("chocsPompiers")((parseInt(transPed.chocsPompiers)||0)+1)}
                style={{background:P.blue,border:"none",borderRadius:"50%",
                  width:40,height:40,fontSize:18,fontWeight:700,color:"#fff",
                  cursor:"pointer",fontFamily:sans}}>+</button>
            </div>
            <Lbl>Rythme initial</Lbl>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5}}>
              {[["choquable","Choquable"],["nonChoquable","Non choquable"],["nonAnalyse","Non analysé"]].map(([id,label])=>(
                <button key={id} onClick={()=>stp("rythmeDSA")(id)}
                  style={{padding:"7px 4px",borderRadius:8,fontSize:10,fontWeight:600,
                    border:`1.5px solid ${transPed.rythmeDSA===id?P.blue:P.border}`,
                    background:transPed.rythmeDSA===id?P.blueSoft:P.surface,
                    color:transPed.rythmeDSA===id?P.blueText:P.textMid,
                    cursor:"pointer",fontFamily:sans}}>{label}</button>
              ))}
            </div>
          </div>

          <Lbl>Note libre (circonstances, témoins, etc.)</Lbl>
          <TArea value={transPed.note} onChange={stp("note")} rows={2}
            placeholder="Ex : noyade, étouffement, trouvé inconscient..." />

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
            boxShadow:`0 6px 18px ${P.amber}33`}}>
            ✓ Enregistrer la transmission
          </button>
        </Modal>
      )}

      {/* ── Modal Constat de décès — pédiatrique ── */}
      {modalDecesPed && (
        <Modal title="Constat de décès" icon="🕊️" soft={P.slateSoft}
          onClose={() => { setModalDecesPed(false); setOmlStepPed(0); setOmlTxtPed(""); }}>
          {omlStepPed === 0 ? (
            <>
              <ChoiceBtn label="Avec OML" sub="Obstacle médico-légal — signalement nécessaire"
                accent={P.rose} soft={P.roseSoft} textC={P.roseText}
                onClick={() => setOmlStepPed(1)} />
              <ChoiceBtn label="Sans OML" sub="Pas d'obstacle médico-légal"
                accent={P.slate} soft={P.slateSoft} textC={P.slateText}
                onClick={() => { addEvent("deces","Constat de décès — sans OML","🕊️"); setModalDecesPed(false); setOmlStepPed(0); }} />
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

      {/* Bandeau fixe régulation */}
      <div style={{position:"fixed",bottom:0,left:0,right:0,zIndex:30,
        background:P.surface,borderTop:`1px solid ${P.border}`,
        padding:"7px 14px 10px",boxShadow:"0 -4px 16px rgba(0,0,0,0.08)"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <button onClick={()=>setModalRegulPed(true)}
            style={{background:"linear-gradient(135deg,#F97316,#EA6010)",border:"none",
              borderRadius:11,color:"#fff",fontSize:12,fontWeight:600,padding:"9px",
              cursor:"pointer",fontFamily:sans,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <span>📞</span> Régulation
          </button>
          <button onClick={() => setShowPdf(true)}
            style={{background:"linear-gradient(135deg,#3B82C4,#2563A8)",border:"none",
              borderRadius:11,color:"#fff",fontSize:12,fontWeight:600,padding:"9px",
              cursor:"pointer",fontFamily:sans}}>
            📄 Compte-rendu
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
          onClose={() => setShowPdf(false)}
        />
      )}
    </div>
  );
}

function ModulePediatrique({ onBack }) {
  const [acrTime,  setAcrTime]  = useState("");
  const [mode,     setMode]     = useState("poids"); // "poids" | "age"
  const [idx,      setIdx]      = useState(0);
  const [showRcp,  setShowRcp]  = useState(false);

  const row   = PED_TABLE[idx];
  const poids = row.p;
  const mat   = calcMateriel(poids);
  const liste = mode === "poids" ? POIDS_LISTE : AGE_LISTE;
  const label = mode === "poids" ? `${poids} kg` : row.age;
  const sub   = mode === "poids" ? `≈ ${row.age}` : `≈ ${poids} kg`;

  if (showRcp) return (
    <RcpPediatrique onBack={() => setShowRcp(false)} acrTime={acrTime} poids={poids} mat={mat} />
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
        <div style={{ width:34, height:34, borderRadius:10, background:P.amberSoft, flexShrink:0,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>👶</div>
        <div style={{ minWidth:0 }}>
          <p style={{ margin:0, fontSize:13, fontWeight:600, color:P.text }}>ACR Pédiatrique</p>
          <p style={{ margin:0, fontSize:10, color:P.textSoft }}>Nourrisson · Enfant · Adolescent</p>
        </div>
      </div>

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
          <div style={{ background:"#FEF2F2", border:"1.5px solid #E53E3E", borderRadius:12,
            padding:"11px 13px", marginBottom:12, display:"flex", gap:9, alignItems:"flex-start" }}>
            <span style={{ fontSize:18, flexShrink:0, lineHeight:1.2 }}>⚠️</span>
            <div>
              <p style={{ margin:"0 0 3px", fontSize:11.5, fontWeight:700, color:"#9B2C2C", lineHeight:1.4 }}>
                Doses et tailles à vérifier systématiquement
              </p>
              <p style={{ margin:0, fontSize:10.5, color:"#9B2C2C", lineHeight:1.5 }}>
                Outil d'aide cognitive — il ne remplace pas le contrôle indépendant.
                Toute posologie et tout matériel doivent être recalculés et confirmés
                par le praticien avant administration. En cas de doute, se référer au
                protocole de service. Le professionnel de santé demeure seul responsable.
              </p>
            </div>
          </div>

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
              border:`1px solid ${P.rose}44` }}>
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
              border:`1px solid ${P.amber}44` }}>
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
              border:`1px solid ${P.blue}44` }}>
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
          <div style={{ background:P.amberSoft, border:`1px solid ${P.amber}44`, borderRadius:12,
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
            background:"linear-gradient(135deg,#D96B6B,#C85050)",
            border:"none", borderRadius:14, color:"#fff",
            fontSize:16, fontWeight:600, padding:"16px",
            cursor:"pointer", fontFamily:sans,
            display:"flex", alignItems:"center", justifyContent:"center", gap:10,
            boxShadow:"0 8px 24px rgba(217,107,107,0.3)", marginBottom:20 }}>
          <span style={{ fontSize:20 }}>🫀</span>
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
            if (t.modal && onOpenModal && ["fast_trauma","thoraco_d","thoraco_g","hemocue","transfusion","exacyl","hemo_ext"].includes(t.modal)) {
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
          boxShadow:`0 4px 12px ${P.violet}33`
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
          padding:"11px", cursor:"pointer", fontFamily:sans, boxShadow:`0 4px 12px ${P.teal}33` }}>
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
  { id:"octaplas",    label:"Octaplas (PFC)",
    indic:"Coagulopathie · transfusion massive",
    dose:"Plasma frais congelé — ratio 1:1 avec CGR",
    logDose:"Octaplas administré", color:"rose", geste:true },
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

// ── APP ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [pat, setPat] = useLocalState("acr_adulte_pat", { nom:"", prenom:"", ddn:"", age:"", sexe:"", temp:"", atcd:"", traitement:"", histoire:"" });
  const sf = k => v => setPat(p => ({ ...p, [k]: v }));

  // Durées manuelles no-flow / low-flow (en minutes)
  const [acrTime,    setAcrTime]    = useLocalState("acr_adulte_acrTime", "");
  const [noFlowMin,  setNoFlowMin]  = useLocalState("acr_adulte_noFlow", "");
  const [lowFlowMin, setLowFlowMin] = useLocalState("acr_adulte_lowFlow", "");
  const [lowFlowStart, setLowFlowStart] = useLocalState("acr_adulte_lowFlowStart", "");

  // IOT data
  const [iot, setIot] = useLocalState("acr_adulte_iot", { cormack:"", sonde:"", repere:"", capno:"" });
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
    hEffondrement:"", temoin:"", mceTemoin:"",
    hArriveePompiers:"", hPoseDSA:"", h1erChoc:"",
    chocsPompiers:0, rythmeDSA:"", gestesSecouristes:"",
    note:"", saved:false,
  });
  const st = k => v => setTrans(p => ({ ...p, [k]: v }));

  // Minuteur Adrénaline (timestamp absolu pour survivre aux navigations)
  const [adrTimerStart, setAdrTimerStart] = useLocalState("acr_adulte_adrStart", 0);
  const [adrInterval,   setAdrInterval]   = useLocalState("acr_adulte_adrInterval", 4);

  // Onglets : "actions" | "etiologie" | "therap"
  const [mainTab,        setMainTab]        = useLocalState("acr_adulte_mainTab", "actions");
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
  const [regulText,   setRegulText]   = useState("");
  const [regulDest,   setRegulDest]   = useState("");
  const [ecgText,     setEcgText]     = useState("");
  const [joules,      setJoules]      = useState("200");
  const [racsTab,     setRacsTab]     = useState("ventil");
  const [racs, setRacs] = useState({
    fr:"", volume:"", pep:"", sat:"", fio2:"", capno:"",
    hypnovelV:"", sufentaV:"", curare:"", autresDrogues:"",
    tas:"", tad:"", fc:"", tempRacs:"", noradrV:"", dobut:"", autresHemo:"",
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

  const addEvent = (id, label, icon, customTime) =>
    setEvents(p => [...p, { id, label, icon, time: customTime || getNow(), sec }]);

  const start = () => {
    const lf = getNow();
    setLowFlowStart(lf);
    setRunning(true);
    setStarted(true);
    setEvents([{ id:"start", label:"Début RCP médicalisée", icon:"🫀", time:lf, sec:0 }]);
    setModalElectrodes(true);
  };

  const confirmIot = () => {
    const parts = [
      iot.cormack && `Cormack ${iot.cormack}`,
      iot.sonde   && `sonde ${iot.sonde} mm`,
      iot.repere  && `repère ${iot.repere} cm`,
      iot.capno   && `ETCO2 ${iot.capno} mmHg`,
    ].filter(Boolean);
    const detail = parts.length ? ` (${parts.join(", ")})` : "";
    addEvent("iot", `Intubation IOT${detail}`, "🫁");
    setModalIot(false);
  };

  const confirmFast = () => {
    const detail = fastResult ? ` — ${fastResult}` : "";
    addEvent("fast", `Fast-écho${detail}`, "🔊");
    setFastResult("");
    setModalFast(false);
  };

  const reset = () => {
    setStarted(false); setRunning(false); setSec(0); setSecStored(0); setModule(null);
    setAcrTime(""); setNoFlowMin(""); setLowFlowMin(""); setLowFlowStart("");
    setEvents([]); setAlert(null); setCycleOffset(0);
    setShowPdf(false); setShowLog(false);
    setPat({ nom:"", prenom:"", ddn:"", age:"", sexe:"", atcd:"", traitement:"", histoire:"" });
    setIot({ cormack:"", sonde:"", repere:"", capno:"" });
    setTrans({ hEffondrement:"", temoin:"", mceTemoin:"", hArriveePompiers:"", hPoseDSA:"", h1erChoc:"", chocsPompiers:0, rythmeDSA:"", gestesSecouristes:"", note:"", saved:false });
    setModalTrans(false);
    setAdrTimerStart(0); setAdrInterval(4);
    setMainTab("actions"); setSuspectedAd([]); setModalEcmo(false); setModalDdac(false);
    setModalFastTrauma(false); setFastTr({ morrison:"", kohler:"", douglas:"", pleureD:"", pleureG:"", pericarde:"" });
    setModalThoraco(null); setModalHemocue(false); setHemocueVal(""); setModalTransfu(false); setTransfu({ cgr:"", pfc:"", plaq:"" });
    setModalExacyl(false); setModalHemoExt(false); setGarrotSite(""); setGarrotHeure(""); setHemocueHist([]);
    clearSession("acr_adulte_");
    setModalCord(false); setModalDeces(false); setModalIot(false); setModalFast(false);
    setModalRythme(false); setModalVvp(false); setModalElectrodes(false); setModalRacs(false); setModalChoc(false); setModalEcg(false); setModalRegul(false);
    setJoules("200"); setEcgText(""); setRegulText(""); setRegulDest("");
    setRacs({ fr:"", volume:"", pep:"", sat:"", fio2:"", capno:"", hypnovelV:"", sufentaV:"", curare:"", autresDrogues:"", tas:"", tad:"", fc:"", tempRacs:"", noradrV:"", dobut:"", autresHemo:"", remplissages:[] });
    setActiveTab("actions");
    setFastResult("");
    setIot({ cormack:"", sonde:"", repere:"", capno:"" });
    setPat({ nom:"", prenom:"", ddn:"", age:"", sexe:"", atcd:"", traitement:"", histoire:"" });
  };

  const cp = (sec - cycleOffset) % 120, pct = (cp/120)*100, rem = 120 - cp;
  const warn = rem <= 30, crit = rem <= 8;
  const bar = crit ? P.rose : warn ? P.amber : P.blue;

  // Pas de tableau ACTIONS_SIMPLE — tous les boutons sont gérés individuellement dans la grille

  const [module, setModule] = useState(null); // null | "adulte_extra" | "adulte_intra" | "pediatrique" | "traumatique"
  const isTrauma = module === "traumatique";

  // États spécifiques trauma (FAST, thoracostomies, hemocue, transfusion)
  const [modalFastTrauma, setModalFastTrauma] = useState(false);
  const [fastTr, setFastTr] = useLocalState("acr_adulte_fastTr", { morrison:"", kohler:"", douglas:"", pleureD:"", pleureG:"", pericarde:"" });
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
      padding:"0 20px" }}>

      {/* Logo */}
      <div style={{ textAlign:"center", marginBottom:44 }}>
        <div style={{ width:80, height:80, borderRadius:24, background:P.roseSoft,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:42,
          margin:"0 auto 16px", boxShadow:"0 8px 28px rgba(217,107,107,0.18)" }}>❤️‍🩹</div>
        <h1 style={{ margin:0, fontSize:28, fontWeight:600, color:P.text, letterSpacing:"-0.02em" }}>
          Copilote ACR
        </h1>
        <p style={{ margin:"6px 0 0", fontSize:13, color:P.textSoft }}>
          Aide cognitive · Arrêt cardiaque
        </p>
      </div>

      {/* Bandeau Reprendre session */}
      {aSessionEnCours && (
        <div style={{ width:"100%", maxWidth:380, marginBottom:16,
          background:P.amberSoft, border:`1.5px solid ${P.amber}66`, borderRadius:14,
          padding:"12px 14px", boxShadow:`0 4px 14px ${P.amber}22` }}>
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

      {/* 4 boutons modules */}
      <div style={{ width:"100%", maxWidth:380, display:"flex", flexDirection:"column", gap:12 }}>

        {/* ACR Adulte Extra-hospitalier */}
        <button onClick={() => setModule("adulte_extra")} style={{
          background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:16,
          padding:"18px 20px", cursor:"pointer", fontFamily:sans, textAlign:"left",
          display:"flex", alignItems:"center", gap:16,
          boxShadow:"0 2px 10px rgba(0,0,0,0.05)",
          transition:"all 0.12s" }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = P.rose; e.currentTarget.style.boxShadow = `0 4px 18px ${P.rose}22`; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = P.border; e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,0.05)"; }}>
          <div style={{ width:48, height:48, borderRadius:14, background:P.roseSoft,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, flexShrink:0 }}>🚑</div>
          <div>
            <p style={{ margin:0, fontSize:15, fontWeight:600, color:P.text }}>ACR Adulte</p>
            <p style={{ margin:"2px 0 0", fontSize:12, color:P.textSoft }}>Extra-hospitalier · SMUR</p>
          </div>
          <span style={{ marginLeft:"auto", color:P.textSoft, fontSize:18 }}>›</span>
        </button>

        {/* ACR Adulte Intra-hospitalier */}
        <button onClick={() => setModule("adulte_intra")} style={{
          background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:16,
          padding:"18px 20px", cursor:"pointer", fontFamily:sans, textAlign:"left",
          display:"flex", alignItems:"center", gap:16,
          boxShadow:"0 2px 10px rgba(0,0,0,0.05)", opacity:0.7 }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = P.blue; e.currentTarget.style.opacity = "1"; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = P.border; e.currentTarget.style.opacity = "0.7"; }}>
          <div style={{ width:48, height:48, borderRadius:14, background:P.blueSoft,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, flexShrink:0 }}>🏥</div>
          <div>
            <p style={{ margin:0, fontSize:15, fontWeight:600, color:P.text }}>ACR Adulte</p>
            <p style={{ margin:"2px 0 0", fontSize:12, color:P.textSoft }}>Intra-hospitalier · SAUV</p>
          </div>
          <span style={{ marginLeft:"auto", fontSize:10, background:P.surfaceAlt,
            color:P.textSoft, padding:"3px 10px", borderRadius:20, whiteSpace:"nowrap" }}>Bientôt</span>
        </button>

        {/* ACR Pédiatrique */}
        <button onClick={() => setModule("pediatrique")} style={{
          background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:16,
          padding:"18px 20px", cursor:"pointer", fontFamily:sans, textAlign:"left",
          display:"flex", alignItems:"center", gap:16,
          boxShadow:"0 2px 10px rgba(0,0,0,0.05)", transition:"all 0.12s" }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = P.amber; e.currentTarget.style.boxShadow = `0 4px 18px ${P.amber}22`; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = P.border; e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,0.05)"; }}>
          <div style={{ width:48, height:48, borderRadius:14, background:P.amberSoft,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, flexShrink:0 }}>👶</div>
          <div>
            <p style={{ margin:0, fontSize:15, fontWeight:600, color:P.text }}>ACR Pédiatrique</p>
            <p style={{ margin:"2px 0 0", fontSize:12, color:P.textSoft }}>Nourrisson · Enfant · Adolescent</p>
          </div>
          <span style={{ marginLeft:"auto", color:P.textSoft, fontSize:18 }}>›</span>
        </button>

        {/* ACR Traumatique */}
        <button onClick={() => setModule("traumatique")} style={{
          background:P.surface, border:`1.5px solid ${P.border}`, borderRadius:16,
          padding:"18px 20px", cursor:"pointer", fontFamily:sans, textAlign:"left",
          display:"flex", alignItems:"center", gap:16,
          boxShadow:"0 2px 10px rgba(0,0,0,0.05)" }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = P.slate; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = P.border; }}>
          <div style={{ width:48, height:48, borderRadius:14, background:P.slateSoft,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, flexShrink:0 }}>🩻</div>
          <div>
            <p style={{ margin:0, fontSize:15, fontWeight:600, color:P.text }}>ACR Traumatique</p>
            <p style={{ margin:"2px 0 0", fontSize:12, color:P.textSoft }}>Trauma · Polytraumatisé · HOTT</p>
          </div>
          <span style={{ marginLeft:"auto", fontSize:18, color:P.textSoft }}>›</span>
        </button>

      </div>

      <p style={{ marginTop:36, fontSize:10, color:P.textSoft, fontFamily:mono }}>
        Usage professionnel exclusif · Outil d'aide cognitive uniquement — chaque professionnel de santé demeure seul responsable de ses prescriptions et décisions thérapeutiques
      </p>
    </div>
  );

  // Module pédiatrique
  if (module === "pediatrique") return <ModulePediatrique onBack={() => setModule(null)} />;

  // Modules non encore développés (intra-hospitalier uniquement)
  if (module && module !== "adulte_extra" && module !== "traumatique") return (
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

  // ── ACCUEIL ACR ADULTE EXTRA-HOSPITALIER ─────────────────────────────────
  if (!started) return (
    <div style={{ background:P.bg, minHeight:"100vh", fontFamily:sans, paddingBottom:40 }}>

      {/* Header avec retour */}
      <div style={{ background:P.surface, borderBottom:`1px solid ${P.border}`, padding:"14px 16px",
        display:"flex", alignItems:"center", gap:12, boxShadow:"0 2px 10px rgba(0,0,0,0.04)" }}>
        <button onClick={() => setModule(null)}
          style={{ background:"transparent", border:"none", color:P.textMid,
            fontSize:22, cursor:"pointer", padding:"0 6px", lineHeight:1, fontFamily:sans }}>‹</button>
        <div style={{ width:38, height:38, borderRadius:12, background:isTrauma?P.slateSoft:P.roseSoft,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>{isTrauma?"🩻":"🚑"}</div>
        <div>
          <p style={{ margin:0, fontSize:14, fontWeight:600, color:P.text }}>{isTrauma?"ACR Traumatique":"ACR Adulte — Extra-hospitalier"}</p>
          <p style={{ margin:0, fontSize:11, color:P.textSoft }}>Copilote ACR · SMUR</p>
        </div>
      </div>

      <div style={{ padding:"14px 14px 0" }}>

        {/* Heure de l'arrêt */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:16,
          padding:"16px 18px", boxShadow:"0 2px 8px rgba(0,0,0,0.04)" }}>
          <p style={{ margin:"0 0 10px", fontSize:10, fontWeight:500, color:P.textSoft,
            textTransform:"uppercase", letterSpacing:"0.09em", fontFamily:mono,
            textAlign:"center" }}>Heure de l'arrêt cardiaque</p>
          <div style={{ display:"flex", justifyContent:"center", alignItems:"center" }}>
            <input type="time" value={acrTime}
              onChange={e => { setAcrTime(e.target.value); st("hEffondrement")(e.target.value); }}
              style={{ background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                borderRadius:12, color:P.text, fontSize:32, padding:"12px 20px",
                fontFamily:mono, textAlign:"center", fontWeight:700,
                outline:"none", appearance:"none", WebkitAppearance:"none" }}
              onFocus={e => e.target.style.borderColor = P.rose}
              onBlur={e  => e.target.style.borderColor = P.border} />
          </div>
          <p style={{ margin:"8px 0 0", fontSize:11, color:P.textSoft, textAlign:"center" }}>
            Laisser vide si inconnue
          </p>
        </div>

        {/* Bouton démarrer */}
        <button onClick={start} style={{
          width:"100%", background:"linear-gradient(135deg,#D96B6B,#C85050)",
          border:"none", borderRadius:16, color:"#fff", fontSize:17, fontWeight:600,
          padding:"20px", cursor:"pointer", fontFamily:sans,
          boxShadow:"0 8px 24px rgba(217,107,107,0.32)",
          display:"flex", alignItems:"center", justifyContent:"center", gap:12 }}>
          <span style={{ fontSize:24 }}>🫀</span> Début RCP médicalisée
        </button>

      </div>
    </div>
  );

  // ── ÉCRAN RCP ──────────────────────────────────────────────────────────────
  return (
    <div style={{ background:P.bg, minHeight:"100vh", fontFamily:sans, paddingBottom:60 }}>

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
              boxShadow:`0 6px 18px ${P.blue}44` }}>
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
          }} style={{ width:"100%", background:P.blueSoft, border:`1.5px solid ${P.blue}44`,
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
            borderRadius:"20px 20px 0 0", padding:"24px 20px 32px",
            boxShadow:"0 -16px 50px rgba(0,0,0,0.2)", fontFamily:sans,
            maxHeight:"92vh", overflowY:"auto" }}>

            {/* Titre */}
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
              <div style={{ width:40, height:40, borderRadius:12, background:P.blueSoft,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🔌</div>
              <div>
                <p style={{ margin:0, fontSize:16, fontWeight:600, color:P.text }}>
                  Vérification des électrodes
                </p>
                <p style={{ margin:0, fontSize:11, color:P.textSoft }}>
                  Confirmer le positionnement avant l'analyse
                </p>
              </div>
            </div>

            {/* Image ERC 2025 */}
            <div style={{ borderRadius:14, overflow:"hidden", marginBottom:16,
              border:`1px solid ${P.border}` }}>
              <img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAH5AlgDASIAAhEBAxEB/8QAGwABAAIDAQEAAAAAAAAAAAAAAAMEAQIFBgf/xABFEAACAgEBBQQHBgQDBwQDAQAAAQIDBBEFEiExURNBYXEGFCIyM1KRIzRTcoHBQmKhsRYk0RU1NnOCkvBDRJPxY4Si4f/EABkBAQEBAQEBAAAAAAAAAAAAAAABAgMEBf/EACMRAQEAAgIDAQADAQEBAAAAAAABAhEhMQMSQVEyYXETBCL/2gAMAwEAAhEDEQA/APZgGAMgwAMgwAMgAAAAAAAAAAAAMamTCMgDBk422dtRwk6qWpXP/wDkslt1Et0v5m0MfCWt89G+5cyn/iLA096f/aePuusvsc7ZOUn3sjO88U+sez2S9JMBvTWa/wCkv42fj5a+xsjJ9O8+fG1dk6pKVcnFrvTF8U+Hs+jmTz2xNuu5rHy5e2+EZdT0JxyxuN1W5dgAMqAAAAAAAAAAAAANd5KSj3s2IZfeq/yv9iYAAAAAAAAAAAABhvQAYlJQTlJ6Jd7OJn+kdePdKqmHaOPBvuODn7Xyc56TluQX8MTpj47WblHrLNsYVctHfFvw4ktG0MXIelV0W+mvE+fmYycXrFtPwZ0/4xn2fSDJ5HZO37KJKrKk518lLvR6uuyNsFOElKL4po45Y3HtuXbcAGVAAAAAAAAAAAAAAAAAABgyDAGQYAAAAZBgAZBgyAAAAAAAAAAAAAAYRkwjIFbaF/q2FdaucY8DwFk5WTc5vWTerZ7nbcXLZWRp8p4rFxbcu1V1Rbfe+h6PFqS1zy7W9iYfrWYt+OtcVrIk2zst4drsqWtUv6HotnYMMHHUI+8/efVli6qF1cq7IqUWuKZm+T/62168PAA6G1Nl2YVjcU5VPlLoc87yy8xzs0zFuMk09GuR7vZGX65g12P3ktJeZ4M9P6JWN13V68nqc/LNzbWPb0YAPM6AAAAAAAAAAAAACGf3qv8AK/2JiGf3qv8AK/2JigACAAAAAAAAAcn0gz/U8Pcg/tLOC8EdY8X6SXu3aUo68K1um/HN5M5XUcpJzlouLYlFwk4yWjXNM6mxMRWWO6a4R5eZPtnBcvt6o8f4kjtfLJn6s+l1twwAdWQ9B6N7ScLViWv2Ze74M8+SUWOq+E4vRxkmZym5ol0+jA0qmrKozXJrU3PG7AAAAAAAAAAAAAAAAAAAAADAMgDAAAAyYAAGQAAAAAAAAAAAAADCMmEZAiyK42Y9kJcYuL1KWBi1Y+PDsoJarVvvZ0LPhy8mVcf7vX+VF3wJAARprOEbIuM4qUX3M5Gb6P02xcsf7OfTuZ2QWZWdJZt4G+izHtddsWpI9B6PUX4alfZD7Oa5d508zZ1OXZXOaW9B6+ZPc92rdiueiSOuXk9ppiY6W4tSSa5MyawjuQjHotDY4tAAAAAAAAAAAAACGf3qv8r/AGJiGf3qv8r/AGJigACAAAAAAAAAfP8AaEndn3SS1bkz31kt2uTfcjxux0p7QtlLi+On1OmF9ZazZu6dPZtXZYVceq1LTWq0YB5bd3bvJqOffsmi2cpr2W1yRwciiePc65riv6nripn4MMuvpNLgzt4vNZdVzyw308uDMouMnF809DB7nB7rYl/b7MpffFaM6B5z0TyNYXUN8nvI9GePOaydZ0AAyoAAAAAAAAAAAAAAAAAAAAAwZAAAAADAAGTAAyAAAAAAAAAAMIyYRkDWa1g11RVo+Eo/L7JcKiW5fZHuftIDcABoAAGls3CGq5t6I3qonvqdzTa5JckR2cZ1x/mTLgZoAAAAAAAAAAAAAAACGf3qv8r/AGJiGf3qv8r/AGJigACAAAAAAAACvnS3MK6XSDPD7PtlXnQlF6avRntNrvTZmT/y2eDqn2dkZ9GmdvHN41jK8vYg0psVtUZx5SWpueK8PQAAg85tnH7HK30vZnxOed7bzXq8F37xwT6Phu8I82c1XU9HbnVtOC7pJpntj5/syW5tCh/zI+gGPLOVx6AAcWwAAAAAAAAAAAAAAAAAAAAAAAAAAAABgGQAAAAAAAAAAAGEZMIyAK2TFqUbUtd3g0uhZAFVWQa1Ul9TWd0I9+r6Lib5NFcqpNRSa46o1qjFQjKMUtUFax7WbUpexHp3koAEdr3ZVz6SSZcK0oqcXF8mZx7Xr2Vj9tcn1QSrAAAAAAAAAAAAAAAAIZ/eq/yv9iYhn96r/K/2JigACAAAAAAAACntaDs2bkRitXuPgeB5cz6S1qcTaPo7VkydlEuym+a7mdfHnMeKzlNufsLIUqXTJ8YvgdU4Etj7RxLda63JrviW8e/P7WNeRW64v+Jo5+Tx7vtK1jl8rqNqK1b0NI2OcvZi93qYVS11m3J+PIkPPw6uLt/X7PocY9LtbGeRjLcWsovgUKfR7Nt0bUYJ97Z7fDnPRwzl9nOxXu5VT6TX9z6HB6wi+qOLgejlOPJWXy7SS4pdyO2lotETyZTK8GM0yADk0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADCMmk7I1wcpcis+0u42Nxj8qAsytrj704rzZFLKhrpBSm/BcPqaRqhFabqfnxMyjrHdhLcfggaR29rbXLfe6tH7MTelaUwX8qNNba+f2i+jJK7FYnprw56lVsARPIjrpBOUuiIJTWcI2LSS1I+znbxsekflRJCuNa0jr9QMJ3V+7NSXSXM29Zmvfqa8nqZA2aZWXU3p7S84tEsbIT92Sl5Mha158TSVMJd2j8OATS2CpG2dPCz24fN3otJprVPVAZAAAAAAABDP71X+V/sTEM/vVf5X+xMUAAQAAAAAAAAADDaXNpAZKu0EvV+X8S/ub25dVXBy1l0RSvvnkaJrchrrp3slulkaAA4Og1qtGS4+VKhbk05V9zXNEQNS6Szbp13V2L2JJ+GpIcdwi/Dy4G0ZWw9y2S/qbmcZ9a6wObHKyI98Z+fAlhnpPS2Dj/ADLkallTVXQawnGyO9Bpo2KgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACpP7TIafuw7vE3I6eLm/5mSCrBvRanFndY7pyjZJe09NH3HWyJ7lE5PuRxIpqK15m8IlWIZmRD+NSXiuJNHabS+0q0XVPUpGYR37IQ+Z6G7jGdu6nqk+oC5A4tgACgAAAAA+K0ZpTJ02Kt+5L3fB9Dc0ti5waT0fc+jESrYI6LO0qjIkCAAAAACGf3qv8r/YmIZ/eq/yv9iYoAAgAAAAABHddGmG9N+S6khyrbHfc5v3VwiiW6WTbaeVda+D7OPRc/qRSTl785S/M9TJWzHq4Q8dWYluV01ZJEm7KpvdSlHp3o2V0O97r/m4FNOUfcnKK6G6usXNRl5m74qkyi4aSsaeig2KbO0rUtNNTc49No9bZdyh48zeEd1c231ZkDYAAgAABCU6Zb1XDrHuZ0qLo3170f1XQ5ptTb2Fyl/DLhI6Y5fKzlPrqgA6MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACnTzn+ZkhHX79i/mNpTUNNe96CrFbaU93H3fnehzC9tRS9h6ewub8SidcOmb2E+DDfy49IrUgL2zIfEn4pIuXESOgADi6AAAB66PTiwYjJTjrHigjWu1TbXFSXNM3I7a3Jb0eE48mbVz7SCly6roBsAArWh9ndKHdPivMtFO5NJTj70Xw/ctxeqT6hlkAAAABDP71X+V/sTEM/vVf5X+xMUAAQAAAAAEeQ92ixruizlw91HTyfu1v5WcyHuryMZ9NYslK572RJ9FoW4T397hwT0KKe85S+Z6mvFOTO8MmJcIvToZGm9KK6tHovEc1ymO7VFeBuOXAHhvLuAAgADlzAapMGs4Ka0ZrCTjLcnz7n1KJBJb0WgAL+Hb2tC196PBlg5uJPs8nT+Gz+50jtLuOd4AAVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVIcLbV4o1u4zrXjqbcsi3x0NbPj1fqX6qSUVKLUlqmcnIxZV5MaqdGpptJ9x0bsqmhpW2Ri3yTZDS1dnTsi9YwikmvEuO4lRV7Nk+NlmnhEu0Uwor3ILRcyQEttXQACKA1VkHLdU1vdNTYI0vnuVSa56cDlrKtrsfZyThHgk+8t59u7HRd3H9ehzUtEdMZwza6dOfXZpGfsS8eRIn2d3P2J8vM5GmvM3pdkpxrhN7mq1XToLibdsGlc3ruT4TX9SaEdeL5HNpmENeLJAAgAAAAAhn96r/K/wBiYhn96r/K/wBiYoAAgAAAAAI8jjRZ+VnK10r16I61y1qmvBnIfGp+TMZtYlK+yT68WV7qdxuVfFd66FmvjVHToc7GxsmrIustlrBxffzGF1bdrW0Jdp8NOXkT00z7VTktEjfB+7R/UnNZ+S9JMfoAaVSck2+pxbbg51mddHaCoVesOp0S3GxJdhSvlq3DV8X/AELrenE50XvzlLu1aR08U3UyvDeFllfuvVdGSyvjZHR+xNcVqQms2lB6na+OVzmVi/XNTgpI2IceiWPj1yfuz4+TJjy5TVdZdw3ZSaUPe14HWXJalbEq0W/Lm+RaOmPTOXYADTIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANVFcXpxKuemlXKC4qRbRFlQc6m1zj7SLBRyMXFzd2y2Kk4r9Rs2CjVOUVonN6eXcTSqhbW5aaSa5rgytgURlQ/bsWkmuEi/D6vgjhSoS1UpvzlqSGVAaTqU3rvST8Ga9nauVv1iBRexa3mPIV1i9re3deB0ZzVcNWablv4q/wC0zGlb29OTk/HkW3fY5mZJuai+b9qS6dCAlyVJZVm/zb4eREdp0wF7ZtWtkJNc9W/2KKTlJRjzb0O3hVqO81yXsr9DOV4InsqhZpvLlyZulotDIOTQAAAAAAACGf3qv8r/AGJiGf3qv8r/AGJigACAAAAAAxJaprqceHGLXi1/U7JXjh1x6vjrzM5TcWXTl1vs24S/6X4G9i1rkuqZ0niUyWkoJ+ZyvV0pSg5z1i9PeM3HXLUu0WJbGONFc2m1oieCk5b0+HRdCvs+MY1zWnFTlx/Utky7WdBFF9nNxfKT1TJTEoqS0a1MxTdjrrotepkjVc48I2cPFajs5v3rOHgtANMqzdrlGPvNfQqwjuwSLN9P2LUOfN9WQJ6rU9Pi1pyz7DGm/OMer4mSxs6rtcpN8Uv7f/Z0yuozHZVMXjxqmtVu6FSGJZC1Rb3q/mOgDjZtqcMJaLRGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADCMmEZAp4/wAL9X/cgw/s7b6XzU3JeTJ8f4X6v+5DlUz3o30/EhzXzLoX+lWgRUXxvhvR59670yUgAAKAACntKpSodvKVfH9CjCi+xJxqf6vQv5r7SdWOv43rL8q5ltLRaG5lqM63XLpxrap9pZDTRcFrrxOxTX2dUYc9EQJb+TCPdFbxbM27AAEAAAAAAAAEM/vVf5X+xMQz+9V/lf7ExQABAAAAAAAAAOZlLczJJfxR3jplDPju3Vz+Zbv7kvSztzcf7PKurfe1JForZdb4XV+/D+q6E9dkba1OL1TRzvPLc/GwAMKAAAUZxbypV1LVaavwZcsmq65TfJLUhw4NVuyXvWPef7HTG3HlLN8NFjWvnKK/Q6OyqVCEp/on4EE29NFzfBeZ1KK1VVGC7kbmVy7YskSAAqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMIyYRkCnj/AAv1f9yQjx/hfq/7kgqql+PKFnb4/Cf8Ue6RNj5Eb4arhJcJRfNMlK2RjNy7Wh7lq+kvMvfYsggx8lXaxktyxc4snIABpfPs6Zy6JgVsddtmW3PlH2I/uXCvgw3cSvXnJbz82WC3sjFHHIs8NCyVsf49v6FkVAAEAAAAAAAAEM/vVf5X+xMQz+9V/lf7ExQABAAAAAAAAAKm0Y/YKS5xki2RZEd6ia8GBzeaKlf+Vvdb+HN6x8H0LUOMI+RpfSrq3F8HzT6M4zjiulSAgxbnJOuzhZDg/HxJyWaWAAb0WpBVym7ba6F3vel5FpLRJLkirifaTsvf8T0j5Fpm8vxJ+pMavtclfLDi/PuOmVNnw0pc++T1/QtnSTUYvIACoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwjJhBvRNgVMf4X6v+5IR0fCXm/7kgqgACoMjFjdpJNwsjykjSnJlGfY5K3bO590i0R3Uwvhu2R1X9i7/USGltatqlB96KqnbhPdt1sp7p83HzLcJxsipQkpJ96GtCtiXODWNdwsgtIv5l1LZFkY8L46S4SXKS5oghkTx5KvL5fw2Lk/MdnS3jfGu81/YslSLUciE0/ZmtC2RAAAAAAAAAAAQz+9V/lf7ExDP71X+V/sTFAAEAAAAAAAAAxL3Xr0MlbNu7KrRcZT4JAUIcn5syYitIpGThe3WK+TS21dVwsj/VdCSi6N9e8uDXBroyQq31Tqn29C/NHqanPFTpaIcubhjTa56aI3qtjdBSg9f2I8yDnjy3Vq1x0JO+S9JKIKumMF3I3fJmlNsba1KLNyXtV/Bf8AlYeCLBT2fP2J1vmnqvIuHdyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABhGl73aZv8AlZuiHMelSXWSQGlS0rj5GwS0SQCgIsl3KmTx0pWdyfI2odjqi7klPTikBuAAo1qtGVJ4kqpOzEluPvg/df8AoWwJdIrU5kZy7O1dlb8r7/IsThGyLjJKUX3M0tprujpZFMr9nk43wpdtX8snxX6l4o0uxrqIN40t6K47ku7yZdxc6rJit17s9OMZc0QQzKp+zN9nP5Z8DevGqvp3Zx4wbSkuaL/qLwKGuVic9cirr/Ev9SxTlU3vSE/a74vg/oTQnABAAAAAAQz+9V/lf7ExDP71X+V/sTFAAEAAAAAAAAA5V0+1yJy7o+yjpze7BvojkV+4tTOV4ax7bAA4too3OV8q+zklH+JrgyUAtFW2mVM3dQvzQ6k1N0bob0f1T7iQr3Y73u1oe7Z07pGt77TprZVOibtoWqfvQ6+RNTdC6O9B+a6GlOSpvcsW5Z8r7zF2NrLtKXuWdVyfmW/lP8Wa59lfCa5a7r/U6x55ZLSdeRHs59z7mdzGsVtEJrvRrHemKlABpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGEQZfF1x/m1J0RXVynZW1yjrqBqDfs5eA7OXgFaA37OXgOzl4AaA37OXgOzl4AaA37OXgOzl4AaA37OXgOzl4AQW012rSyCfj3larFspvlHGulBNaqMuKZ0Ozl4Gjqn20JrTSOuvEsqVD2+ZV8THVi61v8A1EHRlXLeplXYuPHg/wCheA2gACKAAAAAIZ/eq/yv9iYjlBu+M+5JokAAAAAAAAAAACHKemNY+kWc2PCKOnkwlZj2QjzlHRFVYdmi5fUxlNtYq4LPqc+qHqc+qMeta3FYFn1OfVGfU5fMh603FUFr1OXzIepy+ZD1puKN1ELl7S0a5Nc0QdpdjcLF2la/iXNeZ1fUn8yM+pP519DUl6qbjnp05NfdOLN8KGTjwn6vJWVwlp2cuf6Etmx4TlvQm659Y8DONRm4k5LSF0ZPVvXdaOmM0zbtZx86u57j1rtXOEuaLRBdjV5MErYLe6rmv1K8KcvGklVNXV68pvRr9S8Mr4MIyRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMarqgMgAAAAAAAAAAAAAAAAAAAAABFZkVVe/ZGP6gSggrzMex6Qti35k2uoGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5+0NrUYK0k9Z9ETbQyViYllr5pcPM8JfZZk2zslrJvizphh7c1nK6dPK9Icq5tVPciU47VzIy1V0tSmD0TGRz3Xo9m+kUt+NeVxT4bx6WE42QUovVPvPm/I9P6M57nF41j1a905eTCa3G8cnowAcGwAAAAAAAAAAAAANLLI1Vuc3olzNzgek+W6qY0RfGfFmsZu6S3SjtD0husnKGO92PLU41uRbc9bJyl5sjB6pjJ05W7bQsnB6wk0/A6uBt7Ix5KNr34eJyAWyXs2+h4mVXl0xsreqZOeR9Gczssl0yfCfI9ceXPH1unWXYADCgAAAAAAAAAAAFHau0I4GM585vhFFk3wLspKKbk0ku9nIy/SLEx5uME7ZLoebydrZmSmp3PdfcuBRO2Pi/WLl+PV1+lNEpaTonBdddTrYudj5kdabFLw7z58SUZFuPYp1TcZLoavinxJk+jA5extqRz6d2XC2K4rqdQ89mrqunYACAAAAAAAAAAAAB5vb+2LKrfV8ae6170kaxxuV1Et07eZnUYdbndNLou9nDu9Kva+yo4dWzz1t9t0tbbJTfiyM74+KTti5PT4/pTBySvpcV1TO5jZdOXWp0zUkfPCzhZtuFcp1SaWvFdzJl4p8Jk+ggq7PzIZuNG2HfzRaPPZp0AAAAAAAAAAAAAAAAAABwvSmxxw4RXKTK+wMCEsWVlsE9/r0LXpHV21dEFzctC9jVKmiEF3I6e2sNMybqk9h4blruaG8Nj4Uf/STL4Me1/WtRzcvY+NbTJQrUZacGjgbN3sPa0IS4Pe3WexODtXE3Np418VwlNa/U6YZfKzlPr0qMmI+6jJyaAAAAAAAAAAAAAA8X6SWOe0pLuij2h4bb2j2lY0dfF2zl05wAPS5gAAs7NbWfTpz3j6BH3UeC2Ql/tGly5KWp72LUoprkefy9t4sgA4tgAAAAAAAAAAHjfSPKd+c60/ZhwR7Cct2EpdFqfPcubsyrJPvkzt4pztjJCDsbFxIzjK2xap8FqabQ2VKuTsoWsOnQ3/1x9vVPS625QDTT0fAHVlf2LkPH2hU0+Enoz3Seq1PnNUty2Eukkz6Fi2K3Hrmu+KPP5Z9bxSgA4tgAAAAAAAAAAiybVTj2WP8AhTZ8+yLXdfOyXOTbPZ7fs7PZtmj4y4HiD0eKcbc8gAHZkAAHovRXIasspb4Pij1B4bYV3Y7Sr15S4HuUebyzWTpj0AA5NAAAAAAAAAAAAAAAAKEqo33OU+LhLgTkVj7Gc9eT4oki9UmWrGQaWWbjiurMTtUd1pp8dGQSEd1EL0lNcnqiQjlaozcX3LUQSYreko66pPgWCHGi41ceb4kwqAAAAAAAAAAAAADWa1hJLoeO9IKd26FiXNaM9mcHb2LvY8tF7r1R08d1UynDyYAPU5AAA6ewYKWY5NaqMT2WPFxpin0PNejmO5KUtODf9D1KWi0PN5Ly6Y9MgA5NAAAAAAAAAAAgzZbuJc/5WfP92VtrUU22+R7va0t3Z9z/AJTxmzbI15kXPk+87eO6xtYy5r0GDV2WLCLWj04lgJ6rgDxW7u3onSrds/HumpSrWvhw1KGTsTXWWPL/AKWdnUG8fJlj9ZuMryeRiXY2naw0T7z1no5kdts9JvjB6HK27OPYxhr7WuuhY9E5+xdDoz1e1zw3XLWstPSAA4tAAAAAAAAAAA4XpTPdwoR6yPJHp/SyX2dMfFnmD1eL+Lll2AA6IAADaqbrtjOPNM+hYtna49c13xR87PdbEnv7Npf8px8s421i6AAPO6AAAAAAAAAAAAAAAAIcilXQafB6cCKl61pdOBbKM59lkSWnsP8AoUSyhGXvLU1VUE9d03TTWqBFCOmmNtsrJLk9BdZuxajxk+RLhrTHhrza4lSplwMgEAAAAAAAAAAAAAAI7q421yjJapokAHgto4M8a1vde43wZSPdumu7tI2RUo7z01KN+wMa1tx1h5Honln1i4fjyRNi4tmTZuwi2u9noIejdKlrK1teR0qsOnFpcaopcOLLfLPhMKsbPojj4lcIpLRcS0aU8ao+Ruee9tgAIAAAAAAAAAAA523Xpsy08N3nuduxctmWpHhj0eLpzy7ep2bcrsSD11aWjLMoqS0fI85svN9Wt3Zv7OX9D0cZKcVKL1TPL5cLjk7YZbjEa4weqX9TZtRTb5IHP2tkurHca+b4NmMZcrpq3UcXPu7fKnLu14HX9FH9vajz56D0UX29p78prDTzy7r1QAPK6AAAAAAAAAAA8x6WP26V4HnD0vpZCTdM9Hu6aanmj1eP+Lll2AA6IAAAe19HXrs2B4o9r6PLTZsDl5emse3VAB5nQAAAAAAAAAAAAAACOdsILiwNpyUIuT5IqwW/vSkveMycrnrJaQXd1N+QWIuylF/Zy0XRjdtf8SRKBsaRqUU+9vvZviySh2b4OINZw3uKekl3gWgV4ZGj3bFo+pOpKXJ6hGQAAAAAAAAAAANJ2wguLA3IbrlBaLjJ9xpK6dnCtaLqzEIKPHm+oCuO7FLvNgAoYktU11MgKY89F2cuDXIsFWcFLiuDXJmY3Sr4WLVdUVlZBpCyM17LNyAAAAAAAAAAANZwjOLjJap80cPM9GabZOWPN1t9z5HdckubRpK+qC1lNIsys6Szbx9/o/mUJy0jOK70zq0UyrqioPR6cU+RdyMh3vditK1/UiM+TyXLhvHHSPdslwlJJfylDbFLeNBVxb0fcdMw1ryejXFHPHL1srVm48msS98qZ/8Aaz0Hozi3UWWStrcU+Wp16s2KSVy3Wu/uLMLq5+7NM9V8vtNOMx0kBjXUycmgAAAAAAAAA1lOMVrJpAa3UV31uFsFKL7mcXK9GKLG5UWSrb7nyOw8qhc7Ykc86pL7N78uiLMrj0mtvLZPo/kY8klZCevQrvY+Uv4U/wBT0spSsm5z5v8AoYF8+XxqeOPMPZWWv/S/qjEdmZcpOMaW2vE9QIuUJqcHo1/Us/8ARfqXxx5yOxM+XKh/VHq9j41mLhQruWkl3G8M+GmlkXF9e4mhlUzekbIsuXkuUSY6TAwmnyMmFAAAAAAAAAAAfAhnkRT0it5+BHObuk1F6QX9TMYqK0SA1crJ8ZS3V0EYQXFPV9WbSipLR8jTsV3NoKkBF2L/ABJDsWuVjAlBpFz0akuPczEZzcknDTqwJARyjOUuekTHYv8AEYEjSa48TTcSfsS3X5mOxf4kjaNMU9eLYG0bpw4WLVdUTwnGa1i9SE0cGnvQejBpbBHTb2kePBrmiQIAAARWXRr4c30RtdPs4N9/cV4R/ilxkwDdtnN7q6GVXFceb6s2A2oAAoAAAAAAADR1xfFcH4BStr799G4G003rujPhyfRkpVnBS4rg+5klFjmmpe9HmETAAAAYfIDS66NMN6T8l1OfZfbc3rJxj0Riybutc3y7l0NTnll8jcjXs4dDVuMHoov6EgMba007Vd8ZL9DaMlJarX9TIAGnaruUn+hu2lzehjej1X1EGnarvjL6GyUJrXd+vAzvL5l9TPMDMZTr+HNx8O4vYuR2y0lwmuaKBmEuztjNeT8jeOX6zY6wMJ6rUydGAAAACHKsdVDa5vgBFk5e69yrjLvfQpNb73ptyl1YitF4mTlctukhol3AAyoACAAABhxT5oyCjMJzpetbaXy9x0qLVdWpL9TmE2HPcucO6XE3jl8rOUdEAHRgAAAAACLJlu1PTv4EpXyuKjHq9QMQW7FIyAFAAFAAAI77Oyqc0tdCQgzfu0hO0VP9o2fIh/tGfyIpg7esY3XTxcx3WODjpw1LZy9nfeX+U6hzymq3AAGVaxe5en3S4MtFO7lH8yLa5BlkAAVsh62wh3czJrZ95XkbCrAABQEOVY6qJTjzRQWdf1RZjalunVNVNObj0OZ6/d4EuFkTtyJKfetS+tibXZT0sjHqbkV3CcJeOhKZUAAUAAA1hwyVp/EuJsaS9m2uX6CJVsABA0telcn0RuR5HwJ+QHLjyMhckDhe3UABAAAFbMSe6mV9yPyosZfOBCevxfxcsu2rhHR+yi5i/BRVfJlrG+BEnm6XDtKYktYtGQ+R5nR0cWW/RCXgTFbAf+XiuhZO7kAAAVNoP7KK6stlPaHuw8xVioADzugDEnuxb6FdZev/AKcvqamNvSWyLOq107wVfWftN7s3pp1Jar1ZJrdaa6luFhLKlbS5g1tXsa9OJmL1imZVkAEAJ7tkJfzJAxLufR6mp2Xp10ZNYPWKZsdnIAAAAACvk/Er/UsFfJ+JWAAI7W4uMly10YVIAAAAChXzvu0vNFgr5ybxpaLXiiztK5IAO7C1s77y/wAp1DmbNX28n3aHTOOfbUAR3SaSiucuBvFbsUjKtLuUfzItrkipdyj+ZFtckEZAAFW77zHxibGL/vMPymRVjCkm2lzRkifs3p90kSgVtofdJfoco6u0PusvNHKOuHTNC1s77y/ylUtbO+8PyLl0k7dC9exr8r1N4vWKYkt6LT7zSmXsuL5xOLaQABQ1lNR017zYi97IevKK4BEpHb71f5iQjt96v8whVwABAjuWtM14EhiS1i0ByI8jWxtzjFeZtFaap80zTnd5I4/XT4kBVz8t4lakoOTZNj29vTGejjr3Met1td86SAAyK2X70CEuzrjYtJLUqX1SpW8vajrp5Hp8ec1pzyl7aPky3jfAj5EdeMmt6x73fouRDjZ6sypUKtxS5Mmd95wYzXa5ZwlF92vE3I7vc/VEi5I4fHRdwPhNdGWins9+zNfzFw7TpyoACgVNoL7OL6MtlfOi5Y707nqBQMSkopa970MrkR3vSMW/mRwnbq2t+FLyKMfdRdt+FLyKUfdR6PD1XPNkkxviyIyXF+JI35P41nHtaktYtdTSp6x0fNG5HL2Jby5PmeSOyQBPVaoEEcPiz8zeXus0h8Wfmbz9x+Rr6OrX8OPkbkdD1pi/AkOzkAAAAABXyv4H4lgr5Xux8xAI7/gy8iQ0vWtM14BW0OMEZbSWrK9blVFJ8Y9SV7t0HHXg0AhbCzXckpadDcq4eBXiOTg23LnqSysk3pCP6sX+hK2lzD0048iONT13pvVm8oqS0YFPLxIOErIey0tSLFwe0gp2S1T7kWMiNldE9PajobYU1LHj10Nbuk1y3r7KD3IOKfREpSq2dCvKd6nJt9xZnao8Fxl0JVa2tO6tExWjB9unJ6y0LJKI7uUfzItrkipdyj+ZFtckEZAAFW/7zD8psa3/AHmH5TYVYiu96v8AMSkV/wDB5kq5AVtoJvFlotTlLkd5pNaMo5WDFpzre613G8ctcJY55b2am7pPThpzGJhdrCNlr59yOjCuNcdIpJFyy+JI2IrE4T34/qiUHNoT1SYAAEVfxZkpFX8WYEpHbzr/ADEhHb71f5hCrgACAAA5d8dzImuvEgn7NkZd3JlvNX+YT/lIJJNNM5ZdtzpiUYzWkkmvEykktEtEQVxs0ajPk+9am+5Y/es4eC0I0zOxR4R4y6G0Nd32nqzEYRhyX6mxAabWiehBZq4Srs71opE4a1WjEuhDiz36ku+PAkVcIyclFJvv0KsoOjITg92M/pqWN2x87Fp4RNX9SMWSUpxh9SUxXSlj2yXNS5mVyGU0S7T4MtLpx8NToHKpluZEJdz4M6pvHpi9gANIGtkd6uUeq0NgBx4966PQ1sippRfeyRrScl4msu59HqcusnT40nGTqlD+JdxTXD2ZLRruZ0747t2vzrUrZaj2MpSXFcjpjl63TNm5tWbS5k2LGW9KTi0ny1NseiMYKTWsurJxn5N8Qxx1yDmAcG2IxUVojIMT91lEdLbctVo9SU3ur3Oyemns8TQ1lNVJzF7AlrjpPmiyUMCWlk4deJfOk6c6AAoAAAV8ri4LxLBWyPjVrzEGTW34cvI2MT9xhWtXGtGyhFPVLia0/CRuAAAUAAGtkd6uS6ogwJa0KL96PBlkp2J41/aRWtc/e8Cz8RcGi110MQnGcU4vVMyQRf8Auf8ApJSL/wBy/wApKKI7vdj+ZFtckVLvdXg0W48YoJWQABVt45K8EbGr45E/A2FWIsj4eviSrkiPI+E/NG8fdQGSHMluY0336ExUyn2t1dK66yLCp6I7tMV4EgS0WgIAACgAAEVXGc346EreibIqPdb6vUIlNLOM6/zG5pPhZW/EQq2AAgAAKOf8SDK2q5aosZz+1ivArKEU9dOJyz7bx6aQ9myUevEkI58LYvqSGa0AAgAADS2tW1uL/Qjx7W9a7OE4/wBSchyKVOO/F7s48mjU/Kl/XQxq97CevNrUpaScdE9H3lrEylXCNWRHs5dzfJkNiULppPVPijpnOGcby003YrVtuPHVnWqlvVxl1Ry3xRewZb1C15omFMlkAG2QAAcq3hkWLxNZLVNdTNj1um+rMHHLt0nSWz7XErs748ylkvflCpfxPV+RfxdHRfGXJHPxouc5Wy8kdL+sz8WUtFoADi2AAAZjHfthHq9TBNhx3sht8orgax7TLpNnw+xjL5XxKZ1LoKyqUX3o5D39NFomuDN5xnGpqZbmRB9eDOocd6pJ66tNHWre9CL6ouPRl22ABpkAAAqye9kN9yWhZfBFSrjvS6vUCQxL3WZD5MKjx/hIkIsb4KJRQAAUAAANKS0a1QAFWWLKD3see74PkO1yYe/Un4ploF2mlOrIlLIadcl3Fwir+LPzJRSNbVrXLyJ6XrXF+BEZxPh6dGQqcA0telcn4MIr1+1Oc+rNzSr4aNxVR5Hwn+hvF+yvIq5EMlxluyjumIUXWQW/botO4uuBLdkxr9mPtTfJIxjUyhrZZxnLn4G9WNXU9UtZdWSj/AABFAAAAAGJe6/I0o+FE3l7r8jSj4SCJCO7hFS+V6khia1i0BYi9YpmSLHe9TF+BKEAABzs1/5lL+UhJs1f5lP+UhOWfbpj0js9+BIR2fEgiQyoACABzAAxLjour0MmH78PzIs7L06jqjOtQnFSWnJnNztn117s6pTrWujUWdVcjS+HaUyj1R3cnKhDcilvSl4y5lvZ79qyPjwKseRPhvTJ06o549t3p0QAdGAAwByebl5s1UEnrq35iU41uW9JLRsglbPI9mlaR75v9jlZdukvCaneyLpUVv2NdZy/Y2UFXKUI8EmybZdcaYW6dz4si13pSl3Nto3l/FmdgAOLYAABZ2f702VixgPSycf1N4ds5dL5zMmHZ5D6S4nTKmfDWtTXOLOlm4zOKpy91+R0MSW9jw8Foc8ubPf2TXemzGDWS2ADowAADEvdfkVKPhIty4p+RXqgowSco/UDIfJm2i+ZfUaLT3l9QqDG+CiUxVWoQ0co/U30j8y+oGoNtI/OvqNI/OvqBqDbSPzr6jSPzr6gag20j86+pnSPzL6gaA30j8y+o0j8y+oFer4lnmSmK4KM5tyXF8OJJpD5l9RRoZxfdfmbaQ+ZfUVKFaaUlx8QJSO74U/I234/MvqYm4yg47y4rqEQV/Dj5GwhBRilvR4eJtovmX1Co7Pcl5GKfhR8iRxi01vL6iMIxikpLReIGAbaR+dfUaR+dfUDUG2kfnX1GkfnX1A1BtpH5l9TOkfmX1A0BvpH5l9RpD5l9QNHyfkR0e5p0J9IfMvqaV1xgmt9cX1AB8mb6Q+ZfUaQ+ZfUDGL8CPkTGlSjGCjF6pG4QAAFLaEfckuujKp07ao2w3ZciP1OvqzGWO2pdOZLjbHwJS56lXvb2r1M+pw6sz61faKJku+pw+Zj1OHzSHrV9ooRio66GS96lD5pGPUo/Mx609opGJ8It9C96lH5mYlgxlFrefETGpuLNb1ri/A2NYR3YqOvI2OrDl3w7PIku58UYqe7kV+L0L1+PG6UW21p0Mxxq4tPd1a5MzrnbW+NJgAaZCK+lXRUXOcfyvQlAHFuwqqsmWsXLXinLib6aLgdOdMLJKUo6tGOwq+RGMpbWpdKMJbmJNrnN8CNLRJHRnjVzjGKW6o8kjX1SvxGUtJdKAL/AKpDqx6pX4mfSte0UAX/AFSvxHqkOrHpT2igSY0t3Jj/ADLQt+qQ6sRxIRmpJvVFxxsqWyxYNbI79covvRsDow48dVqnzRZwH9pYvIs+rVuyU2tWySMIx91JGZNVq3cbAA0yAAA+KIfVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4MPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAEPqlH4UPoPVKPwofQmAGldNdWvZwUdeeiNwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHN2jtT1W2GPRU78ma1UF3eZ0jgbShfgbYjtGFMrqpR3ZKPNdxZzUqZ5W24LelhUyXyxlx/uXtnZks2iU7KZUzjJxlGXUp0+keDY0pudT/AJo/6HThdXOrtYTjKDWu8nqi3/CJAefxo5W25WXyybMfGUt2EK3o2b12ZOyto04998r8a/hGU+cWPU27oORt2+2mWF2Vkob1yUt16ao6z5Mmhkwcn0evtvwrZXWSskrZJOT14aIo7MltTPonGvJ7OtTetsval5IvqbelMHJuuu2Nsyyd97ybXLSDl4/+Mjp2XmZFcbsnaF8LZLXdhwUSaNu2YOb2t+y9m3WZlqvlW/Yly3l3JlajAyM2qN+Xn2wnNbyhXLRRQ0bdwHH2XkX1Z12z8m3tnBb0LHza8TsCzRFPOuy6p0rFoVsZS0sb/hRcORtu+2m/BVVkoKduklF6argTbZz54WPBUrW+2W7DXu8Rro26Bk4sdj5co79m071c+e6/ZTNs3LytnbNqhZNW5dktyMtOD8Rr8NuwDiLY2W6+0e0r/WNNefs6lnYudZl0WQyFpfTLcn4+I0bdEyecw/8AaGfk5lUMyVdMLWnLnJcXol0NpxydjZ2N/mrL6LpbklPuL6pt6EHM21nW4tdVON8e+W7F9PEry2PlxrdkNo3vIS14v2W+hNLt2wc/Y2fLOxG7VpdXLcnp16nQJeFAV86Fs8O2OO9LXHSL104key68mrCjHMk5XavVuWv9QLhU2nlywsGy+EVJx04PzLZzPSH/AHPf+n9yztL0r17R2vbXGyGz63GS1T3+aLWDk7QtvccvEjTXut7ylrxKOJtmdWJTWsDInuwS3kuD4cy9g7Tll3ut4d1Pst701w8jVn9JFfI2pmLaVuHiY0LXBJ8ZaPTh/qay2zlYkovaGC665PTfhLXQihfVj+k+VO6yNcXWlrJ6ceBttrPozMX1PEavutktFDjpxGv6Nu5CcZwjKL1jJap9Tl5e15LKeLgUPIuXvcdIxLSUsLZWmusqaefikUvRmlR2e7nxstm3J+RJJ2pLM2zSt+zBqnHvVcuJ0MDLWbixuUJQ11TjLmmiyYSS5JIloyc/aO1YYU40whK7In7tcf3OgcHYcVk7RzsuzjNT3Y69y/8AEJPpUvrO22t5YVCXyufH+5Ps/aduTkSxsnGlRdGO9x5NFy7Jox2ldbCvXlvS01NasrGyLNKbq7JpfwyTaRd/0LAORiX2y9IMymVknXGCcYt8FyN/SG62jZkp02SrnvJaxejJrnRtczbL6saU8WtW2rTSL7+Jvjysnj1yuhuWOKcoruZS2rdZVsSdtc5RsUIveT480bxy/V9jQyrW5uNSk9Xxk9Brg2vHNqzbpbduxG12MK1JLTjrw7yni4OZtGqOVk51tTs4whXwSXca7Nqso9Ir67bndJVe+1xa4F1OU29CYORn5ORk7QWz8W3sUo71tnel0RBl4WRs6iWVi59s5V8ZQslqpIaXbpbXybMTZ1t1LSnHTRta947fIey4X0wVt7hGSjyTbKe1r1k+jsrktFOMXp04okyLJ1ejm/XJwnGmOjXNchrhNr+LO2zHrlfBV2te1FdzJTlu63/DvbdpLtew139eOpUwsTO2jh1WX58663H2VDm/FsaXb0AOLsq7Io2jfs/JtdyhHehN89P/ABmczIyMzaLwMW7sIVx3rbFz8kTRt2QcDMxcjZlLy8XOts7PRzhZLVSRPtXadlWzKLsd7kshpKT/AIU1qPU27AOMtkXSgpw2pkOxrXe11izp4sbYY9cb5qdqWkpLvYsExzc7Mza8lUYWJ2r3dXOT0ijpAkVw7Nq5+DKMto4sFTJ6b9b10O1GcZVqafsta6+BxvSK5WUwwalv33SWkV3It5qeLsS2KfGund1/TQ1ZtlVjtPOzbJ/7NxoSpg9O0sem95FjZ2055F9mLlVdjk1rVxT4NeA2BBQ2RRouabf1Kud9n6S4M48HOO6/HmXjo/te2jl5GO64YuM77J69/CPmUbdobWxIdtlYdTpXvbkuKO2c7bmXDH2fZB8bLU4Qj3vUk/Fq5i5EMrHhdU/ZmtVqclbWz7snIqxcOuxUzcW97TvL+yMaWJs2mqxaTS1a6N8Tj4l2Vg5udKOBddG21tOK0XBsSTlKv0Ze1ZXQjbgQhW5JSkp8l1Bvg7Zpy73jzrnRf8k+8Eqx0wARQrLOx3kzx3bGNsOcZcNfLqWShmbIw82bsurasfOcXoyzX0S5ePiTqlLJrq3NOMpJL+pyfR+uU8LNhDXsZSar18v/AKLMfRzDUk5yusS/hlPgdSqqFNarqioQjySWiRd6mmdOR6M2x9Rljt6W1Te9F8zTbMlk7UwMap71kZ70tO5cP9C5l7Gxcu53PfrsfOVctNSTB2XjYLcqYtzlznN6sbm9mr0oekj3Y4dj92FybZ17ciqql2zsjGvTXeb4GMnGqy6ZU3x3oS7ihT6P4VVik1ZalyjOWqX6DjS8ofRjjs+5/wD5pf2Rn0X+42/85/2R0cLBpwapVUKSjKTk9XrxGFhU4NUq6N7dlLee89eIt7JHP9J65S2dGcVqq7FJ+XI6eNkV5GPC2qScZLXh3EkoxnFxmlKLWjT5M5cvR7Ccm4u2uL5xjPRDjWg25pl7Jv7CSs7OSct3jy5kGz9mbLzcSu2EG5OK3l2j1T7+862Lh04dPY0Q3Yc2uerKVuwMKyxzgrKW+arlohL8TTfEwMDEy/8ALpK/dfDfbenkdEpYWy8XBk50Re/JaOUpatoukqxxPSD7xs7/AJ3+hj0iTrswslrWFVvteHL/AEOnlYVOXOqVu9rVLejo9OJNbVC+uVdsVOEuDT7yy9GiFsLK1ZCcXBrVST4HE2/ZGcMPLranVVd7TjxXP/8Awnfo7ha8Hco/IrOB0IYePDF9WVUex003HxQmpTmt1dW6e1U49nprva8NDj+j2tt+dkpNV22+z48W/wByX/DmHr7125r7m/wOnTTXRVGqqKhCK0SQ4k4HI9H/AL1tL/nfux6RfEwP+ev2Oli4NOJO6dW9rdLelq9eIy8GnMdTu3vspb0dHpxG+dprjTmbe+xzcDKl8OuzST6cUdid1cKXdKcVWlrva8NBfRXkVSqugpwlzTOYvR3D3uMrnDX3HPgOLOV5R+jUXKnJv00jba3H/wA/U7ZpXXCquNdcVGEVoku43Jbuk4R3WwoqlbbLdhFat9DGNkVZVStonvwfBPTQzkUQyaJ02a7k1o9HoaYeJVhUKmnXcTb4vUipzmekP+57/wBP7nTIcvGrzMeVN2u5Lno9GWdpUOzpwWz8ZOa+FHv8C0pxk9FJPyZyv8N4HS3/AL2WMLY+Lg3drQp7264+1LXgLom3Njj1ZPpPlQvrjZFVp6SWvHgbZ+JPZOQtoYEPslwtqXLTqdaGDTDOnmR3u1nHdfHhpw7v0LDSkmmtU+aZfZNK1dtW0cFyqlrC2Lj5eDOV6P5SxlZs/Jartrm91S4anUw9nUYM5vH34qfFxctV9DGbszFztHfXrNcpxejG50uqszshVFysnGMV3t6I0xsmvKq7WmW9BtpPTnoc6Po7hKSc5XWJd0p8Dp00149SrpgoQjySJdHKQ87h2rZO2MijIe5Ve96E3yPREGVh0Zle5kVqce7XmvISljXIw8XNUZX1QtUV7LfccfZtVNPpHk146jGtV8FHl3Fn/DmHrwsvUflVnAvYezsXC+71KMmtHLm3+pdyRNObjSVXpRlRm0nZWt3Xv5GfSi6tbOdTnHtJSTUdeOhdz9lY2fKMrlJTitFOD0ZAvR/B7GVbjOTlzm5e19S7nZqm2P8AcFn5I/3RDm1ys9F4qPFqqEv0Wh1MjEqycV41mvZtJPR6Pgb1UwqojTFawjHdSfHgTa6VtlZFd2zaJQkvZgoy48mjn4dsLvSfJnVNTj2Wmqeq7iaXo7hSscl2sIvnCM9EWsbZeLiZDuog4Scd3RPhp5DcTlx8rHx36RWRz0+zuinCW80tdF3/AKHQlsPZkYuUq2o9XY9P7l3MwqM2vcyK1NLk+TXkygvR3C19qV04/LKzgXZprtWFNfo9OOP8JRW7x14am2Z/wy/+RH9i9dg0XYfqsotU6JaRemiRmzDqsw/VJb3Zbqjz46LxJtdOe/8Ahf8A/XLOxP8AdGN+T9yf1Or1L1T2uy3Nznx08zfGohi0Qpq13ILRavVktNOTX/xXd/yV/ZFSzGxn6Q3156e7alKt7zitTurBpjnSzFvdrKO6+PDTyGZgY+dBRyK1LTk+TX6l9k0pT2HsyuDlODjFc27Gl/cnsqwJYdONa4dhNJVqUufTRlePo7hJrfldZFfwys4FzJ2djZWPCm2v2Ie5o9N0b/tdOVl7HWDj2ZGHmXU9nFyUXLg/A6mysizL2dTdavbkuPDnx5lWPo9hprfldZFfwzs4HUhCMIKMEoxS0SXcLSRsc3aW1PVpLHx49rlz92HdHxZ0jnZexcTMyHdcrN9pJ6T0JNfS7+NNm4EcaUsjJtjbl2e9Nvl4It59XrGBfXHi5waWnUo/4cwOlv8A8jOji41eJRGmrXcjy1erLb9Ioejt8bNl116rfqbjJd64le5rL9JqI1+0seGsmu5/+aFrJ2HiX3StTsqnL3uzlpqWcLZ+PgQcaItOXvSb1bG52mq02jtGrArW8nO2fCFa5yZUwMGVl/r20ZxlkP3Ia8K1/qW87ZeNnzhO9T1gtFuy0Kv+HMDpb/8AIxNaOXV3k1qmmka03VXw36bIzj1i9SHCwKcGqVdG9uyer3palKfo7hSk3B21a90J8CcLyrbTlC7b+DChqVsHrNruWuvH9NQdTB2ZjYGrog9985yerYFpIuAAigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIr768eqVlst2KBy/SP7vT+d/wBgc8s7Lp7PD4Mc8d1//9k="
                alt="Positionnement électrodes ERC 2025"
                style={{ width:"100%", display:"block" }} />
            </div>

            {/* Légende positions */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:20 }}>
              {[
                { pos:"Antéro-apical",    desc:"Sous-claviculaire D + apex G", color:P.blue },
                { pos:"Antéro-postérieur",desc:"Sternal + dorsal G",           color:P.teal },
                { pos:"Antéro-latéral",   desc:"Sternal + latéral G",          color:P.violet },
              ].map(p => (
                <div key={p.pos} style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px 12px",
                  borderLeft:`3px solid ${p.color}` }}>
                  <p style={{ margin:"0 0 2px", fontSize:12, fontWeight:600, color:P.text }}>{p.pos}</p>
                  <p style={{ margin:0, fontSize:11, color:P.textSoft }}>{p.desc}</p>
                </div>
              ))}
              <div style={{ background:P.amberSoft, borderRadius:10, padding:"10px 12px",
                borderLeft:`3px solid ${P.amber}` }}>
                <p style={{ margin:"0 0 2px", fontSize:12, fontWeight:600, color:P.amberText }}>Femme</p>
                <p style={{ margin:0, fontSize:11, color:P.amberText }}>Électrode sous le sein gauche</p>
              </div>
            </div>

            {/* Bouton valider */}
            <button onClick={() => {
              addEvent("electrodes", "Électrodes posées et positionnement vérifié", "🔌");
              setModalElectrodes(false);
            }} style={{
              width:"100%", background:"linear-gradient(135deg,#3B82C4,#2563A8)",
              border:"none", borderRadius:14, color:"#fff", fontSize:15, fontWeight:600,
              padding:"16px", cursor:"pointer", fontFamily:sans,
              boxShadow:"0 6px 18px rgba(59,130,196,0.28)",
              display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
              ✓ Électrodes posées — Positionnement vérifié
            </button>

            {/* Bouton ignorer */}
            <button onClick={() => setModalElectrodes(false)}
              style={{ width:"100%", background:"transparent", border:"none", padding:"12px",
                color:P.textSoft, fontSize:12, cursor:"pointer", fontFamily:sans, marginTop:6 }}>
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
              boxShadow:`0 4px 14px ${P.teal}44` }}>
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
                onClick={() => { addEvent("deces","Constat de décès — sans OML","🕊️"); setModalDeces(false); setOmlStep(0); }} />
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
            boxShadow:`0 4px 14px ${P.green}44` }}>
            ✓ FAST normale (rapide)
          </button>

          <p style={{ margin:"0 0 10px", fontSize:11, color:P.textSoft, textAlign:"center" }}>
            ou décrire par site :
          </p>

          {[
            { k:"morrison", label:"Espace de Morrison",  ph:"hépato-rénal" },
            { k:"kohler",   label:"Espace de Köhler",    ph:"spléno-rénal" },
            { k:"douglas",  label:"Cul-de-sac de Douglas", ph:"pelvien" },
            { k:"pleureD",  label:"Plèvre droite",        ph:"épanchement ?" },
            { k:"pleureG",  label:"Plèvre gauche",        ph:"épanchement ?" },
            { k:"pericarde",label:"Péricarde",            ph:"épanchement / tamponnade ?" },
          ].map(s => (
            <div key={s.k} style={{ marginBottom:8 }}>
              <Lbl>{s.label}</Lbl>
              <TInput value={fastTr[s.k]} onChange={sft(s.k)} placeholder={s.ph} />
            </div>
          ))}

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
            <div style={{ background:P.violetSoft, border:`1px solid ${P.violet}33`, borderRadius:10,
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
            const newHist = [...hemocueHist, { val: v, time: h }];
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
              boxShadow:`0 4px 14px ${P.green}44` }}>
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

          {/* Horaires */}
          <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"10px 12px", marginBottom:12 }}>
            <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:600, color:P.textSoft,
              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>Horaires (HH:MM)</p>
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
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div>
                <Lbl>1er choc</Lbl>
                <input type="time" value={trans.h1erChoc} onChange={e => st("h1erChoc")(e.target.value)}
                  style={{ width:"100%", background:P.surface, border:`1.5px solid ${P.border}`,
                    borderRadius:8, padding:"8px 6px", fontSize:14, fontFamily:mono,
                    color:P.text, outline:"none", textAlign:"center", boxSizing:"border-box" }} />
              </div>
            </div>
          </div>

          {/* Gestes entrepris par les secouristes */}
          <div style={{ marginBottom:12 }}>
            <Lbl>Gestes entrepris par les secouristes</Lbl>
            <TArea value={trans.gestesSecouristes || ""} onChange={st("gestesSecouristes")}
              placeholder="MCE, DSA, O₂, garrot, immobilisation, position latérale..." rows={2} />
          </div>

          {/* Chocs et rythme */}
          <div style={{ background:P.blueSoft, border:`1px solid ${P.blue}44`,
            borderRadius:10, padding:"10px 12px", marginBottom:12 }}>
            <p style={{ margin:"0 0 8px", fontSize:10, fontWeight:600, color:P.blueText,
              textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>
              Chocs délivrés par le DSA
            </p>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:14, marginBottom:8 }}>
              <button onClick={() => st("chocsPompiers")(Math.max(0, (parseInt(trans.chocsPompiers)||0) - 1))}
                style={{ background:P.surface, border:`1.5px solid ${P.blue}`, borderRadius:"50%",
                  width:40, height:40, fontSize:18, fontWeight:700, color:P.blueText,
                  cursor:"pointer", fontFamily:sans }}>−</button>
              <span style={{ fontSize:32, fontWeight:700, color:P.blueText, fontFamily:mono, minWidth:42, textAlign:"center" }}>
                {trans.chocsPompiers || 0}
              </span>
              <button onClick={() => st("chocsPompiers")((parseInt(trans.chocsPompiers)||0) + 1)}
                style={{ background:P.blue, border:"none", borderRadius:"50%",
                  width:40, height:40, fontSize:18, fontWeight:700, color:"#fff",
                  cursor:"pointer", fontFamily:sans }}>+</button>
            </div>
            <Lbl>Rythme initial</Lbl>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5 }}>
              {[["choquable","Choquable"],["nonChoquable","Non choquable"],["nonAnalyse","Non analysé"]].map(([id,label]) => (
                <button key={id} onClick={() => st("rythmeDSA")(id)}
                  style={{ padding:"7px 4px", borderRadius:8, fontSize:10, fontWeight:600,
                    border:`1.5px solid ${trans.rythmeDSA===id ? P.blue : P.border}`,
                    background: trans.rythmeDSA===id ? P.blueSoft : P.surface,
                    color: trans.rythmeDSA===id ? P.blueText : P.textMid,
                    cursor:"pointer", fontFamily:sans }}>{label}</button>
              ))}
            </div>
          </div>

          <Lbl>Note libre (intox suspectée, position, etc.)</Lbl>
          <TArea value={trans.note} onChange={st("note")} rows={2}
            placeholder="Ex : trouvé au sol par épouse, suspicion intox..." />

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
            boxShadow:`0 6px 18px ${P.amber}33` }}>
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
            boxShadow:`0 6px 18px ${P.teal}33` }}>
            ✓ Ajouter à la chronologie
          </button>
        </Modal>
      )}

      {/* ── Modal Soins post-RACS ── */}
      {modalRacs && (() => {
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
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, flexShrink:0 }}>
                <div style={{ width:38, height:38, borderRadius:11, background:P.greenSoft,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>🫀</div>
                <div>
                  <p style={{ margin:0, fontSize:15, fontWeight:600, color:P.text }}>Soins post-RACS</p>
                  <p style={{ margin:0, fontSize:11, color:P.textSoft }}>Après retour de circulation spontanée</p>
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
                    style={{ padding:"8px 4px", borderRadius:9, border:"none",
                      background: racsTab===t.id ? P.surface : "transparent",
                      color: racsTab===t.id ? P.text : P.textSoft,
                      fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:sans,
                      boxShadow: racsTab===t.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                      display:"flex", alignItems:"center", justifyContent:"center", gap:4,
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
                    <p style={{ margin:"0 0 10px", fontSize:9, color:"#94B8D0", fontStyle:"italic", textAlign:"right" }}>
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
                      <div style={{ minWidth:0 }}>
                        <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                          textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>SpO₂</p>
                        <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <input type="number" inputMode="decimal" value={racs.sat}
                            onChange={e => sr("sat")(e.target.value)} placeholder="96"
                            style={{ flex:1, minWidth:0, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                              borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                              fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                            onFocus={e => e.target.style.borderColor = P.blue}
                            onBlur={e  => e.target.style.borderColor = P.border} />
                          <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>%</span>
                        </div>
                      </div>
                    </div>
                    <p style={{ margin:"0 0 10px", fontSize:9, color:"#94B8D0", fontStyle:"italic", textAlign:"right" }}>
                      Objectif SpO₂ 94–98 %
                    </p>

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
                      <div style={{ minWidth:0 }}>
                        <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                          textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>EtCO₂</p>
                        <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <input type="number" inputMode="decimal" value={racs.capno}
                            onChange={e => sr("capno")(e.target.value)} placeholder="35"
                            style={{ flex:1, minWidth:0, background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                              borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                              fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                            onFocus={e => e.target.style.borderColor = P.blue}
                            onBlur={e  => e.target.style.borderColor = P.border} />
                          <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>mmHg</span>
                        </div>
                      </div>
                    </div>
                    <p style={{ margin:"0", fontSize:9, color:"#94B8D0", fontStyle:"italic", textAlign:"right" }}>
                      Objectif EtCO₂ 35–45 mmHg
                    </p>
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

                    {/* TAs / TAd / FC — 3 champs séparés */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:4 }}>
                      {[
                        { label:"TAs",        key:"tas", ph:"120", accent:P.rose },
                        { label:"TAd",        key:"tad", ph:"80",  accent:P.rose },
                        { label:"FC /min",    key:"fc",  ph:"80",  accent:P.rose },
                      ].map(f => (
                        <div key={f.key} style={{ minWidth:0 }}>
                          <p style={{ margin:"0 0 4px", fontSize:9, fontWeight:500, color:P.textSoft,
                            textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:mono }}>{f.label}</p>
                          <input type="number" inputMode="decimal" value={racs[f.key]}
                            onChange={e => sr(f.key)(e.target.value)} placeholder={f.ph}
                            style={{ width:"100%", background:P.surfaceAlt, border:`1.5px solid ${P.border}`,
                              borderRadius:8, padding:"9px 4px", fontSize:15, color:P.text,
                              fontFamily:mono, outline:"none", textAlign:"center", fontWeight:600,
                              boxSizing:"border-box" }}
                            onFocus={e => e.target.style.borderColor = f.accent}
                            onBlur={e  => e.target.style.borderColor = P.border} />
                        </div>
                      ))}
                    </div>

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
                          <p style={{ margin:0, fontSize:9, color:"#94B8D0", fontStyle:"italic" }}>
                            Objectif PAM {">"} 65 mmHg · post-TC {">"} 80 mmHg
                          </p>
                        </div>
                      );
                    })()}

                    {/* Température — contrôle ciblé */}
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10,
                      background:"#FFF7ED", border:"1px solid #FDBA74", borderRadius:9, padding:"7px 10px" }}>
                      <span style={{ fontSize:13, flexShrink:0 }}>🌡️</span>
                      <input type="number" inputMode="decimal" step="0.1" value={racs.tempRacs}
                        onChange={e => sr("tempRacs")(e.target.value)} placeholder="36,5"
                        style={{ width:62, background:P.surface, border:`1px solid #FDBA74`,
                          borderRadius:7, padding:"5px 4px", fontSize:14, color:P.text,
                          fontFamily:mono, outline:"none", textAlign:"center", fontWeight:700,
                          boxSizing:"border-box", flexShrink:0 }}
                        onFocus={e => e.target.style.borderColor = "#EA580C"}
                        onBlur={e  => e.target.style.borderColor = "#FDBA74"} />
                      <span style={{ fontSize:12, color:"#9A3412", fontWeight:600, flexShrink:0 }}>°C</span>
                      <span style={{ fontSize:10, color:"#9A3412", lineHeight:1.3 }}>Éviter l'hyperthermie</span>
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

              {/* Valider */}
              <button onClick={() => { addEvent("racs_soins", buildLog(), "🫀"); setModalRacs(false); }}
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

      {/* Header + Timer */}
      <div style={{ background:P.surface, borderBottom:`1px solid ${P.border}`,
        padding:`${alert ? "56px" : "14px"} 16px 14px`,
        boxShadow:"0 2px 10px rgba(0,0,0,0.04)" }}>

        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:20 }}>{isTrauma ? "🩻" : "❤️‍🩹"}</span>
            <div>
              <p style={{ margin:0, fontSize:13, fontWeight:600, color:P.text }}>{pat.nom ? `${pat.nom} ${pat.prenom}` : (isTrauma ? "ACR Traumatique" : "Copilote ACR")}</p>
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
        </div>

        {/* Grand timer */}
        <div style={{ textAlign:"center", marginBottom:14 }}>
          <p style={{ margin:"0 0 2px", fontSize:10, color:P.textSoft, letterSpacing:"0.1em",
            textTransform:"uppercase", fontFamily:mono }}>Début RCP médicalisé</p>
          <span style={{ fontSize:58, fontWeight:300, letterSpacing:"-0.03em",
            color: running ? P.text : P.textSoft, fontFamily:mono, lineHeight:1 }}>
            {fmtSec(sec)}
          </span>
        </div>

        {/* Minuteur Adrénaline (option C : discret au repos, alerte si dépassé) */}
        {adrTimerStart > 0 && started && !events.find(e => e.id === "rosc") && (
          <AdrenalineTimer
            startSec={adrTimerStart}
            intervalMin={adrInterval}
            setIntervalMin={setAdrInterval}
            onAdminister={() => { addEvent("adr","Adrénaline 1 mg IV/IO","💉"); setAdrTimerStart(Date.now()); }}
            onCancel={() => setAdrTimerStart(0)}
            running={running}
            P={P} mono={mono} sans={sans} fmtSec={fmtSec}
          />
        )}

        {/* Compteur chocs cumulés + rappel Cordarone */}
        {(() => {
          const chocsSmur = events.filter(e => e.id === "choc").length;
          const chocsPomp = parseInt(trans.chocsPompiers) || 0;
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
                      ({chocsPomp} pomp. + {chocsSmur} SMUR)
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
                <div style={{ gridColumn:"1 / -1", background:"#FEF3C7",
                  border:"1.5px solid #F59E0B", borderRadius:10, padding:"8px 12px",
                  display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:18 }}>💊</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <p style={{ margin:0, fontSize:11, fontWeight:700, color:"#92400E" }}>
                      Rappel : Cordarone {showCord300 ? "300 mg" : "150 mg"}
                    </p>
                    <p style={{ margin:0, fontSize:10, color:"#B45309" }}>
                      Après le {showCord300 ? "3ᵉ" : "5ᵉ"} choc cumulé
                    </p>
                  </div>
                  <button onClick={() => {
                    if (showCord300) addEvent("cord300", "Cordarone 300 mg IV (après 3ᵉ choc)", "💊");
                    else             addEvent("cord150", "Cordarone 150 mg IV (après 5ᵉ choc)", "💊");
                  }}
                    style={{ background:"#F59E0B", border:"none", borderRadius:7,
                      color:"#fff", padding:"6px 10px", fontSize:11, fontWeight:600,
                      cursor:"pointer", fontFamily:sans }}>
                    Administrer
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Encarts No-flow / Low-flow ── */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 }}>
          {/* No-flow */}
          <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"7px 10px",
            border:`1px solid ${P.border}` }}>
            <p style={{ margin:"0 0 4px", fontSize:9, color:P.textSoft, textTransform:"uppercase",
              letterSpacing:"0.09em", fontFamily:mono }}>No-flow (min)</p>
            <div style={{ display:"flex", alignItems:"center", gap:4 }}>
              <input type="number" min="0" max="60" value={noFlowMin}
                onChange={e => setNoFlowMin(e.target.value)} placeholder="—"
                style={{ flex:1, minWidth:0, background:P.surface, border:`1px solid ${P.border}`,
                  borderRadius:7, padding:"5px 4px", fontSize:17, color:P.text, fontFamily:mono,
                  outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                onFocus={e => e.target.style.borderColor = P.rose}
                onBlur={e  => e.target.style.borderColor = P.border} />
              <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>min</span>
            </div>
          </div>

          {/* Low-flow */}
          <div style={{ background:P.surfaceAlt, borderRadius:10, padding:"7px 10px",
            border:`1px solid ${P.border}` }}>
            <p style={{ margin:"0 0 4px", fontSize:9, color:P.textSoft, textTransform:"uppercase",
              letterSpacing:"0.09em", fontFamily:mono }}>Low-flow (min)</p>
            <div style={{ display:"flex", alignItems:"center", gap:4 }}>
              <input type="number" min="0" max="120" value={lowFlowMin}
                onChange={e => setLowFlowMin(e.target.value)} placeholder="—"
                style={{ flex:1, minWidth:0, background:P.surface, border:`1px solid ${P.border}`,
                  borderRadius:7, padding:"5px 4px", fontSize:17, color:P.text, fontFamily:mono,
                  outline:"none", textAlign:"center", fontWeight:600, boxSizing:"border-box" }}
                onFocus={e => e.target.style.borderColor = P.blue}
                onBlur={e  => e.target.style.borderColor = P.border} />
              <span style={{ fontSize:9, color:P.textSoft, flexShrink:0 }}>min</span>
            </div>
          </div>
        </div>

        {/* Barre cycle */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
          <span style={{ fontSize:10, color:P.textSoft, fontFamily:mono }}>Cycle RCP · 2 min</span>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:10, fontWeight:500, color: warn ? bar : P.textSoft, fontFamily:mono }}>
              {warn ? `⚠ ${rem}s` : `${rem}s`}
            </span>
            <button onClick={() => { setCycleOffset(sec); addEvent("cycle","↺ Cycle remis à zéro","↺"); }}
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
          100–120 /min · 5–6 cm · relâchement complet · ratio 30:2
        </p>
      </div>

      <div style={{ padding:"10px 12px 0" }}>

        {/* ── Onglet unique : Actions ── */}
        {true && <>

          {/* Dossier éditable */}
          <Collapsible icon="🪪"
            title={pat.nom ? `${pat.nom} ${pat.prenom}${pat.age ? ` · ${pat.age} ans` : ""}` : "Dossier patient"}
            badge="éditable">
            <div style={{ display:"grid", gap:12 }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div><Lbl>Nom</Lbl><TInput value={pat.nom} onChange={sf("nom")} placeholder="Dupont" /></div>
                <div><Lbl>Prénom</Lbl><TInput value={pat.prenom} onChange={sf("prenom")} placeholder="Jean" /></div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div><Lbl>Date de naissance</Lbl><TInput type="date" value={pat.ddn} onChange={v => { sf("ddn")(v); sf("age")(calcAge(v)); }} /></div>
                <div><Lbl>Âge</Lbl><TInput value={pat.age} onChange={sf("age")} placeholder="67 ans" /></div>
              </div>
              <div><Lbl>Température (°C)</Lbl>
                <TInput value={pat.temp} onChange={sf("temp")} placeholder="Ex : 35,2 — penser hypothermie / ECMO" /></div>
              <div><Lbl>Antécédents médicaux</Lbl>
                <TArea value={pat.atcd} onChange={sf("atcd")} placeholder="HTA, diabète, ACFA..." rows={2} /></div>
              <div><Lbl>Traitements habituels</Lbl>
                <TArea value={pat.traitement} onChange={sf("traitement")} placeholder="Metformine, Bisoprolol..." rows={2} /></div>
              <div><Lbl>Histoire de la maladie</Lbl>
                <TArea value={pat.histoire} onChange={sf("histoire")} placeholder="Circonstances, symptômes précédents..." rows={3} /></div>
            </div>
          </Collapsible>

          {/* Bandeau Transmission équipes en place — adulte */}
          <button onClick={() => setModalTrans(true)}
            style={{ width:"100%", background: trans.saved ? P.greenSoft : P.amberSoft,
              border:`1.5px solid ${trans.saved ? "#A6D6B0" : "#F5C99E"}`,
              borderRadius:12, padding:"10px 14px", cursor:"pointer", fontFamily:sans,
              display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
            <div style={{ width:24, height:24, color: trans.saved ? P.greenText : P.amberText, flexShrink:0 }}>{ICONS.transmission}</div>
            <div style={{ flex:1, minWidth:0, textAlign:"left" }}>
              <p style={{ margin:0, fontSize:12, fontWeight:600, color: trans.saved ? P.greenText : P.amberText }}>
                {trans.saved ? "Transmission équipes enregistrée" : "Transmission équipes en place"}
              </p>
              <p style={{ margin:"1px 0 0", fontSize:10, color: trans.saved ? P.greenText : P.amberText, opacity:0.85 }}>
                {trans.saved ? "Cliquer pour modifier" : "Recueil pré-SMUR (pompiers, témoin, DSA…)"}
              </p>
            </div>
            <span style={{ fontSize:16, color: trans.saved ? P.greenText : P.amberText }}>
              {trans.saved ? "✓" : "→"}
            </span>
          </button>

          {/* ── Tab bar Actions / Étiologie / Thérapeutiques ── */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5,
            background:P.surfaceAlt, borderRadius:12, padding:4, marginBottom:10 }}>
            {[
              { id:"actions", label:"Actions",       icon:"⚡" },
              { id:"etio",    label:"Étiologie",     icon:"🔍" },
              { id:"ther",    label:"Thérapeutiques", icon:"💊" },
            ].map(t => (
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

          {/* ── Contenu Actions (grille existante) ── */}
          {mainTab === "actions" && (
          <div style={{ display:"flex", flexDirection:"column", gap:9, marginBottom:10 }}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <ActionBtn action={{ label:"Analyse de rythme", svg:ICONS.rythme, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                onClick={() => setModalRythme(true)} />
              <ActionBtn action={{ label:"Voie d'abord", svg:ICONS.vvp, accent:P.green, soft:P.greenSoft, textC:P.greenText }}
                onClick={() => setModalVvp(true)} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <ActionBtn action={{ label:"Adrénaline 1 mg", svg:ICONS.adr, accent:P.rose, soft:P.roseSoft, textC:P.roseText }}
                onClick={() => { addEvent("adr","Adrénaline 1 mg IV/IO","💉"); setAdrTimerStart(Date.now()); }} />
              <ActionBtn action={{ label:"Cordarone", svg:ICONS.amio, accent:P.amber, soft:P.amberSoft, textC:P.amberText }}
                onClick={() => setModalCord(true)} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <ActionBtn action={{ label:"Défibrillation", svg:ICONS.choc, accent:P.blue, soft:P.blueSoft, textC:P.blueText }}
                onClick={() => setModalChoc(true)} />
              <ActionBtn action={{ label:"Intubation IOT", svg:ICONS.iot, accent:P.violet, soft:P.violetSoft, textC:P.violetText }}
                onClick={() => setModalIot(true)} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <ActionBtn action={{ label:"Planche à masser", svg:ICONS.planche, accent:P.teal, soft:P.tealSoft, textC:P.tealText }}
                onClick={() => addEvent("planche","Planche à masser mise en place","🦺")} />
              <ActionBtn action={{ label:"Fast-écho", svg:ICONS.fast, accent:P.blue, soft:P.blueSoft, textC:P.blueText }}
                onClick={() => isTrauma ? setModalFastTrauma(true) : setModalFast(true)} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <ActionBtn action={{ label:"Soins post-RACS", icon:"🫀", accent:P.green, soft:P.greenSoft, textC:P.greenText }}
                onClick={() => setModalRacs(true)} />
              <ActionBtn action={{ label:"Constat de décès", svg:ICONS.deces, accent:P.slate, soft:P.slateSoft, textC:P.slateText }}
                onClick={() => setModalDeces(true)} />
            </div>
          </div>
          )}

          {/* ── Contenu Étiologie ── */}
          {mainTab === "etio" && (
            <>
              {isTrauma ? (
                <EtiologieTab title="HOTT — Causes réversibles traumatiques" causes={CAUSES_HOTT}
                  suspected={suspectedAd}
                  onToggle={(id, label) => {
                    if (suspectedAd.includes(id)) {
                      setSuspectedAd(suspectedAd.filter(x => x !== id));
                    } else {
                      setSuspectedAd([...suspectedAd, id]);
                      addEvent("etio", `Cause suspectée : ${label}`, "🔍");
                    }
                  }}
                  P={P} mono={mono} sans={sans} />
              ) : (
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
              }}
              P={P} mono={mono} sans={sans} />
          )}

        </>}

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

        {/* Chronologie */}
        <div style={{ background:P.surface, border:`1px solid ${P.border}`, borderRadius:14,
          overflow:"hidden", marginBottom:10, boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
          <button onClick={() => setShowLog(v => !v)}
            style={{ width:"100%", background:"transparent", border:"none", padding:"12px 16px",
              display:"flex", justifyContent:"space-between", alignItems:"center",
              cursor:"pointer", fontFamily:sans }}>
            <span style={{ fontSize:13, fontWeight:500, color:P.textMid }}>Chronologie</span>
            <span style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ background:P.blueSoft, color:P.blueText, borderRadius:20,
                padding:"1px 8px", fontSize:10, fontFamily:mono }}>{events.length}</span>
              <span style={{ color:P.textSoft, fontSize:11 }}>{showLog ? "▲" : "▼"}</span>
            </span>
          </button>
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
                    <span style={{ fontSize:12, color:P.textMid, flex:1 }}>{e.label}</span>
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
          <button onClick={reset}
            style={{ background:P.surface, border:`1.5px solid ${P.border}`,
              borderRadius:11, padding:"10px 6px", color:P.textSoft,
              fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:sans }}>
            ↺ Reset
          </button>
        </div>

      </div>

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
              <div style={{ width:38, height:38, borderRadius:11, background:"#FFF3E0",
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

      {/* ── Bandeau fixe Appel Régulation ── */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, zIndex:30,
        background:P.surface, borderTop:`1px solid ${P.border}`,
        padding:"7px 14px 10px", boxShadow:"0 -4px 16px rgba(0,0,0,0.08)" }}>
        <button onClick={() => setModalRegul(true)}
          style={{ width:"100%", background:"linear-gradient(135deg,#F97316,#EA6010)",
            border:"none", borderRadius:11, color:"#fff", fontSize:13, fontWeight:600,
            padding:"9px 16px", cursor:"pointer", fontFamily:sans,
            display:"flex", alignItems:"center", justifyContent:"center", gap:8,
            boxShadow:"0 3px 10px rgba(249,115,22,0.3)" }}>
          <span style={{ fontSize:15 }}>📞</span>
          Appel régulation
        </button>
      </div>

      {/* PDF adulte — overlay */}
      {showPdf && (
        <PdfView patient={pat} noFlow={noFlowMin} lowFlow={lowFlowMin} acrTime={acrTime}
          iot={iot} events={events} totalSec={sec} trans={trans} hemocue={hemocueHist} onClose={() => setShowPdf(false)} />
      )}

    </div>
  );
}