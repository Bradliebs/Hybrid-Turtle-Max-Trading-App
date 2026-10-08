'use client';

/**
 * DEPENDENCIES
 * Consumed by: app pages across the web UI
 * Consumes: src/types/index.ts, src/store/useStore.ts, src/lib/utils.ts
 * Risk-sensitive: NO
 * Last modified: 2026-03-08
 * Notes: Main app navigation, updated with Phase 9 review pages.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { MAIN_NAV_ITEMS, RISK_PROFILES, isNavGroup, type NavEntry, type NavGroup, type NavItem } from '@/types';
import { useStore } from '@/store/useStore';
import {
  LayoutDashboard,
  Briefcase,
  Search,
  ClipboardList,
  NotebookPen,
  ShieldAlert,
  Settings,
  User,
  Shield,
  Activity,
  Bell,
  AlertTriangle,
  BookOpen,
  BarChart3,
  FlaskConical,
  Zap,
  ChevronDown,
  FlaskRound,
  MoreHorizontal,
} from 'lucide-react';

const iconMap: Record<string, React.ReactNode> = {
  Dashboard: <LayoutDashboard className="w-4 h-4" />,
  Portfolio: <Briefcase className="w-4 h-4" />,
  Scan: <Search className="w-4 h-4" />,
  Plan: <ClipboardList className="w-4 h-4" />,
  Alerts: <AlertTriangle className="w-4 h-4" />,
  'Planned Trades': <ClipboardList className="w-4 h-4" />,
  Stops: <Shield className="w-4 h-4" />,
  Orders: <Zap className="w-4 h-4" />,
  Jobs: <Activity className="w-4 h-4" />,
  'Trade Log': <NotebookPen className="w-4 h-4" />,
  Journal: <BookOpen className="w-4 h-4" />,
  Risk: <ShieldAlert className="w-4 h-4" />,
  Signals: <Activity className="w-4 h-4" />,
  Scorecard: <FlaskConical className="w-4 h-4" />,
  'Score Lab': <BarChart3 className="w-4 h-4" />,
  'Exec Audit': <Zap className="w-4 h-4" />,
  Settings: <Settings className="w-4 h-4" />,
  Research: <FlaskRound className="w-4 h-4" />,
  More: <MoreHorizontal className="w-4 h-4" />,
};

// ── Dropdown for grouped nav items ──────────────────────────

function NavDropdown({ group, isGroupActive }: { group: NavGroup; isGroupActive: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Close on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Close on navigation
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all',
          isGroupActive
            ? 'text-foreground bg-primary/15 border border-primary/30'
            : 'text-muted-foreground hover:text-foreground hover:bg-navy-600/50'
        )}
      >
        {iconMap[group.label]}
        {group.label}
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[180px] py-1 rounded-lg border border-border bg-navy-800 shadow-xl z-50">
          {group.children.map((child) => {
            const active = pathname.startsWith(child.href);
            return (
              <Link
                key={child.href}
                href={child.href}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 text-sm transition-colors',
                  active
                    ? 'text-foreground bg-primary/10'
                    : 'text-muted-foreground hover:text-foreground hover:bg-navy-700'
                )}
              >
                {iconMap[child.label]}
                {child.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Navbar ─────────────────────────────────────────────

export default function Navbar() {
  const pathname = usePathname();
  const { riskProfile } = useStore();
  const [unreadCount, setUnreadCount] = useState(0);

  // Fetch unread notification count — polls every 60s
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?unreadOnly=true&limit=1');
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.unreadCount ?? 0);
      }
    } catch {
      // Non-critical — silently ignore
    }
  }, []);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 60_000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  const profileConfig = RISK_PROFILES[riskProfile];
  const profileColor =
    riskProfile === 'CONSERVATIVE'
      ? { bg: 'bg-blue-500/15', border: 'border-blue-500/40', text: 'text-blue-400', dot: 'bg-blue-400' }
      : riskProfile === 'SMALL_ACCOUNT'
      ? { bg: 'bg-amber-500/15', border: 'border-amber-500/40', text: 'text-amber-400', dot: 'bg-amber-400' }
      : { bg: 'bg-primary/15', border: 'border-primary/40', text: 'text-primary-400', dot: 'bg-primary-400' };

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  };

  const isGroupActive = (group: NavGroup) =>
    group.children.some((child) => isActive(child.href));

  // Flatten for mobile: all items in a single scrollable row
  const flatItems: NavItem[] = MAIN_NAV_ITEMS.flatMap((entry) =>
    isNavGroup(entry) ? entry.children : [entry]
  );

  return (
    <nav className="sticky top-0 z-40 w-full border-b border-border bg-navy-900/95 backdrop-blur-md">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-white font-bold text-sm">🐢</span>
            </div>
            <span className="text-lg font-bold text-foreground">
              Hybrid<span className="text-primary-500">Turtle</span>
            </span>
            <span className="hidden sm:inline text-[10px] text-muted-foreground font-mono bg-navy-700/60 px-1.5 py-0.5 rounded border border-border/40">
              v6.0.0
            </span>
          </Link>

          {/* Navigation Links — desktop */}
          <div className="hidden md:flex items-center gap-1">
            {MAIN_NAV_ITEMS.map((entry) => {
              if (isNavGroup(entry)) {
                return (
                  <NavDropdown
                    key={entry.label}
                    group={entry}
                    isGroupActive={isGroupActive(entry)}
                  />
                );
              }
              const item = entry as NavItem;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all',
                    isActive(item.href)
                      ? 'text-foreground bg-primary/15 border border-primary/30'
                      : 'text-muted-foreground hover:text-foreground hover:bg-navy-600/50'
                  )}
                >
                  {iconMap[item.label]}
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-3">
            {/* Notification Bell */}
            <Link
              href="/notifications"
              className="relative flex items-center justify-center p-1.5 rounded-lg hover:bg-navy-600/50 transition-colors"
              title={unreadCount > 0 ? `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}` : 'Notifications'}
            >
              <Bell className="w-5 h-5 text-muted-foreground" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-loss text-white text-[10px] font-bold px-1 leading-none">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </Link>

            {/* Risk Profile Badge */}
            <Link
              href="/settings"
              className={cn(
                'hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:brightness-125',
                profileColor.bg,
                profileColor.border,
                profileColor.text
              )}
              title={`Risk Profile: ${profileConfig.name} — ${profileConfig.description}`}
            >
              <Shield className="w-3.5 h-3.5" />
              <span className={cn('w-1.5 h-1.5 rounded-full', profileColor.dot)} />
              {profileConfig.name}
            </Link>
            <Link
              href="/settings"
              className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-navy-600/50 transition-colors"
              title="Account Settings"
            >
              <div className="w-8 h-8 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center">
                <User className="w-4 h-4 text-primary-400" />
              </div>
            </Link>
          </div>
        </div>
      </div>

      {/* Mobile Navigation — flattened scrollable row */}
      <div className="md:hidden border-t border-border">
        <div className="flex overflow-x-auto px-2 py-1 gap-1">
          {flatItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium whitespace-nowrap transition-all',
                isActive(item.href)
                  ? 'text-foreground bg-primary/15'
                  : 'text-muted-foreground'
              )}
            >
              {iconMap[item.label]}
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
