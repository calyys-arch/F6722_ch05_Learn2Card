import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Deck, Topic } from "./types";
import "./App.css";

type TopicFilter = "all" | string;

type BrowseMode = "sequence" | "paged";

type ProcessParams = {
  topicThreshold: number;
  maxTopics: number;
  maxBullets: number;
  debug: boolean;
};

const DEFAULT_PARAMS: ProcessParams = {
  topicThreshold: 0.75,
  maxTopics: 5,
  maxBullets: 5,
  debug: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateDeckSchema(value: unknown): { ok: true; deck: Deck } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "deck.json 根節點必須是物件（object）。" };
  }

  const paragraphs = value.paragraphs;
  const topics = value.topics;
  const cards = value.cards;
  const stats = value.stats;

  if (!Array.isArray(paragraphs) || !Array.isArray(topics) || !Array.isArray(cards) || !isRecord(stats)) {
    return { ok: false, error: "deck.json 缺少必要欄位（paragraphs/topics/cards/stats）或型別不正確。" };
  }

  const paragraphOk = paragraphs.every((p) => {
    if (!isRecord(p)) return false;
    return (
      typeof p.id === "string" &&
      typeof p.text === "string" &&
      typeof p.summary === "string" &&
      isStringArray(p.keywords) &&
      typeof p.sourceIndex === "number"
    );
  });
  if (!paragraphOk) return { ok: false, error: "paragraphs 欄位格式錯誤：請確認每筆包含 id/text/summary/keywords/sourceIndex。" };

  const topicOk = topics.every((t) => {
    if (!isRecord(t)) return false;
    return typeof t.id === "string" && typeof t.title === "string" && isStringArray(t.memberIds);
  });
  if (!topicOk) return { ok: false, error: "topics 欄位格式錯誤：請確認每筆包含 id/title/memberIds。" };

  const cardOk = cards.every((c) => {
    if (!isRecord(c)) return false;
    return typeof c.id === "string" && typeof c.topicId === "string" && typeof c.title === "string" && isStringArray(c.bullets);
  });
  if (!cardOk) return { ok: false, error: "cards 欄位格式錯誤：請確認每筆包含 id/topicId/title/bullets。" };

  const statOk =
    typeof stats.paragraphCount === "number" &&
    typeof stats.topicCount === "number" &&
    typeof stats.cardCount === "number";
  if (!statOk) return { ok: false, error: "stats 欄位格式錯誤：請確認包含 paragraphCount/topicCount/cardCount。" };

  return { ok: true, deck: value as unknown as Deck };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeParams(params: ProcessParams): { params: ProcessParams; warnings: string[] } {
  const warnings: string[] = [];

  let topicThreshold = params.topicThreshold;
  if (!Number.isFinite(topicThreshold)) {
    warnings.push("分群閾值不是有效數字，已改用預設值 0.75。");
    topicThreshold = DEFAULT_PARAMS.topicThreshold;
  }
  topicThreshold = clampNumber(topicThreshold, 0, 1);
  if (topicThreshold !== params.topicThreshold) warnings.push("分群閾值超出範圍（0.0–1.0），已自動修正。");

  let maxTopics = params.maxTopics;
  if (!Number.isFinite(maxTopics)) {
    warnings.push("最大主題數不是有效數字，已改用預設值 5。");
    maxTopics = DEFAULT_PARAMS.maxTopics;
  }
  maxTopics = Math.trunc(clampNumber(maxTopics, 1, 10));
  if (maxTopics !== params.maxTopics) warnings.push("最大主題數超出範圍（1–10），已自動修正。");

  let maxBullets = params.maxBullets;
  if (!Number.isFinite(maxBullets)) {
    warnings.push("每卡摘要數不是有效數字，已改用預設值 5。");
    maxBullets = DEFAULT_PARAMS.maxBullets;
  }
  maxBullets = Math.trunc(clampNumber(maxBullets, 1, 5));
  if (maxBullets !== params.maxBullets) warnings.push("每卡摘要數超出範圍（1–5），已自動修正。");

  return { params: { topicThreshold, maxTopics, maxBullets, debug: !!params.debug }, warnings };
}

