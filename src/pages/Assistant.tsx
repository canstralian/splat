import { useCallback, useEffect, useRef, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  AgentApiError,
  fetchAgentSession,
  isAgentConfigured,
  resetAgentSession,
  sendAgentMessage,
} from "@/integrations/agent/client";
import type { AgentToolCall } from "@/integrations/agent/types";
import { Loader2, RotateCcw, Send, Sparkles, Wrench } from "lucide-react";

interface LocalMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: AgentToolCall[];
}

const SESSION_STORAGE_KEY = "splat-assistant-session";

function getSessionId(): string {
  const existing = localStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(SESSION_STORAGE_KEY, id);
  return id;
}

function ToolCallChips({ toolCalls }: { toolCalls: AgentToolCall[] }) {
  if (toolCalls.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {toolCalls.map((call, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
            call.status === "ok"
              ? "border-border text-muted-foreground"
              : "border-destructive/40 text-destructive"
          }`}
          title={call.errorMessage ?? undefined}
        >
          <Wrench className="h-2.5 w-2.5" />
          {call.name}
          {call.status === "error" && " ✕"}
        </span>
      ))}
    </div>
  );
}

export default function Assistant() {
  const { toast } = useToast();
  const [sessionId] = useState(getSessionId);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const configured = isAgentConfigured();

  useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchAgentSession(sessionId)
      .then((state) => {
        if (cancelled) return;
        setMessages(state.messages.map((m) => ({ role: m.role, content: m.content })));
      })
      .catch((error) => {
        console.error("Failed to load assistant session", error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configured, sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    try {
      const response = await sendAgentMessage(sessionId, message, allowWrites);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: response.reply, toolCalls: response.toolCalls },
      ]);
    } catch (error) {
      console.error("Assistant request failed", error);
      // Failed turns are not persisted server-side; mirror that locally so a
      // retry starts from a clean conversation.
      setMessages((prev) => prev.slice(0, -1));
      setInput(message);
      toast({
        title: "Assistant unavailable",
        description:
          error instanceof AgentApiError ? error.message : "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  }, [allowWrites, input, sending, sessionId, toast]);

  const startNewConversation = useCallback(async () => {
    try {
      await resetAgentSession(sessionId);
      setMessages([]);
    } catch (error) {
      console.error("Failed to reset assistant session", error);
      toast({
        title: "Could not clear conversation",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    }
  }, [sessionId, toast]);

  if (!configured) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
          <Sparkles className="h-6 w-6 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground max-w-md">
            The assistant is not configured. Set <code className="font-mono">VITE_AGENT_URL</code> to the deployed
            Splat agent worker URL to enable it.
          </p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-2.75rem)] md:h-screen">
        {/* Header bar */}
        <div className="flex items-center gap-2 px-4 md:px-6 h-11 border-b border-border shrink-0">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <span className="text-[13px] font-medium text-foreground">Assistant</span>
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer">
              <Switch checked={allowWrites} onCheckedChange={setAllowWrites} aria-label="Allow changes" />
              Allow changes
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[12px]"
              onClick={startNewConversation}
              disabled={sending || messages.length === 0}
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Clear
            </Button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
              <p className="text-[13px] text-muted-foreground">
                Ask about your bugs — try “show me all blocker bugs” or “what is SPL-00001 about?”
              </p>
              <p className="text-[11px] text-muted-foreground/70">
                Enable “Allow changes” to let the assistant file bugs, comment, or update statuses.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-w-2xl mx-auto">
              {messages.map((message, i) => (
                <div key={i} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed max-w-[85%] whitespace-pre-wrap ${
                      message.role === "user"
                        ? "bg-primary/10 border border-primary/20 text-foreground"
                        : "bg-muted border border-border text-foreground"
                    }`}
                  >
                    {message.content}
                    {message.toolCalls && <ToolCallChips toolCalls={message.toolCalls} />}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="rounded-lg px-3 py-2 bg-muted border border-border">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border px-4 md:px-6 py-3 shrink-0">
          <div className="flex gap-2 max-w-2xl mx-auto">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask the assistant…"
              rows={1}
              className="min-h-[44px] max-h-32 resize-none text-[13px]"
              disabled={sending}
            />
            <Button
              onClick={() => void send()}
              disabled={sending || input.trim().length === 0}
              size="icon"
              className="h-11 w-11 shrink-0"
              aria-label="Send message"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
