"use client";

import { useState } from "react";
import Link from "next/link";

type Phase = "paste" | "parsing" | "review" | "saving" | "done" | "error";

interface ParsedItem {
  name: string;
  quantity: number;
  unit: string;
  location: string;
}

const LOCATION_LABELS: Record<string, string> = {
  fridge: "Fridge", freezer: "Freezer", cupboard: "Cupboard",
};

export default function ReceiptClient() {
  const [phase, setPhase] = useState<Phase>("paste");
  const [text, setText] = useState("");
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [errorMsg, setErrorMsg] = useState("");

  async function parseReceipt() {
    if (!text.trim()) return;
    setPhase("parsing");
    try {
      const res = await fetch("/api/receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Parse failed");
      const { items: found } = await res.json() as { items: ParsedItem[] };
      setItems(found);
      setPhase("review");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setPhase("error");
    }
  }

  async function confirmItems() {
    setPhase("saving");
    try {
      const res = await fetch("/api/scan/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error("Save failed");
      setPhase("done");
    } catch {
      setPhase("error");
      setErrorMsg("Couldn't save items.");
    }
  }

  function removeItem(i: number) {
    setItems(prev => prev.filter((_, idx) => idx !== i));
  }

  function updateItem(i: number, field: keyof ParsedItem, value: string | number) {
    setItems(prev => prev.map((item, idx) => idx === i ? { ...item, [field]: value } : item));
  }

  if (phase === "done") {
    return (
      <Fullscreen>
        <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-status-ok/15 text-5xl mb-4">✓</div>
        <div className="text-2xl font-bold text-status-ok mb-1">Stock updated</div>
        <div className="text-white/50 mb-8">{items.length} item{items.length !== 1 ? "s" : ""} added</div>
        <div className="flex gap-3">
          <Link href="/receipt" className="rounded-2xl bg-white/10 px-6 py-3 font-semibold"
            onClick={() => { setPhase("paste"); setText(""); setItems([]); }}>
            Add another
          </Link>
          <Link href="/dashboard" className="rounded-2xl bg-status-ok px-6 py-3 font-bold text-black">
            View stock
          </Link>
        </div>
      </Fullscreen>
    );
  }

  if (phase === "error") {
    return (
      <Fullscreen>
        <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-status-out/15 text-5xl mb-4">✕</div>
        <div className="text-xl font-bold text-status-out mb-2">Something went wrong</div>
        <div className="text-white/50 text-sm mb-8">{errorMsg}</div>
        <button className="rounded-2xl bg-white/10 px-8 py-4 font-semibold"
          onClick={() => { setPhase("paste"); setErrorMsg(""); }}>
          Try again
        </button>
      </Fullscreen>
    );
  }

  if (phase === "parsing") {
    return (
      <Fullscreen>
        <div className="text-5xl mb-5">🧾</div>
        <div className="text-xl font-semibold mb-2">Reading receipt…</div>
        <div className="text-white/40 text-sm">Claude is extracting your items</div>
      </Fullscreen>
    );
  }

  if (phase === "review") {
    return (
      <div className="flex min-h-screen flex-col pb-28">
        <header className="sticky top-0 z-10 border-b border-white/8 bg-background/90 backdrop-blur-md px-5 py-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-white/40">Found {items.length} item{items.length !== 1 ? "s" : ""}</div>
            <div className="text-lg font-bold">Confirm stock</div>
          </div>
          <button className="text-sm text-white/40 hover:text-white/70 transition-colors"
            onClick={() => { setPhase("paste"); setItems([]); }}>
            ← Back
          </button>
        </header>

        <div className="flex-1 px-4 py-4 space-y-2">
          {items.length === 0 && (
            <div className="py-12 text-center text-white/30 text-sm">
              No grocery items found — paste more of the receipt text.
            </div>
          )}
          {items.map((item, i) => (
            <div key={i} className="rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <input
                  value={item.name}
                  onChange={e => updateItem(i, "name", e.target.value)}
                  className="flex-1 bg-transparent text-base font-semibold focus:outline-none border-b border-white/10 pb-1"
                />
                <button onClick={() => removeItem(i)}
                  className="text-white/30 hover:text-status-out transition-colors text-lg leading-none shrink-0 mt-0.5">
                  ×
                </button>
              </div>
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <div className="flex items-center gap-1.5">
                  <label className="text-white/40">Qty</label>
                  <input type="number" min={0} value={item.quantity}
                    onChange={e => updateItem(i, "quantity", Number(e.target.value))}
                    className="w-12 bg-white/8 rounded-lg px-2 py-1 text-center focus:outline-none" />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-white/40">Unit</label>
                  <input value={item.unit}
                    onChange={e => updateItem(i, "unit", e.target.value)}
                    className="w-20 bg-white/8 rounded-lg px-2 py-1 focus:outline-none" />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-white/40">Location</label>
                  <select value={item.location} onChange={e => updateItem(i, "location", e.target.value)}
                    className="bg-white/8 rounded-lg px-2 py-1 focus:outline-none">
                    {["fridge", "freezer", "cupboard"].map(l => (
                      <option key={l} value={l}>{LOCATION_LABELS[l]}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="fixed bottom-0 left-0 right-0 border-t border-white/8 bg-background px-5 py-4">
          <button disabled={items.length === 0} onClick={confirmItems}
            className="w-full rounded-2xl bg-status-ok py-4 text-base font-bold text-black disabled:opacity-40 transition-opacity">
            Save {items.length} item{items.length !== 1 ? "s" : ""} to stock
          </button>
        </div>
      </div>
    );
  }

  // Paste phase
  return (
    <div className="flex min-h-screen flex-col px-5 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="text-2xl font-bold">Paste receipt</div>
          <div className="text-sm text-white/40 mt-0.5">Copy text from your email and paste below</div>
        </div>
        <Link href="/dashboard" className="text-sm text-white/40 hover:text-white/70 transition-colors">
          Cancel
        </Link>
      </div>

      <div className="mb-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm text-white/40 leading-relaxed">
        <span className="font-semibold text-white/60">How to paste:</span> Open the receipt email → select all text → copy → paste here.
        Works with Tesco, M&S, Waitrose, Sainsbury&apos;s, ASDA, Ocado.
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste your receipt text here…"
        rows={12}
        className="flex-1 w-full rounded-2xl bg-white/[0.05] border border-white/8 px-4 py-4 text-base text-white placeholder:text-white/25 focus:outline-none focus:ring-2 focus:ring-status-ok/40 resize-none font-mono text-sm leading-relaxed"
      />

      <button
        disabled={!text.trim()}
        onClick={parseReceipt}
        className="mt-4 w-full rounded-2xl bg-status-ok py-4 text-base font-bold text-black disabled:opacity-30 transition-opacity"
      >
        Extract items
      </button>
    </div>
  );
}

function Fullscreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      {children}
    </div>
  );
}