const App = () => {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [deckLoading, setDeckLoading] = useState(true);
  const [deckLoadError, setDeckLoadError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  const [inputText, setInputText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  const [params, setParams] = useState<ProcessParams>(DEFAULT_PARAMS);
  const [paramWarnings, setParamWarnings] = useState<string[]>([]);

  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processSuccess, setProcessSuccess] = useState<string | null>(null);

  const [browseMode, setBrowseMode] = useState<BrowseMode>("sequence");
  const [currentTopicId, setCurrentTopicId] = useState<TopicFilter>("all");
  const [currentCardIndex, setCurrentCardIndex] = useState(0);

  const processAbortRef = useRef<AbortController | null>(null);

  const loadDeck = useCallback(async (): Promise<Deck> => {
    setDeckLoading(true);
    setDeckLoadError(null);
    try {
      const resp = await fetch(`/deck.json?ts=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) {
        throw new Error(`載入 deck.json 失敗（HTTP ${resp.status}）`);
      }
      const json: unknown = await resp.json();
      const validated = validateDeckSchema(json);
      if (!validated.ok) {
        throw new Error(`deck.json 格式不符合預期：${validated.error}`);
      }
      setDeck(validated.deck);
      setLastLoadedAt(new Date());
      return validated.deck;
    } catch (err) {
      const message = err instanceof Error ? err.message : "載入失敗：未知錯誤。";
      setDeckLoadError(message);
      setDeck(null);
      throw err;
    } finally {
      setDeckLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDeck().catch(() => undefined);
  }, [loadDeck]);

  const visibleCards = useMemo(() => {
    const cards = deck?.cards ?? [];
    if (currentTopicId === "all") {
      return cards;
    }
    return cards.filter((card: Card) => card.topicId === currentTopicId);
  }, [currentTopicId, deck]);

  const totalCards = visibleCards.length;
  const currentCard = visibleCards[currentCardIndex];

  useEffect(() => {
    if (currentCardIndex >= totalCards) {
      setCurrentCardIndex(Math.max(totalCards - 1, 0));
    }
  }, [currentCardIndex, totalCards]);

  const resolveTopicTitle = () => {
    const topics = deck?.topics ?? [];
    if (currentTopicId === "all" && !currentCard) {
      return "全部主題";
    }
    const topicId =
      currentTopicId === "all" ? currentCard?.topicId : currentTopicId;
    const topic = topics.find((item: Topic) => item.id === topicId);
    return topic?.title || "未命名主題";
  };

  const handleTopicChange = (topicId: TopicFilter) => {
    setCurrentTopicId(topicId);
    setCurrentCardIndex(0);
  };

  const handlePrev = useCallback(() => {
    setCurrentCardIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentCardIndex((prev) => Math.min(prev + 1, totalCards - 1));
  }, [totalCards]);

  const disablePrev = totalCards === 0 || currentCardIndex === 0;
  const disableNext = totalCards === 0 || currentCardIndex >= totalCards - 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "textarea" || tag === "input" || tag === "select" || target?.isContentEditable) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (!disablePrev) handlePrev();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (!disableNext) handleNext();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disableNext, disablePrev, handleNext, handlePrev]);

  const handleFileChange = async (file: File | null) => {
    setInputError(null);
    setProcessError(null);
    setProcessSuccess(null);
    if (!file) {
      setSelectedFileName(null);
      return;
    }
    const lower = file.name.toLowerCase();
    const ok = lower.endsWith(".txt") || lower.endsWith(".md");
    if (!ok) {
      setSelectedFileName(null);
      setInputError("檔案格式不支援：只接受 .txt 或 .md。");
      return;
    }
    setSelectedFileName(file.name);
    const reader = new FileReader();
    const text = await new Promise<string>((resolve, reject) => {
      reader.onerror = () => reject(new Error("讀取檔案失敗：請重試或改用貼上文字。"));
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.readAsText(file);
    });
    setInputText(text);
    if (!text.trim()) {
      setInputError("檔案內容是空的：請選擇包含文字的 .txt 或 .md 檔案。");
    }
  };

  const handleGenerate = async () => {
    setInputError(null);
    setProcessError(null);
    setProcessSuccess(null);
    setParamWarnings([]);

    const text = inputText.trim();
    if (!text) {
      setInputError("請先上傳 .txt/.md 檔案或在文字框貼上內容（不可為空）。");
      return;
    }

    const normalized = normalizeParams(params);
    if (normalized.warnings.length) setParamWarnings(normalized.warnings);

    setProcessing(true);
    const abort = new AbortController();
    processAbortRef.current?.abort();
    processAbortRef.current = abort;

    const timeoutId = window.setTimeout(() => abort.abort(), 120_000);
    try {
      const resp = await fetch("http://127.0.0.1:8000/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          topic_threshold: normalized.params.topicThreshold,
          max_topics: normalized.params.maxTopics,
          max_bullets: normalized.params.maxBullets,
          debug: normalized.params.debug,
        }),
        signal: abort.signal,
      });

      if (!resp.ok) {
        let detail = "";
        try {
          const data: unknown = await resp.json();
          if (isRecord(data) && typeof data.detail === "string") {
            detail = data.detail;
          } else {
            detail = JSON.stringify(data);
          }
        } catch {
          detail = await resp.text();
        }
        throw new Error(detail ? `Backend 回應錯誤（HTTP ${resp.status}）：${detail}` : `Backend 回應錯誤（HTTP ${resp.status}）。`);
      }

      const nextDeck = await loadDeck();
      const cardCount = nextDeck.stats?.cardCount ?? nextDeck.cards.length;
      setProcessSuccess(`已成功產生並載入卡片（目前共 ${cardCount} 張）。`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setProcessError("處理逾時（> 120 秒）：請稍後重試，或縮短輸入內容。");
      } else if (err instanceof TypeError) {
        setProcessError("無法連接到 Backend：請確認 Backend 服務已啟動（http://127.0.0.1:8000）。");
      } else {
        const message = err instanceof Error ? err.message : "處理失敗：未知錯誤。";
        setProcessError(message);
      }
    } finally {
      window.clearTimeout(timeoutId);
      setProcessing(false);
    }
  };

  const stats = deck?.stats ?? { paragraphCount: 0, topicCount: 0, cardCount: 0 };
  const topics = deck?.topics ?? [];

  const pageSize = 8;
  const currentPageIndex = Math.floor(currentCardIndex / pageSize);
  const totalPages = Math.max(1, Math.ceil(totalCards / pageSize));
  const pagedCards = useMemo(() => {
    if (browseMode !== "paged") return [];
    const start = currentPageIndex * pageSize;
    return visibleCards.slice(start, start + pageSize);
  }, [browseMode, currentPageIndex, visibleCards]);

  return (
    <div className="app">
      <div className="app-shell">
        <header className="app-header">
            <div className="app-title">文件歸納切卡機 · Demo UI Shell</div>
            <div className="app-subtitle">
              資料來源：public/deck.json
              {lastLoadedAt ? `（上次載入：${lastLoadedAt.toLocaleTimeString()}）` : ""}
            </div>
        </header>

        <div className="main-layout">
          <aside className="sidebar">
            <section className="panel panel-input">
              <div className="panel-title">輸入與生成</div>

              <div className="field">
                <div className="field-label">檔案上傳（僅 .txt / .md）</div>
                <input
                  className="file-input"
                  type="file"
                  accept=".txt,.md"
                  onChange={(e) => void handleFileChange(e.target.files?.[0] ?? null)}
                />
                {selectedFileName ? (
                  <div className="field-hint">已選擇：{selectedFileName}</div>
                ) : (
                  <div className="field-hint">或直接在下方貼上文字內容</div>
                )}
              </div>

              <div className="field">
                <div className="field-label">文字輸入</div>
                <textarea
                  className="text-area"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="貼上要處理的 Markdown / 純文字內容…"
                  rows={8}
                />
                <div className="field-hint">提示：左右方向鍵可翻卡（焦點不在輸入框時）。</div>
              </div>

              <div className="divider" />

              <div className="field">
                <div className="field-label">分群閾值（topic_threshold）</div>
                <div className="row">
                  <input
                    className="slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={params.topicThreshold}
                    onChange={(e) => setParams((p) => ({ ...p, topicThreshold: Number(e.target.value) }))}
                  />
                  <input
                    className="number-input"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={params.topicThreshold}
                    onChange={(e) => setParams((p) => ({ ...p, topicThreshold: Number(e.target.value) }))}
                  />
                </div>
                <div className="field-hint">相似度閾值，數值越高分群越細（0.0–1.0）。</div>
              </div>

              <div className="field">
                <div className="field-label">最大主題數（max_topics）</div>
                <div className="row">
                  <select
                    className="select"
                    value={params.maxTopics}
                    onChange={(e) => setParams((p) => ({ ...p, maxTopics: Number(e.target.value) }))}
                  >
                    {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-hint">最多產生幾個主題（1–10）。</div>
              </div>

              <div className="field">
                <div className="field-label">每卡摘要數（max_bullets）</div>
                <div className="row">
                  <select
                    className="select"
                    value={params.maxBullets}
                    onChange={(e) => setParams((p) => ({ ...p, maxBullets: Number(e.target.value) }))}
                  >
                    {Array.from({ length: 5 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-hint">每張卡片最多幾個要點（1–5）。</div>
              </div>

              <div className="field">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={params.debug}
                    onChange={(e) => setParams((p) => ({ ...p, debug: e.target.checked }))}
                  />
                  <span>除錯模式（debug）：顯示詳細的處理資訊</span>
                </label>
              </div>

              {paramWarnings.length ? (
                <div className="alert alert-warn">
                  {paramWarnings.map((w, idx) => (
                    <div key={idx}>{w}</div>
                  ))}
                </div>
              ) : null}

              {inputError ? <div className="alert alert-error">{inputError}</div> : null}
              {processError ? (
                <div className="alert alert-error">
                  <div>{processError}</div>
                  <div className="alert-actions">
                    <button className="link-button" onClick={() => void handleGenerate()} disabled={processing}>
                      重試生成
                    </button>
                  </div>
                </div>
              ) : null}
              {processSuccess ? <div className="alert alert-success">{processSuccess}</div> : null}

              <div className="actions">
                <button className="primary-button" onClick={() => void handleGenerate()} disabled={processing}>
                  {processing ? "生成中…" : "生成卡片"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => void loadDeck().catch(() => undefined)}
                  disabled={deckLoading || processing}
                >
                  {deckLoading ? "載入中…" : "重新載入"}
                </button>
              </div>

              <div className="field-hint">
                後端 API：<span className="mono">POST http://127.0.0.1:8000/api/process</span>
              </div>
            </section>

            <section className="panel panel-static">
              <div className="panel-title">統計資訊</div>
              <div className="stats-grid">
                <div className="stat-item">
                  <div className="stat-label">段落數</div>
                  <div className="stat-value">
                    {stats.paragraphCount}
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">主題數</div>
                  <div className="stat-value">{stats.topicCount}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">卡片數</div>
                  <div className="stat-value">{stats.cardCount}</div>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">主題列表</div>
              <div className="topics-list">
                <button
                  className={`topic-button ${
                    currentTopicId === "all" ? "active" : ""
                  }`}
                  onClick={() => handleTopicChange("all")}
                >
                  全部主題
                </button>
                {topics.map((topic: Topic) => (
                  <button
                    key={topic.id}
                    className={`topic-button ${
                      currentTopicId === topic.id ? "active" : ""
                    }`}
                    onClick={() => handleTopicChange(topic.id)}
                  >
                    {topic.title || "未命名主題"}
                  </button>
                ))}
              </div>
            </section>
          </aside>

          <main className="main-panel">
            {deckLoadError ? (
              <div className="empty-state">
                <div className="empty-title">載入失敗</div>
                <div className="empty-text">{deckLoadError}</div>
                <div className="empty-actions">
                  <button className="nav-button" onClick={() => void loadDeck().catch(() => undefined)} disabled={deckLoading}>
                    {deckLoading ? "載入中…" : "重試載入"}
                  </button>
                </div>
              </div>
            ) : deckLoading ? (
              <div className="empty-state">載入 deck.json 中…</div>
            ) : totalCards === 0 ? (
              <div className="empty-state">
                目前沒有卡片可顯示（可能是資料尚未產生）。
              </div>
            ) : (
              <div className="card-viewer">
              <div className="top-row">
                <div className="mode-toggle">
                  <button
                    className={`pill ${browseMode === "sequence" ? "active" : ""}`}
                    onClick={() => setBrowseMode("sequence")}
                  >
                    序列翻卡
                  </button>
                  <button
                    className={`pill ${browseMode === "paged" ? "active" : ""}`}
                    onClick={() => setBrowseMode("paged")}
                  >
                    分頁瀏覽
                  </button>
                </div>
                {browseMode === "paged" ? (
                  <div className="page-meta">
                    第 {currentPageIndex + 1} 頁 / 共 {totalPages} 頁
                  </div>
                ) : null}
              </div>

              <div className="card-meta">
                <div className="card-topic">
                  <span className="card-topic-text">{resolveTopicTitle()}</span>
                  <span className="card-counter">
                    第 {currentCardIndex + 1} 張 / 共 {totalCards} 張
                  </span>
                </div>
              </div>

                {browseMode === "paged" ? (
                  <div className="page-strip">
                    {pagedCards.map((card, idx) => {
                      const absoluteIndex = currentPageIndex * pageSize + idx;
                      const active = absoluteIndex === currentCardIndex;
                      return (
                        <button
                          key={card.id}
                          className={`mini-card ${active ? "active" : ""}`}
                          onClick={() => setCurrentCardIndex(absoluteIndex)}
                          title={card.title}
                        >
                          {card.title || "未命名卡片"}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className="card">
                  <h2 className="card-title">
                    {currentCard?.title || "未命名卡片"}
                  </h2>
                  {currentCard?.bullets?.length ? (
                    <ul className="card-bullets">
                      {currentCard.bullets.map((bullet: string, idx: number) => (
                        <li key={idx}>{bullet}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="card-empty">（此卡片目前沒有內容）</p>
                  )}
                </div>

                <div className="controls">
                  <button
                    className="nav-button"
                    onClick={handlePrev}
                    disabled={disablePrev}
                  >
                    ← 上一張
                  </button>
                  <button
                    className="nav-button"
                    onClick={handleNext}
                    disabled={disableNext}
                  >
                    下一張 →
                  </button>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};

export default App;


