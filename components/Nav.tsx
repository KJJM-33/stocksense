"use client";

import Link from 'next/link';

type NavItem = 'home' | 'stock' | 'scan' | 'receipt';

const ITEMS: { id: NavItem; href: string; label: string; icon: string }[] = [
  { id: 'home',    href: '/',          label: 'Home',    icon: '⌂' },
  { id: 'stock',   href: '/dashboard', label: 'Stock',   icon: '≡' },
  { id: 'scan',    href: '/scan',      label: 'Scan',    icon: '⊡' },
  { id: 'receipt', href: '/receipt',   label: 'Receipt', icon: '🧾' },
];

export default function Nav({ active }: { active?: NavItem }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 flex border-t border-white/8 bg-background/95 backdrop-blur-md">
      {ITEMS.map(item => (
        <Link
          key={item.id}
          href={item.href}
          className={`flex flex-1 flex-col items-center gap-1 py-3 text-xs font-medium transition-colors ${
            active === item.id ? 'text-white' : 'text-white/35 hover:text-white/60'
          }`}
        >
          <span className="text-lg leading-none">{item.icon}</span>
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
