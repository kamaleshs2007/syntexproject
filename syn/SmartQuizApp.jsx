import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const STORAGE_KEY = "smartquiz_history";
const DIFFICULTIES = ["Easy", "Medium", "Hard"];

// ─── UTILS ──────────────────────────────────────────────────────────────────
const storage = {
  load: () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; } },
  save: (data) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {} },
  append: (entry) => { const h = storage.load(); h.unshift(entry); storage.save(h.slice(0, 50)); }
};

const fmt = (s) => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

// ─── GEMINI CALL ─────────────────────────────────────────────────────────────
async function fetchQuestions(apiKey, topic, count, difficulty) {
  const prompt = `Generate ${count} multiple-choice quiz questions about "${topic}" at ${difficulty} difficulty.
Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "questions": [
    {
      "question": "Question text here?",
      "options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],
      "correct": 0,
      "explanation": "Detailed explanation of the correct answer."
    }
  ]
}
"correct" is the 0-based index of the correct option. Make explanations educational and thorough.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  if (!parsed.questions?.length) throw new Error("No questions returned.");
  return parsed.questions;
}

async function fetchInsights(apiKey, topic, questions, answers) {
  const wrong = questions.filter((_, i) => answers[i] !== questions[i].correct);
  if (!wrong.length) return "🎉 Perfect score! You have mastered this topic. Keep it up!";
  const wrongList = wrong.map(q => `- ${q.question}`).join("\n");
  const prompt = `A student took a quiz on "${topic}" and got these questions wrong:\n${wrongList}\n\nIn 3-4 concise bullet points, suggest specific sub-topics they should study more. Be direct and practical. No preamble.`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
  );
  if (!res.ok) throw new Error("Failed to fetch insights.");
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No insights available.";
}

// ─── PDF EXPORT ──────────────────────────────────────────────────────────────
function exportPDF(questions, answers, topic, score, mode = "answered") {
  const win = window.open("", "_blank");
  const rows = questions.map((q, i) => {
    const userAns = answers[i];
    const isCorrect = userAns === q.correct;
    const opts = q.options.map((o, j) => {
      let style = "";
      if (mode === "answered") {
        if (j === q.correct) style = "background:#d4edda;font-weight:bold;";
        else if (j === userAns && !isCorrect) style = "background:#f8d7da;";
      }
      return `<div style="padding:4px 8px;margin:2px 0;border-radius:4px;${style}">${o}</div>`;
    }).join("");
    const expSection = mode === "answered" ? `<div style="margin-top:8px;padding:8px;background:#fff3cd;border-radius:4px;font-size:13px"><strong>Explanation:</strong> ${q.explanation}</div>` : "";
    const badge = mode === "answered" ? `<span style="float:right;padding:2px 8px;border-radius:12px;font-size:12px;background:${isCorrect?"#d4edda;color:#155724":"#f8d7da;color:#721c24"}">${isCorrect?"✓ Correct":"✗ Incorrect"}</span>` : "";
    return `<div style="margin-bottom:20px;padding:12px;border:1px solid #ddd;border-radius:8px;page-break-inside:avoid">
      <p style="font-weight:bold;margin:0 0 8px">${badge}Q${i+1}. ${q.question}</p>
      ${opts}${expSection}
    </div>`;
  }).join("");
  win.document.write(`<!DOCTYPE html><html><head><title>Quiz - ${topic}</title>
  <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;color:#222;line-height:1.6}h1{color:#1a1a2e}@media print{button{display:none}}</style>
  </head><body>
  <h1>📚 ${topic} Quiz</h1>
  ${mode==="answered"?`<p><strong>Score:</strong> ${score}/${questions.length} (${Math.round(score/questions.length*100)}%)</p>`:""}
  <button onclick="window.print()" style="margin-bottom:20px;padding:8px 16px;background:#1a1a2e;color:white;border:none;border-radius:6px;cursor:pointer">🖨 Print / Save as PDF</button>
  ${rows}</body></html>`);
  win.document.close();
}

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

