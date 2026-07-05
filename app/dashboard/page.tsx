import { createClient } from '@supabase/supabase-js';
import Link from 'next/link';
import Nav from '@/components/Nav';

const HOUSEHOLD_ID = process.env.NEXT_PUBLIC_DEFAULT_HOUSEHOLD_ID!;

const LOCATIONS = [
  { key: 'fridge',   label: 'Fridge',   emoji: '🧊' },
  { key: 'freezer',  label: 'Freezer',  emoji: '❄️' },
  { key: 'cupboard', label: 'Cupboard', emoji: '🗄️' },
];

const STATUS_ORDER: Record<string, number> = { out: 0, low: 1, ok: 2 };

function statusBadge(status: string) {
  if (status === 'out') return { dot: 'bg-status-out', label: 'Out',      text: 'text-status-out' };
  if (status === 'low') return { dot: 'bg-status-low', label: 'Low',      text: 'text-status-low' };
  return                       { dot: 'bg-status-ok',  label: 'Good',     text: 'text-status-ok'  };
}

function expiryLabel(useByDate: string | null) {
  if (!useByDate) return null;
  const days = Math.ceil((new Date(useByDate).getTime() - Date.now()) / 86_400_000);
  if (days < 0)  return { text: 'Expired',         cls: 'text-status-out' };
  if (days === 0) return { text: 'Expires today',  cls: 'text-status-out' };
  if (days === 1) return { text: 'Tomorrow',       cls: 'text-status-out' };
  if (days <= 3)  return { text: `${days}d left`,  cls: 'text-status-low' };
  if (days <= 7)  return { text: `${days}d left`,  cls: 'text-status-low' };
  return                  { text: `${days}d`,      cls: 'text-white/30'   };
}

export default async function DashboardPage() {
  const supabase = createClient(
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data, error } = await supabase
    .from('items')
    .select('id, name, status, location, quantity, use_by_date, confidence_level, last_confirmed_at')
    .eq('household_id', HOUSEHOLD_ID)
    .order('name');

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center text-status-out px-6">
        Failed to load stock: {error.message}
      </div>
    );
  }

  const items = (data ?? []).map(i => ({
    ...i,
    _order: STATUS_ORDER[i.status] ?? 3,
  }));

  const totalOut = items.filter(i => i.status === 'out').length;
  const totalLow = items.filter(i => i.status === 'low').length;

  return (
    <div className="flex min-h-screen flex-col pb-20">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/8 bg-background/90 backdrop-blur-md px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tracking-tight">StockSense</span>
          {(totalOut > 0 || totalLow > 0) && (
            <span className="flex items-center gap-2 text-sm">
              {totalOut > 0 && <span className="text-status-out font-semibold">{totalOut} out</span>}
              {totalLow > 0 && <span className="text-status-low font-semibold">{totalLow} low</span>}
            </span>
          )}
        </div>
        <Link
          href="/scan"
          className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/15 transition-colors"
        >
          Scan
        </Link>
      </header>

      {/* Body */}
      <main className="flex-1 px-4 py-6 space-y-8">
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center px-6">
            <div className="text-6xl mb-5">📦</div>
            <div className="text-2xl font-bold mb-2">Nothing tracked yet</div>
            <div className="text-white/50 mb-8 text-base">
              Tap your NFC tag or scan your fridge to get started.
            </div>
            <div className="flex gap-3">
              <Link href="/tap" className="rounded-2xl bg-white/10 px-6 py-3 font-semibold text-base">
                Tap something
              </Link>
              <Link href="/scan" className="rounded-2xl bg-status-ok px-6 py-3 font-semibold text-black text-base">
                Scan fridge
              </Link>
            </div>
          </div>
        )}

        {LOCATIONS.map(({ key, label, emoji }) => {
          const locationItems = items
            .filter(i => i.location === key)
            .sort((a, b) => a._order - b._order);

          return (
            <section key={key}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-bold uppercase tracking-widest text-white/40">
                  {emoji} {label}
                </h2>
                <Link
                  href={`/tap/${key}`}
                  className="text-xs font-semibold text-white/40 hover:text-white/70 transition-colors"
                >
                  + Tap
                </Link>
              </div>

              {locationItems.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 px-5 py-5 text-center text-sm text-white/25">
                  Nothing here yet
                </div>
              ) : (
                <div className="space-y-2">
                  {locationItems.map(item => {
                    const badge = statusBadge(item.status);
                    const expiry = expiryLabel(item.use_by_date);
                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-4"
                      >
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${badge.dot}`} />
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-base leading-tight truncate">
                            {item.name}
                          </div>
                          <div className={`text-sm mt-0.5 ${badge.text}`}>{badge.label}</div>
                        </div>
                        {expiry && (
                          <div className={`shrink-0 text-xs font-medium tabular-nums ${expiry.cls}`}>
                            {expiry.text}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </main>

      <Nav active="stock" />
    </div>
  );
}
