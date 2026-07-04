import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-bold">StockSense</h1>
      <p className="mt-2 text-white/60">
        The dashboard isn&apos;t built yet — the fast path is the tap flow.
      </p>
      <Link
        href="/tap"
        className="mt-8 rounded-xl bg-status-ok px-8 py-4 text-lg font-bold text-black"
      >
        Open /tap
      </Link>
    </div>
  );
}