function ConfigScreen({ onStart }) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("gemini_key") || "");
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState("Medium");
  const [timeLimit, setTimeLimit] = useState(120);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleStart = async () => {
    if (!apiKey.trim()) return setError("Please enter your Gemini API key.");
    if (!topic.trim()) return setError("Please enter a topic.");
    setError(""); setLoading(true);
    localStorage.setItem("gemini_key", apiKey);
    try {
      const questions = await fetchQuestions(apiKey, topic.trim(), count, difficulty);
      onStart({ apiKey, topic: topic.trim(), count, difficulty, timeLimit, questions });
    } catch (e) {
      setError(e.message || "Failed to generate questions. Check your API key and network.");
    }
    setLoading(false);
  };

  return (
    <div style={styles.card}>
      <div style={styles.logoArea}>
        <span style={styles.logo}>⚡</span>
        <h1 style={styles.title}>SmartQuiz</h1>
        <p style={styles.subtitle}>AI-Powered Quiz Generator</p>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>Gemini API Key</label>
        <input style={styles.input} type="password" placeholder="AIza..." value={apiKey} onChange={e => setApiKey(e.target.value)} />
        <span style={styles.hint}>Get yours at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{color:"#6c63ff"}}>aistudio.google.com</a></span>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>Topic</label>
        <input style={styles.input} type="text" placeholder="e.g. Java Programming, Organic Chemistry..." value={topic} onChange={e => setTopic(e.target.value)} onKeyDown={e => e.key==="Enter" && handleStart()} />
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
        <div style={styles.field}>
          <label style={styles.label}>Questions</label>
          <select style={styles.input} value={count} onChange={e => setCount(+e.target.value)}>
            {[3,5,10,15,20].map(n => <option key={n}>{n}</option>)}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Difficulty</label>
          <select style={styles.input} value={difficulty} onChange={e => setDifficulty(e.target.value)}>
            {DIFFICULTIES.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Time (sec)</label>
          <select style={styles.input} value={timeLimit} onChange={e => setTimeLimit(+e.target.value)}>
            {[60,120,180,300,600].map(t => <option key={t} value={t}>{fmt(t)}</option>)}
          </select>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <button style={{...styles.btn, opacity: loading?0.7:1}} onClick={handleStart} disabled={loading}>
        {loading ? <span style={styles.spinner} /> : null}
        {loading ? "Generating Questions..." : "Start Quiz ⚡"}
      </button>
    </div>
  );
}

