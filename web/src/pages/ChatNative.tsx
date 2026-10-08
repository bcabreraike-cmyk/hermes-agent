import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { ChatSessionList } from "@/components/ChatSessionList";
import { Markdown } from "@/components/Markdown";
import { ModelPickerDialog } from "@/components/ModelPickerDialog";
import { useProfileScope } from "@/contexts/useProfileScope";
import { api, type SessionMessage, type SessionSearchResult } from "@/lib/api";
import { GatewayClient } from "@/lib/gatewayClient";
import { cn } from "@/lib/utils";
import { ChatBar } from "@/chat/composer/ChatBar";

interface NativeMessage {
  id: string;
  role: SessionMessage["role"];
  text: string;
  pending?: boolean;
  error?: string;
  rowId?: number;
}

function toNativeMessages(messages: SessionMessage[]): NativeMessage[] {
  return messages.map((m, i) => ({
    id: `hist-${i}-${m.timestamp ?? i}`,
    role: m.role,
    text: m.content ?? "",
  }));
}

function transcriptMarkdown(messages: NativeMessage[]): string {
  return messages
    .map((m) => {
      const head = m.role === "user" ? "## You" : `## ${m.role}`;
      return `${head}\n\n${m.text}`;
    })
    .join("\n\n---\n\n");
}

function rowIdOf(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const id = (row as { row_id?: unknown }).row_id;
  return typeof id === "number" ? id : null;
}

