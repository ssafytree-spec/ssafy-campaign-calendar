const { useState, useEffect, useMemo } = React;

// ---- Supabase 클라이언트 -------------------------------------
const supabase = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);
const ACCESS_CODE = window.APP_CONFIG.ACCESS_CODE || "ssafy16";
const STATUS = ["대기", "진행중", "완료"];

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
// 테이블 변경 실시간 구독
function subscribeTables(tables, onChange) {
  const channel = supabase.channel("db-" + tables.join("-"));
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

  const submit = () => {
    if (code.trim() === ACCESS_CODE) {
      localStorage.setItem("promo_access", code.trim());
      onPass();
    } else {
      setError(true);
    }
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-stripe" />
        <h1>16기 모집홍보 현황판</h1>
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
        <button className="btn-primary" onClick={submit}>입장하기</button>
      </div>
    </div>
  );
}

// ---- 항목 상세 모달 -----------------------------------------------
function TaskModal({ task, isNew, onClose }) {
  const [form, setForm] = useState({ ...task, schedule_date: task.schedule_date || "" });
  const [logs, setLogs] = useState([]);
  const [files, setFiles] = useState([]);
  const [newLog, setNewLog] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const loadSub = async () => {
    if (isNew) return;
    const [l, f] = await Promise.all([
      supabase.from("task_logs").select("*").eq("task_id", task.id).order("created_at", { ascending: false }),
      supabase.from("task_files").select("*").eq("task_id", task.id).order("uploaded_at", { ascending: false }),
    ]);
    setLogs(l.data || []);
    setFiles(f.data || []);
  };

  useEffect(() => {
    loadSub();
    if (!isNew) return subscribeTables(["task_logs", "task_files"], loadSub);
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
    if (isNew) await supabase.from("tasks").insert(payload);
    else await supabase.from("tasks").update(payload).eq("id", task.id);
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
    const path = `${task.id}/${Date.now()}_${file.name}`;
    const { error } = await supabase.storage.from("files").upload(path, file);
    if (error) {
      alert("업로드 실패: " + error.message + "\nSupabase Storage에 \"files\" 버킷이 있는지 확인하세요.");
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
          <label>대구분 *<input value={form.category_main} onChange={set("category_main")} placeholder="예: 대외협력 홍보(고용노동부 등)" /></label>
          <label>소구분<input value={form.category_sub} onChange={set("category_sub")} placeholder="예: 배너" /></label>
          <label>항목 *<input value={form.item_name} onChange={set("item_name")} placeholder="예: 고용노동부 : 배너 홍보" /></label>
          <label>시행일정<input type="date" value={form.schedule_date} onChange={set("schedule_date")} /></label>
          <label>상태
            <select value={form.status} onChange={set("status")}>
              {STATUS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label>협업담당<input value={form.owner} onChange={set("owner")} placeholder="쉼표로 여러 명 입력" /></label>
          <label>협력담당<input value={form.partner} onChange={set("partner")} placeholder="쉼표로 여러 명 입력" /></label>
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

function StatusBoard() {
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
      .order("sort_order").order("id");
    if (!error) setTasks(data || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    return subscribeTables(["tasks"], load);
  }, []);

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
                  <th style={{ width: 130 }}>협업담당</th>
                  <th style={{ width: 150 }}>협력담당</th>
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
          onClose={() => { setSelected(null); setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

// ---- 캘린더 ------------------------------------------------------
function pad(n) { return String(n).padStart(2, "0"); }
function dkey(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

function CalendarView() {
  const today = new Date();
  const [ym, setYm] = useState({ y: today.getFullYear(), m: today.getMonth() + 1 });
  const [events, setEvents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selDate, setSelDate] = useState(null);
  const [form, setForm] = useState(null);

  const load = async () => {
    const [e, t] = await Promise.all([
      supabase.from("events").select("*").order("event_date"),
      supabase.from("tasks").select("id,item_name").order("id"),
    ]);
    setEvents(e.data || []);
    setTasks(t.data || []);
  };

  useEffect(() => {
    load();
    return subscribeTables(["events"], load);
  }, []);

  const byDate = useMemo(() => {
    const map = {};
    events.forEach((ev) => {
      (map[ev.event_date] = map[ev.event_date] || []).push(ev);
    });
    return map;
  }, [events]);

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
      related_task_id: form.related_task_id || null,
    };
    if (form.id) await supabase.from("events").update(payload).eq("id", form.id);
    else await supabase.from("events").insert(payload);
    setForm(null);
    load();
  };

  const removeEvent = async (id) => {
    if (!confirm("이 일정을 삭제할까요?")) return;
    await supabase.from("events").delete().eq("id", id);
    load();
  };

  const todayKey = dkey(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const selEvents = selDate ? byDate[selDate] || [] : [];

  return (
    <div className="cal-layout">
      <div className="cal-main">
        <div className="cal-head">
          <button className="btn-ghost" onClick={() => move(-1)}>◀</button>
          <h2>{ym.y}년 {ym.m}월</h2>
          <button className="btn-ghost" onClick={() => move(1)}>▶</button>
        </div>
        <div className="cal-grid">
          {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
            <div key={d} className={"cal-dow" + (i === 0 ? " sun" : i === 6 ? " sat" : "")}>{d}</div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={"e" + i} className="cal-cell empty-cell" />;
            const k = dkey(ym.y, ym.m, d);
            const evs = byDate[k] || [];
            return (
              <button
                key={k}
                className={"cal-cell" + (k === todayKey ? " today" : "") + (k === selDate ? " sel" : "")}
                onClick={() => setSelDate(k)}
              >
                <span className="cal-day">{d}</span>
                {evs.slice(0, 3).map((ev) => (
                  <span key={ev.id} className={"cal-ev " + (ev.event_type === "오프라인" ? "off" : "on")}>
                    {ev.title}
                  </span>
                ))}
                {evs.length > 3 && <span className="cal-more">+{evs.length - 3}</span>}
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
                onClick={() => setForm({ event_date: selDate, event_type: "온라인", title: "", location: "", note: "", related_task_id: "" })}
              >
                + 일정 추가
              </button>
            </div>
            {selEvents.length === 0 && <div className="empty small">이 날짜에는 일정이 없습니다.</div>}
            {selEvents.map((ev) => (
              <div key={ev.id} className="ev-card">
                <div className="ev-top">
                  <span className={"ev-type " + (ev.event_type === "오프라인" ? "off" : "on")}>{ev.event_type}</span>
                  <div>
                    <button className="btn-mini" onClick={() => setForm({ ...ev, related_task_id: ev.related_task_id || "" })}>수정</button>
                    <button className="btn-mini danger" onClick={() => removeEvent(ev.id)}>삭제</button>
                  </div>
                </div>
                <div className="ev-title">{ev.title}</div>
                {ev.location && <div className="ev-meta">📍 {ev.location}</div>}
                {ev.note && <div className="ev-meta">{ev.note}</div>}
                {ev.related_task_id && (
                  <div className="ev-meta link">
                    🔗 {tasks.find((t) => t.id === ev.related_task_id)?.item_name || "연결된 항목"}
                  </div>
                )}
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
                  <option>온라인</option><option>오프라인</option>
                </select>
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

function StaffView() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);

  const load = async () => {
    const { data } = await supabase.from("staff_assignments").select("*").order("event_date");
    setRows(data || []);
  };

  useEffect(() => {
    load();
    return subscribeTables(["staff_assignments"], load);
  }, []);

  const save = async () => {
    if (!form.event_date || !form.place.trim()) { alert("일정과 장소는 필수입니다."); return; }
    const payload = { ...form, capacity: form.capacity === "" ? null : Number(form.capacity) };
    delete payload.id;
    if (form.id) await supabase.from("staff_assignments").update(payload).eq("id", form.id);
    else await supabase.from("staff_assignments").insert(payload);
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

function TimelineView() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);

  const load = async () => {
    const { data } = await supabase.from("timeline_items").select("*")
      .order("event_date").order("order_no");
    setRows(data || []);
  };

  useEffect(() => {
    load();
    return subscribeTables(["timeline_items"], load);
  }, []);

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
    else await supabase.from("timeline_items").insert(payload);
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

// ---- 최상위 앱 -----------------------------------------------------
const TABS = [
  { key: "board", label: "현황판" },
  { key: "calendar", label: "캘린더" },
  { key: "staff", label: "인력배정" },
  { key: "timeline", label: "D-Day 타임라인" },
];

function App() {
  const [authed, setAuthed] = useState(
    localStorage.getItem("promo_access") === ACCESS_CODE
  );
  const [tab, setTab] = useState("board");

  if (!authed) return <Gate onPass={() => setAuthed(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span className="stripe-dot" />
          16기 모집홍보 현황판
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? "tab active" : "tab"}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button
          className="btn-ghost"
          onClick={() => { localStorage.removeItem("promo_access"); setAuthed(false); }}
        >
          나가기
        </button>
      </header>

      <main className="content">
        {tab === "board" && <StatusBoard />}
        {tab === "calendar" && <CalendarView />}
        {tab === "staff" && <StaffView />}
        {tab === "timeline" && <TimelineView />}
      </main>
    </div>
  );
}

// ---- 렌더 -----------------------------------------------------------
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
