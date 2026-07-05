"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { Location } from "@/lib/constants";

type Phase = "capture" | "scanning" | "review" | "saving" | "done" | "error";

interface ScannedItem {
  name: string;
  quantity: number;
  unit: string;
  location: Location;
  status: "ok" | "low";
  confidence: "high" | "medium" | "low";
}

const LOCATION_LABELS: Record<string, string> = {
  fridge: "Fridge", freezer: "Freezer", cupboard: "Cupboard",
};

export default function ScanClient() {
  const [phase, setPhase] = useState<Phase>("capture");
  const [preview, setPreview] = useState<string | null>(null);
  const [items, setItems] = useState<ScannedItem[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      setPreview(dataUrl);
      await runScan(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  async function runScan(dataUrl: string) {
    setPhase("scanning");
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Scan failed");
      }
      const { items: found } = await res.json() as { items: ScannedItem[] };
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
      setErrorMsg("Couldn't save items. Try again.");
    }
  }

  function removeItem(index: number) {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  function updateItem(index: number, field: keyof ScannedItem, value: string | number) {
    setItems(prev => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
  }

  // ── Done ─────────────────────────────────────────────────────────────────────

  if (phase === "done") {
    return (
      <Fullscreen>
        <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-status-ok/15 text-5xl mb-4">✓</div>
        <div className="text-2xl font-bold text-status-ok mb-1">Saved</div>
        <div className="text-white/50 mb-8">{items.length} item{items.length !== 1 ? "s" : ""} added to stock</div>
        <Link href="/dashboard" className="rounded-2xl bg-white/10 px-8 py-4 font-semibold">
          View stock
        </Link>
      </Fullscreen>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────

  if (phase === "error") {
    return (
      <Fullscreen>
        <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-status-out/15 text-5xl mb-4">✕</div>
        <div className="text-xl font-bold text-status-out mb-2">Something went wrong</div>
        <div className="text-white/50 text-sm mb-8">{errorMsg}</div>
        <button
          className="rounded-2xl bg-white/10 px-8 py-4 font-semibold"
          onClick={() => {
            setPhase("capture");
            setPreview(null);
            setItems([]);
            setErrorMsg("");
          }}
        >
          Try again
        </button>
      </Fullscreen>
    );
  }

  // ── Scanning ─────────────────────────────────────────────────────────────────

  if (phase === "scanning") {
    return (
      <Fullscreen>
        {preview && (
          <div className="mb-6 w-48 h-48 rounded-2xl overflow-hidden opacity-40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Scanning…" className="w-full h-full object-cover" />
          </div>
        )}
        <div className="text-xl font-semibold mb-2">Scanning…</div>
        <div className="text-white/40 text-sm">Claude is reading your fridge</div>
      </Fullscreen>
    );
  }

  // ── Review ────────────────────────────────────────────────────────────────────

  if (phase === "review") {
    return (
      <div className="flex min-h-screen flex-col pb-32">
        <header className="sticky top-0 z-10 border-b border-white/8 bg-background/90 backdrop-blur-md px-5 py-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-white/40">Found {items.length} item{items.length !== 1 ? "s" : ""}</div>
            <div className="text-lg font-bold">Confirm stock</div>
          </div>
          <button
            className="text-sm text-white/40 hover:text-white/70 transition-colors"
            onClick={() => { setPhase("capture"); setPreview(null); setItems([]); }}
          >
            Retake
          </button>
        </header>

        <div className="flex-1 px-4 py-4 space-y-2">
          {items.length === 0 && (
            <div className="py-12 text-center text-white/30 text-sm">
              No items detected — try a clearer photo.
            </div>
          )}
          {items.map((item, i) => (
            <div key={i} className="rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <input
                  value={item.name}
                  onChange={e => updateItem(i, 'name', e.target.value)}
                  className="flex-1 bg-transparent text-base font-semibold focus:outline-none border-b border-white/10 pb-1"
                />
                <button
                  onClick={() => removeItem(i)}
                  className="text-white/30 hover:text-status-out transition-colors text-lg leading-none shrink-0 mt-0.5"
                >
                  ×
                </button>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5">
                  <label className="text-white/40">Qty</label>
                  <input
                    type="number"
                    min={0}
                    value={item.quantity}
                    onChange={e => updateItem(i, 'quantity', Number(e.target.value))}
                    className="w-12 bg-white/8 rounded-lg px-2 py-1 text-center focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-white/40">Location</label>
                  <select
                    value={item.location}
                    onChange={e => updateItem(i, 'location', e.target.value)}
                    className="bg-white/8 rounded-lg px-2 py-1 focus:outline-none"
                  >
                    {['fridge', 'freezer', 'cupboard'].map(l => (
                      <option key={l} value={l}>{LOCATION_LABELS[l]}</option>
                    ))}
                  </select>
                </div>
                <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full ${
                  item.confidence === 'high' ? 'bg-status-ok/15 text-status-ok' :
                  item.confidence === 'medium' ? 'bg-status-low/15 text-status-low' :
                  'bg-white/8 text-white/40'
                }`}>
                  {item.confidence}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Fixed confirm bar */}
        <div className="fixed bottom-0 left-0 right-0 border-t border-white/8 bg-background px-5 py-4">
          <button
            disabled={items.length === 0}
            onClick={confirmItems}
            className="w-full rounded-2xl bg-status-ok py-4 text-base font-bold text-black disabled:opacity-40 transition-opacity"
          >
            Save {items.length} item{items.length !== 1 ? "s" : ""} to stock
          </button>
        </div>
      </div>
    );
  }

  // ── Capture ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col px-5 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="text-2xl font-bold">Scan fridge</div>
          <div className="text-sm text-white/40 mt-0.5">Claude will identify what&apos;s inside</div>
        </div>
        <Link href="/dashboard" className="text-sm text-white/40 hover:text-white/70 transition-colors">
          Cancel
        </Link>
      </div>

      {/* Camera trigger */}
      <button
        onClick={() => fileRef.current?.click()}
        className="flex-1 flex flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed border-white/15 py-16 hover:border-white/25 hover:bg-white/[0.02] transition-all"
      >
        <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-white/8 text-4xl">
          📷
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold">Take a photo</div>
          <div className="text-sm text-white/40 mt-1">Or upload from your library</div>
        </div>
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={handleFile}
      />

      <div className="mt-6 text-center text-xs text-white/25 leading-relaxed">
        Works best with the fridge door open and good lighting.
        Claude will identify items and let you confirm before saving.
      </div>
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