function deltaText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export default function ChatNative() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeSessionId = searchParams.get("resume");
  const { profile } = useProfileScope();
  const gw = useMemo(() => new GatewayClient(), []);
  const [messages, setMessages] = useState<NativeMessage[]>([]);
  const [gwSessionId, setGwSessionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scopeRef = useRef<string | null>(null);
  const [lastUserText, setLastUserText] = useState<string | null>(null);
  const gwSessionIdRef = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const refreshFromServer = useCallback(
    async (sessionId: string) => {
      const res = await api.getSessionMessages(sessionId);
      let rowIds: (number | undefined)[] = [];
      try {
        const hist = (await gw.request("session.history", {
          session_id: sessionId,
        })) as { rows?: unknown[]; messages?: unknown[] };
        const rows = hist.rows ?? hist.messages ?? [];
        if (rows.length === res.messages.length) {
          rowIds = rows.map((r) => rowIdOf(r) ?? undefined);
        }
      } catch {
        rowIds = [];
      }
      setMessages(
        toNativeMessages(res.messages).map((m, i) => ({
          ...m,
          rowId: rowIds[i],
        })),
      );
    },
    [gw],
  );

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .searchSessions(q, profile || undefined)
        .then((res) => {
          setResults(res.results);
        })
        .catch(() => {
          setResults([]);
        })
        .finally(() => {
          setSearching(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, profile]);

  const pickSearchResult = useCallback(
    (id: string) => {
      setQuery("");
      setResults(null);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("resume", id);
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    const key = `${profile ?? ""}\0${activeSessionId}`;
    scopeRef.current = key;
    setError(null);
    api
      .getSessionMessages(activeSessionId)
      .then((res) => {
        if (scopeRef.current !== key) return;
        setMessages(toNativeMessages(res.messages));
      })
      .catch((e: Error) => {
        if (scopeRef.current !== key) return;
        setError(e.message || "failed to load messages");
      });
  }, [activeSessionId, profile]);

  useEffect(() => {
    let cancelled = false;
    const offDelta = gw.on("message.delta", (ev) => {
      const text = deltaText(ev.payload);
      if (!text) return;
      setMessages((prev) => {
        const last = prev.at(-1);
        if (!last || last.role !== "assistant" || !last.pending) return prev;
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      });
    });
    const offComplete = gw.on("message.complete", () => {
      setSending(false);
      setMessages((prev) => {
        const last = prev.at(-1);
        if (!last || last.role !== "assistant") return prev;
        return [...prev.slice(0, -1), { ...last, pending: false }];
      });
      const sid = gwSessionIdRef.current;
      if (sid) {
        refreshFromServer(sid).catch((e: Error) => {
          setError(e.message || "failed to refresh messages");
        });
      }
    });
    gw.connect()
      .then(async () => {
        if (cancelled) return;
        if (activeSessionId) {
          try {
            await gw.request("session.resume", { session_id: activeSessionId });
            if (cancelled) return;
            setGwSessionId(activeSessionId);
            gwSessionIdRef.current = activeSessionId;
            refreshFromServer(activeSessionId).catch(() => {});
            return;
          } catch {
            /* fall through to create */
          }
        }
        const res = await gw.request<{ session_id: string }>("session.create", {
          source: "web",
          ...(profile ? { profile } : {}),
        });
        if (cancelled) return;
        setGwSessionId(res.session_id);
        gwSessionIdRef.current = res.session_id;
        // Pin the fresh session in the URL so a reload resumes it.
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("resume", res.session_id);
            return next;
          },
          { replace: true },
        );
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || "gateway connect failed");
      });
    return () => {
      cancelled = true;
      offDelta();
      offComplete();
    };
  }, [gw, activeSessionId, profile, setSearchParams, refreshFromServer]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const newChat = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("resume");
        return next;
      },
      { replace: false },
    );
    setMessages([]);
    setGwSessionId(null);
    gwSessionIdRef.current = null;
    setEditingIndex(null);
    setError(null);
  }, [setSearchParams]);

  const send = useCallback(
    (text: string, attachments: string[]) => {
      if (!gwSessionId || sending) return;
      if (!text && attachments.length === 0) return;
      setLastUserText(text);
      const now = Date.now();
      const user: NativeMessage = {
        id: `user-${now}`,
        role: "user",
        text,
      };
      const pending: NativeMessage = {
        id: `assistant-${now}`,
        role: "assistant",
        text: "",
        pending: true,
      };
      setMessages((prev) => [...prev, user, pending]);
      setSending(true);
      setError(null);
      (async () => {
        for (const path of attachments) {
          await gw.request("image.attach", {
            session_id: gwSessionId,
            path,
          });
        }
        await gw.request("prompt.submit", { session_id: gwSessionId, text });
      })().catch((e: Error) => {
          setSending(false);
          setError(e.message || "send failed");
          setMessages((prev) => {
            const last = prev.at(-1);
            if (!last || last.role !== "assistant") return prev;
            return [
              ...prev.slice(0, -1),
              { ...last, pending: false, error: e.message },
            ];
          });
        },
      );
    },
    [gw, gwSessionId, sending],
  );

  const retry = useCallback(() => {
    const text = lastUserText;
    if (!gwSessionId || sending || !text) return;
    const pending: NativeMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      text: "",
      pending: true,
    };
    setMessages((prev) => {
      const last = prev.at(-1);
      const base =
        last && last.role === "assistant" ? prev.slice(0, -1) : prev;
      return [...base, pending];
    });
    setSending(true);
    setError(null);
    gw.request("prompt.submit", { session_id: gwSessionId, text }).catch(
      (e: Error) => {
        setSending(false);
        setError(e.message || "send failed");
        setMessages((prev) => {
          const last = prev.at(-1);
          if (!last || last.role !== "assistant") return prev;
          return [
            ...prev.slice(0, -1),
            { ...last, pending: false, error: e.message },
          ];
        });
      },
    );
  }, [gw, gwSessionId, sending, lastUserText]);

  const saveEdit = useCallback(() => {
    if (editingIndex === null || sending) return;
    const target = messages[editingIndex];
    const rowId = target?.rowId;
    const value = editDraft.trim();
    if (!target || target.role !== "user" || rowId === undefined || !value) return;
    const sid = gwSessionIdRef.current;
    if (!sid) return;
    setLastUserText(value);
    const now = Date.now();
    const user: NativeMessage = {
      id: `user-${now}`,
      role: "user",
      text: value,
    };
    const pending: NativeMessage = {
      id: `assistant-${now}`,
      role: "assistant",
      text: "",
      pending: true,
    };
    setMessages([...messages.slice(0, editingIndex), user, pending]);
    setEditingIndex(null);
    setSending(true);
    setError(null);
    gw.request("prompt.submit", {
      session_id: sid,
      text: value,
      confirm_truncate: true,
      truncate_before_row_id: rowId,
    }).catch((e: Error) => {
      setSending(false);
      setError(e.message || "edit failed");
      refreshFromServer(sid).catch(() => {});
    });
  }, [editingIndex, editDraft, messages, sending, gw]);

  const exportChat = useCallback(() => {
    if (messages.length === 0) return;
    const blob = new Blob([transcriptMarkdown(messages)], {
      type: "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${activeSessionId ?? "new"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages, activeSessionId]);

  const lastMessage = messages.at(-1);
  const canRetry =
    !sending &&
    !!gwSessionId &&
    !!lastUserText &&
    !!lastMessage &&
    lastMessage.role === "assistant" &&
    !lastMessage.pending;

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="hidden w-64 shrink-0 overflow-hidden border-r border-current/10 pr-2 lg:block">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats…"
          aria-label="Search chats"
          className="mb-2 w-full rounded border border-current/20 bg-background-base px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground"
        />
        {query.trim() ? (
          <div className="min-h-0 overflow-y-auto">
            {searching && (
              <div className="px-2 py-2 text-xs text-text-secondary">Searching…</div>
            )}
            {!searching && results?.length === 0 && (
              <div className="px-2 py-2 text-xs text-text-secondary">No matches.</div>
            )}
            {(results ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => pickSearchResult(s.id)}
                className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-text-secondary hover:bg-midground/5 hover:text-midground"
              >
                {s.title?.trim() || s.preview?.trim() || "Untitled"}
              </button>
            ))}
          </div>
        ) : (
          <ChatSessionList
            activeSessionId={activeSessionId}
            profile={profile}
            onNewChat={newChat}
          />
        )}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-end gap-2">
          {modelNotice && (
            <span className="truncate text-xs text-text-secondary">{modelNotice}</span>
          )}
          <button
            type="button"
            onClick={() => setModelOpen(true)}
            className="rounded border border-current/20 px-2 py-1 text-xs text-text-secondary hover:text-midground"
          >
            Model
          </button>
          <button
            type="button"
            onClick={exportChat}
            disabled={messages.length === 0}
            className="rounded border border-current/20 px-2 py-1 text-xs text-text-secondary hover:text-midground disabled:opacity-50"
          >
            Export .md
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && (
            <div className="px-2 py-2 text-xs text-destructive">{error}</div>
          )}
          {messages.length === 0 && !error && (
            <div className="px-2 py-8 text-center text-sm text-text-secondary">
              New conversation — type below to start.
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={m.id}
              className={cn(
                "mx-1 my-2 max-w-[min(90%,44rem)] rounded-lg px-3 py-2 text-sm leading-6 wrap-anywhere",
                m.role === "user"
                  ? "ml-auto bg-primary/10 text-foreground"
                  : "bg-midground/5 text-foreground",
              )}
              data-role={m.role}
            >
              {m.role === "user" ? (
                editingIndex === i ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      aria-label="Edit message"
                      className="w-full resize-y rounded border border-current/20 bg-background-base px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={saveEdit}
                        disabled={!editDraft.trim() || sending}
                        className="rounded border border-current/20 px-2 py-0.5 text-xs text-text-secondary hover:text-midground disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingIndex(null)}
                        className="rounded border border-current/20 px-2 py-0.5 text-xs text-text-secondary hover:text-midground"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {m.text}
                    {m.rowId !== undefined && !sending && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingIndex(i);
                          setEditDraft(m.text);
                        }}
                        aria-label="Edit message"
                        className="ml-2 text-xs text-text-secondary hover:text-midground"
                      >
                        Edit
                      </button>
                    )}
                  </>
                )
              ) : m.text ? (
                <Markdown content={m.text} streaming={!!m.pending} />
              ) : (
                m.pending && "…"
              )}
            </div>
          ))}
          {canRetry && (
            <div className="mx-1 my-1">
              <button
                type="button"
                onClick={retry}
                className="rounded border border-current/20 px-2 py-1 text-xs text-text-secondary hover:text-midground"
              >
                Retry
              </button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <ChatBar
          key={modelRefreshKey}
          onSend={send}
          disabled={!gwSessionId || sending}
          profile={profile}
        />
        {modelOpen && (
          <ModelPickerDialog
            loader={() => api.getModelOptions(profile)}
            alwaysGlobal
            onApply={async ({ provider, model, confirmExpensiveModel }) => {
              setModelNotice(null);
              const result = await api.setModelAssignment(
                {
                  confirm_expensive_model: confirmExpensiveModel,
                  scope: "main",
                  provider,
                  model,
                },
                profile,
              );
              if (!result.confirm_required) {
                setModelOpen(false);
                setModelRefreshKey((k) => k + 1);
                setModelNotice(
                  `Model set to ${model.split("/").slice(-1)[0]}. New chats use it.`,
                );
              }
              return result;
            }}
            onClose={() => {
              setModelOpen(false);
              setModelRefreshKey((k) => k + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}
