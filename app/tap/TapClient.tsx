"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { COMMON_ITEMS, TAP_STATUSES, type Location, type TapStatus } from "@/lib/constants";

type Phase = "pick-item" | "pick-status" | "submitting" | "done" | "error";

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

const ITEM_EMOJI: Record<string, string> = {
  Milk: "🥛", Eggs: "🥚", Bread: "🍞", Butter: "🧈",
  Cheese: "🧀", Chicken: "🍗", Rice: "🍚", "Toilet roll": "🧻",
};

const LOCATION_LABELS: Record<string, string> = {
  fridge: "Fridge", freezer: "Freezer", cupboard: "Cupboard",
};

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
      }, 1600);
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
      setQuery(event.results[0][0].transcript);
      setListening(false);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognition.start();
  }

  if (phase === "done") {
    const statusInfo = TAP_STATUSES.find((s) => s.value === loggedStatus);
    return (
      <Fullscreen>
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-status-ok/15">
            <span className="text-4xl">✓</span>
          </div>
          <div className="text-2xl font-bold text-status-ok">Logged</div>
          <div className="text-white/60 text-lg">
            {selectedItem} — {statusInfo?.label}
          </div>
        </div>
      </Fullscreen>
    );
  }

  if (phase === "error") {
    return (
      <Fullscreen>
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-status-out/15 text-4xl">
            ✕
          </div>
          <div className="text-xl font-bold text-status-out">Couldn&apos;t save</div>
          <div className="text-white/50 text-sm">Check your connection and try again.</div>
          <button
            className="mt-2 rounded-2xl bg-white/10 px-8 py-4 text-base font-semibold"
            onClick={() => setPhase(selectedItem ? "pick-status" : "pick-item")}
          >
            Try again
          </button>
        </div>
      </Fullscreen>
    );
  }

  if (phase === "pick-status" || phase === "submitting") {
    return (
      <div className="flex min-h-screen flex-col px-5 py-8">
        <button
          className="mb-6 self-start text-sm text-white/40 hover:text-white/70 transition-colors"
          onClick={() => {
            setPhase("pick-item");
            setSelectedItem(null);
          }}
          disabled={phase === "submitting"}
        >
          ← back
        </button>

        <div className="mb-1 text-sm font-medium text-white/40 uppercase tracking-widest">
          {location ? LOCATION_LABELS[location] : "Item"}
        </div>
        <div className="mb-10 text-4xl font-bold">{selectedItem}</div>

        <div className="flex flex-col gap-3">
          {TAP_STATUSES.map((s) => (
            <button
              key={s.value}
              disabled={phase === "submitting"}
              onClick={() => chooseStatus(s.value)}
              className={statusButtonClass(s.value, phase === "submitting")}
            >
              <span className="text-2xl">{STATUS_ICONS[s.value]}</span>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const filtered = COMMON_ITEMS.filter(item =>
    query.trim() === "" || item.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="flex min-h-screen flex-col px-5 py-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          {location && (
            <div className="text-xs font-bold uppercase tracking-widest text-white/35">
              {LOCATION_LABELS[location] ?? location}
            </div>
          )}
          <div className="text-2xl font-bold">What&apos;s running out?</div>
        </div>
        <Link
          href="/dashboard"
          className="rounded-xl bg-white/8 px-3 py-2 text-xs font-semibold text-white/50 hover:text-white/80 transition-colors"
        >
          Stock
        </Link>
      </div>

      {/* Search input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          chooseItem(query);
        }}
        className="flex items-center gap-2 mb-6"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type an item..."
          autoComplete="off"
          className="flex-1 rounded-2xl bg-white/8 px-4 py-4 text-lg placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-status-ok/50 transition-shadow"
        />
        {supportsVoice && (
          <button
            type="button"
            onClick={startVoice}
            aria-label="Voice input"
            className={`flex h-[56px] w-[56px] items-center justify-center rounded-2xl text-xl transition-colors ${
              listening ? "bg-status-ok/25 text-status-ok" : "bg-white/8 text-white/60"
            }`}
          >
            🎙
          </button>
        )}
      </form>

      {/* Common items grid */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {filtered.map((item) => (
          <button
            key={item}
            onClick={() => chooseItem(item)}
            className="flex items-center gap-3 rounded-2xl bg-white/[0.05] px-4 py-4 text-left text-base font-semibold hover:bg-white/10 active:bg-white/15 transition-colors"
          >
            <span className="text-2xl leading-none">{ITEM_EMOJI[item] ?? "📦"}</span>
            <span>{item}</span>
          </button>
        ))}
      </div>

      {/* Custom item confirm */}
      {query.trim() && !COMMON_ITEMS.includes(query.trim() as (typeof COMMON_ITEMS)[number]) && (
        <button
          onClick={() => chooseItem(query)}
          className="mt-2 w-full rounded-2xl bg-status-ok px-4 py-4 text-base font-bold text-black"
        >
          Use &ldquo;{query.trim()}&rdquo;
        </button>
      )}
    </div>
  );
}

const STATUS_ICONS: Record<string, string> = {
  low: "⚠",
  out: "✕",
  used_some: "✓",
};

function statusButtonClass(status: TapStatus, disabled: boolean) {
  const base = `flex items-center gap-4 rounded-2xl px-6 py-5 text-xl font-bold transition-opacity ${disabled ? "opacity-50" : "active:opacity-80"}`;
  if (status === "low") return `${base} bg-status-low text-black`;
  if (status === "out") return `${base} bg-status-out text-black`;
  return `${base} bg-status-ok text-black`;
}

function Fullscreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      {children}
    </div>
  );
}
