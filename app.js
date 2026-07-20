const { useState, useEffect, useMemo } = React;

// ---- Supabase 클라이언트 -------------------------------------
const supabase = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);
const ACCESS_CODE_HASH = (window.APP_CONFIG.ACCESS_CODE_HASH || "").toLowerCase();
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const STATUS = ["대기", "진행중", "완료"];
const MSG_STATUS = ["초안", "발송대기", "발송완료"];
const CHANNELS = ["문자", "카카오 알림톡", "이메일", "공지사항"];

// ---- 공용 헬퍼 --------------------------------------------------
function fmtDate(d) {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${Number(m)}/${Number(day)}`;
}
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// SMS 바이트 계산 (한글 2byte, 영문/숫자 1byte 기준)
function smsBytes(s) {
  let b = 0;
  for (const ch of s || "") b += ch.charCodeAt(0) > 127 ? 2 : 1;
  return b;
}
function isImageFile(name) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || "");
}
function subscribeTables(tables, onChange) {
  const channel = supabase.channel("db-" + tables.join("-") + "-" + Math.random().toString(36).slice(2, 7));
  tables.forEach((t) =>
    channel.on("postgres_changes", { event: "*", schema: "public", table: t }, onChange)
  );
  channel.subscribe();
  return () => supabase.removeChannel(channel);
}

// ---- 접속코드 게이트 ---------------------------------------------
function Gate({ onPass }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    setChecking(true);
    const hash = await sha256Hex(code.trim());
    if (hash === ACCESS_CODE_HASH) {
      localStorage.setItem("promo_access_hash", hash);
      onPass();
    } else {
      setError(true);
    }
    setChecking(false);
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-stripe" />
        <h1>모집홍보 현황판</h1>
        <p>공유받은 접속코드를 입력하세요.</p>
        <input
          type="password"
          value={code}
          placeholder="접속코드"
          onChange={(e) => { setCode(e.target.value); setError(false); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        {error && <div className="gate-error">접속코드가 맞지 않습니다. 다시 확인해주세요.</div>}
        <button className="btn-primary" onClick={submit} disabled={checking}>
          {checking ? "확인 중…" : "입장하기"}
        </button>
      </div>
    </div>
  );
}

// ---- 항목 상세 모달 (연결된 일정 역방향 표시 포함) ------------------
function TaskModal({ task, isNew, campaignId, categories, onClose, onGoCalendar }) {
  const [form, setForm] = useState({ ...task, schedule_date: task.schedule_date || "" });
  const [logs, setLogs] = useState([]);
  const [files, setFiles] = useState([]);
  const [linkedEvents, setLinkedEvents] = useState([]);
  const [linkedMsgs, setLinkedMsgs] = useState([]);
  const [newLog, setNewLog] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const loadSub = async () => {
    if (isNew) return;
    const [l, f, ev, mg] = await Promise.all([
      supabase.from("task_logs").select("*").eq("task_id", task.id).order("created_at", { ascending: false }),
      supabase.from("task_files").select("*").eq("task_id", task.id).order("uploaded_at", { ascending: false }),
      supabase.from("events").select("*").eq("related_task_id", task.id).order("event_date"),
      supabase.from("messages").select("id,title,send_date,status").eq("related_task_id", task.id).eq("archived", false).order("send_date"),
    ]);
    setLogs(l.data || []);
    setFiles(f.data || []);
    setLinkedEvents(ev.data || []);
    setLinkedMsgs(mg.data || []);
  };

  useEffect(() => {
    loadSub();
    if (!isNew) return subscribeTables(["task_logs", "task_files", "events"], loadSub);
  }, []);

  const save = async () => {
    if (!form.category_main.trim() || !form.item_name.trim()) {
      alert("대구분과 항목은 필수입니다.");
      return;
    }
    setSaving(true);
    const payload = {
      category_main: form.category_main.trim(),
      category_sub: form.category_sub.trim(),
      item_name: form.item_name.trim(),
      detail: form.detail,
      status: form.status,
      schedule_date: form.schedule_date || null,
      owner: form.owner,
      partner: form.partner,
    };
    if (isNew) {
      payload.campaign_id = campaignId;
      await supabase.from("tasks").insert(payload);
    } else {
      await supabase.from("tasks").update(payload).eq("id", task.id);
    }
    setSaving(false);
    onClose();
  };

  const remove = async () => {
    if (!confirm("이 항목을 삭제할까요? 로그와 첨부파일도 함께 삭제됩니다.")) return;
    await supabase.from("tasks").delete().eq("id", task.id);
    onClose();
  };

  const addLog = async () => {
    if (!newLog.trim()) return;
    await supabase.from("task_logs").insert({ task_id: task.id, content: newLog.trim() });
    setNewLog("");
    loadSub();
  };

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const path = `tasks/${task.id}/${Date.now()}_${file.name}`;
    const { error } = await supabase.storage.from("files").upload(path, file);
    if (error) {
      alert("업로드 실패: " + error.message);
    } else {
      const { data } = supabase.storage.from("files").getPublicUrl(path);
      await supabase.from("task_files").insert({
        task_id: task.id, file_name: file.name, file_url: data.publicUrl,
      });
      loadSub();
    }
    setUploading(false);
    e.target.value = "";
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{isNew ? "새 항목 추가" : "항목 상세"}</h2>
          <button className="btn-ghost" onClick={onClose}>닫기 ✕</button>
        </div>

        <div className="form-grid">
          <label>대구분 *
            <input list="cat-main-list" value={form.category_main} onChange={set("category_main")} placeholder="예: 대외협력 홍보(고용노동부 등)" />
            <datalist id="cat-main-list">
              {categories.mains.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label>소구분
            <input list="cat-sub-list" value={form.category_sub} onChange={set("category_sub")} placeholder="예: 배너" />
            <datalist id="cat-sub-list">
              {categories.subs.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label>항목 *<input value={form.item_name} onChange={set("item_name")} placeholder="예: 고용노동부 : 배너 홍보" /></label>
          <label>시행일정<input type="date" value={form.schedule_date} onChange={set("schedule_date")} /></label>
          <label>상태
            <select value={form.status} onChange={set("status")}>
              {STATUS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label>전자담당<input value={form.owner} onChange={set("owner")} placeholder="쉼표로 여러 명 입력" /></label>
          <label>멀캠담당<input value={form.partner} onChange={set("partner")} placeholder="쉼표로 여러 명 입력" /></label>
          <label className="full">세부내용<textarea rows={3} value={form.detail} onChange={set("detail")}></textarea></label>
        </div>

        <div className="modal-actions">
          {!isNew && <button className="btn-danger" onClick={remove}>삭제</button>}
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>

        {!isNew && (
          <React.Fragment>
            <hr />
            {(linkedEvents.length > 0 || linkedMsgs.length > 0) && (
              <React.Fragment>
                <h3>연결된 일정 / 문자</h3>
                <ul className="link-list">
                  {linkedEvents.map((ev) => (
                    <li key={"e" + ev.id}>
                      <span className={"ev-type " + eventTypeClass(ev.event_type)}>{ev.event_type}</span>
                      <b>{fmtDate(ev.event_date)}</b> {ev.is_important && "⭐"} {ev.title}
                      {ev.location && <span className="dim"> · {ev.location}</span>}
                      {onGoCalendar && <button className="btn-mini" onClick={() => { onClose(); onGoCalendar(ev.event_date); }}>캘린더에서 보기</button>}
                    </li>
                  ))}
                  {linkedMsgs.map((m) => (
                    <li key={"m" + m.id}>
                      <span className="ev-type msg-badge">문자</span>
                      <b>{fmtDate(m.send_date)}</b> {m.title}
                      <span className={"status-inline s-" + m.status}>{m.status}</span>
                    </li>
                  ))}
                </ul>
              </React.Fragment>
            )}

            <h3>진행사항 로그</h3>
            <div className="log-input">
              <input
                value={newLog}
                placeholder="예: 4.14 홍보물 게시 완료"
                onChange={(e) => setNewLog(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addLog()}
              />
              <button className="btn-primary" onClick={addLog}>기록</button>
            </div>
            {logs.length === 0 && <div className="empty small">아직 기록이 없습니다.</div>}
            <ul className="log-list">
              {logs.map((l) => (
                <li key={l.id}>
                  <span className="log-time">{fmtDateTime(l.created_at)}</span>
                  {l.content}
                </li>
              ))}
            </ul>

            <h3>첨부파일</h3>
            <label className="upload-btn">
              {uploading ? "업로드 중…" : "+ 파일 업로드"}
              <input type="file" onChange={upload} disabled={uploading} hidden />
            </label>
            {files.length === 0 && <div className="empty small">첨부된 파일이 없습니다.</div>}
            <ul className="file-list">
              {files.map((f) => (
                <li key={f.id}>
                  <a href={f.file_url} target="_blank" rel="noreferrer">{f.file_name}</a>
                  <span className="log-time">{fmtDateTime(f.uploaded_at)}</span>
                </li>
              ))}
            </ul>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

// ---- 현황판 ------------------------------------------------------
const EMPTY_TASK = {
  category_main: "", category_sub: "", item_name: "", detail: "",
  status: "대기", schedule_date: "", owner: "", partner: "",
};

function StatusBoard({ campaignId, onGoCalendar }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [fStatus, setFStatus] = useState("전체");
  const [fPerson, setFPerson] = useState("");
  const [collapsed, setCollapsed] = useState({});

  const load = async () => {
    const { data, error } = await supabase
      .from("tasks").select("*")
      .eq("campaign_id", campaignId)
      .order("sort_order").order("id");
    if (!error) setTasks(data || []);
    setLoading(false);
  };

  useEffect(() => {
    setLoading(true);
    load();
    return subscribeTables(["tasks"], load);
  }, [campaignId]);

  const cycleStatus = async (task, e) => {
    e.stopPropagation();
    const next = STATUS[(STATUS.indexOf(task.status) + 1) % STATUS.length];
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: next } : t)));
    await supabase.from("tasks").update({ status: next }).eq("id", task.id);
  };

  const filtered = useMemo(() => tasks.filter((t) => {
    if (fStatus !== "전체" && t.status !== fStatus) return false;
    if (fPerson && !(t.owner + "," + t.partner).includes(fPerson)) return false;
    return true;
  }), [tasks, fStatus, fPerson]);

  const categories = useMemo(() => ({
    mains: [...new Set(tasks.map((t) => t.category_main).filter(Boolean))],
    subs: [...new Set(tasks.map((t) => t.category_sub).filter(Boolean))],
  }), [tasks]);

  const groups = useMemo(() => {
    const map = new Map();
    filtered.forEach((t) => {
      if (!map.has(t.category_main)) map.set(t.category_main, []);
      map.get(t.category_main).push(t);
    });
    return [...map.entries()];
  }, [filtered]);

  const doneCount = tasks.filter((t) => t.status === "완료").length;

  return (
    <div>
      <div className="board-head">
        <div className="board-summary">
          전체 <b>{tasks.length}</b>건 · 완료 <b className="c-done">{doneCount}</b> ·
          진행중 <b className="c-doing">{tasks.filter((t) => t.status === "진행중").length}</b> ·
          대기 <b className="c-wait">{tasks.filter((t) => t.status === "대기").length}</b>
        </div>
        <div className="board-filters">
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
            <option>전체</option>
            {STATUS.map((s) => <option key={s}>{s}</option>)}
          </select>
          <input
            placeholder="담당자 검색"
            value={fPerson}
            onChange={(e) => setFPerson(e.target.value)}
          />
          <button className="btn-primary" onClick={() => setCreating(true)}>+ 항목 추가</button>
        </div>
      </div>

      {loading && <div className="empty">불러오는 중…</div>}
      {!loading && groups.length === 0 && (
        <div className="empty">표시할 항목이 없습니다. 오른쪽 위 "항목 추가"로 시작하세요.</div>
      )}

      {groups.map(([cat, rows]) => (
        <section key={cat} className="group">
          <button
            className="group-title"
            onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
          >
            <span className={collapsed[cat] ? "chev closed" : "chev"}>▾</span>
            {cat} <span className="group-count">{rows.length}</span>
          </button>

          {!collapsed[cat] && (
            <table className="board-table">
              <thead>
                <tr>
                  <th style={{ width: 84 }}>상태</th>
                  <th style={{ width: 90 }}>소구분</th>
                  <th style={{ width: 200 }}>항목</th>
                  <th>세부내용</th>
                  <th style={{ width: 70 }}>일정</th>
                  <th style={{ width: 130 }}>전자담당</th>
                  <th style={{ width: 150 }}>멀캠담당</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} onClick={() => setSelected(t)}>
                    <td>
                      <button className={"status s-" + t.status} onClick={(e) => cycleStatus(t, e)}>
                        {t.status}
                      </button>
                    </td>
                    <td className="dim">{t.category_sub}</td>
                    <td className="strong">{t.item_name}</td>
                    <td className="detail-cell">{t.detail}</td>
                    <td className={"date-cell" + (t.status !== "완료" && t.schedule_date && t.schedule_date <= new Date().toISOString().slice(0, 10) ? " overdue" : "")}>
                      {fmtDate(t.schedule_date)}
                    </td>
                    <td className="dim">{t.owner}</td>
                    <td className="dim">{t.partner}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      {(selected || creating) && (
        <TaskModal
          task={creating ? EMPTY_TASK : selected}
          isNew={creating}
          campaignId={campaignId}
          categories={categories}
          onGoCalendar={onGoCalendar}
          onClose={() => { setSelected(null); setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

// ---- 캘린더 (일정 + 문자발송 통합 표시) -----------------------------
function pad(n) { return String(n).padStart(2, "0"); }
function dkey(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function eventTypeClass(type) {
  if (type === "오프라인") return "off";
  if (type === "일반") return "general";
  return "on";
}

function CalendarView({ campaignId, initialDate }) {
  const today = new Date();
  const init = initialDate ? new Date(initialDate) : today;
  const [ym, setYm] = useState({ y: init.getFullYear(), m: init.getMonth() + 1 });
  const [events, setEvents] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selDate, setSelDate] = useState(initialDate || null);
  const [form, setForm] = useState(null);
  const [filter, setFilter] = useState("전체"); // 전체 | 일정만 | 문자만

  const load = async () => {
    const [e, m, t] = await Promise.all([
      supabase.from("events").select("*").eq("campaign_id", campaignId).order("event_date"),
      supabase.from("messages").select("id,title,send_date,status,channel").eq("campaign_id", campaignId).eq("archived", false).not("send_date", "is", null),
      supabase.from("tasks").select("id,item_name").eq("campaign_id", campaignId).order("id"),
    ]);
    setEvents(e.data || []);
    setMsgs(m.data || []);
    setTasks(t.data || []);
  };

  useEffect(() => {
    load();
    return subscribeTables(["events", "messages"], load);
  }, [campaignId]);

  const showEvents = filter !== "문자만";
  const showMsgs = filter !== "일정만";

  const byDate = useMemo(() => {
    const map = {};
    if (showEvents) events.forEach((ev) => {
      (map[ev.event_date] = map[ev.event_date] || []).push({ kind: "event", ...ev });
    });
    if (showMsgs) msgs.forEach((m) => {
      (map[m.send_date] = map[m.send_date] || []).push({ kind: "msg", ...m });
    });
    return map;
  }, [events, msgs, showEvents, showMsgs]);

  const first = new Date(ym.y, ym.m - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(ym.y, ym.m, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const move = (diff) => {
    let m = ym.m + diff, y = ym.y;
    if (m === 0) { m = 12; y--; }
    if (m === 13) { m = 1; y++; }
    setYm({ y, m });
    setSelDate(null);
  };

  const saveEvent = async () => {
    if (!form.title.trim()) { alert("내용을 입력하세요."); return; }
    const payload = {
      event_date: form.event_date,
      event_type: form.event_type,
      title: form.title.trim(),
      location: form.location,
      note: form.note,
      is_important: !!form.is_important,
      related_task_id: form.related_task_id || null,
    };
    if (form.id) await supabase.from("events").update(payload).eq("id", form.id);
    else { payload.campaign_id = campaignId; await supabase.from("events").insert(payload); }
    setForm(null);
    load();
  };

  const removeEvent = async (id) => {
    if (!confirm("이 일정을 삭제할까요?")) return;
    await supabase.from("events").delete().eq("id", id);
    load();
  };

  const todayKey = dkey(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const selItems = selDate ? byDate[selDate] || [] : [];

  return (
    <div className="cal-layout">
      <div className="cal-main">
        <div className="cal-head">
          <button className="btn-ghost" onClick={() => move(-1)}>◀</button>
          <h2>{ym.y}년 {ym.m}월</h2>
          <button className="btn-ghost" onClick={() => move(1)}>▶</button>
          <div className="cal-filter">
            {["전체", "일정만", "문자만"].map((f) => (
              <button key={f} className={filter === f ? "chip active" : "chip"} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        </div>
        <div className="cal-grid">
          {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
            <div key={d} className={"cal-dow" + (i === 0 ? " sun" : i === 6 ? " sat" : "")}>{d}</div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={"e" + i} className="cal-cell empty-cell" />;
            const k = dkey(ym.y, ym.m, d);
            const items = byDate[k] || [];
            return (
              <button
                key={k}
                className={"cal-cell" + (k === todayKey ? " today" : "") + (k === selDate ? " sel" : "")}
                onClick={() => setSelDate(k)}
              >
                <span className="cal-day">{d}</span>
                {items.slice(0, 3).map((it) => (
                  <span
                    key={it.kind + it.id}
                    className={"cal-ev " + (it.kind === "msg" ? "msg" : eventTypeClass(it.event_type)) + (it.is_important ? " important" : "")}
                  >
                    {it.kind === "msg" ? "✉ " : it.is_important ? "⭐ " : ""}{it.title}
                  </span>
                ))}
                {items.length > 3 && <span className="cal-more">+{items.length - 3}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <aside className="cal-side">
        {!selDate && <div className="empty">날짜를 선택하면 일정이 표시됩니다.</div>}
        {selDate && (
          <React.Fragment>
            <div className="cal-side-head">
              <h3>{selDate}</h3>
              <button
                className="btn-primary"
                onClick={() => setForm({ event_date: selDate, event_type: "온라인", title: "", location: "", note: "", related_task_id: "", is_important: false })}
              >
                + 일정 추가
              </button>
            </div>
            {selItems.length === 0 && <div className="empty small">이 날짜에는 일정이 없습니다.</div>}
            {selItems.map((it) => it.kind === "event" ? (
              <div key={"e" + it.id} className={"ev-card" + (it.is_important ? " important-card" : "")}>
                <div className="ev-top">
                  <span className={"ev-type " + eventTypeClass(it.event_type)}>{it.event_type}</span>
                  <div>
                    <button className="btn-mini" onClick={() => setForm({ ...it, related_task_id: it.related_task_id || "" })}>수정</button>
                    <button className="btn-mini danger" onClick={() => removeEvent(it.id)}>삭제</button>
                  </div>
                </div>
                <div className="ev-title">{it.is_important && <span className="star">⭐</span>}{it.title}</div>
                {it.location && <div className="ev-meta">📍 {it.location}</div>}
                {it.note && <div className="ev-meta">{it.note}</div>}
                {it.related_task_id && (
                  <div className="ev-meta link">
                    🔗 {tasks.find((t) => t.id === it.related_task_id)?.item_name || "연결된 항목"}
                  </div>
                )}
              </div>
            ) : (
              <div key={"m" + it.id} className="ev-card msg-card">
                <div className="ev-top">
                  <span className="ev-type msg-badge">✉ {it.channel}</span>
                  <span className={"status-inline s-" + it.status}>{it.status}</span>
                </div>
                <div className="ev-title">{it.title}</div>
                <div className="ev-meta dim">공지/문자 탭에서 내용 확인·수정</div>
              </div>
            ))}
          </React.Fragment>
        )}
      </aside>

      {form && (
        <div className="overlay" onClick={() => setForm(null)}>
          <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{form.id ? "일정 수정" : "일정 추가"}</h2>
              <button className="btn-ghost" onClick={() => setForm(null)}>닫기 ✕</button>
            </div>
            <div className="form-grid">
              <label>날짜<input type="date" value={form.event_date} onChange={(e) => setForm({ ...form, event_date: e.target.value })} /></label>
              <label>구분
                <select value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value })}>
                  <option>온라인</option><option>오프라인</option><option>일반</option>
                </select>
              </label>
              <label className="check-label full">
                <input type="checkbox" checked={!!form.is_important} onChange={(e) => setForm({ ...form, is_important: e.target.checked })} />
                ⭐ 중요 일정으로 표시
              </label>
              <label className="full">내용 *<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="예: 모집설명회" /></label>
              <label>장소<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>
              <label>현황판 항목 연결
                <select value={form.related_task_id} onChange={(e) => setForm({ ...form, related_task_id: e.target.value ? Number(e.target.value) : "" })}>
                  <option value="">연결 안 함</option>
                  {tasks.map((t) => <option key={t.id} value={t.id}>{t.item_name}</option>)}
                </select>
              </label>
              <label className="full">비고<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={saveEvent}>저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 인력배정표 ---------------------------------------------------
const EMPTY_STAFF = {
  event_date: "", time_range: "", region: "", place: "", sub_place: "",
  capacity: "", description: "", host_name: "", note: "",
};

function StaffView({ campaignId }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);

  const load = async () => {
    const { data } = await supabase.from("staff_assignments").select("*")
      .eq("campaign_id", campaignId).order("event_date");
    setRows(data || []);
  };

  useEffect(() => {
    load();
    return subscribeTables(["staff_assignments"], load);
  }, [campaignId]);

  const save = async () => {
    if (!form.event_date || !form.place.trim()) { alert("일정과 장소는 필수입니다."); return; }
    const payload = { ...form, capacity: form.capacity === "" ? null : Number(form.capacity) };
    delete payload.id;
    if (form.id) await supabase.from("staff_assignments").update(payload).eq("id", form.id);
    else { payload.campaign_id = campaignId; await supabase.from("staff_assignments").insert(payload); }
    setForm(null);
    load();
  };

  const remove = async (id) => {
    if (!confirm("이 배정을 삭제할까요?")) return;
    await supabase.from("staff_assignments").delete().eq("id", id);
    load();
  };

  return (
    <div>
      <div className="board-head">
        <h2>설명회 일정 및 인력 배정</h2>
        <button className="btn-primary" onClick={() => setForm({ ...EMPTY_STAFF })}>+ 배정 추가</button>
      </div>

      {rows.length === 0 && <div className="empty">등록된 배정이 없습니다.</div>}
      {rows.length > 0 && (
        <table className="board-table">
          <thead>
            <tr>
              <th>일정</th><th>시간</th><th>권역</th><th>장소</th><th>세부장소</th>
              <th>정원</th><th>설명</th><th>운영</th><th>비고</th><th style={{ width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="strong">{fmtDate(r.event_date)}</td>
                <td>{r.time_range}</td>
                <td>{r.region}</td>
                <td className="strong">{r.place}</td>
                <td className="dim">{r.sub_place}</td>
                <td>{r.capacity ?? ""}</td>
                <td className="dim">{r.description}</td>
                <td>{r.host_name}</td>
                <td className="dim">{r.note}</td>
                <td>
                  <button className="btn-mini" onClick={() => setForm({ ...r, capacity: r.capacity ?? "" })}>수정</button>
                  <button className="btn-mini danger" onClick={() => remove(r.id)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {form && (
        <div className="overlay" onClick={() => setForm(null)}>
          <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{form.id ? "배정 수정" : "배정 추가"}</h2>
              <button className="btn-ghost" onClick={() => setForm(null)}>닫기 ✕</button>
            </div>
            <div className="form-grid">
              <label>일정 *<input type="date" value={form.event_date} onChange={(e) => setForm({ ...form, event_date: e.target.value })} /></label>
              <label>시간<input value={form.time_range} onChange={(e) => setForm({ ...form, time_range: e.target.value })} placeholder="14시~16시" /></label>
              <label>권역<input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></label>
              <label>장소 *<input value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} /></label>
              <label>세부장소<input value={form.sub_place} onChange={(e) => setForm({ ...form, sub_place: e.target.value })} /></label>
              <label>정원<input type="number" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></label>
              <label>운영<input value={form.host_name} onChange={(e) => setForm({ ...form, host_name: e.target.value })} /></label>
              <label className="full">설명<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              <label className="full">비고<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={save}>저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- D-Day 타임라인 ------------------------------------------------
const EMPTY_TL = { event_date: "", order_no: "", content: "", location: "", note: "" };

function TimelineView({ campaignId }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);

  const load = async () => {
    const { data } = await supabase.from("timeline_items").select("*")
      .eq("campaign_id", campaignId)
      .order("event_date").order("order_no");
    setRows(data || []);
  };

  useEffect(() => {
    load();
    return subscribeTables(["timeline_items"], load);
  }, [campaignId]);

  const groups = useMemo(() => {
    const map = new Map();
    rows.forEach((r) => {
      if (!map.has(r.event_date)) map.set(r.event_date, []);
      map.get(r.event_date).push(r);
    });
    return [...map.entries()];
  }, [rows]);

  const save = async () => {
    if (!form.event_date || !form.content.trim()) { alert("날짜와 내용은 필수입니다."); return; }
    const payload = { ...form, order_no: form.order_no === "" ? 0 : Number(form.order_no) };
    delete payload.id;
    if (form.id) await supabase.from("timeline_items").update(payload).eq("id", form.id);
    else { payload.campaign_id = campaignId; await supabase.from("timeline_items").insert(payload); }
    setForm(null);
    load();
  };

  const remove = async (id) => {
    if (!confirm("이 항목을 삭제할까요?")) return;
    await supabase.from("timeline_items").delete().eq("id", id);
    load();
  };

  return (
    <div>
      <div className="board-head">
        <h2>D-Day 타임라인 (당일 진행 순서)</h2>
        <button className="btn-primary" onClick={() => setForm({ ...EMPTY_TL })}>+ 순서 추가</button>
      </div>

      {groups.length === 0 && <div className="empty">등록된 타임라인이 없습니다.</div>}

      {groups.map(([date, items]) => (
        <section key={date} className="group">
          <div className="group-title static">{date}</div>
          <ol className="timeline">
            {items.map((r) => (
              <li key={r.id}>
                <span className="tl-no">{r.order_no}</span>
                <div className="tl-body">
                  <div className="tl-content">{r.content}</div>
                  <div className="tl-meta">
                    {r.location && <span className="tl-loc">{r.location}</span>}
                    {r.note && <span>{r.note}</span>}
                  </div>
                </div>
                <div>
                  <button className="btn-mini" onClick={() => setForm({ ...r, order_no: r.order_no ?? "" })}>수정</button>
                  <button className="btn-mini danger" onClick={() => remove(r.id)}>삭제</button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}

      {form && (
        <div className="overlay" onClick={() => setForm(null)}>
          <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{form.id ? "순서 수정" : "순서 추가"}</h2>
              <button className="btn-ghost" onClick={() => setForm(null)}>닫기 ✕</button>
            </div>
            <div className="form-grid">
              <label>날짜 *<input type="date" value={form.event_date} onChange={(e) => setForm({ ...form, event_date: e.target.value })} /></label>
              <label>순서<input type="number" value={form.order_no} onChange={(e) => setForm({ ...form, order_no: e.target.value })} /></label>
              <label className="full">내용 *<input value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="예: 16기 모집공고 팝업 게시" /></label>
              <label>위치<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="예: ssafy.com" /></label>
              <label>비고<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={save}>저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 문자메시지 상세 모달 --------------------------------------------
function MessageModal({ msg, isNew, campaignId, categories, onClose }) {
  const [form, setForm] = useState({ ...msg, send_date: msg.send_date || "" });
  const [changeNote, setChangeNote] = useState("");
  const [logs, setLogs] = useState([]);
  const [files, setFiles] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]); // 신규 작성 중 첨부 대기 파일
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tasks, setTasks] = useState([]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const bytes = smsBytes(form.content);

  const loadSub = async () => {
    const t = await supabase.from("tasks").select("id,item_name").eq("campaign_id", campaignId).order("id");
    setTasks(t.data || []);
    if (isNew) return;
    const [l, f] = await Promise.all([
      supabase.from("message_logs").select("*").eq("message_id", msg.id).order("created_at", { ascending: false }),
      supabase.from("message_files").select("*").eq("message_id", msg.id).order("uploaded_at", { ascending: false }),
    ]);
    setLogs(l.data || []);
    setFiles(f.data || []);
  };

  useEffect(() => { loadSub(); }, []);

  const save = async () => {
    if (!form.category.trim() || !form.title.trim()) {
      alert("카테고리와 문자 이름은 필수입니다.");
      return;
    }
    setSaving(true);
    const payload = {
      category: form.category.trim(),
      title: form.title.trim(),
      content: form.content,
      channel: form.channel,
      send_date: form.send_date || null,
      status: form.status,
      related_task_id: form.related_task_id || null,
    };
    if (isNew) {
      payload.campaign_id = campaignId;
      const { data, error } = await supabase.from("messages").insert(payload).select().single();
      if (error) {
        alert("저장 실패: " + error.message);
        setSaving(false);
        return;
      }
      // 대기 중이던 첨부파일 업로드
      for (const file of pendingFiles) {
        const path = `messages/${data.id}/${Date.now()}_${file.name}`;
        const { error: upErr } = await supabase.storage.from("files").upload(path, file);
        if (!upErr) {
          const { data: pub } = supabase.storage.from("files").getPublicUrl(path);
          await supabase.from("message_files").insert({
            message_id: data.id, file_name: file.name, file_url: pub.publicUrl,
          });
        }
      }
    } else {
      // 내용이 바뀌었으면 이전 내용을 이력으로 저장
      if (form.content !== msg.content) {
        await supabase.from("message_logs").insert({
          message_id: msg.id,
          content: msg.content || "(비어 있음)",
          note: changeNote.trim(),
        });
      }
      await supabase.from("messages").update(payload).eq("id", msg.id);
    }
    setSaving(false);
    onClose();
  };

  const removeOrArchive = async () => {
    if (msg.status === "발송완료") {
      if (!confirm("발송완료된 문자는 기록 보존을 위해 삭제 대신 보관 처리됩니다.\n보관할까요? (보관함 보기로 다시 확인 가능)")) return;
      await supabase.from("messages").update({ archived: true }).eq("id", msg.id);
    } else {
      if (!confirm("이 문자를 삭제할까요? 이력과 첨부파일도 함께 삭제됩니다.")) return;
      await supabase.from("messages").delete().eq("id", msg.id);
    }
    onClose();
  };

  const unarchive = async () => {
    await supabase.from("messages").update({ archived: false }).eq("id", msg.id);
    onClose();
  };

  const addPending = (e) => {
    const file = e.target.files?.[0];
    if (file) setPendingFiles((prev) => [...prev, file]);
    e.target.value = "";
  };
  const removePending = (idx) => setPendingFiles((prev) => prev.filter((_, i) => i !== idx));

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const path = `messages/${msg.id}/${Date.now()}_${file.name}`;
    const { error } = await supabase.storage.from("files").upload(path, file);
    if (error) {
      alert("업로드 실패: " + error.message);
    } else {
      const { data } = supabase.storage.from("files").getPublicUrl(path);
      await supabase.from("message_files").insert({
        message_id: msg.id, file_name: file.name, file_url: data.publicUrl,
      });
      loadSub();
    }
    setUploading(false);
    e.target.value = "";
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{isNew ? "새 문자/공지 추가" : "문자/공지 상세"}{msg.archived ? " (보관됨)" : ""}</h2>
          <button className="btn-ghost" onClick={onClose}>닫기 ✕</button>
        </div>

        <div className="form-grid">
          <label>카테고리 *
            <input list="msg-cats" value={form.category} onChange={set("category")} placeholder="예: 모집홍보 문자" />
            <datalist id="msg-cats">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label>이름 *<input value={form.title} onChange={set("title")} placeholder="예: 4/13 1차 발송분" /></label>
          <label>채널
            <select value={form.channel} onChange={set("channel")}>
              {CHANNELS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label>발송(예정)일<input type="date" value={form.send_date} onChange={set("send_date")} /></label>
          <label>상태
            <select value={form.status} onChange={set("status")}>
              {MSG_STATUS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label>현황판 항목 연결
            <select value={form.related_task_id || ""} onChange={(e) => setForm({ ...form, related_task_id: e.target.value ? Number(e.target.value) : "" })}>
              <option value="">연결 안 함</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.item_name}</option>)}
            </select>
          </label>
          <label className="full">본문
            <textarea rows={6} value={form.content} onChange={set("content")} placeholder="문자 내용 입력"></textarea>
            <span className={"byte-counter" + (bytes > 90 ? " over" : "")}>
              {form.content.length}자 / {bytes} byte {bytes > 90 ? "(90byte 초과 → LMS 장문 전환)" : "(SMS 단문 기준 90byte)"}
            </span>
          </label>
          {!isNew && form.content !== msg.content && (
            <label className="full">변경 메모 (이전 내용은 자동으로 이력에 저장됩니다)
              <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="예: 설명회 시간 변경 반영" />
            </label>
          )}
        </div>

        <div className="modal-actions">
          {!isNew && msg.archived && <button className="btn-ghost" onClick={unarchive}>보관 해제</button>}
          {!isNew && !msg.archived && (
            <button className="btn-danger" onClick={removeOrArchive}>
              {msg.status === "발송완료" ? "보관" : "삭제"}
            </button>
          )}
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>

        {isNew && (
          <React.Fragment>
            <hr />
            <h3>첨부파일 (알림톡 시안, 사진 등)</h3>
            <label className="upload-btn">
              + 사진/파일 추가
              <input type="file" onChange={addPending} hidden />
            </label>
            {pendingFiles.length === 0 && <div className="empty small">저장하면 함께 업로드됩니다.</div>}
            <ul className="file-thumbs">
              {pendingFiles.map((f, i) => (
                <li key={i}>
                  {isImageFile(f.name)
                    ? <img src={URL.createObjectURL(f)} alt={f.name} />
                    : <span className="file-icon">📎</span>}
                  <span className="thumb-name">{f.name}</span>
                  <button className="btn-mini danger" onClick={() => removePending(i)}>제거</button>
                </li>
              ))}
            </ul>
          </React.Fragment>
        )}

        {!isNew && (
          <React.Fragment>
            <hr />
            <h3>내용 변경 이력</h3>
            {logs.length === 0 && <div className="empty small">아직 변경 이력이 없습니다.</div>}
            <ul className="log-list">
              {logs.map((l) => (
                <li key={l.id}>
                  <span className="log-time">{fmtDateTime(l.created_at)}</span>
                  {l.note && <b>{l.note} — </b>}
                  <details>
                    <summary>이전 내용 보기</summary>
                    <pre className="log-pre">{l.content}</pre>
                  </details>
                </li>
              ))}
            </ul>

            <h3>첨부파일 (알림톡 시안, 사진 등)</h3>
            <label className="upload-btn">
              {uploading ? "업로드 중…" : "+ 사진/파일 추가"}
              <input type="file" onChange={upload} disabled={uploading} hidden />
            </label>
            {files.length === 0 && <div className="empty small">첨부된 파일이 없습니다.</div>}
            <ul className="file-thumbs">
              {files.map((f) => (
                <li key={f.id}>
                  {isImageFile(f.file_name)
                    ? <a href={f.file_url} target="_blank" rel="noreferrer"><img src={f.file_url} alt={f.file_name} /></a>
                    : <span className="file-icon">📎</span>}
                  <a className="thumb-name" href={f.file_url} target="_blank" rel="noreferrer">{f.file_name}</a>
                  <span className="log-time">{fmtDateTime(f.uploaded_at)}</span>
                </li>
              ))}
            </ul>
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

// ---- 문자메시지 목록 (공지/문자 탭) -----------------------------------
const EMPTY_MSG = {
  category: "", title: "", content: "", channel: "문자",
  send_date: "", status: "초안", related_task_id: "", archived: false,
};

function MessagesView({ campaignId }) {
  const [msgs, setMsgs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState({});

  const load = async () => {
    const { data } = await supabase.from("messages").select("*")
      .eq("campaign_id", campaignId)
      .order("send_date", { ascending: true, nullsFirst: false }).order("id");
    setMsgs(data || []);
  };

  useEffect(() => {
    load();
    return subscribeTables(["messages"], load);
  }, [campaignId]);

  const cycleStatus = async (m, e) => {
    e.stopPropagation();
    const next = MSG_STATUS[(MSG_STATUS.indexOf(m.status) + 1) % MSG_STATUS.length];
    setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, status: next } : x)));
    await supabase.from("messages").update({ status: next }).eq("id", m.id);
  };

  const visible = msgs.filter((m) => showArchived ? true : !m.archived);
  const categories = [...new Set(msgs.map((m) => m.category))];

  const groups = useMemo(() => {
    const map = new Map();
    visible.forEach((m) => {
      if (!map.has(m.category)) map.set(m.category, []);
      map.get(m.category).push(m);
    });
    return [...map.entries()];
  }, [visible]);

  return (
    <div>
      <div className="board-head">
        <div className="board-summary">
          전체 <b>{msgs.filter((m) => !m.archived).length}</b>건 ·
          발송완료 <b className="c-done">{msgs.filter((m) => !m.archived && m.status === "발송완료").length}</b> ·
          발송대기 <b className="c-doing">{msgs.filter((m) => !m.archived && m.status === "발송대기").length}</b> ·
          초안 <b className="c-wait">{msgs.filter((m) => !m.archived && m.status === "초안").length}</b>
        </div>
        <div className="board-filters">
          <label className="check-label">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            보관함 보기
          </label>
          <button className="btn-primary" onClick={() => setCreating(true)}>+ 문자/공지 추가</button>
        </div>
      </div>

      {groups.length === 0 && (
        <div className="empty">등록된 문자/공지가 없습니다. "문자/공지 추가"로 시작하세요.</div>
      )}

      {groups.map(([cat, rows]) => (
        <section key={cat} className="group">
          <button
            className="group-title"
            onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
          >
            <span className={collapsed[cat] ? "chev closed" : "chev"}>▾</span>
            {cat} <span className="group-count">{rows.length}</span>
          </button>

          {!collapsed[cat] && (
            <table className="board-table">
              <thead>
                <tr>
                  <th style={{ width: 92 }}>상태</th>
                  <th style={{ width: 180 }}>이름</th>
                  <th>본문 미리보기</th>
                  <th style={{ width: 100 }}>채널</th>
                  <th style={{ width: 80 }}>발송일</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} onClick={() => setSelected(m)} className={m.archived ? "row-archived" : ""}>
                    <td>
                      {m.archived
                        ? <span className="status s-보관">보관</span>
                        : <button className={"status s-" + m.status} onClick={(e) => cycleStatus(m, e)}>{m.status}</button>}
                    </td>
                    <td className="strong">{m.title}</td>
                    <td className="detail-cell preview-cell">{m.content}</td>
                    <td className="dim">{m.channel}</td>
                    <td className="date-cell">{fmtDate(m.send_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      {(selected || creating) && (
        <MessageModal
          msg={creating ? EMPTY_MSG : selected}
          isNew={creating}
          campaignId={campaignId}
          categories={categories}
          onClose={() => { setSelected(null); setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

// ---- 엑셀 다운로드 (현재 기수) -----------------------------------------
async function exportToExcel(campaignId, campaignName) {
  const [tasksRes, eventsRes, staffRes, tlRes, msgRes] = await Promise.all([
    supabase.from("tasks").select("*").eq("campaign_id", campaignId).order("sort_order").order("id"),
    supabase.from("events").select("*").eq("campaign_id", campaignId).order("event_date"),
    supabase.from("staff_assignments").select("*").eq("campaign_id", campaignId).order("event_date"),
    supabase.from("timeline_items").select("*").eq("campaign_id", campaignId).order("event_date").order("order_no"),
    supabase.from("messages").select("*").eq("campaign_id", campaignId).order("send_date"),
  ]);

  const tasksSheet = (tasksRes.data || []).map((t) => ({
    "대구분": t.category_main, "소구분": t.category_sub, "항목": t.item_name,
    "세부내용": t.detail, "상태": t.status, "시행일정": t.schedule_date || "",
    "전자담당": t.owner, "멀캠담당": t.partner,
  }));
  const eventsSheet = (eventsRes.data || []).map((e) => ({
    "날짜": e.event_date, "구분": e.event_type, "중요": e.is_important ? "★" : "",
    "내용": e.title, "장소": e.location, "비고": e.note,
  }));
  const staffSheet = (staffRes.data || []).map((s) => ({
    "일정": s.event_date, "시간": s.time_range, "권역": s.region, "장소": s.place,
    "세부장소": s.sub_place, "정원": s.capacity ?? "", "설명": s.description,
    "운영": s.host_name, "비고": s.note,
  }));
  const tlSheet = (tlRes.data || []).map((t) => ({
    "날짜": t.event_date, "순서": t.order_no, "내용": t.content, "위치": t.location, "비고": t.note,
  }));
  const msgSheet = (msgRes.data || []).map((m) => ({
    "카테고리": m.category, "이름": m.title, "본문": m.content, "채널": m.channel,
    "발송일": m.send_date || "", "상태": m.status, "보관여부": m.archived ? "보관" : "",
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tasksSheet), "현황판");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eventsSheet), "캘린더");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(staffSheet), "인력배정");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tlSheet), "D-Day타임라인");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(msgSheet), "공지문자");

  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  XLSX.writeFile(wb, `모집홍보_현황판_${campaignName}_${stamp}.xlsx`);
}

// ---- 전체 백업 (JSON, 모든 기수 포함) ------------------------------------
async function exportBackup() {
  const tables = [
    "campaigns", "tasks", "task_logs", "task_files",
    "events", "staff_assignments", "timeline_items",
    "messages", "message_logs", "message_files",
  ];
  const backup = { exported_at: new Date().toISOString() };
  for (const t of tables) {
    const { data, error } = await supabase.from(t).select("*");
    if (error) throw new Error(t + " 백업 실패: " + error.message);
    backup[t] = data || [];
  }
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  a.href = url;
  a.download = `현황판_전체백업_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- 최상위 앱 -----------------------------------------------------
const TABS = [
  { key: "board", label: "현황판" },
  { key: "calendar", label: "캘린더" },
  { key: "messages", label: "공지/문자" },
  { key: "staff", label: "인력배정" },
  { key: "timeline", label: "D-Day" },
];

function App() {
  const [authed, setAuthed] = useState(
    localStorage.getItem("promo_access_hash") === ACCESS_CODE_HASH && ACCESS_CODE_HASH !== ""
  );
  const [campaigns, setCampaigns] = useState(null); // null = 로딩중
  const [currentId, setCurrentId] = useState(null);
  const [tab, setTab] = useState("board");
  const [calDate, setCalDate] = useState(null); // 캘린더 이동용
  const [busy, setBusy] = useState("");

  const loadCampaigns = async () => {
    const { data, error } = await supabase.from("campaigns").select("*").order("id");
    if (error) { alert("기수 목록을 불러오지 못했습니다: " + error.message + "\n마이그레이션 SQL을 실행했는지 확인하세요."); return; }
    setCampaigns(data || []);
    // 마지막으로 보던 기수 복원, 없으면 가장 최근 기수
    const saved = Number(localStorage.getItem("promo_campaign"));
    if (data?.length) {
      const found = data.find((c) => c.id === saved);
      setCurrentId(found ? found.id : data[data.length - 1].id);
    }
  };

  useEffect(() => {
    if (authed) {
      loadCampaigns();
      return subscribeTables(["campaigns"], loadCampaigns);
    }
  }, [authed]);

  useEffect(() => {
    if (currentId) localStorage.setItem("promo_campaign", String(currentId));
  }, [currentId]);

  const createCampaign = async () => {
    const name = prompt("새 기수 이름을 입력하세요 (예: 17기)");
    if (!name || !name.trim()) return;
    const { data, error } = await supabase.from("campaigns")
      .insert({ name: name.trim(), status: "진행중" }).select().single();
    if (error) { alert("기수 생성 실패: " + error.message); return; }
    await loadCampaigns();
    setCurrentId(data.id);
    setTab("board");
  };

  const toggleCampaignStatus = async () => {
    const cur = campaigns.find((c) => c.id === currentId);
    if (!cur) return;
    const next = cur.status === "진행중" ? "종료" : "진행중";
    if (!confirm(`"${cur.name}"를 "${next}" 상태로 변경할까요? (표시용 라벨이며 편집은 계속 가능합니다)`)) return;
    await supabase.from("campaigns").update({ status: next }).eq("id", currentId);
    loadCampaigns();
  };

  const handleExport = async () => {
    setBusy("excel");
    try {
      const cur = campaigns.find((c) => c.id === currentId);
      await exportToExcel(currentId, cur ? cur.name : "");
    } catch (err) { alert("엑셀 다운로드 오류: " + err.message); }
    setBusy("");
  };

  const handleBackup = async () => {
    setBusy("backup");
    try { await exportBackup(); }
    catch (err) { alert("백업 오류: " + err.message); }
    setBusy("");
  };

  const goCalendar = (date) => {
    setCalDate(date);
    setTab("calendar");
  };

  if (!authed) return <Gate onPass={() => setAuthed(true)} />;
  if (campaigns === null) return <div className="empty" style={{ margin: 40 }}>불러오는 중…</div>;

  // 기수가 하나도 없으면 첫 기수 생성 화면
  if (campaigns.length === 0) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="gate-stripe" />
          <h1>첫 기수 만들기</h1>
          <p>아직 등록된 기수가 없습니다. 첫 기수를 만들어 시작하세요.</p>
          <button className="btn-primary" onClick={createCampaign}>+ 새 기수 만들기</button>
        </div>
      </div>
    );
  }

  const cur = campaigns.find((c) => c.id === currentId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span className="stripe-dot" />
          모집홍보 현황판
        </div>
        <div className="campaign-box">
          <select value={currentId || ""} onChange={(e) => setCurrentId(Number(e.target.value))}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.status === "종료" ? " (종료)" : ""}
              </option>
            ))}
          </select>
          <button className="btn-ghost" onClick={createCampaign} title="새 기수 시작">＋</button>
          {cur && (
            <button className="btn-mini" onClick={toggleCampaignStatus}>
              {cur.status === "진행중" ? "종료 표시" : "진행중으로"}
            </button>
          )}
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? "tab active" : "tab"}
              onClick={() => { setTab(t.key); if (t.key !== "calendar") setCalDate(null); }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <button className="btn-ghost" onClick={handleExport} disabled={busy === "excel"}>
            {busy === "excel" ? "다운로드 중…" : "⬇ 엑셀"}
          </button>
          <button className="btn-ghost" onClick={handleBackup} disabled={busy === "backup"}>
            {busy === "backup" ? "백업 중…" : "🗂 전체백업"}
          </button>
          <button
            className="btn-ghost"
            onClick={() => { localStorage.removeItem("promo_access_hash"); setAuthed(false); }}
          >
            나가기
          </button>
        </div>
      </header>

      <div className="campaign-banner">
        현재 보고 있는 기수: <b>{cur ? cur.name : "-"}</b>
        {cur && cur.status === "종료" && <span className="archived-tag">종료된 기수 (편집 가능)</span>}
      </div>

      <main className="content">
        {tab === "board" && <StatusBoard campaignId={currentId} onGoCalendar={goCalendar} />}
        {tab === "calendar" && <CalendarView campaignId={currentId} initialDate={calDate} />}
        {tab === "messages" && <MessagesView campaignId={currentId} />}
        {tab === "staff" && <StaffView campaignId={currentId} />}
        {tab === "timeline" && <TimelineView campaignId={currentId} />}
      </main>
    </div>
  );
}

// ---- 렌더 -----------------------------------------------------------
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
