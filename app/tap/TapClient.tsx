"use client";

import { useEffect, useRef, useState } from "react";
import { COMMON_ITEMS, TAP_STATUSES, type Location, type TapStatus } from "@/lib/constants";

type Phase = "pick-item" | "pick-status" | "submitting" | "done" | "error";

// Minimal Web Speech API surface — not in TS's DOM lib.
interface MinimalSpeechRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  onresult: ((event: { results: { 0: { transcript: string } }[] }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => MinimalSpeechRecognition;

export default function TapClient({ location }: { location?: Location }) {
  const [phase, setPhase] = useState<Phase>("pick-item");
  const [query, setQuery] = useState("");
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [loggedStatus, setLoggedStatus] = useState<TapStatus | null>(null);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const supportsVoice =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function chooseItem(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSelectedItem(trimmed);
    setPhase("pick-status");
  }

  async function chooseStatus(status: TapStatus) {
    if (!selectedItem) return;
    setPhase("submitting");
    try {
      const res = await fetch("/api/tap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemName: selectedItem, status, location }),
      });
      if (!res.ok) throw new Error("tap failed");
      setLoggedStatus(status);
      setPhase("done");
      setTimeout(() => {
        setPhase("pick-item");
        setSelectedItem(null);
        setQuery("");
        setLoggedStatus(null);
        inputRef.current?.focus();
      }, 1400);
    } catch {
      setPhase("error");
    }
  }

  function startVoice() {
    const win = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "en-GB";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    setListening(true);
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setQuery(transcript);
      setListening(false);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognition.start();
  }

  if (phase === "done") {
    return (
      <Centered>
        <div className="text-status-ok text-2xl font-bold">✓ Logged</div>
        <div className="mt-2 text-lg text-white/80">
          {selectedItem} — {TAP_STATUSES.find((s) => s.value === loggedStatus)?.label}
        </div>
      </Centered>
    );
  }

  if (phase === "error") {
    return (
      <Centered>
        <div className="text-status-out text-2xl font-bold">Couldn&apos;t save</div>
        <div className="mt-2 text-white/60">Check your connection and try again.</div>
        <button
          className="mt-6 rounded-xl bg-white/10 px-6 py-3 text-lg font-semibold"
          onClick={() => setPhase(selectedItem ? "pick-status" : "pick-item")}
        >
          Try again
        </button>
      </Centered>
    );
  }

  if (phase === "pick-status" || phase === "submitting") {
    return (
      <div className="flex flex-1 flex-col px-5 py-8">
        <button
          className="mb-6 self-start text-white/50 text-base"
          onClick={() => {
            setPhase("pick-item");
            setSelectedItem(null);
          }}
          disabled={phase === "submitting"}
        >
          ← back
        </button>
        <div className="mb-8 text-3xl font-bold">{selectedItem}</div>
        <div className="flex flex-col gap-4">
          {TAP_STATUSES.map((s) => (
            <button
              key={s.value}
              disabled={phase === "submitting"}
              onClick={() => chooseStatus(s.value)}
              className={statusButtonClass(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col px-5 py-8">
      {location && (
        <div className="mb-2 text-sm font-medium uppercase tracking-wide text-white/40">
          {location}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          chooseItem(query);
        }}
        className="flex items-center gap-2"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What's running low or out?"
          autoFocus
          autoComplete="off"
          className="flex-1 rounded-xl bg-white/10 px-4 py-4 text-xl placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-status-ok"
        />
        {supportsVoice && (
          <button
            type="button"
            onClick={startVoice}
            aria-label="Voice input"
            className={`rounded-xl px-4 py-4 text-xl ${listening ? "bg-status-ok/30" : "bg-white/10"}`}
          >
            🎙
          </button>
        )}
      </form>

      <div className="mt-8 grid grid-cols-2 gap-3">
        {COMMON_ITEMS.map((item) => (
          <button
            key={item}
            onClick={() => chooseItem(item)}
            className="rounded-xl bg-white/5 px-4 py-5 text-left text-lg font-semibold active:bg-white/15"
          >
            {item}
          </button>
        ))}
      </div>

      {query.trim() && (
        <button
          onClick={() => chooseItem(query)}
          className="mt-6 rounded-xl bg-status-ok px-4 py-4 text-lg font-bold text-black"
        >
          Use &ldquo;{query.trim()}&rdquo;
        </button>
      )}
    </div>
  );
}

function statusButtonClass(status: TapStatus) {
  const base = "rounded-xl px-6 py-6 text-2xl font-bold text-black active:opacity-80";
  if (status === "low") return `${base} bg-status-low`;
  if (status === "out") return `${base} bg-status-out`;
  return `${base} bg-status-ok`;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
      {children}
    </div>
  );
}