function QuizScreen({ config, onFinish }) {
  const { questions, topic, difficulty, timeLimit, apiKey } = config;
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState(Array(questions.length).fill(null));
  const [timeLeft, setTimeLeft] = useState(timeLimit);
  const [showExp, setShowExp] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceHint, setVoiceHint] = useState("");
  const timerRef = useRef(null);
  const recognitionRef = useRef(null);
  const savedRef = useRef(false);

  const doFinish = useCallback((ans, expired = false) => {
    if (savedRef.current) return;
    savedRef.current = true;
    clearInterval(timerRef.current);
    const score = ans.filter((a, i) => a === questions[i].correct).length;
    const entry = { id: Date.now(), topic, difficulty, score, total: questions.length, date: new Date().toISOString(), questions, answers: ans, expired };
    storage.append(entry);
    onFinish(entry, apiKey);
  }, [questions, topic, difficulty, onFinish, apiKey]);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) { doFinish(answers, true); return 0; }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [answers, doFinish]);

  const q = questions[idx];
  const pct = (timeLeft / timeLimit) * 100;
  const timerColor = pct > 50 ? "#22c55e" : pct > 20 ? "#f59e0b" : "#ef4444";

  const select = (opt) => {
    if (answers[idx] !== null) return;
    const a = [...answers]; a[idx] = opt;
    setAnswers(a);
    setShowExp(true);
  };

  const next = () => { setShowExp(false); setIdx(i => i + 1); };

  // Voice-to-Answer
  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return setVoiceHint("Speech recognition not supported in this browser.");
    const r = new SR();
    r.lang = "en-US"; r.interimResults = false;
    r.onstart = () => setListening(true);
    r.onend = () => setListening(false);
    r.onresult = (e) => {
      const said = e.results[0][0].transcript.trim().toUpperCase();
      setVoiceHint(`Heard: "${said}"`);
      const map = { A: 0, B: 1, C: 2, D: 3 };
      const letter = said.charAt(0);
      if (letter in map) select(map[letter]);
      else setVoiceHint(`Couldn't match "${said}" — say A, B, C or D.`);
    };
    r.onerror = () => { setListening(false); setVoiceHint("Microphone error."); };
    recognitionRef.current = r;
    r.start();
  };

  const stopVoice = () => { recognitionRef.current?.stop(); setListening(false); };

  const answered = answers.filter(a => a !== null).length;

  return (
    <div style={styles.card}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <span style={styles.badge}>{topic}</span>
          <span style={{...styles.badge, background:"#f0f0f0", color:"#555", marginLeft:6}}>{difficulty}</span>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:28,fontWeight:900,color:timerColor,fontVariantNumeric:"tabular-nums"}}>{fmt(timeLeft)}</div>
          <div style={{fontSize:11,color:"#999"}}>{answered}/{questions.length} answered</div>
        </div>
      </div>

      {/* Timer bar */}
      <div style={{height:6,background:"#f0f0f0",borderRadius:3,marginBottom:20,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${pct}%`,background:timerColor,borderRadius:3,transition:"width 1s linear,background 0.5s"}} />
      </div>

      {/* Progress dots */}
      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {questions.map((_, i) => (
          <div key={i} onClick={() => { setShowExp(false); setIdx(i); }}
            style={{width:10,height:10,borderRadius:"50%",cursor:"pointer",transition:"all 0.2s",
              background: answers[i]===null ? (i===idx?"#6c63ff":"#e0e0e0") : answers[i]===questions[i].correct ? "#22c55e" : "#ef4444",
              transform: i===idx?"scale(1.4)":"scale(1)",border: i===idx?"2px solid #6c63ff":"none"}} />
        ))}
      </div>

      {/* Question */}
      <div style={{marginBottom:20}}>
        <div style={{fontSize:12,color:"#999",marginBottom:6}}>Question {idx+1} of {questions.length}</div>
        <p style={{fontSize:18,fontWeight:700,lineHeight:1.5,margin:0}}>{q.question}</p>
      </div>

      {/* Options */}
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {q.options.map((opt, j) => {
          const chosen = answers[idx];
          let bg = "#f8f9fa", border = "1.5px solid #e0e0e0", color = "#222";
          if (chosen !== null) {
            if (j === q.correct) { bg = "#d4edda"; border = "1.5px solid #22c55e"; color = "#155724"; }
            else if (j === chosen) { bg = "#f8d7da"; border = "1.5px solid #ef4444"; color = "#721c24"; }
          } else if (j === chosen) { bg = "#e8e6ff"; border = "1.5px solid #6c63ff"; }
          return (
            <button key={j} onClick={() => select(j)} disabled={chosen !== null}
              style={{...styles.optBtn, background:bg, border, color, cursor: chosen!==null?"default":"pointer"}}>
              <span style={{fontWeight:700,marginRight:10,opacity:0.5}}>{["A","B","C","D"][j]}</span>
              {opt.replace(/^[A-D]\)\s?/,"")}
            </button>
          );
        })}
      </div>

      {/* Explanation */}
      {showExp && answers[idx] !== null && (
        <div style={{padding:14,background:"#fffbea",border:"1px solid #f59e0b",borderRadius:10,marginBottom:16,fontSize:14,lineHeight:1.6}}>
          <strong>💡 Explanation:</strong> {q.explanation}
        </div>
      )}

      {/* Voice */}
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
        <button onClick={listening ? stopVoice : startVoice} disabled={answers[idx]!==null}
          style={{...styles.btnSm, background: listening?"#ef4444":"#6c63ff"}}>
          {listening ? "🛑 Stop" : "🎤 Voice Answer"}
        </button>
        {voiceHint && <span style={{fontSize:12,color:"#888"}}>{voiceHint}</span>}
      </div>

      {/* Nav */}
      <div style={{display:"flex",gap:10,justifyContent:"space-between"}}>
        <button style={{...styles.btnSm, background:"#e0e0e0", color:"#333"}} disabled={idx===0} onClick={() => { setShowExp(false); setIdx(i=>i-1); }}>← Prev</button>
        {idx < questions.length - 1
          ? <button style={styles.btnSm} onClick={next}>Next →</button>
          : <button style={{...styles.btnSm, background:"#22c55e"}} onClick={() => doFinish(answers)}>Submit Quiz ✓</button>
        }
      </div>
    </div>
  );
}

function ResultScreen({ entry, apiKey, onRestart, onHistory }) {
  const { topic, difficulty, score, total, date, questions, answers, expired } = entry;
  const pct = Math.round(score / total * 100);
  const [insights, setInsights] = useState("");
  const [loadingIns, setLoadingIns] = useState(false);

  const grade = pct >= 90 ? "A" : pct >= 75 ? "B" : pct >= 60 ? "C" : pct >= 50 ? "D" : "F";
  const gradeColor = pct >= 75 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";

  const getInsights = async () => {
    setLoadingIns(true);
    try { setInsights(await fetchInsights(apiKey, topic, questions, answers)); }
    catch { setInsights("Could not load insights. Please try again."); }
    setLoadingIns(false);
  };

  return (
    <div style={styles.card}>
      {expired && <div style={{...styles.error, background:"#fff3cd", color:"#856404", border:"1px solid #ffc107"}}>⏰ Time's up! Quiz was auto-saved.</div>}

      <div style={{textAlign:"center",marginBottom:24}}>
        <div style={{fontSize:72,fontWeight:900,color:gradeColor,lineHeight:1}}>{pct}%</div>
        <div style={{fontSize:32,fontWeight:700,color:gradeColor}}>{grade}</div>
        <div style={{color:"#666",marginTop:6}}>{score} / {total} correct · {topic} · {difficulty}</div>
        <div style={{fontSize:12,color:"#aaa",marginTop:4}}>{new Date(date).toLocaleString()}</div>
      </div>

      {/* Answer review */}
      <div style={{maxHeight:320,overflowY:"auto",marginBottom:16}}>
        {questions.map((q, i) => {
          const correct = answers[i] === q.correct;
          return (
            <div key={i} style={{padding:12,marginBottom:8,borderRadius:8,background: correct?"#f0fdf4":"#fff5f5", border:`1px solid ${correct?"#86efac":"#fca5a5"}`}}>
              <div style={{fontWeight:600,fontSize:14,marginBottom:4}}>{correct?"✅":"❌"} Q{i+1}. {q.question}</div>
              <div style={{fontSize:13,color:"#555"}}>
                Your answer: <strong>{answers[i]!==null ? q.options[answers[i]] : "Not answered"}</strong>
                {!correct && <> · Correct: <strong style={{color:"#16a34a"}}>{q.options[q.correct]}</strong></>}
              </div>
            </div>
          );
        })}
      </div>

      {/* AI Insights */}
      {insights ? (
        <div style={{padding:14,background:"#f0f4ff",border:"1px solid #6c63ff",borderRadius:10,marginBottom:16,fontSize:14,lineHeight:1.7,whiteSpace:"pre-wrap"}}>
          <strong>🧠 AI Study Insights:</strong><br/>{insights}
        </div>
      ) : (
        <button style={{...styles.btnSm, background:"#6c63ff", marginBottom:16, width:"100%"}} onClick={getInsights} disabled={loadingIns}>
          {loadingIns ? "Analyzing..." : "🧠 Get AI Study Insights"}
        </button>
      )}

      {/* PDF Exports */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
        <button style={{...styles.btnSm, background:"#1a1a2e"}} onClick={() => exportPDF(questions, answers, topic, score, "answered")}>📄 Export Answered PDF</button>
        <button style={{...styles.btnSm, background:"#374151"}} onClick={() => exportPDF(questions, answers, topic, score, "blank")}>📋 Export Blank PDF</button>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <button style={{...styles.btnSm, background:"#22c55e"}} onClick={onRestart}>🔁 New Quiz</button>
        <button style={{...styles.btnSm, background:"#f59e0b"}} onClick={onHistory}>📚 History</button>
      </div>
    </div>
  );
}

function HistoryScreen({ onBack }) {
  const [history, setHistory] = useState(storage.load);
  const [expanded, setExpanded] = useState(null);

  const clear = () => { if (confirm("Clear all quiz history?")) { storage.save([]); setHistory([]); } };

  if (!history.length) return (
    <div style={styles.card}>
      <h2 style={styles.h2}>📚 Quiz History</h2>
      <p style={{color:"#999",textAlign:"center",padding:32}}>No quizzes yet. Take one!</p>
      <button style={styles.btn} onClick={onBack}>← Back</button>
    </div>
  );

  return (
    <div style={styles.card}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <h2 style={{...styles.h2,margin:0}}>📚 Quiz History</h2>
        <button style={{...styles.btnSm, background:"#ef4444", fontSize:12}} onClick={clear}>Clear All</button>
      </div>
      <div style={{maxHeight:460,overflowY:"auto"}}>
        {history.map((e, i) => {
          const pct = Math.round(e.score/e.total*100);
          const color = pct>=75?"#22c55e":pct>=50?"#f59e0b":"#ef4444";
          return (
            <div key={e.id} style={{marginBottom:10,borderRadius:10,overflow:"hidden",border:"1px solid #e0e0e0"}}>
              <div onClick={() => setExpanded(expanded===i?null:i)}
                style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",cursor:"pointer",background:"#fafafa"}}>
                <div>
                  <strong style={{fontSize:15}}>{e.topic}</strong>
                  <span style={{...styles.badge, marginLeft:8, fontSize:11}}>{e.difficulty}</span>
                  {e.expired && <span style={{...styles.badge, background:"#fff3cd",color:"#856404",marginLeft:4,fontSize:11}}>Expired</span>}
                  <div style={{fontSize:12,color:"#aaa",marginTop:2}}>{new Date(e.date).toLocaleString()}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:22,fontWeight:900,color}}>{pct}%</div>
                  <div style={{fontSize:12,color:"#888"}}>{e.score}/{e.total}</div>
                </div>
              </div>
              {expanded===i && (
                <div style={{padding:"10px 14px",borderTop:"1px solid #eee",background:"#fff"}}>
                  {e.questions.map((q, j) => {
                    const ok = e.answers[j]===q.correct;
                    return <div key={j} style={{fontSize:13,padding:"4px 0",color:ok?"#16a34a":"#dc2626"}}>{ok?"✅":"❌"} {q.question}</div>;
                  })}
                  <div style={{display:"flex",gap:8,marginTop:10}}>
                    <button style={{...styles.btnSm,fontSize:12,background:"#1a1a2e"}} onClick={()=>exportPDF(e.questions,e.answers,e.topic,e.score,"answered")}>📄 PDF</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button style={{...styles.btn, marginTop:12}} onClick={onBack}>← Back to Quiz</button>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("config");
  const [quizConfig, setQuizConfig] = useState(null);
  const [result, setResult] = useState(null);
  const [apiKey, setApiKey] = useState("");

  return (
    <div style={styles.root}>
      <div style={styles.bg} />
      <div style={styles.wrapper}>
        {screen==="config" && <ConfigScreen onStart={(cfg) => { setQuizConfig(cfg); setApiKey(cfg.apiKey); setScreen("quiz"); }} />}
        {screen==="quiz" && quizConfig && <QuizScreen config={quizConfig} onFinish={(entry, key) => { setResult(entry); setApiKey(key); setScreen("result"); }} />}
        {screen==="result" && result && <ResultScreen entry={result} apiKey={apiKey} onRestart={() => setScreen("config")} onHistory={() => setScreen("history")} />}
        {screen==="history" && <HistoryScreen onBack={() => setScreen(result?"result":"config")} />}
      </div>
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const styles = {
  root: { minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", padding:16, position:"relative", fontFamily:"'Segoe UI', system-ui, sans-serif", background:"#0f0f1a" },
  bg: { position:"fixed", inset:0, background:"radial-gradient(ellipse at 30% 20%, #1a1040 0%, #0f0f1a 60%), radial-gradient(ellipse at 80% 80%, #0a1628 0%, transparent 60%)", zIndex:0 },
  wrapper: { position:"relative", zIndex:1, width:"100%", maxWidth:560 },
  card: { background:"rgba(255,255,255,0.97)", borderRadius:20, padding:28, boxShadow:"0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1)" },
  logoArea: { textAlign:"center", marginBottom:28 },
  logo: { fontSize:40 },
  title: { margin:"4px 0 0", fontSize:32, fontWeight:900, background:"linear-gradient(135deg,#6c63ff,#f093fb)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" },
  subtitle: { color:"#888", margin:"4px 0 0", fontSize:14 },
  h2: { fontSize:22, fontWeight:800, marginBottom:16 },
  field: { marginBottom:16 },
  label: { display:"block", fontSize:13, fontWeight:600, color:"#444", marginBottom:6 },
  input: { width:"100%", padding:"10px 14px", borderRadius:10, border:"1.5px solid #e0e0e0", fontSize:15, outline:"none", boxSizing:"border-box", background:"#fafafa", transition:"border 0.2s" },
  hint: { fontSize:12, color:"#aaa", marginTop:4, display:"block" },
  btn: { width:"100%", padding:"14px", borderRadius:12, border:"none", background:"linear-gradient(135deg,#6c63ff,#f093fb)", color:"white", fontSize:16, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 },
  btnSm: { padding:"10px 16px", borderRadius:10, border:"none", background:"#6c63ff", color:"white", fontSize:14, fontWeight:600, cursor:"pointer" },
  optBtn: { width:"100%", textAlign:"left", padding:"12px 16px", borderRadius:10, fontSize:15, fontWeight:500, transition:"all 0.15s" },
  error: { background:"#fef2f2", color:"#dc2626", border:"1px solid #fca5a5", borderRadius:8, padding:"10px 14px", marginBottom:16, fontSize:14 },
  badge: { display:"inline-block", padding:"3px 10px", borderRadius:20, background:"#ede9fe", color:"#5b21b6", fontSize:12, fontWeight:600 },
  spinner: { width:16, height:16, border:"2px solid rgba(255,255,255,0.4)", borderTop:"2px solid white", borderRadius:"50%", display:"inline-block", animation:"spin 0.8s linear infinite" },
};
