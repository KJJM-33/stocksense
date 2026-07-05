import Link from 'next/link';
import Nav from '@/components/Nav';

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col pb-20">
      {/* Hero */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-white/8 text-4xl">
          📦
        </div>
        <h1 className="text-3xl font-bold tracking-tight">StockSense</h1>
        <p className="mt-2 text-base text-white/50">
          Your household stock, always in view.
        </p>

        {/* Quick actions */}
        <div className="mt-10 w-full max-w-xs space-y-3">
          <Link
            href="/dashboard"
            className="flex w-full items-center justify-between rounded-2xl bg-white/8 px-5 py-4 font-semibold hover:bg-white/12 transition-colors"
          >
            <span>View stock</span>
            <span className="text-white/40">→</span>
          </Link>
          <Link
            href="/scan"
            className="flex w-full items-center justify-between rounded-2xl bg-status-ok px-5 py-4 font-bold text-black hover:opacity-90 transition-opacity"
          >
            <span>Scan fridge</span>
            <span className="opacity-60">→</span>
          </Link>
        </div>

        {/* NFC shortcut hint */}
        <p className="mt-10 text-sm text-white/25">
          Tap your NFC tag to log from the fridge
        </p>
      </div>

      <Nav active="home" />
    </div>
  );
}
